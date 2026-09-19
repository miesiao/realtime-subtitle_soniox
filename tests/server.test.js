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
process.env.TOUR_EARLY_ACCESS_EMAILS = 'tester@example.invalid';
process.env.GOOGLE_LOGIN_CLIENT_ID = '';
process.env.GOOGLE_LOGIN_CLIENT_SECRET = '';
const tourRows=new Map();
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
  dbGetUserById: async (id) => balances.has(id) ? { id, name: id, email:id==='user-a'?'tester@example.invalid':'other@example.invalid' } : null,
  dbCreateTourGroup: async({id,userId,name,code})=>{const row={id,user_id:userId,name,code,status:'open',active_session_id:null,created_at:new Date()};tourRows.set(id,row);return row;},
  dbGetTourGroupsByUser: async(userId)=>[...tourRows.values()].filter(x=>x.user_id===userId),
  dbGetOpenTourGroups: async()=>[],
  dbGetTourGroupsForRouting: async()=>[],
  dbGetTourGroup: async(id,userId)=>tourRows.get(id)?.user_id===userId?tourRows.get(id):null,
  dbCreateTourSession: async({id,userId,groupId,joinCode,name})=>{const group=tourRows.get(groupId);if(!group||group.user_id!==userId)throw Error('tour_not_found');if(group.active_session_id)throw Error('tour_session_active');const row={id,user_id:userId,join_code:joinCode,name,status:'created',tour_group_id:groupId,next_seq:1,created_at:new Date()};rows.set(id,row);group.active_session_id=id;return row;},
  dbRotateTourGroup: async(id,userId,code)=>{const group=tourRows.get(id);if(!group||group.user_id!==userId)return null;if(group.active_session_id)throw Error('tour_session_active');group.code=code;return group;},
  dbCloseTourGroup: async(id,userId)=>{const group=tourRows.get(id);if(!group||group.user_id!==userId)return null;if(group.active_session_id)throw Error('tour_session_active');group.status='closed';return group;},
  dbMarkSessionEnded: async(id)=>{const row=rows.get(id);if(row){row.status='ended';row.ended_at=new Date();if(row.tour_group_id)tourRows.get(row.tour_group_id).active_session_id=null;}},
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
let base;
const clients = new Set();
const cookies = {};
before(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
  for (const id of ['user-a', 'user-b']) {
    await new Promise((resolve, reject) => sessionStore.set(id, { cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000), httpOnly: true, path: '/' }, passport: { user: id } }, (err) => err ? reject(err) : resolve()));
    const sig = crypto.createHmac('sha256', 'test-cookie-secret').update(id).digest('base64').replace(/=+$/, '');
    cookies[id] = 'connect.sid=' + encodeURIComponent('s:' + id + '.' + sig);
  }
});
afterEach(async () => {
  for (const client of clients) client.terminate(); clients.clear();
  await new Promise((resolve) => setTimeout(resolve, 15));
});
after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
async function room() {
  const res = await fetch(base + '/api/sessions', { method: 'POST', headers: { Cookie: cookies['user-a'] } });
  assert.equal(res.status, 200); return res.json();
}
function socket(path = '/', user = 'user-a', origin = base) {
  const ws = new WebSocket(base.replace('http', 'ws') + path, { headers: { Origin: origin, ...(user ? { Cookie: cookies[user] } : {}) } });
  clients.add(ws); return ws;
}
function message(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', listen); reject(new Error('Message timeout')); }, 1500);
    const listen = (raw) => { const data = JSON.parse(String(raw)); if (predicate(data)) { clearTimeout(timer); ws.off('message', listen); resolve(data); } };
    ws.on('message', listen);
  });
}
async function host(roomId, user = 'user-a') {
  const ws = socket('/', user); await once(ws, 'open');
  const result = message(ws, (m) => ['host_registered', 'register_error'].includes(m.type));
  ws.send(JSON.stringify({ type: 'register', role: 'host', sessionId: roomId }));
  return { ws, result: await result };
}
async function refused(ws, expected) {
  ws.on('error', () => {});
  const [req, res] = await once(ws, 'unexpected-response');
  assert.equal(res.statusCode, expected); res.resume(); req.destroy();
}

