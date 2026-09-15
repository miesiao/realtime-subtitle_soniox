import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { WebSocketServer, WebSocket } from 'ws';
import { SonioxNodeClient } from '@soniox/node';
import QRCode from 'qrcode';
import {
  pool,
  runMigrations,
  dbInsertSession,
  dbMarkSessionLive,
  dbSetSessionLanguages,
  dbMarkSessionEnded,
  dbRenameSession,
  dbInsertTranscriptLine,
  dbGetSessionTranscript,
  dbUpsertUserByGoogleSub,
  dbGetUserById,
  dbGetSessionOwner,
  dbGetSessionsByUser,
  dbGetSessionById,
  dbDeleteSession,
  dbDeleteAbandonedCreatedSessions,
  dbGetUserCredits,
  dbChargeCredits,
  dbCreateOrder,
  dbSetOrderLastFive,
  dbGetOrder,
  dbInsertUsageLedger,
  dbMarkSessionPaused,
  dbMarkSessionResumed,
} from './db.js';
import { runTranscriptCleanup } from './transcript-cleanup.js';
import { sendOrderNotificationEmail, sendOrderCreatedEmail } from './mail.js';

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
// issuance). Session creation/rename/transcript moved to login-based
// ownership in phase 3a (see requireLoginApi/requireLoginPage below) — this
// shared-secret gate is kept only for /api/temporary-key, deliberately not
// torn out yet (SPEC §3a point 4: "避免 auth 真空", pull it only when told
// to). Fixed-time comparison so a wrong guess can't be narrowed down by
// measuring how long the check took.
function isValidHostSecret(provided) {
  const expected = process.env.HOST_SECRET;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(typeof provided === 'string' ? provided : '');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// ---------------------------------------------------------------------------
// Paid credit system (SPEC steps 3/6). Amount→credits mapping is fixed here,
// server-side, precisely so a tampered client request can never buy more
// credits than it paid for — the client only ever picks a `tier` key.
// ---------------------------------------------------------------------------
const TOPUP_TIERS = {
  300: { amountPaid: 300, creditsToAdd: 300 },
  500: { amountPaid: 500, creditsToAdd: 530 },
  1000: { amountPaid: 1000, creditsToAdd: 1100 },
};
// Three lines on purpose (host.js's #orderBankText renders this with
// white-space: pre-line) — this is the single source of truth for the
// transfer account; no HTML in this app hardcodes the account number itself,
// only the copy-to-clipboard button reads BANK_ACCOUNT_NUMBER directly (see
// POST /api/orders below) so "複製" copies just the digits, not all 3 lines.
const BANK_INFO = '南隅有限公司\n(808) 玉山銀行\n0598-940-168796';
const BANK_ACCOUNT_NUMBER = '0598-940-168796';

// Billing rate (SPEC step 6): 2 credits/min base (pure transcription) + 1
// credit/min per target language. Only one target language is selectable
// today (host.js's single targetLangSelect), so targetLangCount is always 0
// or 1 in practice — written generically in case that ever changes.
const BASE_CREDITS_PER_MINUTE = 2;
function creditsPerMinuteFor(targetLangCount) {
  return BASE_CREDITS_PER_MINUTE + targetLangCount;
}
const BILLING_TICK_MS = 60 * 1000;
// "剩約 10 分鐘時預警" (SPEC step 6) — worth warning about, not yet an
// emergency; the real backstop is the auto-pause below.
const LOW_BALANCE_WARNING_MINUTES = 10;
// Host WS reconnects (network blip) must NOT stop billing — host.js's own
// reconnect backoff caps at 10s, so any gap under this is routine. Only a
// gap this long is treated as "host actually walked away" (closed the tab,
// lost power, etc.) and stops the meter so a dead session can't rack up
// charges against nobody's audio.
const BILLING_DISCONNECT_GRACE_MS = 90 * 1000;

// Gate for /api/temporary-key only (see comment above). Writes the error
// response itself and returns false on failure so the caller can just
// `if (!authorizeHost(...)) return;`.
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

// ---------------------------------------------------------------------------
// Google login (SPEC §3a) — Passport + express-session, no external hosted
// auth service. Identity is decided entirely server-side: the session cookie
// is httpOnly, so client-side code never sees (and can't spoof) who's logged
// in, only the /api/me response tells it.
// ---------------------------------------------------------------------------
if (!process.env.SESSION_SECRET) {
  console.error(
    'Missing SESSION_SECRET — using a random value generated at boot. Logins ' +
    'will not survive a server restart until you set SESSION_SECRET in .env.'
  );
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Application-layer authorization on top of OAuth (this does NOT touch the
// OAuth/session verification itself — Google having authenticated someone
// only proves *who* they are, not that they're allowed to use this app as a
// host). Checked in the verify callback below, after Google's profile comes
// back but before any DB write.
//
// Fail-closed by design: an empty/missing LOGIN_ALLOWLIST blocks everyone
// rather than admitting everyone. A silently-empty allowlist is the failure
// mode that matters most to avoid here — it would mean this gate went
// missing without anyone noticing (env var typo'd, not set on a new
// deploy, etc.) and quietly reverted to "anyone with a Google account is a
// host," which is exactly the hole this feature closes.
function parseAllowlist(raw) {
  if (!raw) return new Set();
  return new Set(
    raw.split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}
const LOGIN_ALLOWLIST = parseAllowlist(process.env.LOGIN_ALLOWLIST);
// Public-launch switch (SPEC step 2): once true, ANY Google account may log
// in/register (a fresh one starting at credits = 0, upsert logic unchanged)
// and LOGIN_ALLOWLIST below is never consulted. Deliberately NOT the
// default — flip this on only after the credit gate + auto-pause (SPEC step
// 6) has been verified working, per the ordering note in .env.example: this
// is the door, the credit gate is the lock, and the lock has to already be
// installed before the door opens.
const OPEN_SIGNUP = process.env.OPEN_SIGNUP === 'true';
if (!OPEN_SIGNUP && LOGIN_ALLOWLIST.size === 0) {
  console.error(
    'LOGIN_ALLOWLIST 未設定或為空 — 目前所有 Google 登入都會被拒絕。' +
    '請在環境變數設定 LOGIN_ALLOWLIST（逗號分隔的 email 清單）以允許特定帳號登入本服務，' +
    '或在驗證過點數防線後將 OPEN_SIGNUP 設為 true 開放註冊。'
  );
}
function isEmailAllowed(email) {
  if (OPEN_SIGNUP) return Boolean(email);
  if (!email) return false;
  return LOGIN_ALLOWLIST.has(String(email).trim().toLowerCase());
}

const GOOGLE_LOGIN_CONFIGURED = Boolean(process.env.GOOGLE_LOGIN_CLIENT_ID && process.env.GOOGLE_LOGIN_CLIENT_SECRET);
if (!GOOGLE_LOGIN_CONFIGURED) {
  console.error(
    'Missing GOOGLE_LOGIN_CLIENT_ID / GOOGLE_LOGIN_CLIENT_SECRET — Google login is ' +
    'disabled. Set both in .env (same values as the Railway env) to enable it.'
  );
} else {
  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_LOGIN_CLIENT_ID,
      clientSecret: process.env.GOOGLE_LOGIN_CLIENT_SECRET,
      callbackURL: '/auth/google/callback',
      proxy: true, // resolve the relative callbackURL using X-Forwarded-* (Railway terminates TLS upstream)
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = (profile.emails && profile.emails[0] && profile.emails[0].value) || null;
        // Allowlist check happens here — after Google has verified who this
        // person is, before we ever touch the DB. Rejected: done(null,
        // false, info) so Passport treats it as a failed login, no
        // dbUpsertUserByGoogleSub call, no row written, no session created.
        if (!isEmailAllowed(email)) {
          console.warn(`[auth] rejected login: ${email || '(no email in Google profile)'} is not in LOGIN_ALLOWLIST`);
          done(null, false, { reason: 'not_allowlisted', email });
          return;
        }
        const name = profile.displayName || null;
        const user = await dbUpsertUserByGoogleSub({
          id: crypto.randomUUID(),
          googleSub: profile.id,
          email,
          name,
        });
        done(null, user);
      } catch (err) {
        done(err);
      }
    }
  ));
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await dbGetUserById(id);
    done(null, user || false);
  } catch (err) {
    done(err);
  }
});

