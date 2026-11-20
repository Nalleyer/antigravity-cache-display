// Read-only extraction of per-request token/cache usage from an Antigravity
// conversation database (<appData>/conversations/<id>.db).
//
// Layout (protobuf blobs; field numbers learned from the open-source agy-capsule
// project, MIT): table gen_metadata(idx, data), one row per model request.
//   data.1            ChatModelMetadata
//     .1.4            usage { 2: uncached input, 3: total output, 5: cached input,
//                             9: thinking, 10: reply }
//     .11 / .12       time-to-first-token / streaming duration {1: sec, 2: nanos}
//     .19 / .21       model slug / display name
//     .14             retry count
//     .17[]           retry infos { 2: usage counters of that attempt, 3: error text }
//   data.2            step indices produced by this request
// Table steps(idx, step_type, status, metadata): metadata.1 = creation timestamp.

import { DatabaseSync } from 'node:sqlite';

export function readVarint(buf, offset) {
  let val = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length && i - offset < 10) {
    const b = buf[i++];
    if (i - offset === 10 && b > 1) throw new RangeError('Invalid 64-bit protobuf varint');
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [Number(val), i];
    shift += 7n;
  }
  throw new RangeError('Truncated protobuf varint');
}

export function parsePbMap(buf) {
  const fields = new Map();
  if (!buf) return fields;
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let i = 0;
  while (i < buf.length) {
    try {
      const [tag, next] = readVarint(buf, i);
      i = next;
      const fn = Math.floor(tag / 8);
      const wt = tag & 7;
      if (fn === 0) break;
      if (!fields.has(fn)) fields.set(fn, []);
      if (wt === 0) {
        const [val, n] = readVarint(buf, i);
        i = n;
        fields.get(fn).push(val);
      } else if (wt === 2) {
        const [len, n] = readVarint(buf, i);
        i = n;
        if (len < 0 || i + len > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + len));
        i += len;
      } else if (wt === 5) {
        fields.get(fn).push(buf.subarray(i, i + 4));
        i += 4;
      } else if (wt === 1) {
        fields.get(fn).push(buf.subarray(i, i + 8));
        i += 8;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return fields;
}

const num = (map, key) => {
  const v = map.get(key)?.[0];
  return typeof v === 'number' ? v : 0;
};

function duration(map, key) {
  if (!map.has(key)) return null;
  const d = parsePbMap(map.get(key)[0]);
  return num(d, 1) + num(d, 2) / 1e9;
}

function timestampMs(buf) {
  if (!buf) return null;
  const t = parsePbMap(buf);
  if (!t.has(1)) return null;
  return num(t, 1) * 1000 + num(t, 2) / 1e6;
}

function usageOf(map) {
  const uncached = num(map, 2);
  const cached = num(map, 5);
  return {
    uncached,
    cached,
    input: uncached + cached,
    output: num(map, 3),
    reported: [2, 3, 5, 9, 10].some(k => map.has(k)),
  };
}

function packedVarints(values) {
  const out = [];
  for (const value of values || []) {
    if (typeof value === 'number') out.push(value);
    else for (let off = 0; off < value.length;) {
      const [v, next] = readVarint(value, off);
      out.push(v);
      off = next;
    }
  }
  return out;
}

/** Parse one gen_metadata row. Returns null for unusable rows. */
export function parseGenRow(idx, data) {
  const top = parsePbMap(data);
  if (!top.has(1)) return null;
  const m1 = parsePbMap(top.get(1)[0]);
  const usageMap = parsePbMap(m1.get(4)?.[0]);
  const usage = usageOf(usageMap);
  const ttft = duration(m1, 11);
  const streaming = duration(m1, 12);

  const retries = (m1.get(17) || []).map(buf => {
    const info = parsePbMap(buf);
    const err = info.get(3)?.[0];
    return {
      usage: usageOf(parsePbMap(info.get(2)?.[0])),
      error: Buffer.isBuffer(err) && err.length ? err.toString('utf8').slice(0, 300) : '',
    };
  });

  // m1.21 = display name ("Claude Sonnet 5.5 (High)"), m1.19 = model slug.
  const text = key => {
    const b = m1.get(key)?.[0];
    return Buffer.isBuffer(b) && b.length && b.length < 120 ? b.toString('utf8') : '';
  };
  const model = text(21) || text(19);

  return {
    idx,
    stepIndices: packedVarints(top.get(2)),
    usage,
    ttft,
    streaming,
    retryCount: num(m1, 14),
    retries,
    model,
  };
}

/**
 * Derive analysis fields for an ordered list of parsed requests.
 * `times` maps request idx -> { startMs, endMs } (either may be null).
 */
export function analyze(requests, times = new Map(), opts = {}) {
  const missMinTokens = opts.missMinTokens ?? 2000; // smallest unread prefix worth flagging
  const longGapSec = opts.longGapSec ?? 300;
  const minCacheable = opts.minCacheable ?? 1024; // rough lower bound for implicit caching
  const rows = [];
  let prev = null;
  for (const r of requests) {
    const u = r.usage;
    if (!u.reported || u.input === 0) continue; // preflight / not finished
    const t = times.get(r.idx) || {};
    const startMs = t.startMs ?? null;
    // The model finished answering at start + TTFT + streaming. Step "done" times also
    // cover tool execution, so they are only a fallback.
    let endMs = t.endMs ?? null;
    if (startMs !== null && r.ttft !== null && r.streaming !== null) endMs = startMs + (r.ttft + r.streaming) * 1000;
    const hit = u.input > 0 ? u.cached / u.input : null;
    const gapSec = prev && startMs !== null && prev.endMs !== null ? Math.max(0, (startMs - prev.endMs) / 1000) : null;
    const expectedCached = prev ? Math.min(prev.input, u.input) : 0;
    const missed = Math.max(0, expectedCached - u.cached);
    const flags = [];
    if (u.cached === 0) flags.push(u.input < minCacheable ? 'zero-small' : 'zero');
    // The previous request's whole prompt should be a reusable prefix; flag when much of it was not read.
    else if (prev && missed >= Math.max(missMinTokens, expectedCached * 0.5)) flags.push('miss');
    if (gapSec !== null && gapSec >= longGapSec) flags.push('gap');
    if (prev && u.input < prev.input * 0.7) flags.push('shrunk'); // context shrank: compaction/truncation breaks the prefix
    if (r.retries.some(x => x.error)) flags.push('retry');
    const row = {
      n: rows.length + 1,
      idx: r.idx,
      startMs,
      endMs,
      gapSec,
      input: u.input,
      cached: u.cached,
      uncached: u.uncached,
      hit,
      output: u.output,
      ttft: r.ttft,
      streaming: r.streaming,
      model: r.model,
      retries: r.retries.length,
      expectedCached,
      missed,
      flags,
    };
    rows.push(row);
    prev = { hit, input: u.input, endMs };
  }
  return rows;
}

export function summarize(rows) {
  let input = 0, cached = 0, zero = 0, zeroCacheable = 0, misses = 0, output = 0;
  for (const r of rows) {
    input += r.input; cached += r.cached; output += r.output;
    if (r.flags.includes('zero')) { zero++; zeroCacheable++; }
    else if (r.flags.includes('zero-small')) zero++;
    if (r.flags.includes('miss')) misses++;
  }
  const last = rows.at(-1) || null;
  return {
    requests: rows.length,
    input, cached, output,
    hit: input > 0 ? cached / input : null,
    zero, zeroCacheable, misses,
    lastHit: last ? last.hit : null,
  };
}

/** Read a conversation database and return analysed rows. */
export function readConversation(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const raw = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    const requests = [];
    for (const row of raw) {
      try {
        const parsed = parseGenRow(row.idx, row.data);
        if (parsed) requests.push(parsed);
      } catch { /* skip a malformed row */ }
    }
    // Step timestamps, used to estimate when each request ran.
    const stepTimes = new Map();
    const wanted = new Set(requests.flatMap(r => r.stepIndices));
    if (wanted.size) {
      for (const step of db.prepare('SELECT idx, metadata FROM steps').iterate()) {
        if (!wanted.has(step.idx)) continue;
        const f = parsePbMap(step.metadata);
        stepTimes.set(step.idx, {
          created: timestampMs(f.get(1)?.[0]),
          done: timestampMs(f.get(8)?.[0]) ?? timestampMs(f.get(7)?.[0]),
        });
      }
    }
    const times = new Map();
    for (const r of requests) {
      let start = null, end = null;
      for (const s of r.stepIndices) {
        const t = stepTimes.get(s);
        if (!t) continue;
        const c = t.created ?? t.done;
        if (c !== null && (start === null || c < start)) start = c;
        const d = t.done ?? t.created;
        if (d !== null && (end === null || d > end)) end = d;
      }
      times.set(r.idx, { startMs: start, endMs: end });
    }
    return { requests, times };
  } finally {
    db.close();
  }
}
