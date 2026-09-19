import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { WebSocketServer, WebSocket } from 'ws';
import { attachAudioRelay } from './audio-relay.js';
import { LANGUAGES } from './public/languages.js';
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
  dbChargeSessionMinute,
  dbCreateOrder,
  dbSetOrderLastFive,
  dbGetOrder,
  dbMarkSessionPaused,
  dbMarkSessionResumed,
  dbRecoverSessions, dbGetRecentTranscript, dbCommitTranscript, dbMarkTranscriptWarning,
  dbGetRawTranscript, dbExpireTranscripts, dbSetHistoryBoundary, dbGetAudioMeter, dbSaveAudioMeter, dbGetBillingHistory,
  dbCreateTourGroup,dbGetTourGroupsByUser,dbGetTourGroupsForRouting,dbGetTourGroup,dbRenameTourGroup,dbCreateTourSession,dbCloseTourGroup,dbRotateTourGroup,
} from './db.js';
import { runTranscriptCleanup, startCleanupWorker } from './transcript-cleanup.js';
import { sendOrderNotificationEmail, sendOrderCreatedEmail } from './mail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;

if (!process.env.SONIOX_API_KEY) {
  console.error('Missing SONIOX_API_KEY. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Soniox credentials stay in the server-side audio relay.

const PUBLIC_DIR = path.join(__dirname, 'public');
const VENDOR_CLIENT_SDK = path.join(__dirname, 'node_modules', '@soniox', 'client', 'dist', 'index.mjs');
const VENDOR_OPENCC = path.join(__dirname, 'node_modules', 'opencc-js', 'dist', 'esm', 'cn2t.js');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

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
const LOW_BALANCE_WARNING_MINUTES = 10;
const BILLING_DISCONNECT_GRACE_MS = 90 * 1000;

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
// in/register (a fresh one starting at credits = 50, upsert logic unchanged)
// and LOGIN_ALLOWLIST below is never consulted. Deliberately NOT the
// default — flip this on only after the credit gate + auto-pause (SPEC step
// 6) has been verified working, per the ordering note in .env.example: this
// is the door, the credit gate is the lock, and the lock has to already be
// installed before the door opens.
const OPEN_SIGNUP = process.env.OPEN_SIGNUP === 'true';
// Temporary early access. Future plans can grant the same feature through
// a membership entitlement without changing the tour/session data model.
const TOUR_EARLY_ACCESS_EMAILS = parseAllowlist(process.env.TOUR_EARLY_ACCESS_EMAILS);
function canCreateFixedTours(user){return Boolean(user?.email && TOUR_EARLY_ACCESS_EMAILS.has(user.email.trim().toLowerCase()));}
function requireFixedTourAccess(req,res,next){
  if(!canCreateFixedTours(req.user))return res.status(403).json({error:'fixed_tours_not_enabled'});
  next();
}
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
//   - `id`: internal, never appears
//     in a public URL. The host page gets it once, straight from an
//     authenticated POST /api/sessions response, and uses it only over its
//     own WebSocket registration — never rendered into the QR/viewer link.
//   - `joinCode`: the public, capability-based ticket. Anyone holding it can
//     watch; it's what goes in the QR code and the viewer URL.
// ---------------------------------------------------------------------------
export const sessions = new Map();           // id -> session
const sessionsByJoinCode = new Map(); // joinCode -> id
const tourGroupsByCode = new Map();
const tourGroupsById = new Map();
const invalidViewerCodes = new Map();
function rejectedViewerCode(req,ws){
  const key=req.socket.remoteAddress||'unknown',now=Date.now();
  const old=invalidViewerCodes.get(key);
  const entry=old&&now-old.since<60_000?old:{since:now,count:0};
  entry.count++;invalidViewerCodes.set(key,entry);
  if(entry.count>60){send(ws,{type:'register_error',reason:'too_many_attempts'});ws.close(1008);return;}
  send(ws,{type:'register_error',reason:'invalid_code'});
}
function rememberTourGroup(row){
  const group={id:row.id,userId:row.user_id,name:row.name,code:row.code,status:row.status,
    activeSessionId:row.active_session_id,viewers:new Set()};
  tourGroupsById.set(group.id,group);
  tourGroupsByCode.set(group.code,group);
  return group;
}
function tourShare(req,group){
  return {id:group.id,name:group.name,code:group.code,status:group.status,
    activeSessionId:group.activeSessionId,viewerUrl:getOrigin(req)+'/live?code='+group.code};
}
function notifyTourViewers(group,room){
  for(const ws of group.viewers){
    if(ws.roomSessionId)sessions.get(ws.roomSessionId)?.viewers.delete(ws);
    ws.roomSessionId=room?.id||null;
    if(room)room.viewers.add(ws);
    send(ws,{type:'viewer_registered',sessionId:room?.id||null});
    send(ws,{type:'session_status',status:room?.status||'waiting',name:room?.name||group.name,targetLangs:room?.targetLangs||null});
    if(room && ['live','paused'].includes(room.status))send(ws,{type:'backfill',utterances:room.history.slice(-BACKFILL_COUNT)});
  }
  if(room)sendViewerCount(room);
}

const JOIN_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/i/l — avoids read-aloud ambiguity
const JOIN_CODE_LENGTH = 6;

function generateJoinCode() {
  const bytes = crypto.randomBytes(JOIN_CODE_LENGTH);
  let s = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) s += JOIN_CODE_ALPHABET[bytes[i] % JOIN_CODE_ALPHABET.length];
  return s;
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
function createSession(userId, row = null) {
  const id = row?.id || crypto.randomUUID();
  const joinCode = row?.join_code || createUniqueJoinCode();
  const session = {
    id,
    joinCode,
    name: row?.name || null,
    tourGroupId:row?.tour_group_id||null,
    status: row?.status || 'created',
    transcriptWarning: Boolean(row?.transcript_warning),
    displayAfterSeq: Number(row?.display_after_seq || 0),
    // Owning user (SPEC step 6): who to charge/credit-check for this
    // session's per-minute billing. Always set — every session now requires
    // login to create (see POST /api/sessions) — but kept nullable-safe
    // throughout the billing helpers below in case an old in-memory session
    // somehow predates this field.
    userId: userId || null,
    // Actual audio metering belongs to the authenticated relay.
    audioRelay: null,
    audioMeterStates: {},
    billingRate: null,
    lowBalanceWarned: false,
    disconnectGraceTimer: null,
    // Set the instant a host WS disconnects while this session is
    // live/paused; cleared back to null the instant a host WS reconnects
    // (register handler). Distinct from disconnectGraceTimer's short
    // BILLING_DISCONNECT_GRACE_MS window (network blip vs. billing) — this is
    // what the long-TTL sweep below measures "how long has host actually
    // been gone" against, independent of whether that short grace timer has
    // fired yet.
    hostDisconnectedAt: row ? Date.now() : null,
    // null = host hasn't clicked Start yet (unknown); [] = pure transcription
    // (translation off); [lang] = one_way translation to `lang`. Set once at
    // audio connection config; updated when provider confirms first audio.
    // Viewers read this (via session_status) to decide their layout at join
    // time, without waiting for/guessing from actual utterance content.
    targetLangs: row?.target_langs || null,
    hostWs: null,
    viewers: new Set(),
    history: [],   // oldest → newest, capped at HISTORY_MAX
    nextId: Number(row?.next_seq || 1),
    createdAt: row ? new Date(row.created_at).getTime() : Date.now(),
    startedAt: row?.started_at ? new Date(row.started_at).getTime() : null,
    endedAt: row?.ended_at ? new Date(row.ended_at).getTime() : null,
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
      if(session.tourGroupId){const group=tourGroupsById.get(session.tourGroupId);
        if(group?.activeSessionId===id){group.activeSessionId=null;notifyTourViewers(group,null);}}
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
export const sessionStore = pool ? new PgSessionStore({ pool, tableName: 'user_sessions', createTableIfMissing: true }) : new session.MemoryStore();
const sessionMiddleware = session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
});
app.use(sessionMiddleware);
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

// Retired: browsers never receive provider credentials, even after login.
app.post('/api/temporary-key', requireLoginApi, (req, res) => {
  res.status(410).json({ error: '請重新整理頁面，使用新的字幕場次開播流程' });
});

// Creates a new session (SPEC §2/§4): generates the internal id + public
// join_code, in status `created`, owned by the logged-in user (SPEC §3a
// point 3 — this replaces the old shared host-secret gate for this one
// endpoint; see requireLoginApi above).
// Fixed tour entrances: owner-gated management, guest-readable link only.
app.get('/api/tours',requireLoginApi,async(req,res)=>{
  try{
    const rows=await dbGetTourGroupsByUser(req.user.id);
    res.json(rows.map(row=>({...tourShare(req,{id:row.id,name:row.name,code:row.code,status:row.status,activeSessionId:row.active_session_id}),activeStatus:row.active_status,createdAt:row.created_at})));
  }catch(error){console.error('[tour] list:',error.message);res.status(503).json({error:'固定入口暫時無法讀取'});}
});
app.post('/api/tours',requireLoginApi,requireFixedTourAccess,async(req,res)=>{
  const name=typeof req.body?.name==='string'?req.body.name.trim():'';
  if(!name||name.length>80)return res.status(400).json({error:'請填寫 1–80 字的團名'});
  try{
    let row;
    for(let attempt=0;attempt<5;attempt++){
      const code=Array.from(crypto.randomBytes(8),byte=>JOIN_CODE_ALPHABET[byte%JOIN_CODE_ALPHABET.length]).join('');
      try{row=await dbCreateTourGroup({id:crypto.randomUUID(),userId:req.user.id,name,code});break;}
      catch(error){if(error.code!=='23505')throw error;}
    }
    if(!row)throw new Error('code_generation_failed');
    const group=rememberTourGroup(row),shared=tourShare(req,group);
    res.status(201).json({...shared,qrDataUrl:await QRCode.toDataURL(shared.viewerUrl,{margin:1,width:320})});
  }catch(error){console.error('[tour] create:',error.message);res.status(503).json({error:'建立固定入口失敗，請稍後重試'});}
});
app.get('/api/tours/:id/qr',requireLoginApi,async(req,res)=>{
  try{const row=await dbGetTourGroup(req.params.id,req.user.id);
    if(!row)return res.status(404).end();
    const url=getOrigin(req)+'/live?code='+row.code;
    res.set('Cache-Control','no-store').type('png').send(await QRCode.toBuffer(url,{margin:1,width:320}));
  }catch(error){console.error('[tour] qr:',error.message);res.status(503).end();}
});
app.patch('/api/tours/:id/name',requireLoginApi,async(req,res)=>{
  const name=typeof req.body?.name==='string'?req.body.name.trim():'';
  if(!name||name.length>80)return res.status(400).json({error:'請填寫 1–80 字的團名'});
  try{const row=await dbRenameTourGroup(req.params.id,req.user.id,name);
    if(!row)return res.status(404).json({error:'固定入口不存在或已關閉'});
    const group=tourGroupsById.get(row.id);if(group)group.name=name;
    res.json({id:row.id,name});
  }catch(error){console.error('[tour] rename:',error.message);res.status(503).json({error:'更名失敗'});}
});
app.post('/api/tours/:id/sessions',requireLoginApi,requireFixedTourAccess,async(req,res)=>{
  const name=typeof req.body?.name==='string'?req.body.name.trim():'';
  if(!name||name.length>80)return res.status(400).json({error:'請填寫 1–80 字的場次名稱'});
  try{
    let row;
    for(let attempt=0;attempt<5;attempt++){
      const id=crypto.randomUUID(),joinCode=createUniqueJoinCode();
      try{row=await dbCreateTourSession({id,userId:req.user.id,groupId:req.params.id,joinCode,name});break;}
      catch(error){if(error.code!=='23505')throw error;}
    }
    if(!row)throw new Error('code_generation_failed');
    const group=tourGroupsById.get(req.params.id);
    if(!group)throw new Error('tour_runtime_missing');
    const room=createSession(req.user.id,row);
    group.activeSessionId=room.id;
    notifyTourViewers(group,room);
    res.status(201).json({id:room.id,groupId:group.id,name:room.name,hostUrl:'/host?id='+room.id,viewerUrl:getOrigin(req)+'/live?code='+group.code});
  }catch(error){
    if(error.message==='tour_session_active')return res.status(409).json({error:'請先結束目前場次'});
    if(error.message==='tour_not_found'||error.message==='tour_closed')return res.status(404).json({error:'固定入口不存在或已關閉'});
    console.error('[tour] new session:',error.message);res.status(503).json({error:'建立團體場次失敗，請稍後重試'});
  }
});
app.post('/api/tours/:id/rotate',requireLoginApi,async(req,res)=>{
  try{
    let row;
    for(let attempt=0;attempt<5;attempt++){
      const code=Array.from(crypto.randomBytes(8),byte=>JOIN_CODE_ALPHABET[byte%JOIN_CODE_ALPHABET.length]).join('');
      try{row=await dbRotateTourGroup(req.params.id,req.user.id,code);break;}
      catch(error){if(error.code!=='23505')throw error;}
    }
    if(!row)return res.status(404).json({error:'固定入口不存在'});
    const group=tourGroupsById.get(row.id);
    if(group){tourGroupsByCode.delete(group.code);group.code=row.code;tourGroupsByCode.set(group.code,group);
      for(const viewer of group.viewers){send(viewer,{type:'session_status',status:'closed',name:group.name});viewer.close(1008);}
      group.viewers.clear();}
    const shared=tourShare(req,group||{id:row.id,name:row.name,code:row.code,status:row.status,activeSessionId:row.active_session_id});
    res.json(shared);
  }catch(error){
    if(error.message==='tour_session_active')return res.status(409).json({error:'請先結束目前場次'});
    if(error.message==='tour_closed')return res.status(409).json({error:'固定入口已關閉'});
    console.error('[tour] rotate:',error.message);res.status(503).json({error:'更換固定碼失敗'});
  }
});
app.post('/api/tours/:id/close',requireLoginApi,async(req,res)=>{
  try{const row=await dbCloseTourGroup(req.params.id,req.user.id);
    if(!row)return res.status(404).json({error:'固定入口不存在'});
    const group=tourGroupsById.get(row.id);
    if(group){group.status='closed';group.activeSessionId=null;
      for(const ws of group.viewers)send(ws,{type:'session_status',status:'closed',name:group.name});}
    res.json({id:row.id,status:'closed'});
  }catch(error){if(error.message==='tour_session_active')return res.status(409).json({error:'請先結束目前場次'});
    console.error('[tour] close:',error.message);res.status(503).json({error:'關閉固定入口失敗'});}
});

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
    sessions.delete(session.id); sessionsByJoinCode.delete(session.joinCode);
    return res.status(503).json({error:'場次保存失敗，請稍後重試'});
  }
  const viewerUrl = `${getOrigin(req)}/live?code=${session.joinCode}`;
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
      tourGroupId:row.tour_group_id,
      expiresAt: row.expires_at, transcriptExpired: Boolean(row.transcript_expired_at || (row.expires_at && new Date(row.expires_at)<=new Date())), transcriptWarning: row.transcript_warning,
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
  const sharedCode=row.tour_group_id?(await dbGetTourGroup(row.tour_group_id,req.user.id))?.code:row.join_code;
  if(!sharedCode)return res.status(503).json({error:'固定入口暫時無法讀取'});
  const viewerUrl = getOrigin(req)+'/live?code='+sharedCode;
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(viewerUrl, { margin: 1, width: 320 });
  } catch (err) {
    console.error('QR code generation failed:', err);
  }
  res.status(200).json({ id: row.id, joinCode: sharedCode, tourGroupId:row.tour_group_id, name: row.name, status: row.status, viewerUrl, qrDataUrl });
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
  if(liveSession?.tourGroupId){const group=tourGroupsById.get(liveSession.tourGroupId);
    if(group?.activeSessionId===id){group.activeSessionId=null;notifyTourViewers(group,null);}}
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
  if(req.body?.transcriptIncomplete) await dbMarkTranscriptWarning(id);
  const liveSession = sessions.get(id);
  try {
    if (liveSession) {
      await endSession(liveSession); // updates memory + DB + broadcasts + cleanup
    } else {
      await dbMarkSessionEnded(id);
      const groupId=(await dbGetSessionById(id))?.tour_group_id;
      if(groupId){const group=tourGroupsById.get(groupId);if(group?.activeSessionId===id){group.activeSessionId=null;notifyTourViewers(group,null);}}
      await runTranscriptCleanup(id);
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
  res.status(200).json({ id: req.user.id, email: req.user.email, name: req.user.name, features:{fixedTours:canCreateFixedTours(req.user)} });
});

