// CLI: node tools/inspect.mjs [conversationId|dbPath] [--csv | --usage]
// Prints per-request cache usage for a conversation (default: newest .db).
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { analyze, summarize, readConversation, parsePbMap } from '../cache-display/sidecars/cache_display/parser.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const target = args.find(a => !a.startsWith('--'));
const dir = join(homedir(), '.gemini', 'antigravity', 'conversations');

let dbPath = target;
if (!dbPath) {
  let best = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.db')) continue;
    const m = statSync(join(dir, f)).mtimeMs;
    if (!best || m > best.m) best = { f, m };
  }
  dbPath = join(dir, best.f);
} else if (!/[\\/]/.test(dbPath)) dbPath = join(dir, dbPath.replace(/\.db$/, '') + '.db');

console.error('db:', dbPath);
if (flags.has('--usage')) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  for (const row of db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all()) {
    const top = parsePbMap(row.data);
    const m1 = parsePbMap(top.get(1)?.[0]);
    const u = parsePbMap(m1.get(4)?.[0]);
    const flat = Object.fromEntries([...u].map(([k, v]) => [k, typeof v[0] === 'number' ? v[0] : '<' + v[0].length + 'b>']));
    const strs = [];
    for (const [k, v] of m1) for (const x of v) if (Buffer.isBuffer(x) && x.length > 3 && x.length < 100 && /^[\x20-\x7e]+$/.test(x.toString('latin1'))) strs.push(k + ':' + x.toString('latin1'));
    const retries = (m1.get(17) || []).length;
    console.log(row.idx, JSON.stringify(flat), 'm1.3=' + m1.get(3)?.[0], 'retries=' + retries, strs.join(' '));
  }
  db.close();
  process.exit(0);
}
const { requests, times } = readConversation(dbPath);
const rows = analyze(requests, times);
if (flags.has('--csv')) {
  console.log('n,idx,time,gapSec,input,cached,uncached,hitPct,output,ttft,flags');
  for (const r of rows) console.log([r.n, r.idx, r.startMs ? new Date(r.startMs).toISOString() : '', r.gapSec?.toFixed(1) ?? '', r.input, r.cached, r.uncached, r.hit === null ? '' : (r.hit * 100).toFixed(1), r.output, r.ttft?.toFixed(2) ?? '', r.flags.join('|')].join(','));
} else {
  console.table(rows.map(r => ({ n: r.n, idx: r.idx, time: r.startMs ? new Date(r.startMs).toLocaleTimeString() : '-', gap: r.gapSec === null ? '-' : Math.round(r.gapSec) + 's', input: r.input, cached: r.cached, hit: r.hit === null ? '-' : (r.hit * 100).toFixed(1) + '%', out: r.output, flags: r.flags.join(',') })));
}
console.log(summarize(rows));
