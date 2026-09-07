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

// --- sessions ---------------------------------------------------------

export async function dbInsertSession({ id, joinCode, name, sourceLang, targetLangs }) {
  if (!dbReady()) return;
  await pool.query(
    `INSERT INTO sessions (id, join_code, name, status, source_lang, target_langs)
     VALUES ($1, $2, $3, 'created', $4, $5)`,
    [id, joinCode, name || null, sourceLang || null, targetLangs || null]
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