// --- Credits / top-up (SPEC steps 3/6) --------------------------------------

// Host.js polls this before ever attempting Start (SPEC step 6 "開場預
// 檢") — display only; the server-side audio relay enforces the balance.
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
// itself on failure, with an explicit response on failure.
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
    expiresAt: row.expires_at, transcriptExpired: Boolean(row.transcript_expired_at || (row.expires_at && new Date(row.expires_at)<=new Date())), transcriptWarning: row.transcript_warning,
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
  if (row.transcript_expired_at || (row.expires_at && new Date(row.expires_at)<=new Date())) return res.status(410).json({error:"逐字稿已到期刪除"});
  try { await runTranscriptCleanup(id); } catch (err) { return res.status(503).json({error:'無法排入整理，請稍後重試'}); }
  res.status(202).json({ id, processingStatus: 'processing' });
});


app.get('/api/sessions/:id/transcript/raw',requireLoginApi,async(req,res)=>{
  const {id}=req.params;
  if(!(await authorizeSessionOwner(req,res,id)))return;
  const row=await dbGetSessionTranscript(id);
  if(!row)return res.status(404).json({error:'session_not_found'});
  if(row.transcript_expired_at || (row.expires_at && new Date(row.expires_at)<=new Date())) return res.status(410).json({error:'逐字稿已到期刪除'});
  const lines=await dbGetRawTranscript(id);
  res.setHeader('Content-Type','text/plain; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="transcript-raw.txt"');
  res.setHeader('Cache-Control','no-store');
  res.send((row.transcript_warning?'注意：本場曾發生字幕保存或補送異常，原稿可能不完整。\n\n':'')+lines.map(line=>line.original_text).join('\n'));
});
app.get('/api/billing',requireLoginApi,async(req,res)=>res.json(await dbGetBillingHistory(req.user.id)));
app.get('/api/service-info',(req,res)=>res.json({supportEmail:process.env.SUPPORT_EMAIL||'subtiitw@gmail.com',topupResponse:'下一個工作日內確認入帳',retentionDays:30}));
app.get('/billing',requireLoginPage,(req,res)=>serveFile(res,path.join(PUBLIC_DIR,'billing.html')));
app.get('/privacy',(req,res)=>serveFile(res,path.join(PUBLIC_DIR,'privacy.html')));

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
// login. The legacy /single recorder is retired and redirects to sessions.
app.get('/', (req, res) => serveFile(res, path.join(PUBLIC_DIR, 'landing.html')));
app.get(['/single', '/index.html'], (req, res) => res.redirect('/sessions'));
app.get('/app.js', (req, res) => res.status(410).send('Legacy recording entry retired'));