// requireLoginApi: for JSON endpoints — 401 body, never a redirect (SPEC §3a
// point 3: "未登入回 401").
function requireLoginApi(req, res, next) {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: 'login_required' });
    return;
  }
  next();
}

// requireLoginPage: for full-page routes that have no guest use (/sessions —
// a signed-out visitor owns no sessions to list; /host used to be gated the
// same way but now allows guests, see its route below) — bounce straight to
// Google login and back, so a signed-out visitor never sees a half-working
// page. Only ever redirects to a same-origin relative path (never trusts an
// absolute/`//`-prefixed returnTo — that would be an open redirect).
function requireLoginPage(req, res, next) {
  if (!req.isAuthenticated()) {
    const returnTo = encodeURIComponent(req.originalUrl);
    res.redirect(`/auth/google?returnTo=${returnTo}`);
    return;
  }
  next();
}

function sanitizeReturnTo(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/host';
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

// Order codes (SPEC follow-up: short, human-typeable id instead of a UUID —
// this is something a host reads over the phone / types into an email, not
// an internal reference like sessions.id). Same no-readalikes alphabet as
// join codes, one flat 6-character block, uppercased for visual distinction
// from join codes. Uniqueness is checked against the DB (orders live there,
// not in an in-memory Map like sessions) with a short retry loop — collision
// odds at 6 chars over a 32-symbol alphabet (~1 billion combinations) are
// negligible for this feature's volume, so a handful of retries is already
// generous headroom, not a real bottleneck.
const ORDER_CODE_ALPHABET = JOIN_CODE_ALPHABET.toUpperCase();
const ORDER_CODE_LENGTH = 6;
const ORDER_CODE_MAX_ATTEMPTS = 5;

function generateOrderCode() {
  const bytes = crypto.randomBytes(ORDER_CODE_LENGTH);
  let s = '';
  for (let i = 0; i < ORDER_CODE_LENGTH; i++) s += ORDER_CODE_ALPHABET[bytes[i] % ORDER_CODE_ALPHABET.length];
  return s;
}

async function createUniqueOrderCode() {
  for (let attempt = 0; attempt < ORDER_CODE_MAX_ATTEMPTS; attempt++) {
    const code = generateOrderCode();
    const existing = await dbGetOrder(code);
    if (!existing) return code;
  }
  throw new Error('Failed to generate a unique order code');
}

// created: QR issued, host not broadcasting yet, viewers can't watch.
// live: host is broadcasting, calibrating, viewers can watch.
// ended: host closed the session for good; join_code no longer admits anyone.
function createSession(userId) {
  const id = crypto.randomUUID();
  const joinCode = createUniqueJoinCode();
  const session = {
    id,
    joinCode,
    name: null,
    status: 'created',
    // Owning user (SPEC step 6): who to charge/credit-check for this
    // session's per-minute billing. Always set — every session now requires
    // login to create (see POST /api/sessions) — but kept nullable-safe
    // throughout the billing helpers below in case an old in-memory session
    // somehow predates this field.
    userId: userId || null,
    // Billing state (SPEC step 6), all reset on every host_start:
    // billingRate = credits/minute for the CURRENT recording stint,
    // billingTimer = the setInterval charging it, lowBalanceWarned = have we
    // already sent the ~10-min warning for this stint (so it fires once, not
    // every tick), disconnectGraceTimer = pending "host really left" timeout
    // (see BILLING_DISCONNECT_GRACE_MS).
    billingRate: null,
    billingTimer: null,
    lowBalanceWarned: false,
    disconnectGraceTimer: null,
    // Set the instant a host WS disconnects while this session is
    // live/paused; cleared back to null the instant a host WS reconnects
    // (register handler). Distinct from disconnectGraceTimer's short
    // BILLING_DISCONNECT_GRACE_MS window (network blip vs. billing) — this is
    // what the long-TTL sweep below measures "how long has host actually
    // been gone" against, independent of whether that short grace timer has
    // fired yet.
    hostDisconnectedAt: null,
    // null = host hasn't clicked Start yet (unknown); [] = pure transcription
    // (translation off); [lang] = one_way translation to `lang`. Set once at
    // host_start and never changed after — see the host_start handler below.
    // Viewers read this (via session_status) to decide their layout at join
    // time, without waiting for/guessing from actual utterance content.
    targetLangs: null,
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
// SPEC fix ("場次沒結束一直掛 live"), part (b): a live/paused session with
// NO host connection for this long is genuinely abandoned, not just a
// network blip (BILLING_DISCONNECT_GRACE_MS already handles those in under
// two minutes) — swept to 'ended' so it can't outlive whoever was running it.
const LONG_DISCONNECT_TTL_MS = 30 * 60 * 1000;

async function sweepStaleSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    const stale =
      (session.status === 'ended' && now - session.endedAt > ENDED_SESSION_TTL_MS) ||
      (session.status === 'created' && now - session.createdAt > ABANDONED_CREATED_SESSION_TTL_MS);
    if (stale) {
      sessions.delete(id);
      sessionsByJoinCode.delete(session.joinCode);
      continue;
    }
    const abandonedWhileOpen =
      (session.status === 'live' || session.status === 'paused') &&
      session.hostDisconnectedAt &&
      now - session.hostDisconnectedAt > LONG_DISCONNECT_TTL_MS;
    if (abandonedWhileOpen) {
      console.log(`[cleanup] session ${id} had no host connection for over 30 minutes — force-ending`);
      await endSession(session).catch((err) => {
        console.error(`[cleanup] failed to force-end abandoned session ${id}:`, err);
      });
    }
  }
  // Extends the above to the DB layer: a never-started session otherwise
  // lives in the `sessions` table forever (and keeps showing up in
  // "字幕場次"'s list as a zombie) even after its in-memory copy is swept.
  // Same TTL as the in-memory branch above, on purpose — one "abandoned"
  // definition, not two independently-tunable ones.
  try {
    const deleted = await dbDeleteAbandonedCreatedSessions(ABANDONED_CREATED_SESSION_TTL_MS);
    if (deleted > 0) console.log(`[cleanup] deleted ${deleted} abandoned never-started session(s) from the DB`);
  } catch (err) {
    console.error('[cleanup] failed to delete abandoned sessions from the DB:', err);
  }
}
setInterval(() => {
  sweepStaleSessions().catch((err) => console.error('[cleanup] sweep failed:', err));
}, SESSION_CLEANUP_INTERVAL_MS).unref();

function getOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

// Railway terminates TLS upstream and forwards plain HTTP with
// X-Forwarded-Proto — without trust proxy, Express never considers the
// request secure, and express-session's cookie.secure would silently refuse
// to set the cookie in production.
const app = express();
app.set('trust proxy', 1);

const PgSessionStore = connectPgSimple(session);
app.use(session({
  store: pool ? new PgSessionStore({ pool, tableName: 'user_sessions', createTableIfMissing: true }) : undefined,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));
app.use(passport.initialize());
app.use(passport.session());

app.use(express.json({ limit: '1mb' }));
// Turns a malformed JSON body into the same shaped error the old
// readJsonBody() used to produce, instead of express's default HTML error page.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }
  next(err);
});