test('guest cannot create sessions or retrieve provider credentials', async () => {
  for (const path of ['/api/sessions', '/api/temporary-key']) {
    const res = await fetch(base + path, { method: 'POST' }); assert.equal(res.status, 401);
  }
});
test('retired key endpoint never issues keys even to a logged-in user', async () => {
  const res = await fetch(base + '/api/temporary-key', { method: 'POST', headers: { Cookie: cookies['user-a'] } });
  assert.equal(res.status, 410); assert.equal((await res.json()).api_key, undefined);
});
test('Google session owner can register; guest and other account cannot take over', async () => {
  const r = await room();
  assert.equal((await host(r.id, null)).result.reason, 'not_authorized');
  assert.equal((await host(r.id, 'user-b')).result.reason, 'not_authorized');
  assert.equal((await host(r.id)).result.type, 'host_registered');
});
test('second owner tab cannot replace the current host', async () => {
  const r = await room(); await host(r.id);
  assert.equal((await host(r.id)).result.reason, 'host_already_connected');
});
test('forged origin, anonymous audio and other-owner audio are rejected', async () => {
  const r = await room(); await host(r.id);
  await refused(socket('/', 'user-a', 'https://evil.invalid'), 403);
  await refused(socket('/audio?sessionId=' + r.id, null), 401);
  await refused(socket('/audio?sessionId=' + r.id, 'user-b'), 403);
});
test('audio requires registered host; ended sessions cannot resume', async () => {
  const r = await room();
  await refused(socket('/audio?sessionId=' + r.id), 409);
  sessions.get(r.id).status = 'ended';
  await refused(socket('/audio?sessionId=' + r.id), 403);
});
test('legacy host_start never starts billing or marks room live', async () => {
  const r = await room(), h = await host(r.id), before = debits;
  h.ws.send(JSON.stringify({ type: 'host_start', translateEnabled: true, targetLanguage: 'en' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(debits, before); assert.equal(sessions.get(r.id).status, 'created');
});
test('real socket round-trip starts billing only on provider-confirmed audio; one stream per user', async () => {
  const r = await room(), h = await host(r.id), before = debits;
  const audio = socket('/audio?sessionId=' + r.id); await once(audio, 'open');
  audio.send(JSON.stringify({ translation: { type: 'one_way', target_language: 'en' } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(debits, before);
  await refused(socket('/audio?sessionId=' + r.id), 409);
  const started = message(h.ws, (m) => m.type === 'recording_started');
  audio.send(Buffer.from('fake microphone data'));
  await started;
  assert.equal(debits, before + 1); assert.equal(sessions.get(r.id).status, 'live');
  const ended = once(audio, 'close');
  h.ws.send(JSON.stringify({ type: 'host_stop' }));
  await ended;
});
test('legacy pages redirect, and logged-in /host without id routes to session creation', async () => {
  for (const path of ['/single', '/index.html', '/host']) {
    const res = await fetch(base + path, { redirect: 'manual', headers: { Cookie: cookies['user-a'] } });
    assert.equal(res.status, 302); assert.equal(res.headers.get('location'), '/sessions');
  }
});
test('guest host page has no password prompt; homepage promises only implemented output', async () => {
  const hostSource = await (await fetch(base + '/host.js')).text();
  assert.doesNotMatch(hostSource, /window\.prompt|x-host-secret|fetchTemporaryKey/);
  const landing = await (await fetch(base + '/')).text();
  assert.doesNotMatch(landing, /紀要|3 種譯文/);
});

test('persisted transcript ACK replay is deduplicated; raw download is owner-only',async()=>{const r=await room();const {ws}=await host(r.id);sessions.get(r.id).status='paused';const data={type:'host_utterance',clientMessageId:'replay-test',ts:Date.now(),original:'保留最後一句',translations:{en:'tail'}};for(let i=0;i<2;i++){const ack=message(ws,m=>m.type==='utterance_ack');ws.send(JSON.stringify(data));await ack;}assert.equal(transcriptRows.get(r.id).length,1);assert.equal(sessions.get(r.id).history.length,1);const raw=await fetch(base+'/api/sessions/'+r.id+'/transcript/raw',{headers:{Cookie:cookies['user-a']}});assert.equal(raw.status,200);assert.match(await raw.text(),/保留最後一句/);const foreign=await fetch(base+'/api/sessions/'+r.id+'/transcript/raw',{headers:{Cookie:cookies['user-b']}});assert.equal(foreign.status,403);});

test('tour early access keeps one guest link across two rooms and isolates each transcript',async()=>{
  const headers={Cookie:cookies['user-a'],'Content-Type':'application/json'};
  const guestCreate=await fetch(base+'/api/tours',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'旅行團'})});
  assert.equal(guestCreate.status,401);
  const denied=await fetch(base+'/api/tours',{method:'POST',headers:{Cookie:cookies['user-b'],'Content-Type':'application/json'},body:JSON.stringify({name:'別人的團'})});
  assert.equal(denied.status,403);
  const created=await fetch(base+'/api/tours',{method:'POST',headers,body:JSON.stringify({name:'五日旅行'})});
  assert.equal(created.status,201);const group=await created.json();assert.equal(group.code.length,8);assert.match(group.viewerUrl,/\/live\?code=/);
  const viewer=socket('/',null);await once(viewer,'open');
  const waiting=message(viewer,m=>m.type==='session_status'&&m.status==='waiting');
  viewer.send(JSON.stringify({type:'register',role:'viewer',joinCode:group.code}));await waiting;
  const firstSwitch=message(viewer,m=>m.type==='viewer_registered'&&Boolean(m.sessionId));
  const firstResponse=await fetch(base+'/api/tours/'+group.id+'/sessions',{method:'POST',headers,body:JSON.stringify({name:'第一天上午'})});
  assert.equal(firstResponse.status,201);const first=await firstResponse.json();assert.equal((await firstSwitch).sessionId,first.id);
  const hostInfo=await fetch(base+'/api/sessions/'+first.id,{headers:{Cookie:cookies['user-a']}});
  assert.equal((await hostInfo.json()).viewerUrl,group.viewerUrl);
  const repeat=await fetch(base+'/api/tours/'+group.id+'/sessions',{method:'POST',headers,body:JSON.stringify({name:'不應重複'})});assert.equal(repeat.status,409);
  const foreignQr=await fetch(base+'/api/tours/'+group.id+'/qr',{headers:{Cookie:cookies['user-b']}});assert.equal(foreignQr.status,404);
  sessions.get(first.id).status='live';const firstHost=await host(first.id);
  const firstCaption=message(viewer,m=>m.type==='utterance'&&m.original==='第一場');
  firstHost.ws.send(JSON.stringify({type:'host_utterance',clientMessageId:'first',ts:Date.now(),original:'第一場',translations:{}}));await firstCaption;
  const backToWaiting=message(viewer,m=>m.type==='session_status'&&m.status==='waiting');
  const ended=await fetch(base+'/api/sessions/'+first.id+'/end',{method:'POST',headers});assert.equal(ended.status,200);await backToWaiting;
  const secondSwitch=message(viewer,m=>m.type==='viewer_registered'&&m.sessionId&&m.sessionId!==first.id);
  const secondResponse=await fetch(base+'/api/tours/'+group.id+'/sessions',{method:'POST',headers,body:JSON.stringify({name:'第二天下午'})});
  assert.equal(secondResponse.status,201);const second=await secondResponse.json();assert.equal((await secondSwitch).sessionId,second.id);
  assert.equal(second.viewerUrl,group.viewerUrl);
  sessions.get(second.id).status='live';const secondHost=await host(second.id);
  const secondCaption=message(viewer,m=>m.type==='utterance'&&m.original==='第二場');
  secondHost.ws.send(JSON.stringify({type:'host_utterance',clientMessageId:'second',ts:Date.now(),original:'第二場',translations:{}}));await secondCaption;
  assert.deepEqual(transcriptRows.get(first.id).map(x=>x.original_text),['第一場']);
  assert.deepEqual(transcriptRows.get(second.id).map(x=>x.original_text),['第二場']);
  const secondEnd=await fetch(base+'/api/sessions/'+second.id+'/end',{method:'POST',headers});assert.equal(secondEnd.status,200);
  const rotatedResponse=await fetch(base+'/api/tours/'+group.id+'/rotate',{method:'POST',headers});assert.equal(rotatedResponse.status,200);
  const rotated=await rotatedResponse.json();assert.notEqual(rotated.code,group.code);
  const expiredViewer=socket('/',null);await once(expiredViewer,'open');
  const invalid=message(expiredViewer,m=>m.type==='register_error');expiredViewer.send(JSON.stringify({type:'register',role:'viewer',joinCode:group.code}));assert.equal((await invalid).reason,'invalid_code');
  const newViewer=socket('/',null);await once(newViewer,'open');
  const newWaiting=message(newViewer,m=>m.type==='session_status');newViewer.send(JSON.stringify({type:'register',role:'viewer',joinCode:rotated.code}));assert.equal((await newWaiting).status,'waiting');
  const closed=await fetch(base+'/api/tours/'+group.id+'/close',{method:'POST',headers});assert.equal(closed.status,200);
  const lateViewer=socket('/',null);await once(lateViewer,'open');
  const closedState=message(lateViewer,m=>m.type==='session_status');lateViewer.send(JSON.stringify({type:'register',role:'viewer',joinCode:rotated.code}));
  assert.equal((await closedState).status,'closed');
});