// Landing spot for a rejected /auth/google/callback (allowlist miss or any
// other OAuth failure) — public, no login, explains what happened instead
// of a bare "login=failed" query string on /host.
app.get('/login-failed', (req, res) => serveFile(res, path.join(PUBLIC_DIR, 'login-failed.html')));

// /host is now open to guests (SPEC guest-mode): a signed-out visitor can
// browse the settings panel and top-up plans without logging in first — only
// pressing Start or actually creating an order requires login (enforced at
// the authenticated audio relay and session APIs below.
// handler, /api/orders — all unchanged). Passport's session middleware above
// still runs regardless, so req.user/req.isAuthenticated() are populated
// exactly as before whenever a login cookie IS present; this route just stops
// forcing a redirect when it's absent. /sessions has no guest use (a signed-
// out visitor owns no sessions to list) so it stays fully gated.
app.get('/host', (req, res) => {
  if (req.isAuthenticated() && !req.query.id) return res.redirect('/sessions');
  serveFile(res, path.join(PUBLIC_DIR, 'host.html'));
});
app.get('/sessions', requireLoginPage, (req, res) => serveFile(res, path.join(PUBLIC_DIR, 'sessions.html')));

// Viewer flow stays completely open — no login, ever (SPEC §3a "不要碰的").
app.get('/live', (req, res) => serveFile(res, path.join(PUBLIC_DIR, 'viewer2.html')));
// Preserve the room code in previously shared links and QR codes.
app.get(['/viewer', '/viewer.html', '/viewer2', '/viewer2.html'], (req, res) => {
  const query = new URL(req.originalUrl, 'http://localhost').search;
  res.redirect(308, '/live' + query);
});