// The real cost gate (SPEC step 6): this is the one endpoint that actually
// causes Soniox spend, so it's where credits are checked, not just at
// host_start over the WS (that check exists too, for session-state
// consistency, but a client could in principle skip straight to this
// endpoint — this one has to hold on its own). targetLangCount comes from
// the client (host.js reads it off the same checkbox state host_start
// does) so the rate matches whatever the host is actually about to record
// with; an invalid/missing value is clamped to 0 (cheapest, pure-
// transcription rate) rather than trusted as something higher.
app.post('/api/temporary-key', async (req, res) => {
  if (!authorizeHost(req, res)) return;
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: 'login_required' });
    return;
  }
  const targetLangCount = Number.isInteger(req.body.targetLangCount) && req.body.targetLangCount > 0
    ? req.body.targetLangCount
    : 0;
  const requiredCredits = creditsPerMinuteFor(targetLangCount);
  let credits;
  try {
    credits = await dbGetUserCredits(req.user.id);
  } catch (err) {
    console.error(`[db] failed to read credits for user ${req.user.id}:`, err);
    res.status(500).json({ error: 'Failed to check credits' });
    return;
  }
  // null (DB unreachable, or user row missing) is treated the same as "not
  // enough" — see dbGetUserCredits's own comment: this is the cost defense,
  // it does not get to fail open.
  if (credits === null || credits < requiredCredits) {
    res.status(402).json({ error: 'insufficient_credits', credits: credits ?? 0, required: requiredCredits });
    return;
  }
  try {
    // usage_type must be "transcribe_websocket" for real-time STT (per @soniox/node types).
    const { api_key, expires_at } = await soniox.auth.createTemporaryKey({
      usage_type: 'transcribe_websocket',
      expires_in_seconds: 300,
    });
    res.status(200).json({ api_key, expires_at });
  } catch (err) {
    console.error('createTemporaryKey failed:', err);
    res.status(500).json({ error: 'Failed to create temporary key' });
  }
});

