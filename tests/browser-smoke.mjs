import { test, mock, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import { WebSocket } from 'ws';
import { attachAudioRelay } from '../audio-relay.js';

// Isolated fixtures: never load .env, call Google/Soniox/Claude or connect
// to the deployment database. Real Express sessions and real local sockets.
mock.module('dotenv/config', { namedExports: {} });
process.env.SONIOX_API_KEY = 'test-server-only-key';
process.env.SESSION_SECRET = 'test-cookie-secret';
process.env.NODE_ENV = 'test';
process.env.OPEN_SIGNUP = 'false';
process.env.LOGIN_ALLOWLIST = 'tester@example.invalid';
process.env.GOOGLE_LOGIN_CLIENT_ID = '';
process.env.GOOGLE_LOGIN_CLIENT_SECRET = '';
const transcriptRows=new Map();
const meters=new Map();
const rows = new Map();
const balances = new Map([['user-a', 50], ['user-b', 50]]);
let debits = 0;
const exports = Object.fromEntries([...fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8').matchAll(/export async function (\w+)/g)].map((match) => [match[1], async () => null]));
Object.assign(exports, {
  pool: null,
  dbCommitTranscript: async(id,msg)=>{const lines=transcriptRows.get(id)||[];const old=lines.find(x=>x.client_message_id===msg.clientMessageId);if(old)return {row:old,inserted:false};const row={seq:lines.length+1,ts:new Date(msg.ts),original_text:msg.original,translations:msg.translations,client_message_id:msg.clientMessageId};lines.push(row);transcriptRows.set(id,lines);return {row,inserted:true};},
  dbGetSessionTranscript: async id=>({...rows.get(id),cleaned_transcript:null}),
  dbGetRawTranscript: async id=>transcriptRows.get(id)||[],
  dbGetBillingHistory: async()=>({orders:[],entries:[]}),
  dbGetAudioMeter: async (id,rate) => meters.get(id+':'+rate)||{processedMs:0,paidMinutes:0},
  dbSaveAudioMeter: async (id,rate,ms) => {const m=meters.get(id+':'+rate);if(m)m.processedMs=ms.processedMs;},
  dbGetUserById: async (id) => balances.has(id) ? { id, name: id } : null,
  dbGetUserCredits: async (id) => balances.get(id),
  dbInsertSession: async (row) => rows.set(row.id, { ...row, user_id: row.userId, join_code: row.joinCode, status: 'created' }),
  dbGetSessionOwner: async (id) => rows.get(id),
  dbGetSessionById: async (id) => rows.get(id),
  dbGetSessionsByUser: async () => [],
  dbChargeSessionMinute: async (userId, sessionId, rate, minute) => {
    meters.set(sessionId+':'+rate,{processedMs:0,paidMinutes:minute});
    assert.equal(rows.get(sessionId).user_id, userId);
    if (balances.get(userId) < rate) return null;
    debits++; balances.set(userId, balances.get(userId) - rate); return balances.get(userId);
  },
});
mock.module(new URL('../db.js', import.meta.url).href, { namedExports: exports });
mock.module(new URL('../transcript-cleanup.js', import.meta.url).href, { namedExports: { runTranscriptCleanup: async () => {}, startCleanupWorker: () => () => {} } });
mock.module(new URL('../mail.js', import.meta.url).href, { namedExports: { sendOrderNotificationEmail: async () => {}, sendOrderCreatedEmail: async () => {} } });
class Provider extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  send(data, options) {
    if (options?.binary && data.length) this.emit('message', Buffer.from(JSON.stringify({ tokens: [], total_audio_proc_ms: 1000 })));
    if (String(data) === '') this.emit('message', Buffer.from(JSON.stringify({tokens:[],total_audio_proc_ms:1000,finished:true})));
    if (!options) assert.equal(JSON.parse(String(data)).api_key, 'test-server-only-key');
  }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
}
mock.module(new URL('../audio-relay.js', import.meta.url).href, { namedExports: {
  attachAudioRelay: (client, options) => attachAudioRelay(client, {
    ...options,
    createUpstream: () => { const provider = new Provider(); setImmediate(() => { provider.readyState = 1; provider.emit('open'); }); return provider; },
  }),
} });
const { server, sessionStore, sessions } = await import('../server.js');

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_URL || 'playwright');
server.listen(0,'127.0.0.1'); await once(server,'listening');
const base='http://127.0.0.1:'+server.address().port;
const id='user-a';
await new Promise((resolve,reject)=>sessionStore.set(id,{cookie:{originalMaxAge:3600000,expires:new Date(Date.now()+3600000),httpOnly:true,path:'/'},passport:{user:id}},err=>err?reject(err):resolve()));
const sig=crypto.createHmac('sha256','test-cookie-secret').update(id).digest('base64').replace(/=+$/,'');
const value='s:'+id+'.'+sig;
const browser=await chromium.launch({headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
try {
  const guest=await browser.newContext(); const guestPage=await guest.newPage();
  let prompts=0; const errors=[];
  guestPage.on('dialog',async d=>{prompts++;await d.dismiss();});
  guestPage.on('pageerror',e=>errors.push(e.message));
  await guestPage.goto(base+'/host');
  await guestPage.waitForFunction(()=>document.querySelector('#whoAmI').textContent.includes('訪客'));
  assert.equal(prompts,0);
  assert.match(await guestPage.locator('#sessionErrorText').textContent(),/訪客模式/);
  assert.deepEqual(errors,[]);
  console.log('PASS browser guest: no password, correct guest state, no JS errors');
  await guest.close();
  const denied=await browser.newContext();
  await denied.addCookies([{name:'connect.sid',value:encodeURIComponent(value),url:base,httpOnly:true}]);
  const creation=await denied.request.post(base+'/api/sessions'); const room=await creation.json();
  await denied.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Permission denied','NotAllowedError');};});
  const deniedPage=await denied.newPage(); deniedPage.on('pageerror',e=>errors.push(e.message));
  await deniedPage.goto(base+'/host?id='+room.id);
  await deniedPage.waitForFunction(()=>document.querySelector('#wsStatus').textContent.includes('connected'));
  await deniedPage.waitForTimeout(100);
  await deniedPage.locator('#startBtn').click();
  await deniedPage.waitForFunction(()=>document.querySelector('#status').textContent.includes('麥克風權限被拒絕'));
  assert.equal(debits,0); assert.equal(sessions.get(room.id).status,'created');
  assert.equal(await deniedPage.locator('#startBtn').isEnabled(),true);
  console.log('PASS browser microphone denied: zero debit, no live session, retry enabled');
  await denied.close();
  const live=await browser.newContext({permissions:['microphone']});
  await live.addCookies([{name:'connect.sid',value:encodeURIComponent(value),url:base,httpOnly:true}]);
  const page=await live.newPage(); page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/host?id='+room.id);
  await page.waitForFunction(()=>document.querySelector('#wsStatus').textContent.includes('connected'));
  await page.waitForTimeout(100);
  await page.locator('#startBtn').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='recording');
  assert.equal(debits,1); assert.equal(sessions.get(room.id).status,'live');
  assert.equal(await page.locator('#creditsDisplay').textContent(),'47');
  await page.locator('#stopBtn').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='idle');
  assert.equal(debits,1);
  await page.locator('#startBtn').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='recording');
  assert.equal(debits,1);
  console.log('PASS browser pause/resume: final result closes cleanly, paid minute is reused');
  fs.mkdirSync('.gstack/qa-reports/screenshots',{recursive:true});
  await page.screenshot({path:'.gstack/qa-reports/screenshots/mvp-fixed-host.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS browser real SDK + fake mic + local provider: first confirmed audio costs 3 points');
  await page.locator('#stopBtn').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='idle');
  const boxPage=await live.newPage();await boxPage.goto(base+'/privacy');
  await boxPage.evaluate(async()=>{const {TranscriptOutbox}=await import('/transcript-outbox.js');window.sent=[];window.warnings=[];window.box=await new TranscriptOutbox('browser-outbox-test',m=>window.sent.push(m),m=>window.warnings.push(m)).open();await box.add('尚未確認的尾句',{en:'tail'});clearInterval(box.timer);});
  await boxPage.reload();
  const result=await boxPage.evaluate(async()=>{const {TranscriptOutbox}=await import('/transcript-outbox.js');const sent=[];const warnings=[];const box=await new TranscriptOutbox('browser-outbox-test',m=>sent.push(m),m=>warnings.push(m)).open();await box.pump();const restored=box.items[0];await box.ack(restored.clientMessageId);await box.pump();const empty=box.items.length;box.items.push({clientMessageId:'expired',ts:Date.now()-300001});await box.pump();clearInterval(box.timer);return {original:restored.original,empty,gap:box.gap,warnings:warnings.length};});
  assert.deepEqual(result,{original:'尚未確認的尾句',empty:0,gap:true,warnings:1});
  console.log('PASS browser IndexedDB: reload preserves pending text, ACK removes it, expiration warns');
  await boxPage.goto(base+'/billing');await boxPage.waitForFunction(()=>document.querySelector('#credits').textContent==='47');
  assert.equal(await boxPage.locator('#entries table').count(),1);
  await boxPage.screenshot({path:'.gstack/qa-reports/screenshots/mvp-billing.png'});
  await boxPage.close();
  await live.close();
} finally {
  await browser.close(); server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