// index:false — otherwise express.static would keep auto-serving index.html
// for GET / and silently shadow the landing page route above.
app.use(express.static(PUBLIC_DIR, { index: false }));

export const server = http.createServer(app);

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

async function pushUtterance(session,msg,ws) {
  if(typeof msg.clientMessageId!=='string'||msg.clientMessageId.length>80||!msg.clientMessageId||typeof msg.original!=='string'||msg.original.length>12000||!msg.original.trim())return;
  const ts=Number(msg.ts);
  if(!Number.isFinite(ts)||ts>Date.now()+60_000||Date.now()-ts>5*60_000){
    session.transcriptWarning=true;
    await dbMarkTranscriptWarning(session.id);
    send(ws,{type:'utterance_rejected',clientMessageId:msg.clientMessageId});return;
  }
  const translations={};
  for(const [lang,text] of Object.entries(msg.translations||{})){
    if(/^[a-z]{2,3}$/.test(lang)&&typeof text==='string'&&text.length<=12000)translations[lang]=text;
  }
  try{
    const result=await dbCommitTranscript(session.id,{...msg,ts,translations});
    const row=result.row;
    const utterance={type:'utterance',id:Number(row.seq),ts:new Date(row.ts).getTime(),original:row.original_text,translations:row.translations};
    if(result.inserted){
      session.nextId=Math.max(session.nextId,utterance.id+1);
      session.history.push(utterance);
      if(session.history.length>HISTORY_MAX)session.history.shift();
      broadcastToViewers(session,utterance);
    }
    if(session.transcriptWarning)await dbMarkTranscriptWarning(session.id);
    send(ws,{type:'utterance_ack',clientMessageId:msg.clientMessageId});
  }catch(error){
    session.transcriptWarning=true;
    await dbMarkTranscriptWarning(session.id).catch(()=>{});
    send(ws,{type:'transcript_warning',message:'字幕尚未保存，正在補送；請先不要關閉頁面。'});
  }
}