// Creates a new session (SPEC §2/§4): generates the internal id + public
// join_code, in status `created`, owned by the logged-in user (SPEC §3a
// point 3 — this replaces the old shared host-secret gate for this one
// endpoint; see requireLoginApi/authorizeHost comments above).
app.post('/api/sessions', requireLoginApi, async (req, res) => {
  const session = createSession(req.user.id);
  // DB is the source of truth for session metadata (SPEC §6.5); this is an
  // infrequent, one-off write (not the per-utterance hot path), so it's
  // fine to await it here. A DB outage must not stop hosts from starting
  // a session though — log and keep going, the in-memory object still works
  // for the live broadcast the rest of this request/session relies on.
  try {
    await dbInsertSession({ id: session.id, joinCode: session.joinCode, name: session.name, userId: req.user.id });
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
  res.status(200).json({ id: session.id, joinCode: session.joinCode, name: session.name, viewerUrl, qrDataUrl });
});

// "My sessions" list (SPEC §3a point 5) — the page that replaces "host
// disappeared, transcript gone": whatever DB rows this user owns, regardless
// of whether the in-memory session object is still alive.
app.get('/api/sessions', requireLoginApi, async (req, res) => {
  try {
    const rows = await dbGetSessionsByUser(req.user.id);
    res.status(200).json(rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      processingStatus: row.processing_status,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    })));
  } catch (err) {
    console.error(`[db] failed to list sessions for user ${req.user.id}:`, err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Single existing session's share info (SPEC fix: "進入 /host 就自動建場" was
// creating a zombie `created` row on every page load/refresh — /host now
// requires ?id=<sessionId> for a session created explicitly via the
// "＋ 開新場次" button on 字幕場次, and loads it here instead of calling POST
// /api/sessions again). Ownership-gated like rename/transcript above.
app.get('/api/sessions/:id', requireLoginApi, async (req, res) => {
  const { id } = req.params;
  if (!(await authorizeSessionOwner(req, res, id))) return;
  let row;
  try {
    row = await dbGetSessionById(id);
  } catch (err) {
    console.error(`[db] failed to load session ${id}:`, err);
    res.status(500).json({ error: 'Failed to load session' });
    return;
  }
  if (!row) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  const viewerUrl = `${getOrigin(req)}/viewer2?code=${row.join_code}`;
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(viewerUrl, { margin: 1, width: 320 });
  } catch (err) {
    console.error('QR code generation failed:', err);
  }
  res.status(200).json({ id: row.id, joinCode: row.join_code, name: row.name, status: row.status, viewerUrl, qrDataUrl });
});

// Deletes a session entirely (SPEC: "刪除場次" — the counterpart to the
// "＋ 開新場次" button, for a never-used or fully-done-with session). Never
// allowed while actually live — an already-started session's join_code and
// connected viewers must survive (SPEC: "不要動 join_code 存續"); end it from
// /host first. Ownership-gated the same way as the routes above.
app.delete('/api/sessions/:id', requireLoginApi, async (req, res) => {
  const { id } = req.params;
  if (!(await authorizeSessionOwner(req, res, id))) return;
  const liveSession = sessions.get(id);
  if (liveSession && (liveSession.status === 'live' || liveSession.status === 'paused')) {
    res.status(409).json({ error: 'session_live' });
    return;
  }
  let deleted;
  try {
    deleted = await dbDeleteSession(id, req.user.id);
  } catch (err) {
    console.error(`[db] failed to delete session ${id}:`, err);
    res.status(500).json({ error: 'Failed to delete session' });
    return;
  }
  if (!deleted) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  if (liveSession) {
    sessions.delete(id);
    sessionsByJoinCode.delete(liveSession.joinCode);
  }
  res.status(200).json({ id, deleted: true });
});

// Manual safety net (SPEC fix: "場次沒結束一直掛 live") — the 字幕場次 list
// shows this for any session still displaying as live/paused so a host (or
// anyone who owns the session) can force it closed even if the tab that was
// running it is long gone and never sent host_end_session itself. Reuses the
// exact same endSession() path as that WS message and the long-disconnect
// sweep below — one "end this session for good" implementation, three
// triggers. Ownership-gated like the routes above; works whether or not the
// session still has an in-memory object (a restarted server has none, but
// the DB row can still be live/paused) — see endSession's own comment.
app.post('/api/sessions/:id/end', requireLoginApi, async (req, res) => {
  const { id } = req.params;
  if (!(await authorizeSessionOwner(req, res, id))) return;
  const liveSession = sessions.get(id);
  try {
    if (liveSession) {
      await endSession(liveSession); // updates memory + DB + broadcasts + cleanup
    } else {
      await dbMarkSessionEnded(id);
    }
  } catch (err) {
    console.error(`[db] failed to end session ${id}:`, err);
    res.status(500).json({ error: 'Failed to end session' });
    return;
  }
  res.status(200).json({ id, status: 'ended' });
});

// Tells client-side code who (if anyone) is logged in. Identity is decided
// here, server-side, from the httpOnly session cookie — never trust anything
// the client claims about itself.
// Guest-mode change: a signed-out caller now gets 200 { guest: true } instead
// of 401 — /host is browsable without login (see the /host route below), and
// this is what lets its front-end tell "not logged in" apart from "logged-in
// user with no name/email" without treating every visit as an error to
// bounce off of. Every endpoint that actually costs something or touches
// owned data (temporary-key, orders, sessions CRUD) still requires login
// unchanged — this only affects how /api/me itself reports absence of login.
app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated()) {
    res.status(200).json({ guest: true });
    return;
  }
  res.status(200).json({ id: req.user.id, email: req.user.email, name: req.user.name });
});

// --- Credits / top-up (SPEC steps 3/6) --------------------------------------

// Host.js polls this before ever attempting Start (SPEC step 6 "開場預
// 檢") — a client-side courtesy check only; /api/temporary-key is the
// endpoint that actually enforces it.
app.get('/api/credits', requireLoginApi, async (req, res) => {
  try {
    const credits = await dbGetUserCredits(req.user.id);
    res.status(200).json({ credits: credits ?? 0 });
  } catch (err) {
    console.error(`[db] failed to read credits for user ${req.user.id}:`, err);
    res.status(500).json({ error: 'Failed to read credits' });
  }
});

