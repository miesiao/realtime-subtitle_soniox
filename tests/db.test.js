import {test,mock,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const pg=new PGlite();
let tail=Promise.resolve();
async function lock(){const previous=tail;let release;tail=new Promise(r=>release=r);await previous;return release;}
async function query(sql,args){if(args?.length)return pg.query(sql,args);const result=await pg.exec(sql);return result.at(-1)||{rows:[]};}
class Pool{on(){}async query(sql,args){const release=await lock();try{return await query(sql,args);}finally{release();}}async connect(){const release=await lock();return {query,release};}async end(){}}
mock.module('pg',{defaultExport:{Pool}});process.env.DATABASE_URL='postgres://isolated';
const db=await import('../db.js');
after(()=>pg.close());
const user=crypto.randomUUID();let room;
async function newRoom(){const id=crypto.randomUUID();await db.dbInsertSession({id,joinCode:id.slice(0,12),userId:user});return id;}
const message=(id='one')=>({clientMessageId:id,ts:Date.now(),original:'完整原始內容，含最後一句。',translations:{en:'Last sentence.'}});
test('migrations are repeatable; opening balance reconciles',async()=>{await db.runMigrations();await db.runMigrations();await db.dbUpsertUserByGoogleSub({id:user,googleSub:'google-test'});room=await newRoom();assert.equal((await db.dbReconcileAccounts())[0].matches,true);});
test('duplicate concurrent minute charges once and meter survives reload',async()=>{assert.deepEqual(await Promise.all([db.dbChargeSessionMinute(user,room,3,1),db.dbChargeSessionMinute(user,room,3,1)]),[47,47]);await db.dbSaveAudioMeter(room,3,{processedMs:12345});assert.deepEqual(await db.dbGetAudioMeter(room,3),{processedMs:12345,paidMinutes:1});assert.equal((await db.dbReconcileAccounts())[0].matches,true);});
test('ledger insertion failure rolls back debit',async()=>{await pg.exec("CREATE FUNCTION reject_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$; CREATE TRIGGER reject_usage BEFORE INSERT ON usage_ledger FOR EACH ROW EXECUTE FUNCTION reject_usage();");await assert.rejects(db.dbChargeSessionMinute(user,room,3,2),/test rollback/);assert.equal(await db.dbGetUserCredits(user),47);await pg.exec('DROP TRIGGER reject_usage ON usage_ledger; DROP FUNCTION reject_usage();');});
test('ACK replay deduplicates, clear never resets transcript sequence; restart restores same room',async()=>{const first=await db.dbCommitTranscript(room,message());assert.equal(first.inserted,true);assert.equal((await db.dbCommitTranscript(room,message())).inserted,false);await db.dbSetHistoryBoundary(room);const second=await db.dbCommitTranscript(room,message('two'));assert.equal(Number(second.row.seq),2);assert.equal((await db.dbGetRawTranscript(room)).length,2);assert.equal((await db.dbGetRecentTranscript(room)).length,1);await pg.query("UPDATE sessions SET status='live' WHERE id=$1",[room]);assert.equal((await db.dbRecoverSessions()).find(x=>x.id===room).status,'paused');});
test('cleanup cannot publish partial chunks or stale revision; expiration prevents resurrection',async()=>{await db.dbMarkSessionEnded(room);await db.dbQueueCleanup(room);const job=await db.dbClaimCleanupJob(crypto.randomUUID());assert.equal(job.sessionId,room);await db.dbPrepareCleanupChunks(room,job.token,'hash',[{startSeq:1,endSeq:2,text:'input'}]);await assert.rejects(db.dbFinishCleanupJob(room,job.token,'ready'),/incomplete_chunks/);await db.dbCommitTranscript(room,message('late'));assert.equal(await db.dbSaveCleanupChunk(room,job.token,'hash',0,'old'),false);const next=await db.dbClaimCleanupJob(crypto.randomUUID());await db.dbPrepareCleanupChunks(room,next.token,'new',[{startSeq:1,endSeq:3,text:'all'}]);await db.dbSaveCleanupChunk(room,next.token,'new',0,'完整整理');assert.equal(await db.dbFinishCleanupJob(room,next.token,'ready'),true);await pg.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[room]);await db.dbExpireTranscripts();assert.equal((await db.dbGetRawTranscript(room)).length,0);assert.equal(await db.dbSaveCleanupChunk(room,next.token,'new',0,'resurrect'),false);assert.equal((await pg.query('SELECT * FROM cleanup_chunks')).rows.length,0);});
test('deleting session retains usage ledger and original reference',async()=>{assert.equal(await db.dbDeleteSession(room,user),true);const row=(await pg.query('SELECT * FROM usage_ledger')).rows[0];assert.equal(row.session_id,null);assert.equal(row.source_session_id,room);assert.equal((await db.dbReconcileAccounts())[0].matches,true);});
test('manual confirmation and adjustment are idempotent; bank reference cannot be reused',async()=>{await db.dbCreateOrder({id:'ORDER1',userId:user,amountPaid:300,creditsToAdd:300});await db.dbSetOrderLastFive('ORDER1',user,'12345');await db.dbConfirmOrder('ORDER1','tester','bank-unique');assert.equal((await db.dbConfirmOrder('ORDER1','tester','bank-unique')).alreadyConfirmed,true);await db.dbCreateOrder({id:'ORDER2',userId:user,amountPaid:300,creditsToAdd:300});await db.dbSetOrderLastFive('ORDER2',user,'12345');await assert.rejects(db.dbConfirmOrder('ORDER2','tester','bank-unique'));assert.equal(await db.dbGetUserCredits(user),347);await db.dbAdjustCredits(user,10,'adjust-1','tester','test credit');await db.dbAdjustCredits(user,10,'adjust-1','tester','test credit');assert.equal(await db.dbGetUserCredits(user),357);assert.equal((await db.dbReconcileAccounts())[0].matches,true);assert.equal((await db.dbGetBillingHistory(user)).entries.length,3);});