// ---------------------------------------------------------------------------
// Audio usage is metered by the server-side relay, never a host message.
// ---------------------------------------------------------------------------
function stopSessionAudio(session) {
  session.audioRelay?.close();
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
  stopSessionAudio(session);
  clearDisconnectGrace(session);
  if (session.status === 'ended') return;
  await Promise.allSettled(session.pendingInserts);
  await dbMarkSessionEnded(session.id);
  session.status = 'ended';
  session.endedAt = Date.now();
  if(session.tourGroupId){const group=tourGroupsById.get(session.tourGroupId);
    if(group?.activeSessionId===session.id){group.activeSessionId=null;notifyTourViewers(group,null);}}
  console.log(`[session ${session.id}] ended`);
  broadcastToViewers(session, { type: 'session_status', status: 'ended', name: session.name });
  session.viewers.clear();
  session.hostWs = null;

  // Batch pipeline (SPEC §6.5/§6): fully decoupled from the realtime path
  // above — draining pendingInserts first closes the race where a line from
  // the very last utterance is still mid-flight when cleanup reads the
  // transcript back (see pushUtterance/pendingInserts).
  await Promise.allSettled(session.pendingInserts);

  await runTranscriptCleanup(session.id).catch(error=>console.error('[cleanup] queue will recover on restart:',error.message));
}