// Step 3: pick a tier → create a pending order → show bank info + order id.
// `tier` is one of TOPUP_TIERS's keys (the amount in NTD); the credits
// awarded for it are looked up server-side, never taken from the client.
app.post('/api/orders', requireLoginApi, async (req, res) => {
  const tier = TOPUP_TIERS[req.body.tier];
  if (!tier) {
    res.status(400).json({ error: 'invalid_tier', validTiers: Object.keys(TOPUP_TIERS).map(Number) });
    return;
  }
  let order;
  try {
    const id = await createUniqueOrderCode();
    order = await dbCreateOrder({
      id,
      userId: req.user.id,
      amountPaid: tier.amountPaid,
      creditsToAdd: tier.creditsToAdd,
    });
  } catch (err) {
    console.error(`[db] failed to create order for user ${req.user.id}:`, err);
    res.status(500).json({ error: 'Failed to create order' });
    return;
  }
  res.status(200).json({
    id: order.id,
    amountPaid: order.amount_paid,
    creditsToAdd: order.credits_to_add,
    status: order.status,
    bankInfo: BANK_INFO,
    bankAccount: BANK_ACCOUNT_NUMBER,
  });
  // Fire-and-forget, same contract as the last-five notification below — a
  // send failure must never affect the order the response above already
  // confirmed (SPEC: "寄信失敗只 log,不中斷下單").
  sendOrderCreatedEmail({ order, user: req.user }).catch((err) => {
    console.error(`[mail] unexpected failure notifying about new order ${order.id}:`, err);
  });
});

// Step 3/4: host fills in the transfer's last five digits → recorded on the
// order → SPEC step 4's notification email fires. Ownership-scoped by
// dbSetOrderLastFive (WHERE user_id = $2) so a host can't touch another
// user's order by guessing its id.
app.patch('/api/orders/:id/last-five', requireLoginApi, async (req, res) => {
  const { id } = req.params;
  const lastFive = typeof req.body.lastFive === 'string' ? req.body.lastFive.trim() : '';
  if (!/^[0-9]{5}$/.test(lastFive)) {
    res.status(400).json({ error: 'invalid_last_five' });
    return;
  }
  let order;
  try {
    order = await dbSetOrderLastFive(id, req.user.id, lastFive);
  } catch (err) {
    console.error(`[db] failed to record last-five for order ${id}:`, err);
    res.status(500).json({ error: 'Failed to update order' });
    return;
  }
  if (!order) {
    res.status(404).json({ error: 'order_not_found' });
    return;
  }
  res.status(200).json({ id: order.id, status: order.status, lastFive: order.last_five });
  // Email is fire-and-forget and best-effort (SPEC step 4: "寄信失敗只
  // log,不中斷下單") — the response above has already gone out regardless.
  sendOrderNotificationEmail({ order, user: req.user }).catch((err) => {
    console.error(`[mail] unexpected failure notifying about order ${id}:`, err);
  });
});

// Ownership check shared by rename/transcript/retry below (SPEC §3a point
// 6): 404 if the session doesn't exist, 403 if it exists but belongs to
// someone else (or to nobody — a pre-phase-3a session with user_id null,
// which can never equal a real logged-in user's id). Writes the response
// itself on failure, same calling convention as authorizeHost.
async function authorizeSessionOwner(req, res, id) {
  let owner;
  try {
    owner = await dbGetSessionOwner(id);
  } catch (err) {
    console.error(`[db] failed to look up owner of session ${id}:`, err);
    res.status(500).json({ error: 'Failed to look up session' });
    return false;
  }
  if (!owner) {
    res.status(404).json({ error: 'session_not_found' });
    return false;
  }
  if (owner.user_id !== req.user.id) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

// Rename (SPEC §6.5 point 6 / §3a point 5): now gated by session ownership
// instead of the shared host secret — only the user who owns this session
// may rename it.
app.patch('/api/sessions/:id/name', requireLoginApi, async (req, res) => {
  const { id } = req.params;
  if (!(await authorizeSessionOwner(req, res, id))) return;
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const liveSession = sessions.get(id);
  if (liveSession) liveSession.name = name;
  try {
    await dbRenameSession(id, name);
  } catch (err) {
    console.error(`[db] failed to rename session ${id}:`, err);
    res.status(500).json({ error: 'Failed to rename session' });
    return;
  }
  res.status(200).json({ id, name });
});

// Single-session result view (SPEC §6.5 point 5 / §3a point 5) — also used
// by the "my sessions" list page. Ownership-gated: only the owning host can
// read their own transcript (SPEC §3a point 6 / §6 "只有開播的 host 本人可見").
app.get('/api/sessions/:id/transcript', requireLoginApi, async (req, res) => {
  const { id } = req.params;
  if (!(await authorizeSessionOwner(req, res, id))) return;
  let row;
  try {
    row = await dbGetSessionTranscript(id);
  } catch (err) {
    console.error(`[db] failed to read transcript for session ${id}:`, err);
    res.status(500).json({ error: 'Failed to read transcript' });
    return;
  }
  if (!row) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  res.status(200).json({
    id: row.id,
    name: row.name,
    status: row.status,
    processingStatus: row.processing_status,
    cleanedTranscript: row.cleaned_transcript,
  });
});

// Manual retry (SPEC §6.5: "不要讓一次 API 失敗就永久卡死") — re-runs the
// same batch cleanup function used on `ended`. Fire-and-forget: this is a
// slow Claude call, the host polls GET .../transcript for the result.
// Ownership-gated the same way as the endpoints above.
app.post('/api/sessions/:id/transcript/retry', requireLoginApi, async (req, res) => {
  const { id } = req.params;
  if (!(await authorizeSessionOwner(req, res, id))) return;
  let row;
  try {
    row = await dbGetSessionTranscript(id);
  } catch (err) {
    console.error(`[db] failed to read session ${id} for retry:`, err);
    res.status(500).json({ error: 'Failed to read session' });
    return;
  }
  if (!row) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  if (row.status !== 'ended') {
    res.status(400).json({ error: 'session_not_ended' });
    return;
  }
  runTranscriptCleanup(id).catch((err) => {
    console.error(`[transcript-cleanup] retry for session ${id} threw unexpectedly:`, err);
  });
  res.status(202).json({ id, processingStatus: 'processing' });
});

// --- Google login routes (SPEC §3a point 1) --------------------------------

app.get('/auth/google', (req, res, next) => {
  if (!GOOGLE_LOGIN_CONFIGURED) {
    res.status(500).json({ error: 'Google login not configured' });
    return;
  }
  req.session.returnTo = sanitizeReturnTo(req.query.returnTo);
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
  if (!GOOGLE_LOGIN_CONFIGURED) {
    res.status(500).json({ error: 'Google login not configured' });
    return;
  }
  next();
}, (req, res, next) => {
  // Custom callback form (rather than the { failureRedirect } shorthand) so
  // we can tell "not on the allowlist" apart from any other OAuth failure
  // and send each to a message that actually explains what happened — see
  // the verify callback's done(null, false, { reason, email }) above.
  passport.authenticate('google', (err, user, info) => {
    if (err) { next(err); return; }
    if (!user) {
      const reason = (info && info.reason) || 'oauth_failed';
      const params = new URLSearchParams({ reason });
      if (info && info.email) params.set('email', info.email);
      res.redirect(`/login-failed?${params.toString()}`);
      return;
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) { next(loginErr); return; }
      const returnTo = sanitizeReturnTo(req.session.returnTo);
      delete req.session.returnTo;
      res.redirect(returnTo);
    });
  })(req, res, next);
});

