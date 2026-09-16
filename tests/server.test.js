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
