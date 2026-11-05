import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../site');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
const server = createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path === '/douli') { res.writeHead(308, { Location: '/douli/' }); res.end(); return; }
    const relative = path.startsWith('/douli/') ? path.slice(7) : path.slice(1);
    const file = resolve(root, relative || 'index.html');
    if (!file.startsWith(root + sep) || !types[extname(file)] || !(await stat(file)).isFile()) throw new Error('Not found');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
});
server.listen(Number(process.env.DOULI_SITE_PORT || 4180), '127.0.0.1', () => console.log(`Douli website: http://127.0.0.1:${server.address().port}/douli/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
