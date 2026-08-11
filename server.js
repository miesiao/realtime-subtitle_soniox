import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
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

  if (url.pathname === '/host') {
    serveFile(res, path.join(PUBLIC_DIR, 'host.html'));
    return;
  }

  if (url.pathname === '/viewer') {
    serveFile(res, path.join(PUBLIC_DIR, 'viewer.html'));
    return;
  }

  if (url.pathname === '/viewer2') {
    serveFile(res, path.join(PUBLIC_DIR, 'viewer2.html'));
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

// ---------------------------------------------------------------------------
// WebSocket layer: host/viewer roles, §3 unified utterance contract, history
// cache. Step 1 (連接骨架) only — no Soniox/Haiku wiring here yet. The host
// side sends already-shaped { original, translations } and the server just
// stamps id/ts and fans it out; later steps decide how translations get
// filled in before this point.
// ---------------------------------------------------------------------------
const HISTORY_MAX = 50;     // how many recent utterances the server keeps in memory
const BACKFILL_COUNT = 10;  // how many to push to a viewer immediately on connect
const HISTORY_PAGE = 10;    // how many to return per history_request page

let hostWs = null;
const viewers = new Set();
const history = []; // oldest → newest, capped at HISTORY_MAX
let nextId = 1;

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcastToViewers(data) {
  const payload = JSON.stringify(data);
  for (const v of viewers) {
    if (v.readyState === WebSocket.OPEN) v.send(payload);
  }
}

function sendViewerCount() {
  send(hostWs, { type: 'viewer_count', count: viewers.size });
}

function pushUtterance({ original, translations }) {
  const utterance = {
    type: 'utterance',
    id: nextId++,
    ts: Date.now(),
    original: original || '',
    translations: translations && typeof translations === 'object' ? translations : {},
  };
  history.push(utterance);
  if (history.length > HISTORY_MAX) history.shift();
  broadcastToViewers(utterance);
}

const wss = new WebSocketServer({ server });

// Heartbeat: some networks (mobile wifi handoffs, NAT idle timeouts) drop a
// connection one-sidedly without ever sending a TCP FIN/RST, so the browser's
// WebSocket never fires onclose and just sits there looking "connected" while
// actually dead. Pinging every 15s and terminating anyone that didn't pong
// since the last check forces a real close, which triggers the client's
// existing reconnect logic.
const HEARTBEAT_INTERVAL = 15000;

wss.on('connection', (ws) => {
  let role = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'register') {
      role = msg.role === 'host' ? 'host' : msg.role === 'viewer' ? 'viewer' : null;

      if (role === 'host') {
        hostWs = ws;
        console.log('[host] connected');
        sendViewerCount();
      } else if (role === 'viewer') {
        viewers.add(ws);
        console.log(`[viewer+] total=${viewers.size}`);
        sendViewerCount();
        send(ws, { type: 'backfill', utterances: history.slice(-BACKFILL_COUNT) });
      }
      return;
    }

    if (role === 'host' && msg.type === 'host_utterance') {
      pushUtterance(msg);
      return;
    }

    // Interim (non-final) snapshot of the sentence currently being spoken —
    // just relayed straight through, never stamped with an id or kept in
    // history. The eventual host_utterance for the same sentence supersedes it.
    if (role === 'host' && msg.type === 'host_interim') {
      broadcastToViewers({
        type: 'interim',
        original: msg.original || '',
        translations: msg.translations && typeof msg.translations === 'object' ? msg.translations : {},
      });
      return;
    }

    // Explicit wipe, host-triggered only. Pausing (host just stops recording)
    // must NOT touch history — only this clears it, both server-side and on
    // every connected viewer.
    if (role === 'host' && msg.type === 'host_clear') {
      history.length = 0;
      nextId = 1;
      console.log('[host] cleared history');
      broadcastToViewers({ type: 'clear' });
      return;
    }

    // Precise reconnect catch-up (viewer2): "everything after the last id I
    // saw", not the fixed-size backfill window. id is a monotonically
    // increasing counter per pushUtterance, so `> after` is exact — no
    // duplicates, no gaps, as long as the id sequence hasn't been reset.
    // If it HAS been reset (host_clear happened while this viewer was
    // disconnected, so current ids are all <= its stale `after`), there's
    // no valid delta to compute — send a full reset instead.
    if (role === 'viewer' && msg.type === 'resync') {
      const after = Number.isFinite(msg.after) ? msg.after : 0;
      const maxId = history.length ? history[history.length - 1].id : 0;
      if (maxId < after) {
        send(ws, { type: 'resync', reset: true, utterances: history.slice() });
      } else {
        send(ws, { type: 'resync', reset: false, utterances: history.filter((u) => u.id > after) });
      }
      return;
    }

    if (role === 'viewer' && msg.type === 'history_request') {
      const before = Number.isFinite(msg.before) ? msg.before : Infinity;
      const older = history.filter((u) => u.id < before);
      const page = older.slice(-HISTORY_PAGE);
      const hasMore = older.length > page.length;
      send(ws, { type: 'history_batch', utterances: page, hasMore });
      return;
    }
  });

  ws.on('close', () => {
    if (role === 'host') {
      if (hostWs === ws) hostWs = null;
      console.log('[host] disconnected');
    } else if (role === 'viewer') {
      viewers.delete(ws);
      console.log(`[viewer-] total=${viewers.size}`);
      sendViewerCount();
    }
  });
});

const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate(); // 'close' handler does the role-specific cleanup
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(heartbeatTimer));

server.listen(PORT, () => {
  console.log(`Soniox test server running at http://localhost:${PORT}`);
  console.log(`  Host   : http://localhost:${PORT}/host`);
  console.log(`  Viewer : http://localhost:${PORT}/viewer`);
  console.log(`  Viewer2: http://localhost:${PORT}/viewer2`);
});