app.get('/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) { next(err); return; }
    res.redirect('/');
  });
});

app.get('/vendor/soniox-client.mjs', (req, res) => serveFile(res, VENDOR_CLIENT_SDK));
app.get('/vendor/opencc-cn2t.mjs', (req, res) => serveFile(res, VENDOR_OPENCC));

// Public marketing landing page ("隨時有字幕") — the actual entry point now.
// It carries its own "登入 / 註冊" button straight to /auth/google, so a
// signed-out visitor no longer has to bounce through /host first to find
// login. The old single-page Soniox test page moved to /single (no route
// change to that page itself — still index.html).
app.get('/', (req, res) => serveFile(res, path.join(PUBLIC_DIR, 'landing.html')));
app.get('/single', (req, res) => serveFile(res, path.join(PUBLIC_DIR, 'index.html')));

// Landing spot for a rejected /auth/google/callback (allowlist miss or any
// other OAuth failure) — public, no login, explains what happened instead
// of a bare "login=failed" query string on /host.
app.get('/login-failed', (req, res) => serveFile(res, path.join(PUBLIC_DIR, 'login-failed.html')));

// /host is now open to guests (SPEC guest-mode): a signed-out visitor can
// browse the settings panel and top-up plans without logging in first — only
// pressing Start or actually creating an order requires login (enforced at
// those specific endpoints below: /api/temporary-key, the WS host_start
// handler, /api/orders — all unchanged). Passport's session middleware above
// still runs regardless, so req.user/req.isAuthenticated() are populated
// exactly as before whenever a login cookie IS present; this route just stops
// forcing a redirect when it's absent. /sessions has no guest use (a signed-
// out visitor owns no sessions to list) so it stays fully gated.
app.get('/host', (req, res) => serveFile(res, path.join(PUBLIC_DIR, 'host.html')));
app.get('/sessions', requireLoginPage, (req, res) => serveFile(res, path.join(PUBLIC_DIR, 'sessions.html')));

// Viewer flow stays completely open — no login, ever (SPEC §3a "不要碰的").
app.get('/viewer', (req, res) => serveFile(res, path.join(PUBLIC_DIR, 'viewer.html')));
app.get('/viewer2', (req, res) => serveFile(res, path.join(PUBLIC_DIR, 'viewer2.html')));

// index:false — otherwise express.static would keep auto-serving index.html
// for GET / and silently shadow the landing page route above.
app.use(express.static(PUBLIC_DIR, { index: false }));

const server = http.createServer(app);

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

// ---------------------------------------------------------------------------
// Per-minute billing (SPEC step 6) — the only cost defense once signup is
// open to the public. Lives entirely on the in-memory `session` object
// (billingTimer/billingRate/lowBalanceWarned/disconnectGraceTimer, see
// createSession) so it survives a host WS reconnect untouched: the timer is
// keyed to the session, not to any one WebSocket instance.
// ---------------------------------------------------------------------------

function clearBillingTimer(session) {
  if (session.billingTimer) {
    clearInterval(session.billingTimer);
    session.billingTimer = null;
  }
}

function clearDisconnectGrace(session) {
  if (session.disconnectGraceTimer) {
    clearTimeout(session.disconnectGraceTimer);
    session.disconnectGraceTimer = null;
  }
}

// Ends a session for good — shared by host_end_session (WS), the manual
// "結束本場" safety-net endpoint (POST /api/sessions/:id/end), and the
// long-disconnect sweep (LONG_DISCONNECT_TTL_MS) below. One implementation
// of "end this session", three triggers. Only the in-memory path can
// broadcast to viewers or drain pendingInserts — callers with just a DB row
// (no in-memory session object, e.g. after a server restart) fall back to
// dbMarkSessionEnded directly instead of calling this.
async function endSession(session) {
  clearBillingTimer(session);
  clearDisconnectGrace(session);
  if (session.status === 'ended') return;
  session.status = 'ended';
  session.endedAt = Date.now();
  console.log(`[session ${session.id}] ended`);
  broadcastToViewers(session, { type: 'session_status', status: 'ended', name: session.name });
  session.viewers.clear();
  session.hostWs = null;

  // Batch pipeline (SPEC §6.5/§6): fully decoupled from the realtime path
  // above — draining pendingInserts first closes the race where a line from
  // the very last utterance is still mid-flight when cleanup reads the
  // transcript back (see pushUtterance/pendingInserts).
  await Promise.allSettled(session.pendingInserts);
  try {
    await dbMarkSessionEnded(session.id);
  } catch (err) {
    console.error(`[db] failed to mark session ${session.id} ended:`, err);
  }
  await runTranscriptCleanup(session.id);
}

