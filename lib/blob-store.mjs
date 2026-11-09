// Storage adapter for Netlify Blobs.
import { getStore } from '@netlify/blobs';

const NO_ETAG = '__no_etag__';

export function blobStore() {
  const s = getStore({ name: 'gradebook', consistency: 'strong' });
  const sessKey = (uid, token) => `sessions/${uid}/${token}`;
  return {
    async loadState() {
      const r = await s.getWithMetadata('state', { type: 'json', consistency: 'strong' });
      if (!r) return { state: null, version: null };
      // Netlify returns an ETag so saves can be conditional; local emulators may not.
      return { state: r.data, version: r.etag || NO_ETAG };
    },
    async saveState(state, version) {
      let res;
      if (version === NO_ETAG) res = await s.setJSON('state', state);
      else if (version) res = await s.setJSON('state', state, { onlyIfMatch: version });
      else res = await s.setJSON('state', state, { onlyIfNew: true });
      return res.modified;
    },
    getSession: (uid, token) => s.get(sessKey(uid, token), { type: 'json', consistency: 'strong' }),
    setSession: (uid, token, sess) => s.setJSON(sessKey(uid, token), sess),
    deleteSession: (uid, token) => s.delete(sessKey(uid, token)),
    async deleteUserSessions(uid) {
      const { blobs } = await s.list({ prefix: `sessions/${uid}/` });
      await Promise.all(blobs.map((b) => s.delete(b.key)));
    },
    getAttempts: (key) => s.get(`attempts/${key}`, { type: 'json' }),
    setAttempts: (key, v) => s.setJSON(`attempts/${key}`, v),
  };
}
