import { WebSocket } from 'ws';

const MINUTE_MS = 60_000;
const MAX_BUFFER = 512 * 1024;

// Meter only provider-confirmed audio. A closed/error-only connection costs
// no credits. Keep the meter per session AND rate across pause/reconnect so
// reconnecting does not round the same minute up a second time.
export class AudioMeter {
  constructor(charge, state = { processedMs: 0, paidMinutes: 0 }, save = async () => {}) {
    this.save = save;
    this.charge = charge;
    this.state = state;
    this.baseMs = state.processedMs;
    this.lastMs = 0;
  }

  async update(processedMs) {
    if (!Number.isFinite(processedMs) || processedMs < 0) throw new Error('Invalid audio progress');
    this.lastMs = Math.max(this.lastMs, processedMs);
    const totalMs = this.baseMs + this.lastMs;
    const minutes = Math.ceil(totalMs / MINUTE_MS);
    while (this.state.paidMinutes < minutes) {
      const balance = await this.charge(this.state.paidMinutes + 1);
      if (balance === null) {
        this.state.processedMs = Math.min(totalMs, this.state.paidMinutes * MINUTE_MS);
        await this.save(this.state);
        return false;
      }
      this.state.paidMinutes++;
    }
    this.state.processedMs = totalMs;
    await this.save(this.state);
    return true;
  }
}

export function relayConfig(input, languages) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid config');
  const config = {
    model: 'stt-rt-v5', audio_format: 'auto',
    enable_language_identification: true, enable_endpoint_detection: true,
  };
  if (input.translation !== undefined) {
    if (input.translation?.type !== 'one_way' || !languages.has(input.translation.target_language)) {
      throw new Error('Invalid translation language');
    }
    config.translation = { type: 'one_way', target_language: input.translation.target_language };
  }
  if (input.language_hints !== undefined) {
    if (!Array.isArray(input.language_hints) || input.language_hints.length > 10 ||
        !input.language_hints.every((lang) => languages.has(lang))) throw new Error('Invalid language hints');
    config.language_hints = input.language_hints;
  }
  if (input.context?.terms !== undefined) {
    const terms = input.context.terms;
    if (!Array.isArray(terms) || terms.length > 100 ||
        !terms.every((term) => typeof term === 'string' && term.length <= 100)) throw new Error('Invalid terms');
    config.context = { terms };
  }
  // Never forward client api_key, model, alternate translation modes or
  // other cost-affecting options. This service supports one translation.
  return config;
}

// The browser holds no Soniox credential. Closing this relay closes the
// upstream too, including when a modified browser ignores a pause message.
export function attachAudioRelay(client, {
  apiKey, languages, getCredits, charge, meterStates, onStarted, onStopped,
  loadMeter, saveMeter = async () => {},
  onInsufficient, createUpstream = () => new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket'),
  now = Date.now, idleMs = 15_000, maxMs = 2 * 60 * MINUTE_MS,
}) {
  let upstream;
  let configured = false;
  let closed = false;
  let finished = false;
  let started = false;
  let queue = [];
  let queuedBytes = 0;
  let lastAudioAt = now();
  let lastProgressAt = now();
  let lastProgress = 0;
  let meter;
  let config;
  let chain = Promise.resolve();
  const beganAt = now();

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(watchdog);
    queue = [];
    upstream?.terminate();
    if (client.readyState === WebSocket.OPEN) client.close();
    // Drain already received provider progress before releasing the user's
    // single-stream slot; reconnect cannot race the previous debit.
    chain.finally(() => onStopped()).catch(() => {});
  }
  function fail(code, message) {
    if (closed) return;
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({
      tokens: [], error_code: code, error_message: message,
    }));
    close();
  }
  const watchdog = setInterval(() => {
    if (now() - beganAt > maxMs) return fail(408, '已達單次連線上限，請重新開始');
    if (now() - lastAudioAt > idleMs || now() - lastProgressAt > idleMs) {
      fail(408, '收音或語音服務已中斷，請重新開始');
    }
  }, Math.min(1000, idleMs));
  watchdog.unref?.();

  function forward(data, binary) {
    if (closed) return;
    if (upstream?.readyState === WebSocket.OPEN) {
      if (upstream.bufferedAmount > MAX_BUFFER) return fail(429, '音訊傳送過快，請重新開始');
      upstream.send(data, { binary });
    } else {
      queuedBytes += data.length;
      if (queuedBytes > MAX_BUFFER) return fail(429, '音訊緩衝已滿，請重新開始');
      queue.push([data, binary]);
    }
  }

  client.on('message', (raw, binary) => {
    if (closed || finished) return;
    if (!configured) {
      configured = true;
      if (binary || raw.length > 16_384) return fail(400, 'Invalid audio configuration');
      try { config = relayConfig(JSON.parse(raw.toString()), languages); }
      catch { return fail(400, 'Invalid audio configuration'); }
      const rate = config.translation ? 3 : 2;

      // Read-only preflight. First debit happens on positive provider progress.
      Promise.all([getCredits(), loadMeter ? loadMeter(rate) : (meterStates[rate] ||= {processedMs:0,paidMinutes:0})]).then(([credits,state]) => {
        meterStates[rate] = state;
        meter = new AudioMeter((minute) => charge(rate,minute), state, (value) => saveMeter(rate,value));
        if (closed) return;
        const hasPaidRemainder = state.processedMs < state.paidMinutes * MINUTE_MS;
        if (credits === null || (!hasPaidRemainder && credits < rate)) {
          onInsufficient(credits);
          return fail(402, '點數不足，請先儲值');
        }
        upstream = createUpstream();
        upstream.on('error', () => fail(503, '語音服務連線失敗，請稍後重試'));
        upstream.on('open', () => {
          if (closed) return upstream.terminate();
          upstream.send(JSON.stringify({ ...config, api_key: apiKey }));
          for (const [data, isBinary] of queue) forward(data, isBinary);
          queue = [];
          queuedBytes = 0;
        });
        upstream.on('message', (rawResult) => {
          chain = chain.then(async () => {
            const result = JSON.parse(rawResult.toString());
            if (result.error_code) return fail(result.error_code, '語音服務無法處理音訊，請稍後重試');
            const progress = result.total_audio_proc_ms ?? 0;
            if (progress > lastProgress) {
              lastProgress = progress;
              lastProgressAt = now();
              if (!(await meter.update(progress))) {
                onInsufficient(0);
                return fail(402, '點數不足，已停止收音');
              }
              if (!started && !closed) {
                started = true;
                await onStarted(config);
              }
            }
            if (!closed && client.readyState === WebSocket.OPEN) client.send(rawResult.toString());
            if (result.finished) close();
          }).catch(() => fail(503, '計費或語音服務暫時無法使用，已停止收音'));
        });
        upstream.on('close', () => {
          chain = chain.then(() => close());
        });
      }).catch(() => fail(503, '無法確認餘額，請稍後重試'));
      return;
    }
    if (binary && raw.length) {
      lastAudioAt = now();
      forward(raw, true);
    } else if (raw.length === 0) {
      finished = true;
      forward(raw, binary);
    } else if (!binary && raw.length < 256) {
      try {
        const command = JSON.parse(raw.toString());
        if (!['keepalive', 'finalize'].includes(command.type)) throw new Error('Invalid control');
        forward(Buffer.from(JSON.stringify({ type: command.type })), false);
      } catch { fail(400, 'Invalid audio control'); }
    } else fail(400, 'Invalid audio frame');
  });
  client.on('close', close);
  client.on('error', close);
  return { close, get done() { return chain; } };
}