function maybeWarnLowBalance(session, credits) {
  if (session.lowBalanceWarned || !session.billingRate) return;
  const minutesRemaining = Math.floor(credits / session.billingRate);
  if (minutesRemaining <= LOW_BALANCE_WARNING_MINUTES) {
    session.lowBalanceWarned = true;
    send(session.hostWs, { type: 'low_balance_warning', credits, minutesRemaining });
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const audioWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
const activeAudioUsers = new Map();
const audioAttempts = new Map();
const supportedLanguages = new Set(LANGUAGES.map((language) => language.code));

// A browser can only open our sockets from this site's origin. Google login
// is resolved from the signed, httpOnly session cookie during the upgrade.
server.on('upgrade', async (req, socket, head) => {
  socket.on('error', () => {});
  const reject = (status) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 ' + status + ' Rejected\r\nConnection: close\r\n\r\n');
  };
  try {
    if (req.headers.origin !== getOrigin(req)) return reject(403);
    const url = new URL(req.url, 'http://localhost');
    if (!['/', '/audio'].includes(url.pathname)) return reject(404);
    await new Promise((resolve, reject) => {
      const res = new http.ServerResponse(req);
      sessionMiddleware(req, res, (err) => err ? reject(err) : resolve());
    });
    const userId = req.session?.passport?.user;
    req.authUserId = userId && await dbGetUserById(userId) ? userId : null;
    if (socket.destroyed) return;
    if (url.pathname === '/audio') {
      const room = sessions.get(url.searchParams.get('sessionId'));
      if (!req.authUserId) return reject(401);
      if (!room || room.userId !== req.authUserId || room.status === 'ended') return reject(403);
      if (!room.hostWs || room.hostWs.readyState !== WebSocket.OPEN) return reject(409);
      if (activeAudioUsers.has(req.authUserId)) return reject(409);
      const now = Date.now();
      for (const [key, value] of audioAttempts) if (now - value.since > 60_000) audioAttempts.delete(key);
      const attempts = audioAttempts.get(req.authUserId) || { since: now, count: 0 };
      if (++attempts.count > 10) return reject(429);
      audioAttempts.set(req.authUserId, attempts);
      // handleUpgrade is synchronous here (no verifyClient callback). Claim
      // only after a valid handshake so malformed requests cannot strand a slot.
      audioWss.handleUpgrade(req, socket, head, (ws) => {
        activeAudioUsers.set(req.authUserId, room.id);
        audioWss.emit('connection', ws, room);
      });
    } else {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }
  } catch (err) {
    console.error('[ws] upgrade failed:', err.message);
    reject(503);
  }
});

audioWss.on('connection', (ws, room) => {
  room.audioMeterStates ||= {};
  room.lowBalanceWarned = false;
  const relay = attachAudioRelay(ws, {
    apiKey: process.env.SONIOX_API_KEY,
    languages: supportedLanguages,
    meterStates: room.audioMeterStates,
    getCredits: () => dbGetUserCredits(room.userId),
    loadMeter: rate => dbGetAudioMeter(room.id,rate),
    saveMeter: (rate,state) => dbSaveAudioMeter(room.id,rate,state),
    charge: async (rate,minute) => {
      room.billingRate = rate;
      const balance = await dbChargeSessionMinute(room.userId, room.id, rate, minute);
      if (balance !== null) {
        send(room.hostWs, { type: 'credits_update', credits: balance });
        maybeWarnLowBalance(room, balance);
      }
      return balance;
    },
    onStarted: async (config) => {
      if (room.status === 'ended') return;
      const firstStart = !room.startedAt;
      room.status = 'live';
      room.startedAt ||= Date.now();
      room.targetLangs = config.translation ? [config.translation.target_language] : [];
      broadcastToViewers(room, { type: 'session_status', status: 'live', targetLangs: room.targetLangs, name: room.name });
      send(room.hostWs, { type: 'recording_started' });
      await (firstStart ? dbMarkSessionLive(room.id) : dbMarkSessionResumed(room.id));
      await dbSetSessionLanguages(room.id, { sourceLangs: config.language_hints || ['auto'], targetLangs: room.targetLangs });
    },
    onStopped: () => {
      if (room.audioRelay === relay) room.audioRelay = null;
      activeAudioUsers.delete(room.userId);
      // Keep live during final text delivery. A new relay cancels this pause.
      setTimeout(() => {
        if (room.audioRelay || room.status !== 'live') return;
        room.status = 'paused';
        broadcastToViewers(room, { type: 'session_status', status: 'paused', targetLangs: room.targetLangs, name: room.name });
        dbMarkSessionPaused(room.id).catch((err) => console.error('[db] pause failed:', err));
      }, 1000).unref();
    },
    onInsufficient: (credits) => send(room.hostWs, { type: 'force_pause', reason: 'insufficient_credits', credits }),
  });
  room.audioRelay = relay;
});

// Heartbeat: some networks (mobile wifi handoffs, NAT idle timeouts) drop a
// connection one-sidedly without ever sending a TCP FIN/RST, so the browser's
// WebSocket never fires onclose and just sits there looking "connected" while
// actually dead. Pinging every 15s and terminating anyone that didn't pong
// since the last check forces a real close, which triggers the client's
// existing reconnect logic.
const HEARTBEAT_INTERVAL = 15000;

wss.on('connection', (ws, req) => {
  ws.on('error', () => ws.terminate());
  let role = null;
  let sessionId = null; // host room or viewer room at initial registration
  let tourGroupId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let messageChain=Promise.resolve();
  ws.on('message',raw=>{
    messageChain=messageChain.then(()=>handleMessage(raw)).catch(error=>{
      console.error('[ws] message:',error.message);
      send(ws,{type:'transcript_warning',message:'保存暫時失敗，請保持頁面開啟等待重試。'});
    });
  });
  async function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

    if (msg.type === 'register') {
      if (role) return; // one socket cannot change roles or rooms
      if (msg.role === 'host') {
        const session = typeof msg.sessionId === 'string' ? sessions.get(msg.sessionId) : null;
        if (!session) {
          send(ws, { type: 'register_error', reason: 'session_not_found' });
          return;
        }
        if (!req.authUserId || session.userId !== req.authUserId || (session.status === 'ended' && Date.now()-session.endedAt>5*60_000)) {
          send(ws, { type: 'register_error', reason: 'not_authorized' });
          return;
        }
        if (session.hostWs && session.hostWs !== ws && session.hostWs.readyState === WebSocket.OPEN) {
          send(ws, { type: 'register_error', reason: 'host_already_connected' });
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
        send(ws, { type: 'host_registered', transcriptWarning:session.transcriptWarning });
      } else if (msg.role === 'viewer') {
        const requestedCode=typeof msg.joinCode==='string'?msg.joinCode.trim().toLowerCase():'';
        const group=tourGroupsByCode.get(requestedCode);
        if(group){
          role='viewer';tourGroupId=group.id;group.viewers.add(ws);
          if(group.status==='closed'){
            send(ws,{type:'viewer_registered',sessionId:null});
            send(ws,{type:'session_status',status:'closed',name:group.name});return;
          }
          const active=group.activeSessionId?sessions.get(group.activeSessionId):null;
          ws.roomSessionId=active?.id||null;
          if(active){active.viewers.add(ws);sendViewerCount(active);}
          send(ws,{type:'viewer_registered',sessionId:active?.id||null});
          send(ws,{type:'session_status',status:active?.status||'waiting',targetLangs:active?.targetLangs||null,name:active?.name||group.name});
          if(active && ['live','paused'].includes(active.status))send(ws,{type:'backfill',utterances:active.history.slice(-BACKFILL_COUNT)});
          return;
        }
        const targetId = sessionsByJoinCode.get(requestedCode);
        const session = targetId ? sessions.get(targetId) : null;
        if (!session) {
          rejectedViewerCode(req,ws);
          return;
        }
        role = 'viewer';
        sessionId = session.id;
        ws.roomSessionId=session.id;
        session.viewers.add(ws);
        console.log(`[viewer+] session=${session.id} total=${session.viewers.size}`);
        sendViewerCount(session);
        send(ws,{type:'viewer_registered',sessionId:session.id});
        send(ws, { type: 'session_status', status: session.status, targetLangs: session.targetLangs, name: session.name });
        if (session.status === 'live' || session.status === 'paused') {
          send(ws, { type: 'backfill', utterances: session.history.slice(-BACKFILL_COUNT) });
        }
      }
      return;
    }

    // Every non-register message operates on the session resolved above —
    // if the connection never registered (or its session got swept), there's
    // nothing to act on.
    const resolvedId=role==='viewer'?ws.roomSessionId:sessionId;
    const session=resolvedId?sessions.get(resolvedId):null;
    if (!session) return;
    if (role === 'host' && session.hostWs !== ws) return;

    // Legacy start messages never authorize audio or trigger a debit.
    if (role === 'host' && msg.type === 'host_start') return;
    if (role === 'host' && msg.type === 'host_stop') {
      session.audioRelay?.close();
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
      if(['live','paused','ended'].includes(session.status)) { const pending=pushUtterance(session,msg,ws);session.pendingInserts.add(pending);try{await pending;}finally{session.pendingInserts.delete(pending);} }
      return;
    }

    if(role==='host' && msg.type==='host_gap'){
      session.transcriptWarning=true; await dbMarkTranscriptWarning(session.id);
      send(ws,{type:'gap_ack'}); return;
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
      await dbSetHistoryBoundary(session.id);
      session.history.length = 0;
      session.displayAfterSeq=session.nextId-1;
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
      if(msg.sessionId && msg.sessionId!==session.id)return send(ws,{type:'resync',reset:true,utterances:session.history.slice()});
      const after = Number.isFinite(msg.after) ? msg.after : 0;
      const maxId = session.history.length ? session.history[session.history.length - 1].id : 0;
      if (maxId < after || after < session.displayAfterSeq) {
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
  }

  ws.on('close', () => {
    if(tourGroupId)tourGroupsById.get(tourGroupId)?.viewers.delete(ws);
    const resolvedId=role==='viewer'?ws.roomSessionId:sessionId;
    const session=resolvedId?sessions.get(resolvedId):null;
    if (!session) return;
    if (role === 'host') {
      if (session.hostWs !== ws) return;
      session.hostWs = null;
      session.audioRelay?.close();
      console.log(`[host] disconnected session=${session.id}`);
      // Audio has stopped above. Grace time only controls the abandoned-room
      // status shown to viewers; it never authorizes more audio or charges.
      if (session.status === 'live' || session.status === 'paused') {
        session.hostDisconnectedAt = Date.now();
        clearDisconnectGrace(session); // just in case one was already pending
        session.disconnectGraceTimer = setTimeout(() => {
          session.disconnectGraceTimer = null;
          if (session.hostWs) return; // reconnected in the meantime after all
          stopSessionAudio(session);
          if (session.status === 'live') {
            session.status = 'paused';
            console.log(`[session ${session.id}] host never reconnected within grace period — auto-paused`);
            broadcastToViewers(session, { type: 'session_status', status: 'paused', targetLangs: session.targetLangs, name: session.name });
            dbMarkSessionPaused(session.id).catch((err) => {
              console.error(`[db] failed to mark session ${session.id} paused:`, err);
            });
          }
        }, BILLING_DISCONNECT_GRACE_MS);
        session.disconnectGraceTimer.unref();
      }
    } else if (role === 'viewer') {
      session.viewers.delete(ws);
      console.log(`[viewer-] session=${session.id} total=${session.viewers.size}`);
      sendViewerCount(session);
    }
  });
});

const heartbeatTimer = setInterval(() => {
  for(const [key,value] of invalidViewerCodes)if(Date.now()-value.since>60_000)invalidViewerCodes.delete(key);
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
server.on('close', () => {
  clearInterval(heartbeatTimer);
  for (const room of sessions.values()) {
    room.audioRelay?.close();
    clearDisconnectGrace(room);
  }
  for (const ws of wss.clients) ws.terminate();
  for (const ws of audioWss.clients) ws.terminate();
  wss.close();
  audioWss.close();
});

// Restore durable state before accepting traffic. A database failure stops startup.
await runMigrations();
export async function restoreRuntime(){
  for(const row of (await dbRecoverSessions())||[]){
    if(sessions.has(row.id))continue;
    const room=createSession(row.user_id,row);
    room.history=(await dbGetRecentTranscript(row.id))||[];
  }
}
await restoreRuntime();
for(const row of (await dbGetTourGroupsForRouting())||[])rememberTourGroup(row);
async function maintainRetention(){
  for(const id of (await dbExpireTranscripts())||[]){
    const room=sessions.get(id);
    if(room){sessionsByJoinCode.delete(room.joinCode);sessions.delete(id);}
  }
}
await maintainRetention();
const retentionTimer=setInterval(()=>maintainRetention().catch(error=>console.error('[retention]',error.message)),60*60_000);
retentionTimer.unref();
const stopCleanupWorker=startCleanupWorker();
server.on('close',()=>{clearInterval(retentionTimer);stopCleanupWorker();});

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) server.listen(PORT, () => {
  console.log(`Soniox test server running at http://localhost:${PORT}`);
  console.log(`  Host   : http://localhost:${PORT}/host`);
  console.log(`  Live   : http://localhost:${PORT}/live`);
});
