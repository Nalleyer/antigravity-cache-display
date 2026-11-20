import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from './service.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const service = createService();
const readPage = () => readFileSync(join(here, 'index.html'), 'utf8');

// The SDK skips authentication for GET and for any method without a UI token,
// so the data route is POST-only and the sidecar refuses to serve without a token.
if (!process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN?.trim()) {
  console.error('[cache-display] disabled: host did not supply a UI token');
} else {
  const { SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();
  app.page('/', readPage);
  app.page('/index.html', readPage);
  app.api('/api/cache', (data = {}) => {
    const conversationId = data.conversationId || app.config.conversationId || '';
    const res = service.inspect(conversationId);
    // Unchanged snapshots are not resent: the page keeps its previous render.
    if (res.ok && data.version && data.version === res.version) {
      return { ok: true, unchanged: true, version: res.version, conversationId: res.conversationId };
    }
    return res;
  }, 'POST');
  await app.run();
}
