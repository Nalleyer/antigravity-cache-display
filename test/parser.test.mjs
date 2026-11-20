import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, parseGenRow, summarize } from '../cache-display/sidecars/cache_display/parser.mjs';

// Minimal protobuf encoder for fixtures.
const varint = n => { const out = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
const num = (f, v) => Buffer.concat([varint(f * 8), varint(v)]);
const msg = (f, buf) => Buffer.concat([varint(f * 8 + 2), varint(buf.length), buf]);
const str = (f, s) => msg(f, Buffer.from(s));

function row({ uncached, cached, output = 100, ttft = [2, 0], streaming = [3, 0], steps = [1], model = 'Test Model', retryError = '' }) {
  const usage = Buffer.concat([num(2, uncached), num(3, output), num(5, cached), num(10, output)]);
  const dur = ([s, n]) => Buffer.concat([num(1, s), n ? num(2, n) : Buffer.alloc(0)]);
  const retry = Buffer.concat([msg(2, usage), retryError ? str(3, retryError) : Buffer.alloc(0)]);
  const m1 = Buffer.concat([msg(4, usage), msg(11, dur(ttft)), msg(12, dur(streaming)), msg(17, retry), str(21, model)]);
  return Buffer.concat([msg(1, m1), msg(2, Buffer.concat(steps.map(s => varint(s))))]);
}

test('parseGenRow reads usage, timing, model and step indices', () => {
  const r = parseGenRow(7, row({ uncached: 1000, cached: 9000, steps: [3, 4] }));
  assert.equal(r.usage.input, 10000);
  assert.equal(r.usage.cached, 9000);
  assert.equal(r.ttft, 2);
  assert.equal(r.streaming, 3);
  assert.equal(r.model, 'Test Model');
  assert.deepEqual(r.stepIndices, [3, 4]);
  assert.equal(r.retries.length, 1);
});

test('parseGenRow ignores rows without metadata', () => {
  assert.equal(parseGenRow(0, Buffer.alloc(0)), null);
});

test('analyze flags zero cache, prefix misses, gaps and shrinkage', () => {
  const reqs = [
    parseGenRow(0, row({ uncached: 20000, cached: 0 })),                 // first request, cold: zero
    parseGenRow(1, row({ uncached: 1000, cached: 20000 })),              // good
    parseGenRow(2, row({ uncached: 15000, cached: 6000 })),              // reads little of the 21000 prefix: miss
    parseGenRow(3, row({ uncached: 300, cached: 0 })),                   // tiny + zero
    parseGenRow(4, row({ uncached: 100, cached: 100 })),                 // shrank
  ];
  const times = new Map([
    [0, { startMs: 0 }], [1, { startMs: 10_000 }], [2, { startMs: 20_000 }],
    [3, { startMs: 20_000 + 700_000 }], [4, { startMs: 800_000 }],
  ]);
  const rows = analyze(reqs, times);
  assert.deepEqual(rows[0].flags, ['zero']);
  assert.deepEqual(rows[1].flags, []);
  assert.ok(rows[2].flags.includes('miss'));
  assert.equal(rows[2].missed, 15000);
  assert.ok(rows[3].flags.includes('zero-small'));
  assert.ok(rows[3].flags.includes('gap'));
  assert.ok(rows[4].flags.includes('shrunk'));
  assert.equal(rows[1].gapSec, 5); // 10s start - (0s + 2s ttft + 3s streaming)
  const s = summarize(rows);
  assert.equal(s.requests, 5);
  assert.equal(s.zero, 2);
  assert.equal(s.zeroCacheable, 1);
  assert.equal(s.misses, 1);
});

test('analyze skips unfinished requests with no usage', () => {
  const reqs = [parseGenRow(0, msg(1, num(3, 5)))];
  assert.equal(analyze(reqs).length, 0);
});

test('analyze flags retries that carry an error', () => {
  const reqs = [parseGenRow(0, row({ uncached: 100, cached: 1000, retryError: 'RESOURCE_EXHAUSTED' }))];
  assert.ok(analyze(reqs)[0].flags.includes('retry'));
});