// Auto-pause (SPEC step 6, the critical one): stop the meter and tell the
// host to stop recording, but touch NOTHING about the session's lifecycle —
// status stays 'live', join_code keeps admitting viewers, viewers' own
// connections are untouched. This is exactly what host.js's own Pause
// button already does server-side (nothing) — the only new part is telling
// the host's browser to actually stop Soniox, since the server can't do
// that itself (audio goes straight from the host's browser to Soniox, never
// through this server).
function autoPauseForInsufficientCredits(session, credits) {
  clearBillingTimer(session);
  console.log(`[billing] session ${session.id} auto-paused — user ${session.userId} out of credits (${credits})`);
  send(session.hostWs, { type: 'force_pause', reason: 'insufficient_credits', credits });
}

function maybeWarnLowBalance(session, credits) {
  if (session.lowBalanceWarned || !session.billingRate) return;
  const minutesRemaining = Math.floor(credits / session.billingRate);
  if (minutesRemaining <= LOW_BALANCE_WARNING_MINUTES) {
    session.lowBalanceWarned = true;
    send(session.hostWs, { type: 'low_balance_warning', credits, minutesRemaining });
  }
}

// Prepay model: charges for the NEXT minute of recording before it happens
// (called once immediately at Start, then once per BILLING_TICK_MS after) —
// this is what makes "見底自動暫停" actually mean *before* running a minute
// the user can't afford, not after. dbChargeCredits's own WHERE credits >=
// amount makes the charge atomic, so this is safe even if somehow called
// concurrently for the same user.
async function chargeNextMinute(session) {
  if (!session.billingRate || !session.userId) return;
  const rate = session.billingRate;
  let newBalance;
  try {
    newBalance = await dbChargeCredits(session.userId, rate);
  } catch (err) {
    // DB down mid-session: unlike most of this app, billing fails CLOSED —
    // this feature's entire job is cost containment, so silently letting
    // recording continue unmetered through an outage would defeat it.
    console.error(`[billing] charge failed for session ${session.id} (user ${session.userId}), pausing:`, err);
    autoPauseForInsufficientCredits(session, null);
    return;
  }
  if (newBalance === null) {
    let credits = null;
    try { credits = await dbGetUserCredits(session.userId); } catch { /* best-effort for the message only */ }
    autoPauseForInsufficientCredits(session, credits ?? 0);
    return;
  }
  dbInsertUsageLedger({
    sessionId: session.id,
    userId: session.userId,
    creditsCharged: rate,
    targetLangCount: session.targetLangs ? session.targetLangs.length : 0,
    balanceAfter: newBalance,
  }).catch((err) => {
    console.error(`[db] failed to record usage_ledger for session ${session.id}:`, err);
  });
  send(session.hostWs, { type: 'credits_update', credits: newBalance });
  maybeWarnLowBalance(session, newBalance);
}

