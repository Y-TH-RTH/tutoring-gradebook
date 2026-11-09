// Netlify Function: serves every /api/* request.
import { handle } from '../../lib/core.mjs';
import { blobStore } from '../../lib/blob-store.mjs';

export default async (req) => handle(req, blobStore());

export const config = { path: '/api/*' };
