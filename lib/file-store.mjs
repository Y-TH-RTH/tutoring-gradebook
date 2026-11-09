// Storage adapter that keeps data in local JSON files (used by local-server.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, 'state.json');
  const metaPath = path.join(dir, 'meta.json');
  const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
  const writeJson = (p, v) => { const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v, null, 1)); fs.renameSync(tmp, p); };
  const meta = () => readJson(metaPath, { sessions: {}, attempts: {} });
  const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');
  let lock = Promise.resolve();
  const serial = (fn) => (lock = lock.then(fn, fn));

  return {
    async loadState() {
      if (!fs.existsSync(statePath)) return { state: null, version: null };
      const text = fs.readFileSync(statePath, 'utf8');
      return { state: JSON.parse(text), version: hash(text) };
    },
    saveState: (state, version) => serial(() => {
      const cur = fs.existsSync(statePath) ? hash(fs.readFileSync(statePath, 'utf8')) : null;
      if (cur !== version) return false;
      writeJson(statePath, state);
      return true;
    }),
    async getSession(uid, token) { return meta().sessions[`${uid}/${token}`] || null; },
    setSession: (uid, token, sess) => serial(() => { const m = meta(); m.sessions[`${uid}/${token}`] = sess; writeJson(metaPath, m); }),
    deleteSession: (uid, token) => serial(() => { const m = meta(); delete m.sessions[`${uid}/${token}`]; writeJson(metaPath, m); }),
    deleteUserSessions: (uid) => serial(() => {
      const m = meta();
      for (const k of Object.keys(m.sessions)) if (k.startsWith(`${uid}/`)) delete m.sessions[k];
      writeJson(metaPath, m);
    }),
    async getAttempts(key) { return meta().attempts[key] || null; },
    setAttempts: (key, v) => serial(() => { const m = meta(); m.attempts[key] = v; writeJson(metaPath, m); }),
  };
}
