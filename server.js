import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { SonioxNodeClient } from '@soniox/node';
import QRCode from 'qrcode';
import {
  runMigrations,
  dbInsertSession,
  dbMarkSessionLive,
  dbMarkSessionEnded,
  dbRenameSession,
  dbInsertTranscriptLine,
  dbGetSessionTranscript,
} from './db.js';
import { runTranscriptCleanup } from './transcript-cleanup.js';

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

// Guards the one endpoint that actually costs money (Soniox temporary key
// issuance). Everything else — viewer pages, the WebSocket relay — stays
// open. Fixed-time comparison so a wrong guess can't be narrowed down by
// measuring how long the check took.
function isValidHostSecret(provided) {
  const expected = process.env.HOST_SECRET;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(typeof provided === 'string' ? provided : '');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// Shared gate for every host-only endpoint (temporary-key, session create,
// rename, transcript read/retry). Writes the error response itself and
// returns false on failure so callers can just `if (!authorizeHost(...)) return;`.
function authorizeHost(req, res) {
  if (!process.env.HOST_SECRET) {
    console.error('HOST_SECRET is not set — refusing host-only request. Set HOST_SECRET in .env before going live.');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Server misconfigured: HOST_SECRET not set' }));
    return false;
  }
  if (!isValidHostSecret(req.headers['x-host-secret'])) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(new Error('Body too large'));
    });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

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

// ---------------------------------------------------------------------------
// Session store — the multi-session isolation this refactor exists for.
//
// Every runtime piece of state that used to be a lone module-level variable
// (hostWs / viewers / history / nextId) now lives on one of these objects,
// keyed by an internal `id`. Two sessions running at once get two objects;
// nothing is shared, so there is nothing left to cross-broadcast into.
//
// Two different identifiers, never interchangeable (see SPEC §3):
//   - `id`: internal, permanent-for-the-life-of-the-process, never appears
//     in a public URL. The host page gets it once, straight from an
//     authenticated POST /api/sessions response, and uses it only over its
//     own WebSocket registration — never rendered into the QR/viewer link.
//   - `joinCode`: the public, capability-based ticket. Anyone holding it can
//     watch; it's what goes in the QR code and the viewer URL.
// ---------------------------------------------------------------------------
const sessions = new Map();           // id -> session
const sessionsByJoinCode = new Map(); // joinCode -> id

const JOIN_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/i/l — avoids read-aloud ambiguity
const JOIN_CODE_SEGMENTS = [3, 4, 3];

function randomSegment(len) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += JOIN_CODE_ALPHABET[bytes[i] % JOIN_CODE_ALPHABET.length];
  return s;
}

function generateJoinCode() {
  return JOIN_CODE_SEGMENTS.map(randomSegment).join('-');
}

function createUniqueJoinCode() {
  let code;
  do { code = generateJoinCode(); } while (sessionsByJoinCode.has(code));
  return code;
}

// created: QR issued, host not broadcasting yet, viewers can't watch.
// live: host is broadcasting, calibrating, viewers can watch.
// ended: host closed the session for good; join_code no longer admits anyone.
function createSession() {
  const id = crypto.randomUUID();
  const joinCode = createUniqueJoinCode();
  const session = {
    id,
    joinCode,
    name: null,
    status: 'created',
    hostWs: null,
    viewers: new Set(),
    history: [],   // oldest → newest, capped at HISTORY_MAX
    nextId: 1,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    // Fire-and-forget TranscriptLine INSERT promises still in flight (see
    // pushUtterance). Never awaited on the broadcast path — only drained by
    // host_end_session before it reads the transcript back for batch
    // cleanup, so a session that ends moments after its last utterance can't
    // lose that line to the read winning the race against its own insert.
    pendingInserts: new Set(),
  };
  sessions.set(id, session);
  sessionsByJoinCode.set(joinCode, id);
  return session;
}

// Ended sessions are kept around (not deleted) so a viewer who still has the
// old join_code gets an accurate "本場已結束" instead of "invalid_code" —
// but this is in-memory only, so both ended and long-abandoned never-started
// sessions need a TTL or the Map grows forever across a long-running process.
const SESSION_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const ENDED_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const ABANDONED_CREATED_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function sweepStaleSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    const stale =
      (session.status === 'ended' && now - session.endedAt > ENDED_SESSION_TTL_MS) ||
      (session.status === 'created' && now - session.createdAt > ABANDONED_CREATED_SESSION_TTL_MS);
    if (stale) {
      sessions.delete(id);
      sessionsByJoinCode.delete(session.joinCode);
    }
  }
}
setInterval(sweepStaleSessions, SESSION_CLEANUP_INTERVAL_MS).unref();

function getOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/api/temporary-key') {
    if (!authorizeHost(req, res)) return;
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

  // Creates a new session (SPEC §2/§4): generates the internal id + public
  // join_code, in status `created`. Gated the same way as the temporary-key
  // endpoint — no accounts yet (that's phase 3), so this shared secret is
  // the only thing stopping a stranger from spinning up sessions for free.
  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    if (!authorizeHost(req, res)) return;
    const session = createSession();
    // DB is the source of truth for session metadata (SPEC §6.5); this is an
    // infrequent, one-off write (not the per-utterance hot path), so it's
    // fine to await it here. A DB outage must not stop hosts from starting
    // a session though — log and keep going, the in-memory object still works
    // for the live broadcast the rest of this request/session relies on.
    try {
      await dbInsertSession({ id: session.id, joinCode: session.joinCode, name: session.name });
    } catch (err) {
      console.error(`[db] failed to insert session ${session.id}:`, err);
    }
    const viewerUrl = `${getOrigin(req)}/viewer2?code=${session.joinCode}`;
    let qrDataUrl = null;
    try {
      qrDataUrl = await QRCode.toDataURL(viewerUrl, { margin: 1, width: 320 });
    } catch (err) {
      console.error('QR code generation failed:', err);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: session.id, joinCode: session.joinCode, name: session.name, viewerUrl, qrDataUrl }));
    return;
  }

  // Host-only rename (SPEC §6.5 point 6): "host 開場當下能改這一場的名字."
  // No accounts yet, so ownership is enforced the same way session creation
  // is — the shared host secret, not a per-user check.
  {
    const renameMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/name$/);
    if (req.method === 'PATCH' && renameMatch) {
      if (!authorizeHost(req, res)) return;
      const id = renameMatch[1];
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'name is required' }));
        return;
      }
      const session = sessions.get(id);
      if (session) session.name = name;
      let found = Boolean(session);
      try {
        found = (await dbRenameSession(id, name)) || found;
      } catch (err) {
        console.error(`[db] failed to rename session ${id}:`, err);
      }
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_not_found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, name }));
      return;
    }
  }

  // Minimal single-session result view (SPEC §6.5 point 5) — NOT the "my
  // sessions" list page, that's phase 3. Host polls this after ending a
  // session to see processing / ready / failed and read/download the
  // cleaned transcript once it's ready.
  {
    const transcriptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
    if (req.method === 'GET' && transcriptMatch) {
      if (!authorizeHost(req, res)) return;
      const id = transcriptMatch[1];
      let row;
      try {
        row = await dbGetSessionTranscript(id);
      } catch (err) {
        console.error(`[db] failed to read transcript for session ${id}:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to read transcript' }));
        return;
      }
      if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_not_found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: row.id,
        name: row.name,
        status: row.status,
        processingStatus: row.processing_status,
        cleanedTranscript: row.cleaned_transcript,
      }));
      return;
    }
  }

  // Manual retry (SPEC §6.5: "不要讓一次 API 失敗就永久卡死") — re-runs the
  // same batch cleanup function used on `ended`. Fire-and-forget: this is a
  // slow Claude call, the host polls GET .../transcript for the result.
  {
    const retryMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/transcript\/retry$/);
    if (req.method === 'POST' && retryMatch) {
      if (!authorizeHost(req, res)) return;
      const id = retryMatch[1];
      let row;
      try {
        row = await dbGetSessionTranscript(id);
      } catch (err) {
        console.error(`[db] failed to read session ${id} for retry:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to read session' }));
        return;
      }
      if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_not_found' }));
        return;
      }
      if (row.status !== 'ended') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_not_ended' }));
        return;
      }
      runTranscriptCleanup(id).catch((err) => {
        console.error(`[transcript-cleanup] retry for session ${id} threw unexpectedly:`, err);
      });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, processingStatus: 'processing' }));
      return;
    }
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
// cache — all of it scoped per session (SPEC §5). The host side sends
// already-shaped { original, translations } and the server just stamps
// id/ts and fans it out to that session's viewers only; later steps decide
// how translations get filled in before this point.
//
// No module-level mutable room state on purpose: everything below reads a
// `session` object resolved from the connection's own sessionId/joinCode at
// registration time (see the `register` handler), never a shared global.
// ---------------------------------------------------------------------------
const HISTORY_MAX = 50;     // how many recent utterances a session keeps in memory
const BACKFILL_COUNT = 10;  // how many to push to a viewer immediately on connect
const HISTORY_PAGE = 10;    // how many to return per history_request page

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcastToViewers(session, data) {
  const payload = JSON.stringify(data);
  for (const v of session.viewers) {
    if (v.readyState === WebSocket.OPEN) v.send(payload);
  }
}

