import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AudioMeter, attachAudioRelay, relayConfig } from '../audio-relay.js';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  send(data, options) { this.sent.push({ data: String(data), options }); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  receive(data, binary = false) { this.emit('message', Buffer.from(typeof data === 'object' ? JSON.stringify(data) : data), binary); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup(t, overrides = {}) {
  const client = new Socket();
  const upstream = new Socket();
  upstream.readyState = 0;
  let charged = 0, stopped = 0, started = 0, created = 0;
  const relay = attachAudioRelay(client, {
    apiKey: 'private-server-key', languages: new Set(['en', 'zh']),
    getCredits: async () => 50, charge: async () => { charged++; return 50 - charged * 3; },
    meterStates: {}, onStarted: async () => { started++; }, onStopped: () => { stopped++; },
    onInsufficient: () => {}, createUpstream: () => { created++; return upstream; },
    ...overrides,
  });
  t.after(() => relay.close());
  return { client, upstream, relay, counts: () => ({ charged, stopped, started, created }) };
}
async function connect(fixture) {
  fixture.client.receive({ api_key: 'untrusted', translation: { type: 'one_way', target_language: 'en' } });
  await tick();
  fixture.upstream.readyState = 1;
  fixture.upstream.emit('open');
}

test('no audio / zero progress does not debit; boundaries and duplicate progress debit exactly once', async () => {
  let charges = 0;
  const meter = new AudioMeter(async () => { charges++; return 100; });
  await meter.update(0); assert.equal(charges, 0);
  await meter.update(1); await meter.update(1); await meter.update(0); assert.equal(charges, 1);
  await meter.update(60_000); assert.equal(charges, 1);
  await meter.update(60_001); assert.equal(charges, 2);
  await assert.rejects(meter.update(NaN));
});

test('pause/reconnect consumes remaining paid minute without charging again', async () => {
  const state = { processedMs: 0, paidMinutes: 0 };
  let charges = 0;
  const charge = async () => { charges++; return 0; };
  await new AudioMeter(charge, state).update(30_000);
  const resumed = new AudioMeter(charge, state);
  await resumed.update(30_000); assert.equal(charges, 1);
  await resumed.update(30_001); assert.equal(charges, 2);
});

test('no balance cannot advance the meter or manufacture a paid minute', async () => {
  const state = { processedMs: 0, paidMinutes: 0 };
  assert.equal(await new AudioMeter(async () => null, state).update(500), false);
  assert.deepEqual(state, { processedMs: 0, paidMinutes: 0 });
});

test('config ignores provider keys/model and restricts translation to one supported language', () => {
  const languages = new Set(['en']);
  const config = relayConfig({ api_key: 'evil', model: 'expensive', translation: { type: 'one_way', target_language: 'en' } }, languages);
  assert.equal(config.api_key, undefined); assert.equal(config.model, 'stt-rt-v5');
  assert.throws(() => relayConfig({ translation: { type: 'two_way', target_language: 'en' } }, languages));
  assert.throws(() => relayConfig({ translation: { type: 'one_way', target_language: 'unknown' } }, languages));
  assert.throws(() => relayConfig({ language_hints: ['unknown'] }, languages));
  assert.throws(() => relayConfig({ context: { terms: ['x'.repeat(101)] } }, languages));
});

test('microphone denied before config: no upstream, no debit', async (t) => {
  const f = setup(t);
  f.client.close(); await tick();
  assert.deepEqual(f.counts(), { charged: 0, started: 0, stopped: 1, created: 0 });
});

test('upstream connect/config error and empty result never debit', async (t) => {
  const f = setup(t); await connect(f);
  f.upstream.receive({ tokens: [], total_audio_proc_ms: 0 }); await tick();
  f.upstream.receive({ error_code: 400, error_message: 'bad config' }); await tick();
  assert.equal(f.counts().charged, 0);
  assert.equal(f.client.readyState, 3);
  assert.equal(f.upstream.readyState, 3);
});

test('last affordable minute works; next minute stops upstream even when client ignores force_pause', async (t) => {
  let balance = 3;
  const f = setup(t, {
    getCredits: async () => balance,
    charge: async (rate) => { if (balance < rate) return null; balance -= rate; return balance; },
  });
  await connect(f); assert.equal(balance, 3);
  f.upstream.receive({ tokens: [], total_audio_proc_ms: 100 }); await tick();
  assert.equal(balance, 0); assert.equal(f.client.readyState, 1);
  f.upstream.receive({ tokens: [], total_audio_proc_ms: 60_000 }); await tick();
  assert.equal(f.client.readyState, 1);
  f.upstream.receive({ tokens: [], total_audio_proc_ms: 60_001 }); await tick();
  assert.equal(f.client.readyState, 3); assert.equal(f.upstream.readyState, 3);
  assert.equal(f.counts().started, 1);
});

test('zero credits with an unused paid remainder can reconnect', async (t) => {
  const f = setup(t, {
    getCredits: async () => 0,
    meterStates: { 3: { processedMs: 1000, paidMinutes: 1 } },
    charge: async () => { throw new Error('must not debit'); },
  });
  await connect(f);
  f.upstream.receive({ tokens: [], total_audio_proc_ms: 1000 }); await tick();
  assert.equal(f.client.readyState, 1); assert.equal(f.counts().started, 1);
});

test('zero credits without paid remainder rejects before opening provider socket', async (t) => {
  const f = setup(t, { getCredits: async () => 0 });
  f.client.receive({}); await tick();
  assert.equal(f.counts().created, 0); assert.equal(f.client.readyState, 3);
});

test('database failure closes both ends and does not start live session', async (t) => {
  const f = setup(t, { charge: async () => { throw new Error('db unavailable'); } });
  await connect(f); f.upstream.receive({ tokens: [], total_audio_proc_ms: 100 }); await tick();
  assert.equal(f.counts().started, 0); assert.equal(f.upstream.readyState, 3);
});

test('concurrent provider progress serializes debit; duplicate results do not race', async (t) => {
  let debit = 0;
  const f = setup(t, { charge: async () => { await tick(); debit++; return 50; } });
  await connect(f);
  for (let i = 0; i < 10; i++) f.upstream.receive({ tokens: [], total_audio_proc_ms: 100 });
  await f.relay.done;
  assert.equal(debit, 1); assert.equal(f.counts().started, 1);
});

test('disconnect drains pending debit before releasing the single-user slot', async (t) => {
  let resolveCharge, stopped = false;
  const f = setup(t, { charge: () => new Promise((resolve) => { resolveCharge = resolve; }), onStopped: () => { stopped = true; } });
  await connect(f); f.upstream.receive({ tokens: [], total_audio_proc_ms: 100 }); await tick();
  f.client.close(); await tick(); assert.equal(stopped, false);
  resolveCharge(47); await tick(); assert.equal(stopped, true);
});

test('binary audio buffered before upstream open is forwarded after server-only config', async (t) => {
  const f = setup(t);
  f.client.receive({ api_key: 'client-secret', model: 'evil' });
  f.client.receive('audio bytes', true); await tick();
  f.upstream.readyState = 1; f.upstream.emit('open');
  assert.equal(JSON.parse(f.upstream.sent[0].data).api_key, 'private-server-key');
  assert.equal(f.upstream.sent[1].data, 'audio bytes');
  assert.equal(f.counts().charged, 0);
});

test('finished result reaches SDK before the sockets close', async (t) => {
  const f = setup(t); await connect(f);
  f.client.receive('');
  f.upstream.receive({ tokens: [], total_audio_proc_ms: 500, finished: true }); await tick();
  assert.equal(f.counts().charged, 1);
  assert.equal(JSON.parse(f.client.sent.at(-1).data).finished, true);
  assert.equal(f.counts().stopped, 1);
});

test('missing audio/provider progress is bounded by watchdog without debit', async (t) => {
  const f = setup(t, { idleMs: 20 }); await connect(f);
  await new Promise((resolve) => setTimeout(resolve, 65));
  assert.equal(f.client.readyState, 3); assert.equal(f.counts().charged, 0);
});
