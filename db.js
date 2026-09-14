// Persistence layer (SPEC §6.5). DB is the source of truth for Session
// metadata and TranscriptLine; the in-memory `session` objects in server.js
// are only a live-period mirror (see the big comment there). This module
// must never let a DB outage take down the realtime WS path — every writer
// here is expected to be called fire-and-forget with a .catch() logging the
// error, not awaited inline in a broadcast.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

// Railway exposes both an internal URL (DATABASE_URL, only reachable from
// inside Railway's private network — what the deployed app should use) and
// a public proxy URL (DATABASE_PUBLIC_URL, reachable from anywhere,
// including local dev). Prefer DATABASE_URL per spec; fall back to the
// public one so `npm start` on a laptop still works against the same DB.
const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;

if (!connectionString) {
  console.error(
    'Missing DATABASE_URL (and no DATABASE_PUBLIC_URL fallback) — transcript ' +
    'persistence is disabled. Set DATABASE_URL in .env to the Railway Postgres ' +
    'connection string.'
  );
}

// PGSSL=disable turns this off for a local non-SSL Postgres. Railway's
// Postgres (both internal and public-proxy) accepts SSL with an
// unverified/self-signed-style cert, hence rejectUnauthorized: false.
const sslEnabled = process.env.PGSSL !== 'disable';

export const pool = connectionString
  ? new Pool({ connectionString, ssl: sslEnabled ? { rejectUnauthorized: false } : false })
  : null;

if (pool) {
  // Idle-client errors (e.g. Railway proxy dropping a connection) surface
  // here instead of crashing the process — pg's Pool default behavior for
  // an unhandled 'error' on an idle client IS to bring the process down.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err);
  });
}

let migrated = false;

// Runs schema.sql once at startup. Every statement in it is
// CREATE-IF-NOT-EXISTS, so this is safe to call on every boot. Failure is
// logged loudly but does NOT exit the process — live captioning/broadcast
// has no DB dependency and must keep working even if Postgres is
// unreachable; only persistence-dependent features degrade.
export async function runMigrations() {
  if (!pool) return;
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    migrated = true;
    console.log('[db] schema migrated (sessions, transcript_lines)');
  } catch (err) {
    console.error('[db] migration failed — persistence layer disabled until this is fixed:', err);
  }
}

function dbReady() {
  return Boolean(pool && migrated);
}

// --- users --------------------------------------------------------------

// Google is the only identity source (SPEC §3a): look up by google_sub, and
// upsert on every login so a changed Google display name/email stays fresh.
export async function dbUpsertUserByGoogleSub({ id, googleSub, email, name }) {
  if (!dbReady()) throw new Error('Database not available');
  const result = await pool.query(
    `INSERT INTO users (id, google_sub, email, name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_sub) DO UPDATE SET email = $3, name = $4
     RETURNING id, google_sub, email, name, created_at`,
    [id, googleSub, email || null, name || null]
  );
  return result.rows[0];
}

