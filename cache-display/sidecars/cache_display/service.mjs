import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { analyze, readConversation, summarize } from './parser.mjs';

const ID_RE = /^[0-9a-zA-Z_-]+$/;

/**
 * Conversation directories to read. Under the host, the sidecar's data dir is
 * <appData>/sidecar_data/<plugin>/<sidecar>/data, so conversations live in
 * <appData>/conversations. Standalone, only the Antigravity app's dir is used.
 */
export function conversationDirectories(dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
  if (dataDir) {
    const root = resolve(dataDir);
    for (let dir = root; dir !== dirname(dir); dir = dirname(dir)) {
      if (basename(dir) === 'sidecar_data') return [join(dirname(dir), 'conversations')];
    }
    return [join(root, 'conversations')];
  }
  return [join(homedir(), '.gemini', 'antigravity', 'conversations')];
}

function stamp(path) {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.size}:${s.mtimeNs}`;
  } catch {
    return null;
  }
}

export function createService(dirs = conversationDirectories()) {
  const cache = new Map(); // dbPath -> { key, value }

  function resolveDb(id) {
    if (id) {
      if (typeof id !== 'string' || !ID_RE.test(id)) return null;
      for (const dir of dirs) {
        const path = join(dir, `${id}.db`);
        if (statSync(path, { throwIfNoEntry: false })?.isFile()) return path;
      }
      return null;
    }
    // No conversation selected (e.g. "new conversation" page): follow the newest DB.
    let latest = null, newest = -Infinity;
    for (const dir of dirs) {
      let files = [];
      try { files = readdirSync(dir); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.db')) continue;
        const path = join(dir, file);
        const st = statSync(path, { throwIfNoEntry: false });
        if (st?.isFile() && st.mtimeMs > newest) { latest = path; newest = st.mtimeMs; }
      }
    }
    return latest;
  }

  function inspect(conversationId) {
    const dbPath = resolveDb(conversationId);
    if (!dbPath) return { ok: false, error: 'no-conversation', conversationId: conversationId || null };
    const key = `${stamp(dbPath)}|${stamp(dbPath + '-wal') || 'no-wal'}`;
    const hit = cache.get(dbPath);
    if (hit?.key === key) return hit.value;
    let value;
    try {
      const { requests, times } = readConversation(dbPath);
      const rows = analyze(requests, times);
      value = {
        ok: true,
        conversationId: basename(dbPath, '.db'),
        version: key,
        summary: summarize(rows),
        rows,
      };
    } catch (err) {
      // A busy / half-written DB: reuse the last good snapshot if there is one.
      if (hit?.value?.ok) return hit.value;
      return { ok: false, error: 'read-failed', message: String(err?.message || err).slice(0, 200), conversationId: basename(dbPath, '.db') };
    }
    cache.set(dbPath, { key, value });
    if (cache.size > 6) cache.delete(cache.keys().next().value);
    return value;
  }

  return { inspect };
}