// Called once per successful host_start (see the WS handler below) — starts
// the meter for this recording stint at the rate that was just agreed on.
function startBilling(session, rate) {
  clearBillingTimer(session); // defensive: never let two timers stack on one session
  session.billingRate = rate;
  session.lowBalanceWarned = false;
  chargeNextMinute(session); // pay for the minute that's about to start
  session.billingTimer = setInterval(() => chargeNextMinute(session), BILLING_TICK_MS);
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

  ws.on('message', async (raw) => {
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
        // A host reconnect (network blip) must not be mistaken for "host
        // walked away" — cancel any pending implicit-stop grace timeout from
        // a previous close (see ws.on('close') below and
        // BILLING_DISCONNECT_GRACE_MS), and clear the long-disconnect clock
        // (LONG_DISCONNECT_TTL_MS / sweepStaleSessions) the same way.
        clearDisconnectGrace(session);
        session.hostDisconnectedAt = null;
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
        send(ws, { type: 'session_status', status: session.status, targetLangs: session.targetLangs, name: session.name });
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

    // Host clicked Start (SPEC §4 state machine): created → live, exactly
    // once — a later pause/Start cycle re-sends this while already live, and
    // must NOT reset startedAt or re-fire dbMarkSessionLive.
    //
    // Settings sync (targetLangs/sourceLangs → session object, DB, and the
    // viewer broadcast below), by contrast, runs on EVERY host_start, first
    // or not: pausing to change source/target language and pressing Start
    // again reuses this same session/join_code (SPEC: join_code never
    // changes), so this is the only place that change can ever reach the
    // server, the DB record, and already-connected viewers. Previously this
    // whole block was gated behind the created→live transition, so a
    // mid-session settings change silently never left the host's browser.
    if (role === 'host' && msg.type === 'host_start') {
      if (session.status === 'ended') return; // can't restart an ended session

      // Credit gate (SPEC step 6): computed from what the host is actually
      // about to (re)start with, same formula as /api/temporary-key's own
      // check (creditsPerMinuteFor) so the two never disagree about whether
      // this stint is affordable. A rejection here changes NOTHING about
      // session/targetLangs/DB state — from the session's point of view it's
      // as if Start was never pressed. host.js's own pre-check and the
      // /api/temporary-key 402 are what the host actually sees; this is the
      // backstop that keeps server-side session state consistent with that.
      const wantsTargetLangs = msg.translateEnabled && typeof msg.targetLanguage === 'string'
        ? [msg.targetLanguage]
        : [];
      const rate = creditsPerMinuteFor(wantsTargetLangs.length);
      let credits = null;
      try {
        credits = session.userId ? await dbGetUserCredits(session.userId) : null;
      } catch (err) {
        console.error(`[db] failed to read credits for user ${session.userId}:`, err);
      }
      if (credits === null || credits < rate) {
        console.log(`[billing] session ${session.id} host_start rejected — user ${session.userId} has ${credits ?? 0} credits, needs ${rate}`);
        return;
      }

      // Host clicked Start (SPEC §4 state machine): created → live, exactly
      // once — a later pause/Start cycle re-sends this while already live, and
      // must NOT reset startedAt or re-fire dbMarkSessionLive. A session the
      // server itself auto-paused (SPEC fix "場次沒結束一直掛 live" — see
      // endSession/hostDisconnectedAt and the 'paused' status below) can also
      // resume from here: same reused join_code, but startedAt is untouched
      // since it was never really a fresh session.
      //
      // Settings sync (targetLangs/sourceLangs → session object, DB, and the
      // viewer broadcast below), by contrast, runs on EVERY host_start, first
      // or not: pausing to change source/target language and pressing Start
      // again reuses this same session/join_code (SPEC: join_code never
      // changes), so this is the only place that change can ever reach the
      // server, the DB record, and already-connected viewers. Previously this
      // whole block was gated behind the created→live transition, so a
      // mid-session settings change silently never left the host's browser.
      const firstStart = session.status === 'created';
      const resumingFromPause = session.status === 'paused';
      session.hostDisconnectedAt = null; // host is clearly back, whatever the long-TTL sweep thought
      if (firstStart) {
        session.status = 'live';
        session.startedAt = Date.now();
        console.log(`[session ${session.id}] live`);
      } else if (resumingFromPause) {
        session.status = 'live';
        console.log(`[session ${session.id}] resumed from paused`);
      }
      // What the host actually chose, for viewers (session_status, read at
      // join time AND on every subsequent broadcast — see targetLangs
      // comment on the session object) and for the DB record (SPEC §6.5).
      session.targetLangs = wantsTargetLangs;
      broadcastToViewers(session, { type: 'session_status', status: 'live', targetLangs: session.targetLangs, name: session.name });
      if (firstStart) {
        dbMarkSessionLive(session.id).catch((err) => {
          console.error(`[db] failed to mark session ${session.id} live:`, err);
        });
      } else if (resumingFromPause) {
        dbMarkSessionResumed(session.id).catch((err) => {
          console.error(`[db] failed to mark session ${session.id} resumed:`, err);
        });
      }
      // sourceLangs is host.js's language_hints selection (['auto'] or a
      // list of codes — see currentSourceLangSelection there); record-only,
      // same as targetLangs above — falls back to ['auto'] for a malformed
      // message rather than silently recording nothing.
      const sourceLangs = Array.isArray(msg.sourceLangs) && msg.sourceLangs.length ? msg.sourceLangs : ['auto'];
      dbSetSessionLanguages(session.id, { sourceLangs, targetLangs: session.targetLangs }).catch((err) => {
        console.error(`[db] failed to record language settings for session ${session.id}:`, err);
      });
      startBilling(session, rate);
      return;
    }

    // New (SPEC step 6): host clicked Pause — mirrors host_start's role for
    // billing. Doesn't touch session.status/history/viewers at all (that's
    // the whole point of Pause — see host.js), only stops the meter so a
    // paused session never keeps getting charged for audio that stopped.
    if (role === 'host' && msg.type === 'host_stop') {
      clearBillingTimer(session);
      return;
    }

    // Host explicitly ends the session (not the same as Pause/Stop, which
    // only stops the mic — see host.js). live/created/paused → ended,
    // permanently: the join_code stops admitting anyone from this point on.
    // endSession() runs synchronously up to its first await (status flip +
    // broadcast + clearing viewers/hostWs), so that part still happens
    // immediately from this handler's point of view — only the DB
    // update + transcript cleanup tail runs in the background, uncaught
    // here on purpose (errors are already logged inside endSession itself).
    if (role === 'host' && msg.type === 'host_end_session') {
      endSession(session).catch((err) => {
        console.error(`[session ${session.id}] endSession failed:`, err);
      });
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
      // A dropped app WS does NOT by itself mean recording stopped — Soniox
      // audio goes straight from the host's browser to Soniox, independent
      // of this connection, and host.js's own reconnect (≤10s backoff) will
      // usually re-register long before this fires. Only treat it as "host
      // actually left" (closed the tab, lost power) after a real grace
      // period with no reconnect — see BILLING_DISCONNECT_GRACE_MS.
      //
      // SPEC fix ("場次沒結束一直掛 live"): this used to only run — and only
      // ever stop billing — when session.billingTimer was already set, so a
      // host who paused (billingTimer null) and then closed the tab left the
      // session live forever, with no grace timer ever scheduled at all.
      // Now it always runs for a live/paused session regardless of billing
      // state, and on timeout also flips the session to 'paused' (not
      // ended — a network blip or a host who'll be right back shouldn't lose
      // the join_code) so it stops looking permanently live to viewers and
      // to the 字幕場次 list. hostDisconnectedAt feeds the separate, much
      // longer LONG_DISCONNECT_TTL_MS sweep for a session that's truly been
      // abandoned, not just paused.
      if (session.status === 'live' || session.status === 'paused') {
        session.hostDisconnectedAt = Date.now();
        clearDisconnectGrace(session); // just in case one was already pending
        session.disconnectGraceTimer = setTimeout(() => {
          session.disconnectGraceTimer = null;
          if (session.hostWs) return; // reconnected in the meantime after all
          clearBillingTimer(session);
          if (session.status === 'live') {
            session.status = 'paused';
            console.log(`[session ${session.id}] host never reconnected within grace period — auto-paused`);
            broadcastToViewers(session, { type: 'session_status', status: 'paused', targetLangs: session.targetLangs, name: session.name });
            dbMarkSessionPaused(session.id).catch((err) => {
              console.error(`[db] failed to mark session ${session.id} paused:`, err);
            });
          }
        }, BILLING_DISCONNECT_GRACE_MS);
      }
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