function sendViewerCount(session) {
  send(session.hostWs, { type: 'viewer_count', count: session.viewers.size });
}

function pushUtterance(session, { original, translations }) {
  const utterance = {
    type: 'utterance',
    id: session.nextId++,
    ts: Date.now(),
    original: original || '',
    translations: translations && typeof translations === 'object' ? translations : {},
  };
  session.history.push(utterance);
  if (session.history.length > HISTORY_MAX) session.history.shift();
  broadcastToViewers(session, utterance);

  // Persistence never gates the broadcast above — this fires after viewers
  // already have the utterance, and a DB hiccup here only gets logged, never
  // surfaced to host/viewers (SPEC §6.5: "不可等散場", "廣播絕不等待 DB").
  // Tracked in pendingInserts so host_end_session can drain it before the
  // batch cleanup reads the transcript back — see the field comment above.
  const insertPromise = dbInsertTranscriptLine(session.id, utterance.id, utterance.ts, utterance.original).catch((err) => {
    console.error(`[db] failed to insert transcript line session=${session.id} seq=${utterance.id}:`, err);
  });
  session.pendingInserts.add(insertPromise);
  insertPromise.finally(() => session.pendingInserts.delete(insertPromise));
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
  let sessionId = null; // resolved at register time from sessionId (host) or joinCode (viewer)
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'register') {
      if (msg.role === 'host') {
        const session = typeof msg.sessionId === 'string' ? sessions.get(msg.sessionId) : null;
        if (!session) {
          send(ws, { type: 'register_error', reason: 'session_not_found' });
          return;
        }
        role = 'host';
        sessionId = session.id;
        session.hostWs = ws;
        console.log(`[host] connected session=${session.id}`);
        sendViewerCount(session);
      } else if (msg.role === 'viewer') {
        const targetId = typeof msg.joinCode === 'string' ? sessionsByJoinCode.get(msg.joinCode) : null;
        const session = targetId ? sessions.get(targetId) : null;
        if (!session) {
          send(ws, { type: 'register_error', reason: 'invalid_code' });
          return;
        }
        role = 'viewer';
        sessionId = session.id;
        session.viewers.add(ws);
        console.log(`[viewer+] session=${session.id} total=${session.viewers.size}`);
        sendViewerCount(session);
        send(ws, { type: 'session_status', status: session.status });
        if (session.status === 'live') {
          send(ws, { type: 'backfill', utterances: session.history.slice(-BACKFILL_COUNT) });
        }
      }
      return;
    }

    // Every non-register message operates on the session resolved above —
    // if the connection never registered (or its session got swept), there's
    // nothing to act on.
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session) return;

    // Host clicked Start (SPEC §4 state machine): created → live. Idempotent
    // — a pause/Start cycle mid-broadcast re-sends this but the session is
    // already live, so it's a no-op rather than resetting startedAt.
    if (role === 'host' && msg.type === 'host_start') {
      if (session.status === 'created') {
        session.status = 'live';
        session.startedAt = Date.now();
        console.log(`[session ${session.id}] live`);
        broadcastToViewers(session, { type: 'session_status', status: 'live' });
        dbMarkSessionLive(session.id).catch((err) => {
          console.error(`[db] failed to mark session ${session.id} live:`, err);
        });
      }
      return;
    }

    // Host explicitly ends the session (not the same as Pause/Stop, which
    // only stops the mic — see host.js). live/created → ended, permanently:
    // the join_code stops admitting anyone from this point on.
    if (role === 'host' && msg.type === 'host_end_session') {
      if (session.status !== 'ended') {
        session.status = 'ended';
        session.endedAt = Date.now();
        console.log(`[session ${session.id}] ended`);
        broadcastToViewers(session, { type: 'session_status', status: 'ended' });
        session.viewers.clear();
        session.hostWs = null;

        // Batch pipeline (SPEC §6.5/§6): fully decoupled from the realtime
        // path above — this UPDATE + the Claude cleanup call run in the
        // background and never block a viewer or the WS handler. Draining
        // pendingInserts first closes the race where a line from the very
        // last utterance is still mid-flight when cleanup reads the
        // transcript back (see pushUtterance/pendingInserts).
        (async () => {
          await Promise.allSettled(session.pendingInserts);
          try {
            await dbMarkSessionEnded(session.id);
          } catch (err) {
            console.error(`[db] failed to mark session ${session.id} ended:`, err);
          }
          await runTranscriptCleanup(session.id);
        })();
      }
      return;
    }

    if (role === 'host' && msg.type === 'host_utterance') {
      if (session.status === 'live') pushUtterance(session, msg);
      return;
    }

    // Interim (non-final) snapshot of the sentence currently being spoken —
    // just relayed straight through, never stamped with an id or kept in
    // history. The eventual host_utterance for the same sentence supersedes it.
    if (role === 'host' && msg.type === 'host_interim') {
      if (session.status === 'live') {
        broadcastToViewers(session, {
          type: 'interim',
          original: msg.original || '',
          translations: msg.translations && typeof msg.translations === 'object' ? msg.translations : {},
        });
      }
      return;
    }

    // Explicit wipe, host-triggered only. Pausing (host just stops recording)
    // must NOT touch history — only this clears it, both server-side and on
    // every viewer of THIS session (never another session's).
    if (role === 'host' && msg.type === 'host_clear') {
      session.history.length = 0;
      session.nextId = 1;
      console.log(`[session ${session.id}] cleared history`);
      broadcastToViewers(session, { type: 'clear' });
      return;
    }

    // Precise reconnect catch-up (viewer2): "everything after the last id I
    // saw", not the fixed-size backfill window. id is a monotonically
    // increasing counter per pushUtterance (scoped to this session), so
    // `> after` is exact — no duplicates, no gaps, as long as the id
    // sequence hasn't been reset. If it HAS been reset (host_clear happened
    // while this viewer was disconnected, so current ids are all <= its
    // stale `after`), there's no valid delta to compute — send a full reset.
    if (role === 'viewer' && msg.type === 'resync') {
      const after = Number.isFinite(msg.after) ? msg.after : 0;
      const maxId = session.history.length ? session.history[session.history.length - 1].id : 0;
      if (maxId < after) {
        send(ws, { type: 'resync', reset: true, utterances: session.history.slice() });
      } else {
        send(ws, { type: 'resync', reset: false, utterances: session.history.filter((u) => u.id > after) });
      }
      return;
    }

    if (role === 'viewer' && msg.type === 'history_request') {
      const before = Number.isFinite(msg.before) ? msg.before : Infinity;
      const older = session.history.filter((u) => u.id < before);
      const page = older.slice(-HISTORY_PAGE);
      const hasMore = older.length > page.length;
      send(ws, { type: 'history_batch', utterances: page, hasMore });
      return;
    }
  });

  ws.on('close', () => {
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session) return;
    if (role === 'host') {
      if (session.hostWs === ws) session.hostWs = null;
      console.log(`[host] disconnected session=${session.id}`);
    } else if (role === 'viewer') {
      session.viewers.delete(ws);
      console.log(`[viewer-] session=${session.id} total=${session.viewers.size}`);
      sendViewerCount(session);
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

// Runs schema.sql (idempotent) before accepting requests. A failure here is
// logged loudly but does not stop the server — live captioning has no DB
// dependency (see db.js) and must keep working even with Postgres down.
await runMigrations();

server.listen(PORT, () => {
  console.log(`Soniox test server running at http://localhost:${PORT}`);
  console.log(`  Host   : http://localhost:${PORT}/host`);
  console.log(`  Viewer : http://localhost:${PORT}/viewer`);
  console.log(`  Viewer2: http://localhost:${PORT}/viewer2`);
});