// Used by passport's deserializeUser — session cookie only stores the id.
export async function dbGetUserById(id) {
  if (!dbReady()) return null;
  const result = await pool.query(
    `SELECT id, google_sub, email, name, created_at FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// --- credits / billing (SPEC step 6) -------------------------------------
// The credit balance is the ONLY cost defense once login is opened to the
// public, so unlike most reads in this file this one deliberately has no
// "degrade gracefully" story: a null return here must make the caller treat
// the user as unable to afford anything, never as "unknown, let it through".
export async function dbGetUserCredits(userId) {
  if (!dbReady()) return null;
  const result = await pool.query(`SELECT credits FROM users WHERE id = $1`, [userId]);
  return result.rows[0] ? result.rows[0].credits : null;
}

// Atomic conditional debit: only succeeds (and only returns a row) if the
// balance can actually cover `amount` — `credits >= amount` is checked by
// Postgres itself in the same statement that decrements it, so two
// concurrent charge attempts for the same user can never both succeed and
// drive the balance negative (the second one's WHERE simply matches zero
// rows once the first has already spent it). Returns null on insufficient
// balance or DB unavailability — callers must treat both as "can't charge".
export async function dbChargeCredits(userId, amount) {
  if (!dbReady()) return null;
  const result = await pool.query(
    `UPDATE users SET credits = credits - $2 WHERE id = $1 AND credits >= $2 RETURNING credits`,
    [userId, amount]
  );
  return result.rows[0] ? result.rows[0].credits : null;
}

// Manual top-up confirmation writes straight to the DB by hand (SPEC step
// 5 — no admin UI); this helper exists only for completeness/tests, nothing
// in the live request path calls it.
export async function dbAddCredits(userId, amount) {
  if (!dbReady()) return null;
  const result = await pool.query(
    `UPDATE users SET credits = credits + $2 WHERE id = $1 RETURNING credits`,
    [userId, amount]
  );
  return result.rows[0] ? result.rows[0].credits : null;
}

// --- orders (儲值下單, SPEC step 3) ----------------------------------------

export async function dbCreateOrder({ id, userId, amountPaid, creditsToAdd }) {
  if (!dbReady()) throw new Error('Database not available');
  const result = await pool.query(
    `INSERT INTO orders (id, user_id, amount_paid, credits_to_add, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING id, user_id, amount_paid, credits_to_add, last_five, status, created_at, confirmed_at`,
    [id, userId, amountPaid, creditsToAdd]
  );
  return result.rows[0];
}

// Ownership-scoped on purpose (WHERE id = $1 AND user_id = $2) — a host can
// only fill in the last-five of their own order, never guess/overwrite
// someone else's by id. Returns null if the order doesn't exist or isn't
// this user's, so the route can 404 without leaking which is which.
export async function dbSetOrderLastFive(id, userId, lastFive) {
  if (!dbReady()) return null;
  const result = await pool.query(
    `UPDATE orders SET last_five = $3 WHERE id = $1 AND user_id = $2
     RETURNING id, user_id, amount_paid, credits_to_add, last_five, status, created_at, confirmed_at`,
    [id, userId, lastFive]
  );
  return result.rows[0] || null;
}

export async function dbGetOrder(id) {
  if (!dbReady()) return null;
  const result = await pool.query(
    `SELECT id, user_id, amount_paid, credits_to_add, last_five, status, created_at, confirmed_at
     FROM orders WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// --- usage_ledger (SPEC step 6: append-only, traceable) --------------------

export async function dbInsertUsageLedger({ sessionId, userId, creditsCharged, targetLangCount, balanceAfter }) {
  if (!dbReady()) return;
  await pool.query(
    `INSERT INTO usage_ledger (session_id, user_id, credits_charged, target_lang_count, balance_after)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, userId, creditsCharged, targetLangCount, balanceAfter]
  );
}

// --- sessions ---------------------------------------------------------

export async function dbInsertSession({ id, joinCode, name, sourceLang, targetLangs, userId }) {
  if (!dbReady()) return;
  await pool.query(
    `INSERT INTO sessions (id, join_code, name, status, source_lang, target_langs, user_id)
     VALUES ($1, $2, $3, 'created', $4, $5, $6)`,
    [id, joinCode, name || null, sourceLang || null, targetLangs || null, userId || null]
  );
}

// Records what the host actually chose at Start time (SPEC §6.5 "如實記
// 錄"). Purely a record for "my sessions" / future reference; never read
// back to drive any live behavior. `null` (omitted/undefined here) means
// "never recorded" — a real empty array (pure-transcription's target_langs,
// or source_langs' own ['auto'] sentinel — see schema.sql) is written as-is,
// distinct from null, since node-postgres serializes a JS `[]` to a real
// empty Postgres array rather than collapsing it.
export async function dbSetSessionLanguages(id, { sourceLangs, targetLangs } = {}) {
  if (!dbReady()) return;
  await pool.query(
    `UPDATE sessions SET source_langs = $2, target_langs = $3 WHERE id = $1`,
    [id, sourceLangs ?? null, targetLangs ?? null]
  );
}

export async function dbMarkSessionLive(id) {
  if (!dbReady()) return;
  await pool.query(
    `UPDATE sessions SET status = 'live', started_at = now() WHERE id = $1`,
    [id]
  );
}

export async function dbMarkSessionEnded(id) {
  if (!dbReady()) return;
  await pool.query(
    `UPDATE sessions SET status = 'ended', ended_at = now() WHERE id = $1`,
    [id]
  );
}

export async function dbRenameSession(id, name) {
  if (!dbReady()) return false;
  const result = await pool.query(
    `UPDATE sessions SET name = $2 WHERE id = $1`,
    [id, name]
  );
  return result.rowCount > 0;
}

export async function dbSetProcessingStatus(id, status) {
  if (!dbReady()) return;
  await pool.query(
    `UPDATE sessions SET processing_status = $2 WHERE id = $1`,
    [id, status]
  );
}

export async function dbSetCleanedTranscript(id, cleanedTranscript) {
  if (!dbReady()) return;
  await pool.query(
    `UPDATE sessions SET cleaned_transcript = $2, processing_status = 'ready' WHERE id = $1`,
    [id, cleanedTranscript]
  );
}

// Returns null if the session isn't in the DB (e.g. persistence was down
// when it was created) rather than throwing, so callers can render a clear
// "not found" instead of a 500.
export async function dbGetSessionTranscript(id) {
  if (!dbReady()) return null;
  const result = await pool.query(
    `SELECT id, name, status, processing_status, cleaned_transcript
     FROM sessions WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// Ownership check (SPEC §3a point 6): every "view this session's transcript
// / rename this session" endpoint calls this first and compares user_id to
// the logged-in user before doing anything else. A pre-phase-3a session has
// user_id = null, which never equals a real user id — it just becomes
// inaccessible through these endpoints rather than crashing anything.
export async function dbGetSessionOwner(id) {
  if (!dbReady()) return null;
  const result = await pool.query(`SELECT id, user_id FROM sessions WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

// "My sessions" list (SPEC §3a point 5) — name, status, created_at, and
// processing_status for every session this user owns, newest first.
export async function dbGetSessionsByUser(userId) {
  if (!dbReady()) return [];
  const result = await pool.query(
    `SELECT id, name, status, processing_status, created_at, started_at, ended_at
     FROM sessions WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

// --- transcript_lines ---------------------------------------------------

export async function dbInsertTranscriptLine(sessionId, seq, ts, originalText) {
  if (!dbReady()) return;
  await pool.query(
    `INSERT INTO transcript_lines (session_id, seq, ts, original_text) VALUES ($1, $2, $3, $4)`,
    [sessionId, seq, new Date(ts), originalText]
  );
}

export async function dbGetTranscriptLines(sessionId) {
  if (!dbReady()) return [];
  const result = await pool.query(
    `SELECT original_text FROM transcript_lines WHERE session_id = $1 ORDER BY seq ASC`,
    [sessionId]
  );
  return result.rows.map((r) => r.original_text);
}
