// Local preview server (no host needed): node tools/dev-server.mjs [port]
// Serves the pane and the same /api/cache route, reading ~/.gemini/antigravity/conversations.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../cache-display/sidecars/cache_display/service.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'cache-display', 'sidecars', 'cache_display');
const service = createService();
const port = Number(process.argv[2]) || 8765;

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(join(dir, 'index.html')));
  }
  if (req.method === 'POST' && url.pathname === '/api/cache') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body || '{}'); } catch {}
      const out = service.inspect(data.conversationId || url.searchParams.get('conversationId') || '');
      const payload = out.ok && data.version === out.version ? { ok: true, unchanged: true } : out;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    return;
  }
  res.writeHead(404).end('not found');
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
