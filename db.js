// Persistence and billing require a healthy database. Transcript ACKs follow durable writes.
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

// Atomic schema migration; fail startup if persistence is unavailable.
export async function runMigrations() {
  if (!pool) throw new Error('Database required');
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(sql); await client.query('COMMIT'); }
    catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    migrated = true;
    console.log('[db] schema migrated (sessions, transcript_lines)');
  } catch (err) {
    console.error('[db] migration failed:', err.message);
    throw err;
  }
}

function dbReady() {
  return Boolean(pool && migrated);
}

// --- users --------------------------------------------------------------

// Google is the only identity source (SPEC §3a): look up by google_sub, and
// upsert on every login so a changed Google display name/email stays fresh.
export async function dbUpsertUserByGoogleSub({ id, googleSub, email, name }) {
  return transaction(async client=>{
    const {rows:[user]}=await client.query(`INSERT INTO users(id,google_sub,email,name) VALUES($1,$2,$3,$4)
      ON CONFLICT(google_sub) DO UPDATE SET email=$3,name=$4 RETURNING id,google_sub,email,name,created_at,credits`,[id,googleSub,email||null,name||null]);
    await client.query('INSERT INTO account_opening_balances(user_id,credits) VALUES($1,$2) ON CONFLICT DO NOTHING',[user.id,user.credits]);
    return user;
  });
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
export async function dbChargeCredits() { throw new Error('Use idempotent dbChargeSessionMinute');
}

// The debit and audit record commit together; a ledger failure rolls both back.
export async function dbChargeSessionMinute(userId, sessionId, rate, minute) {
  if (![2,3].includes(rate) || !Number.isSafeInteger(minute) || minute<1) throw new Error('Invalid debit');
  return transaction(async client=>{
    const {rows:[user]}=await client.query('SELECT credits FROM users WHERE id=$1 FOR UPDATE',[userId]);
    if(!user) throw new Error('user_not_found');
    const debitId=sessionId+':'+rate+':'+minute;
    const {rows:[old]}=await client.query('SELECT balance_after FROM usage_ledger WHERE debit_id=$1',[debitId]);
    if(old) return user.credits;
    const {rows:[room]}=await client.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2',[sessionId,userId]);
    if(!room)throw new Error('session_not_found');
    if(user.credits<rate)return null;
    const balance=user.credits-rate;
    await client.query('UPDATE users SET credits=$2 WHERE id=$1',[userId,balance]);
    await client.query(`INSERT INTO usage_ledger(session_id,source_session_id,user_id,credits_charged,target_lang_count,balance_after,debit_id)
      VALUES($1,$1,$2,$3,$4,$5,$6)`,[sessionId,userId,rate,rate-2,balance,debitId]);
    await client.query(`INSERT INTO audio_meters(session_id,rate,paid_minutes) VALUES($1,$2,$3)
      ON CONFLICT(session_id,rate) DO UPDATE SET paid_minutes=GREATEST(audio_meters.paid_minutes,$3)`,[sessionId,rate,minute]);
    return balance;
  });
}

// Manual top-up confirmation writes straight to the DB by hand (SPEC step
// 5 — no admin UI); this helper exists only for completeness/tests, nothing
// in the live request path calls it.
export async function dbAddCredits() { throw new Error('Use audited dbConfirmOrder or dbAdjustCredits');
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
    `UPDATE orders SET last_five = $3 WHERE id = $1 AND user_id = $2 AND status='pending'
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

export async function dbInsertUsageLedger() { throw new Error('Use atomic dbChargeSessionMinute');
}

// --- sessions ---------------------------------------------------------

export async function dbInsertSession({ id, joinCode, name, sourceLang, targetLangs, userId }) {
  requireDatabase();
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
    `UPDATE sessions SET status = 'live', started_at = COALESCE(started_at,now()) WHERE id = $1 AND status<>'ended'`,
    [id]
  );
}

export async function dbMarkSessionEnded(id) {
  return transaction(async client=>{
    const {rows:[row]}=await client.query("UPDATE sessions SET status='ended', ended_at=COALESCE(ended_at,now()), expires_at=COALESCE(expires_at,now()+interval '30 days'), processing_status=COALESCE(processing_status,'queued') WHERE id=$1 RETURNING *",[id]);
    if(row?.tour_group_id)await client.query('UPDATE tour_groups SET active_session_id=NULL WHERE id=$1 AND active_session_id=$2',[row.tour_group_id,id]);
    if(row && !row.transcript_expired_at && new Date(row.expires_at)>new Date())await client.query('INSERT INTO cleanup_jobs(session_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
  });
}

// SPEC fix ("場次沒結束一直掛 live"): the server-side auto-pause for a host
// that disconnected and never reconnected within BILLING_DISCONNECT_GRACE_MS
// (see server.js's ws.on('close')) — deliberately NOT 'ended': join_code and
// history survive, and a host coming back just presses Start again (see
// dbMarkSessionResumed). started_at/ended_at are untouched either way.
export async function dbMarkSessionPaused(id) {
  if (!dbReady()) return;
  await pool.query(`UPDATE sessions SET status = 'paused' WHERE id = $1 AND status<>'ended'`, [id]);
}

// Counterpart to dbMarkSessionPaused: host pressed Start again after an
// auto-pause. Unlike dbMarkSessionLive, this must NOT touch started_at — the
// session was already running once, this isn't a fresh start.
export async function dbMarkSessionResumed(id) {
  if (!dbReady()) return;
  await pool.query(`UPDATE sessions SET status = 'live' WHERE id = $1 AND status<>'ended'`, [id]);
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
    `SELECT id,name,status,processing_status,CASE WHEN expires_at<=now() THEN NULL ELSE cleaned_transcript END AS cleaned_transcript,expires_at,transcript_expired_at,transcript_warning
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
    `SELECT id,name,status,processing_status,created_at,started_at,ended_at,expires_at,transcript_expired_at,transcript_warning,tour_group_id
     FROM sessions WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

// Full row for a single session, including join_code — used by GET
// /api/sessions/:id so /host can render an EXISTING session's QR/join code
// without ever creating a new one (see server.js's createSession comment on
// the zombie-session fix).
export async function dbGetSessionById(id) {
  if (!dbReady()) return null;
  const result = await pool.query(
    `SELECT *
     FROM sessions WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// Deletes a session and everything that references it (transcript_lines,
// usage_ledger) — ownership-scoped (WHERE ... AND user_id = $2), so a host
// can only delete their own session. usage_ledger is append-only/never-
// deleted everywhere else in this file (SPEC step 6: "與扣點一致可追溯"); this
// is the one deliberate exception, since deleting a session is supposed to
// make every trace of it go away. Transactional so a never-started session
// (no children) and an ended one with real history are both all-or-nothing.
// Returns true if a session row was actually deleted (false = not found, or
// not owned by this user).
export async function dbDeleteSession(id,userId){
  return transaction(async client=>{
    const {rows:[s]}=await client.query('SELECT status FROM sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId]);
    if(!s)return false;
    if(['live','paused'].includes(s.status))throw new Error('session_live');
    await client.query('DELETE FROM cleanup_jobs WHERE session_id=$1',[id]);
    await client.query('DELETE FROM transcript_lines WHERE session_id=$1',[id]);
    await client.query('DELETE FROM sessions WHERE id=$1',[id]);
    return true; // ledger retained; session_id becomes null, source_session_id stays.
  });
}

// Zombie-session cleanup, extended to the DB layer (previously
// sweepStaleSessions in server.js only ever forgot these in-memory, leaving
// the DB row — and therefore the "字幕場次" list — with a dead entry forever).
// A session that was created but never started has no transcript_lines/
// usage_ledger rows yet (both are only ever written after Start), so this is
// always a safe plain delete with nothing to cascade. Ended sessions are
// deliberately never touched here — only their in-memory copy ever expires
// (see ENDED_SESSION_TTL_MS) — the DB row + transcript stay forever.
export async function dbDeleteAbandonedCreatedSessions(olderThanMs) {
  if (!dbReady()) return 0;
  const result = await pool.query(
    `DELETE FROM sessions WHERE status = 'created' AND created_at < now() - ($1 || ' milliseconds')::interval`,
    [olderThanMs]
  );
  return result.rowCount;
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

// Reliability operations must never report success when persistence is down.
function requireDatabase() { if (!dbReady()) throw new Error('Database unavailable'); }
async function transaction(work) {
  requireDatabase();
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
export async function dbGetAudioMeter(sessionId, rate) {
  requireDatabase();
  const { rows } = await pool.query('SELECT processed_ms, paid_minutes FROM audio_meters WHERE session_id=$1 AND rate=$2', [sessionId, rate]);
  return { processedMs: rows[0]?.processed_ms ?? 0, paidMinutes: rows[0]?.paid_minutes ?? 0 };
}
export async function dbSaveAudioMeter(sessionId, rate, state) {
  requireDatabase();
  await pool.query('UPDATE audio_meters SET processed_ms=GREATEST(processed_ms,$3) WHERE session_id=$1 AND rate=$2', [sessionId, rate, state.processedMs]);
}
export async function dbRecoverSessions() {
  return transaction(async client => {
    await client.query("UPDATE sessions SET status='paused' WHERE status='live'");
    await client.query(`INSERT INTO cleanup_jobs(session_id) SELECT id FROM sessions WHERE status='ended' AND transcript_expired_at IS NULL
      AND expires_at>now() AND (processing_status IS NULL OR processing_status IN ('queued','processing')) ON CONFLICT DO NOTHING`);
    await client.query("UPDATE cleanup_jobs SET status='queued',job_token=NULL,lease_until=NULL WHERE status='processing'");
    return (await client.query("SELECT * FROM sessions WHERE (status IN ('created','paused') OR (status='ended' AND ended_at>now()-interval '5 minutes')) AND transcript_expired_at IS NULL")).rows;
  });
}
export async function dbGetRecentTranscript(sessionId, limit = 50) {
  requireDatabase();
  const { rows } = await pool.query(`SELECT seq,ts,original_text,translations FROM transcript_lines
    WHERE session_id=$1 AND seq > (SELECT display_after_seq FROM sessions WHERE id=$1) ORDER BY seq DESC LIMIT $2`, [sessionId, limit]);
  return rows.reverse().map(row => ({ type:'utterance', id:Number(row.seq),ts:new Date(row.ts).getTime(),original:row.original_text,translations:row.translations }));
}
export async function dbSetHistoryBoundary(sessionId) {
  requireDatabase();
  await pool.query('UPDATE sessions SET display_after_seq=next_seq-1 WHERE id=$1',[sessionId]);
}
export async function dbMarkTranscriptWarning(sessionId) {
  requireDatabase();
  await pool.query('UPDATE sessions SET transcript_warning=true WHERE id=$1',[sessionId]);
}
export async function dbCommitTranscript(sessionId, message) {
  return transaction(async client => {
    const {rows:[s]}=await client.query('SELECT * FROM sessions WHERE id=$1 FOR UPDATE',[sessionId]);
    if (!s || s.transcript_expired_at || (s.expires_at && new Date(s.expires_at)<=new Date())) throw new Error('transcript_expired');
    const {rows:[old]}=await client.query('SELECT * FROM transcript_lines WHERE session_id=$1 AND client_message_id=$2',[sessionId,message.clientMessageId]);
    if (old) return { row:old, inserted:false };
    if (s.status==='ended' && Date.now()-new Date(s.ended_at).getTime()>5*60_000) throw new Error('session_ended');
    const {rows:[row]}=await client.query(`INSERT INTO transcript_lines(session_id,seq,ts,original_text,translations,client_message_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[sessionId,s.next_seq,new Date(message.ts),message.original,message.translations,message.clientMessageId]);
    await client.query('UPDATE sessions SET next_seq=next_seq+1,transcript_revision=transcript_revision+1 WHERE id=$1',[sessionId]);
    if(s.status==='ended') {
      await client.query("UPDATE sessions SET processing_status='queued',cleaned_transcript=NULL WHERE id=$1",[sessionId]);
      await client.query(`INSERT INTO cleanup_jobs(session_id) VALUES($1) ON CONFLICT(session_id) DO UPDATE
        SET status='queued',job_token=NULL,lease_until=NULL,updated_at=now()`,[sessionId]);
    }
    return {row, inserted:true};
  });
}
export async function dbGetRawTranscript(sessionId) {
  requireDatabase();
  return (await pool.query(`SELECT t.seq,t.ts,t.original_text FROM transcript_lines t JOIN sessions s ON s.id=t.session_id
    WHERE t.session_id=$1 AND s.transcript_expired_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now()) ORDER BY t.seq`,[sessionId])).rows;
}
export async function dbExpireTranscripts() {
  return transaction(async client=>{
    const {rows}=await client.query(`SELECT id FROM sessions WHERE status='ended' AND expires_at<=now()
      AND transcript_expired_at IS NULL FOR UPDATE SKIP LOCKED`);
    for(const {id} of rows){
      await client.query('DELETE FROM cleanup_jobs WHERE session_id=$1',[id]);
      await client.query('DELETE FROM transcript_lines WHERE session_id=$1',[id]);
      await client.query(`UPDATE sessions SET cleaned_transcript=NULL,name=NULL,processing_status='expired',transcript_expired_at=now() WHERE id=$1`,[id]);
    }
    return rows.map(row=>row.id);
  });
}
export async function dbQueueCleanup(sessionId) {
  return transaction(async client=>{
    const {rows:[s]}=await client.query('SELECT * FROM sessions WHERE id=$1 FOR UPDATE',[sessionId]);
    if(!s || s.status!=='ended') throw new Error('session_not_ended');
    if(s.transcript_expired_at || (s.expires_at && new Date(s.expires_at)<=new Date())) throw new Error('transcript_expired');
    const {rows:[job]}=await client.query(`INSERT INTO cleanup_jobs(session_id) VALUES($1) ON CONFLICT(session_id) DO UPDATE
      SET status=CASE WHEN cleanup_jobs.status IN ('failed','incomplete') THEN 'queued' ELSE cleanup_jobs.status END, updated_at=now() RETURNING *`,[sessionId]);
    await client.query('UPDATE sessions SET processing_status=$2 WHERE id=$1',[sessionId,job.status]);
    return job;
  });
}
export async function dbClaimCleanupJob(token) {
  return transaction(async client=>{
    const {rows:[s]}=await client.query(`SELECT * FROM sessions s WHERE s.status='ended' AND s.transcript_expired_at IS NULL AND s.expires_at>now()
      AND EXISTS (SELECT 1 FROM cleanup_jobs j WHERE j.session_id=s.id AND (j.status='queued' OR (j.status='processing' AND j.lease_until<now())))
      ORDER BY s.ended_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if(!s) return null;
    await client.query(`UPDATE cleanup_jobs SET status='processing',source_revision=$2,job_token=$3,lease_until=now()+interval '5 minutes',updated_at=now() WHERE session_id=$1`,[s.id,s.transcript_revision,token]);
    await client.query("UPDATE sessions SET processing_status='processing' WHERE id=$1",[s.id]);
    const {rows:lines}=await client.query('SELECT seq,original_text FROM transcript_lines WHERE session_id=$1 ORDER BY seq',[s.id]);
    return {sessionId:s.id,token,revision:s.transcript_revision,lines};
  });
}
async function withCleanupJob(sessionId,token,work){
  return transaction(async client=>{
    const {rows:[s]}=await client.query('SELECT * FROM sessions WHERE id=$1 FOR UPDATE',[sessionId]);
    if(!s || s.transcript_expired_at || (s.expires_at && new Date(s.expires_at)<=new Date())) return false;
    const {rows:[job]}=await client.query('SELECT * FROM cleanup_jobs WHERE session_id=$1 AND job_token=$2 AND status=$3 FOR UPDATE',[sessionId,token,'processing']);
    if(!job || Number(job.source_revision)!==Number(s.transcript_revision)) return false;
    await client.query("UPDATE cleanup_jobs SET lease_until=now()+interval '5 minutes',updated_at=now() WHERE session_id=$1",[sessionId]);
    return work(client,job);
  });
}
export async function dbRenewCleanupJob(sessionId,token){return withCleanupJob(sessionId,token,()=>true);}
export async function dbPrepareCleanupChunks(sessionId,token,hash,chunks){
  return withCleanupJob(sessionId,token,async client=>{
    await client.query('UPDATE cleanup_jobs SET source_hash=$2 WHERE session_id=$1',[sessionId,hash]);
    await client.query('DELETE FROM cleanup_chunks WHERE session_id=$1 AND source_hash<>$2',[sessionId,hash]);
    for(let i=0;i<chunks.length;i++){
      const c=chunks[i];
      await client.query(`INSERT INTO cleanup_chunks(session_id,source_hash,chunk_index,start_seq,end_seq,input_text) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[sessionId,hash,i,c.startSeq,c.endSeq,c.text]);
    }
    return (await client.query('SELECT * FROM cleanup_chunks WHERE session_id=$1 AND source_hash=$2 ORDER BY chunk_index',[sessionId,hash])).rows;
  });
}
export async function dbSaveCleanupChunk(sessionId,token,hash,index,text){
  return withCleanupJob(sessionId,token,async client=>{
    await client.query('UPDATE cleanup_chunks SET output_text=$4 WHERE session_id=$1 AND source_hash=$2 AND chunk_index=$3',[sessionId,hash,index,text]);return true;
  });
}
export async function dbFinishCleanupJob(sessionId,token,status){
  return withCleanupJob(sessionId,token,async (client,job)=>{
    let cleaned=null;
    if(status==='ready'){
      const {rows}=await client.query('SELECT output_text FROM cleanup_chunks WHERE session_id=$1 AND source_hash=$2 ORDER BY chunk_index',[sessionId,job.source_hash]);
      if(rows.some(r=>r.output_text===null)) throw new Error('incomplete_chunks');
      cleaned=rows.map(r=>r.output_text).join('\n\n');
    }
    await client.query('UPDATE sessions SET processing_status=$2,cleaned_transcript=$3 WHERE id=$1',[sessionId,status,cleaned]);
    await client.query('UPDATE cleanup_jobs SET status=$2,job_token=NULL,lease_until=NULL,updated_at=now() WHERE session_id=$1',[sessionId,status]);
    return true;
  });
}
export async function dbConfirmOrder(orderId,operator,reference){
  if(!operator?.trim() || !reference?.trim()) throw new Error('operator_and_reference_required');
  return transaction(async client=>{
    const {rows:[order]}=await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[orderId]);
    if(!order) throw new Error('order_not_found');
    if(order.status==='paid') return {alreadyConfirmed:true,order};
    if(order.status!=='pending' || !order.last_five) throw new Error('order_not_ready');
    const {rows:[user]}=await client.query('UPDATE users SET credits=credits+$2 WHERE id=$1 RETURNING credits',[order.user_id,order.credits_to_add]);
    await client.query(`INSERT INTO credit_ledger(entry_id,user_id,kind,credits_delta,balance_after,order_id,transfer_reference,operator,reason)
      VALUES($1,$2,'topup',$3,$4,$5,$6,$7,'人工核對匯款')`,['order:'+orderId,order.user_id,order.credits_to_add,user.credits,orderId,reference.trim(),operator.trim()]);
    await client.query("UPDATE orders SET status='paid',confirmed_at=now() WHERE id=$1",[orderId]);
    return {alreadyConfirmed:false,credits:user.credits};
  });
}
export async function dbAdjustCredits(userId,amount,entryId,operator,reason){
  if(!Number.isInteger(amount)||amount===0||!entryId?.trim()||!operator?.trim()||!reason?.trim()) throw new Error('invalid_adjustment');
  return transaction(async client=>{
    const {rows:[user]}=await client.query('SELECT credits FROM users WHERE id=$1 FOR UPDATE',[userId]);
    if(!user) throw new Error('user_not_found');
    const {rows:[old]}=await client.query('SELECT * FROM credit_ledger WHERE entry_id=$1',[entryId]);
    if(old){if(old.user_id!==userId||old.credits_delta!==amount||old.kind!=='adjustment')throw new Error('adjustment_id_conflict');return old.balance_after;}
    if(user.credits+amount<0)throw new Error('insufficient_credits');
    const balance=user.credits+amount;
    await client.query('UPDATE users SET credits=$2 WHERE id=$1',[userId,balance]);
    await client.query(`INSERT INTO credit_ledger(entry_id,user_id,kind,credits_delta,balance_after,operator,reason) VALUES($1,$2,'adjustment',$3,$4,$5,$6)`,[entryId,userId,amount,balance,operator,reason]);
    return balance;
  });
}
export async function dbGetBillingHistory(userId){
  requireDatabase();
  const orders=await pool.query('SELECT id,amount_paid,credits_to_add,last_five,status,created_at,confirmed_at FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[userId]);
  const entries=await pool.query(`SELECT * FROM (
    SELECT 'usage' AS kind, -credits_charged AS delta,balance_after,created_at,source_session_id::text AS reference FROM usage_ledger WHERE user_id=$1
    UNION ALL SELECT kind,credits_delta,balance_after,created_at,COALESCE(order_id,entry_id) FROM credit_ledger WHERE user_id=$1
    ) ledger ORDER BY created_at DESC LIMIT 200`,[userId]);
  return {orders:orders.rows,entries:entries.rows};
}
export async function dbReconcileAccounts(){
  requireDatabase();
  const {rows}=await pool.query(`SELECT u.id,u.email,u.credits AS actual,b.credits AS opening,b.captured_at,
    b.credits+COALESCE((SELECT SUM(c.credits_delta) FROM credit_ledger c WHERE c.user_id=u.id AND c.created_at>=b.captured_at),0)
    -COALESCE((SELECT SUM(l.credits_charged) FROM usage_ledger l WHERE l.user_id=u.id AND l.created_at>=b.captured_at),0) AS expected
    FROM users u JOIN account_opening_balances b ON b.user_id=u.id ORDER BY u.created_at`);
  return rows.map(row=>({...row,expected:Number(row.expected),matches:Number(row.expected)===row.actual}));
}

// Group membership can later be driven by a paid-tier entitlement. These
// operations only manage data; the HTTP handlers enforce feature access.
export async function dbCreateTourGroup({id,userId,name,code}) {
  requireDatabase();
  return (await pool.query('INSERT INTO tour_groups(id,user_id,name,code) VALUES($1,$2,$3,$4) RETURNING *',[id,userId,name,code])).rows[0];
}
export async function dbGetTourGroupsByUser(userId) {
  requireDatabase();
  return (await pool.query(`SELECT g.*,s.status AS active_status FROM tour_groups g
    LEFT JOIN sessions s ON s.id=g.active_session_id WHERE g.user_id=$1 ORDER BY g.created_at DESC`,[userId])).rows;
}
export async function dbGetOpenTourGroups() {
  requireDatabase();
  return (await pool.query("SELECT * FROM tour_groups WHERE status='open'")).rows;
}
export async function dbGetTourGroup(id,userId) {
  requireDatabase();
  return (await pool.query('SELECT * FROM tour_groups WHERE id=$1 AND user_id=$2',[id,userId])).rows[0]||null;
}
export async function dbRenameTourGroup(id,userId,name) {
  requireDatabase();
  return (await pool.query('UPDATE tour_groups SET name=$3 WHERE id=$1 AND user_id=$2 AND status=$4 RETURNING *',[id,userId,name,'open'])).rows[0]||null;
}
export async function dbCreateTourSession({id,userId,groupId,joinCode,name}) {
  return transaction(async client=>{
    const {rows:[group]}=await client.query('SELECT * FROM tour_groups WHERE id=$1 AND user_id=$2 FOR UPDATE',[groupId,userId]);
    if(!group)throw new Error('tour_not_found');
    if(group.status!=='open')throw new Error('tour_closed');
    if(group.active_session_id)throw new Error('tour_session_active');
    const {rows:[room]}=await client.query(`INSERT INTO sessions(id,join_code,name,user_id,tour_group_id,status)
      VALUES($1,$2,$3,$4,$5,'created') RETURNING *`,[id,joinCode,name,userId,groupId]);
    await client.query('UPDATE tour_groups SET active_session_id=$2 WHERE id=$1',[groupId,id]);
    return room;
  });
}
export async function dbCloseTourGroup(id,userId) {
  return transaction(async client=>{
    const {rows:[group]}=await client.query('SELECT * FROM tour_groups WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId]);
    if(!group)return null;
    if(group.active_session_id)throw new Error('tour_session_active');
    return (await client.query("UPDATE tour_groups SET status='closed',closed_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];
  });
}
export async function dbGetTourGroupsForRouting() {
  requireDatabase();
  return (await pool.query('SELECT id,user_id,name,code,status,active_session_id FROM tour_groups')).rows;
}
export async function dbRotateTourGroup(id,userId,code) {
  return transaction(async client=>{
    const {rows:[group]}=await client.query('SELECT * FROM tour_groups WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId]);
    if(!group)return null;
    if(group.status!=='open')throw new Error('tour_closed');
    if(group.active_session_id)throw new Error('tour_session_active');
    return (await client.query('UPDATE tour_groups SET code=$2 WHERE id=$1 RETURNING *',[id,code])).rows[0];
  });
}
