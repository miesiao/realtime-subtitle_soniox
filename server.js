import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SonioxNodeClient } from '@soniox/node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;

if (!process.env.SONIOX_API_KEY) {
  console.error('Missing SONIOX_API_KEY. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Reads SONIOX_API_KEY from the environment. This key never leaves the server.
const soniox = new SonioxNodeClient();

const PUBLIC_DIR = path.join(__dirname, 'public');
const VENDOR_CLIENT_SDK = path.join(__dirname, 'node_modules', '@soniox', 'client', 'dist', 'index.mjs');
const VENDOR_OPENCC = path.join(__dirname, 'node_modules', 'opencc-js', 'dist', 'esm', 'cn2t.js');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/api/temporary-key') {
    try {
      // usage_type must be "transcribe_websocket" for real-time STT (per @soniox/node types).
      const { api_key, expires_at } = await soniox.auth.createTemporaryKey({
        usage_type: 'transcribe_websocket',
        expires_in_seconds: 300,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ api_key, expires_at }));
    } catch (err) {
      console.error('createTemporaryKey failed:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to create temporary key' }));
    }
    return;
  }

  if (url.pathname === '/vendor/soniox-client.mjs') {
    serveFile(res, VENDOR_CLIENT_SDK);
    return;
  }

  if (url.pathname === '/vendor/opencc-cn2t.mjs') {
    serveFile(res, VENDOR_OPENCC);
    return;
  }

  const requestedPath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!requestedPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  serveFile(res, requestedPath);
});

server.listen(PORT, () => {
  console.log(`Soniox test server running at http://localhost:${PORT}`);
});