test('legacy migration preserves text and ledger, normalizes reused seq, and gives 30-day grace',async()=>{
 const legacy=new PGlite();
 try {
  const sql=fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8');
  await legacy.exec(sql.slice(0,sql.indexOf('CREATE TABLE IF NOT EXISTS app_migrations')));
  const uid=crypto.randomUUID(),sid=crypto.randomUUID();
  await legacy.query('INSERT INTO users(id,google_sub,credits) VALUES($1,$2,44)',[uid,'legacy']);
  await legacy.query("INSERT INTO sessions(id,join_code,user_id,status,ended_at) VALUES($1,'legacy',$2,'ended',now()-interval '90 days')",[sid,uid]);
  await legacy.query("INSERT INTO transcript_lines(session_id,seq,original_text) VALUES($1,1,'first'),($1,1,'tail')",[sid]);
  await legacy.query('INSERT INTO usage_ledger(session_id,user_id,credits_charged,target_lang_count,balance_after) VALUES($1,$2,3,1,44)',[sid,uid]);
  await legacy.exec(sql);
  const lines=(await legacy.query('SELECT seq,original_text FROM transcript_lines ORDER BY seq')).rows;
  assert.deepEqual(lines,[{seq:1,original_text:'first'},{seq:2,original_text:'tail'}]);
  const row=(await legacy.query('SELECT next_seq,expires_at FROM sessions')).rows[0];assert.equal(Number(row.next_seq),3);assert.ok(new Date(row.expires_at).getTime()>Date.now()+29*86400000);
  assert.equal((await legacy.query('SELECT source_session_id FROM usage_ledger')).rows[0].source_session_id,sid);
  assert.equal((await legacy.query('SELECT credits FROM account_opening_balances')).rows[0].credits,44);
 } finally {await legacy.close();}
});
