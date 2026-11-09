// Run the gradebook on your own computer: `npm start`, then open http://localhost:3000
// Data is saved in ./data (state.json holds everything; back it up by copying the folder).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './lib/core.mjs';
import { fileStore } from './lib/file-store.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const store = fileStore(process.env.DATA_DIR || path.join(root, 'data'));
const publicDir = path.join(root, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      const response = await handle(request, store);
      const headers = {};
      response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers['set-cookie'] = cookies;
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    let file = path.normalize(path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(publicDir, 'index.html');
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end('Server error');
  }
}).listen(PORT, () => console.log(`Gradebook running at http://localhost:${PORT}`));
