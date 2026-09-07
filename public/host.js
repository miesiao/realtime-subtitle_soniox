import { SonioxClient } from '/vendor/soniox-client.mjs';
import * as OpenCC from '/vendor/opencc-cn2t.mjs';

// --- Host password gate (protects the one endpoint that costs money) ------
// Not a real account system — just a shared password kept in localStorage.
// Asked immediately on page load (not lazily on first recording) so a host
// can't get halfway into the UI before hitting the gate.
const HOST_SECRET_STORAGE_KEY = 'hostSecret';

function getStoredHostSecret() {
  return localStorage.getItem(HOST_SECRET_STORAGE_KEY);
}

function promptForHostSecret() {
  const secret = window.prompt('請輸入密碼：') || '';
  localStorage.setItem(HOST_SECRET_STORAGE_KEY, secret);
  return secret;
}

function clearStoredHostSecret() {
  localStorage.removeItem(HOST_SECRET_STORAGE_KEY);
}

let hostSecret = getStoredHostSecret();
if (!hostSecret) hostSecret = promptForHostSecret();

// Soniox's language codes only have generic "zh" — no zh-Hant/zh-Hans, and
// there is no API parameter to force Traditional output. In practice the
// model often emits Simplified. So we force-convert everything to
// Traditional (Taiwan phrasing) here, before it ever leaves the host —
// per spec §4.5 this conversion happens in exactly one place, and for
// step 2 that place is the host (not the server).
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });

// --- Traditional/Simplified Chinese heuristic (diagnostic badge only) -----
const HANZI_PAIRS = [
  ['國','国'],['學','学'],['語','语'],['漢','汉'],['灣','湾'],
  ['電','电'],['腦','脑'],['網','网'],['絡','络'],['資','资'],
  ['訊','讯'],['經','经'],['濟','济'],['開','开'],['發','发'],
  ['這','这'],['麼','么'],['說','说'],['話','话'],['書','书'],
  ['寫','写'],['歷','历'],['藝','艺'],['醫','医'],['實','实'],
  ['驗','验'],['計','计'],['劃','划'],['業','业'],['務','务'],
  ['財','财'],['議','议'],['報','报'],['處','处'],['車','车'],
  ['輛','辆'],['銀','银'],['貨','货'],['幣','币'],['營','营'],
  ['農','农'],['東','东'],['買','买'],['賣','卖'],['讀','读'],
  ['長','长'],['門','门'],['問','问'],['間','间'],['樂','乐'],
  ['見','见'],['覺','觉'],['認','认'],['識','识'],['動','动'],
  ['現','现'],['場','场'],['應','应'],['對','对'],['從','从'],
  ['為','为'],['個','个'],['們','们'],['來','来'],['還','还'],
  ['沒','没'],['時','时'],['會','会'],['與','与'],['讓','让'],
  ['種','种'],['樣','样'],['樓','楼'],['頭','头'],['顯','显'],
  ['龍','龙'],['鳥','鸟'],['馬','马'],['魚','鱼'],['飛','飞'],
  ['風','风'],['點','点'],['熱','热'],['燈','灯'],['廣','广'],
  ['廠','厂'],['歲','岁'],['歸','归'],['殺','杀'],['氣','气'],
  ['溫','温'],['滿','满'],['準','准'],['關','关'],['聽','听'],
  ['聲','声'],['興','兴'],['歡','欢'],['歐','欧'],['澤','泽'],
];
const TRAD_SET = new Set(HANZI_PAIRS.map((p) => p[0]));
const SIMP_SET = new Set(HANZI_PAIRS.map((p) => p[1]));

function detectHanziScript(text) {
  let trad = 0;
  let simp = 0;
  for (const ch of text) {
    if (TRAD_SET.has(ch)) trad++;
    else if (SIMP_SET.has(ch)) simp++;
  }
  if (trad === 0 && simp === 0) return null;
  return trad >= simp ? '繁體 Traditional' : '簡體 Simplified';
}

// --- DOM refs -------------------------------------------------------------
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');
const endSessionBtn = document.getElementById('endSessionBtn');
const targetLangSelect = document.getElementById('targetLang');
const termsInput = document.getElementById('terms');
const statusEl = document.getElementById('status');
const wsStatusEl = document.getElementById('wsStatus');
const viewerCountEl = document.getElementById('viewerCount');
const originalTextEl = document.getElementById('originalText');
const translationTextEl = document.getElementById('translationText');
const originalScriptEl = document.getElementById('originalScript');
const translationScriptEl = document.getElementById('translationScript');
const sentLogEl = document.getElementById('sentLog');
const joinCodeEl = document.getElementById('joinCode');
const viewerLinkEl = document.getElementById('viewerLink');
const qrImgEl = document.getElementById('qrImg');
const sessionErrorEl = document.getElementById('sessionError');
const sessionErrorTextEl = document.getElementById('sessionErrorText');
const retrySessionBtn = document.getElementById('retrySessionBtn');
const sessionNameInput = document.getElementById('sessionNameInput');
const renameBtn = document.getElementById('renameBtn');
const renameStatusEl = document.getElementById('renameStatus');
const transcriptSectionEl = document.getElementById('transcriptSection');
const transcriptStatusEl = document.getElementById('transcriptStatus');
const transcriptTextEl = document.getElementById('transcriptText');
const retryTranscriptBtn = document.getElementById('retryTranscriptBtn');
const downloadTranscriptBtn = document.getElementById('downloadTranscriptBtn');

const LANG_CLASS = { zh: 'lang-zh', en: 'lang-en', es: 'lang-es' };
function langClass(lang) {
  return LANG_CLASS[lang] || 'lang-other';
}

// --- Server WS connection (host role) --------------------------------------
// Independent of Soniox recording state — connects on page load so host can
// see viewer count immediately, and so host_utterance sends have somewhere
// to go the moment a segment finalizes.
//
// Auto-reconnects with the same exponential backoff as /viewer2 (1s → 2s →
// 4s → 8s, capped at 10s, then fixed 10s retries) — but unlike viewer's
// low-key banner, a host disconnect means EVERY viewer goes dark, so this
// gets a loud, impossible-to-miss warning instead (see hostDisconnectBannerEl).
//
// Declared here (above session creation) rather than below it: initSession()
// calls connectWs() as soon as a session exists, and connectWs() closes over
// ws/wsReconnectTimer/wsReconnectAttempt below — those `let` bindings must
// already be past their temporal dead zone by the time that call happens, or
// it throws a ReferenceError.
const hostDisconnectBannerEl = document.getElementById('hostDisconnectBanner');
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 10000;
let ws = null;
let wsReconnectTimer = null;
let wsReconnectAttempt = 0;

function nextWsReconnectDelay() {
  const delay = Math.min(WS_RECONNECT_BASE_MS * (2 ** wsReconnectAttempt), WS_RECONNECT_MAX_MS);
  wsReconnectAttempt++;
  return delay;
}

function showHostDisconnectBanner() {
  hostDisconnectBannerEl.classList.add('visible');
}

function hideHostDisconnectBanner() {
  hostDisconnectBannerEl.classList.remove('visible');
}

function connectWs() {
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = null;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);

  ws.addEventListener('open', () => {
    wsReconnectAttempt = 0;
    wsStatusEl.textContent = 'ws: connected';
    hideHostDisconnectBanner();
    ws.send(JSON.stringify({ type: 'register', role: 'host', sessionId: currentSession.id }));
  });
  ws.addEventListener('close', () => {
    wsStatusEl.textContent = 'ws: disconnected';
    showHostDisconnectBanner();
    wsReconnectTimer = setTimeout(connectWs, nextWsReconnectDelay());
  });
  ws.addEventListener('error', () => {
    wsStatusEl.textContent = 'ws: error';
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'viewer_count') {
      viewerCountEl.textContent = `viewers: ${msg.count}`;
    } else if (msg.type === 'register_error') {
      wsStatusEl.textContent = `ws: register failed (${msg.reason})`;
    }
  });
}

// --- Session creation (SPEC §2/§4: internal id + public join_code + QR) ----
// One session per page load — "開一場即生成新亂碼網址", Meet-mode. The
// internal id only ever travels over this authenticated fetch response and
// this page's own WS registration; it never gets embedded in the QR/viewer
// link (that's `joinCode`, the capability-based ticket — see §3).
let currentSession = null; // { id, joinCode, viewerUrl, qrDataUrl }

function requestCreateSession(secret) {
  return fetch('/api/sessions', {
    method: 'POST',
    headers: { 'x-host-secret': secret },
  });
}

async function createSession() {
  let res = await requestCreateSession(hostSecret);
  if (res.status === 401) {
    clearStoredHostSecret();
    alert('密碼錯誤，請重新輸入');
    hostSecret = promptForHostSecret();
    res = await requestCreateSession(hostSecret);
  }
  if (!res.ok) throw new Error('Failed to create session');
  return res.json();
}

function renderSession(session) {
  joinCodeEl.textContent = session.joinCode;
  viewerLinkEl.href = session.viewerUrl;
  viewerLinkEl.textContent = session.viewerUrl;
  sessionNameInput.value = session.name || '';
  if (session.qrDataUrl) {
    qrImgEl.src = session.qrDataUrl;
    qrImgEl.hidden = false;
  }
}

// Generic authenticated JSON fetch for the phase-2 host-only endpoints
// (rename, transcript status/retry) — same 401-reprompt pattern as
// requestCreateSession/requestTemporaryKey above.
async function hostFetchJson(url, options = {}) {
  const doFetch = (secret) => fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), 'x-host-secret': secret },
  });
  let res = await doFetch(hostSecret);
  if (res.status === 401) {
    clearStoredHostSecret();
    alert('密碼錯誤，請重新輸入');
    hostSecret = promptForHostSecret();
    res = await doFetch(hostSecret);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

renameBtn.addEventListener('click', async () => {
  if (!currentSession) return;
  const name = sessionNameInput.value.trim();
  if (!name) { renameStatusEl.textContent = '名稱不可為空'; return; }
  renameBtn.disabled = true;
  renameStatusEl.textContent = '改名中…';
  try {
    const result = await hostFetchJson(`/api/sessions/${currentSession.id}/name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    currentSession.name = result.name;
    renameStatusEl.textContent = '已更新';
  } catch (err) {
    console.error('Rename failed:', err);
    renameStatusEl.textContent = `改名失敗：${err.message}`;
  } finally {
    renameBtn.disabled = false;
  }
});

// --- Post-session transcript status (SPEC §6.5 points 5/6) ------------------
// Single-session view only — no "my sessions" list, that's phase 3. Starts
// polling right after host_end_session is sent; keeps polling while
// processing_status is null/'processing', stops once it settles into
// 'ready' or 'failed'.
let transcriptPollTimer = null;
const TRANSCRIPT_POLL_MS = 3000;
const TRANSCRIPT_STATUS_LABELS = { processing: '整理中…', ready: '完成，可下載', failed: '整理失敗' };

function renderTranscriptStatus(data) {
  transcriptSectionEl.hidden = false;
  transcriptStatusEl.textContent = TRANSCRIPT_STATUS_LABELS[data.processingStatus] || '準備中…';
  retryTranscriptBtn.hidden = data.processingStatus !== 'failed';
  if (data.processingStatus === 'ready' && data.cleanedTranscript) {
    transcriptTextEl.textContent = data.cleanedTranscript;
    downloadTranscriptBtn.hidden = false;
    downloadTranscriptBtn.onclick = () => {
      const blob = new Blob([data.cleanedTranscript], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${data.name || 'transcript'}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    };
  } else {
    transcriptTextEl.textContent = '';
    downloadTranscriptBtn.hidden = true;
  }
}

async function pollTranscriptStatus() {
  if (!currentSession) return;
  try {
    const data = await hostFetchJson(`/api/sessions/${currentSession.id}/transcript`);
    renderTranscriptStatus(data);
    if (data.processingStatus !== 'ready' && data.processingStatus !== 'failed') {
      transcriptPollTimer = setTimeout(pollTranscriptStatus, TRANSCRIPT_POLL_MS);
    }
  } catch (err) {
    console.error('Transcript status fetch failed:', err);
    transcriptStatusEl.textContent = `查詢失敗：${err.message}`;
    transcriptPollTimer = setTimeout(pollTranscriptStatus, TRANSCRIPT_POLL_MS);
  }
}

function startTranscriptPolling() {
  clearTimeout(transcriptPollTimer);
  transcriptSectionEl.hidden = false;
  transcriptStatusEl.textContent = '準備中…';
  pollTranscriptStatus();
}

retryTranscriptBtn.addEventListener('click', async () => {
  if (!currentSession) return;
  retryTranscriptBtn.disabled = true;
  try {
    await hostFetchJson(`/api/sessions/${currentSession.id}/transcript/retry`, { method: 'POST' });
    startTranscriptPolling();
  } catch (err) {
    console.error('Retry failed:', err);
    transcriptStatusEl.textContent = `重試失敗：${err.message}`;
  } finally {
    retryTranscriptBtn.disabled = false;
  }
});

// A failure here (bad password entered twice, server briefly unreachable,
// etc.) must NOT silently kill the rest of this module — as a top-level
// await, an uncaught rejection here would stop every statement below it
// from ever running (WS connect, Start/Stop/End wiring, all of it), leaving
// a host staring at a page that looks loaded but does nothing, with no
// visible error. So this is caught, surfaced on-page, and retryable instead.
async function initSession() {
  try {
    currentSession = await createSession();
    renderSession(currentSession);
    sessionErrorEl.hidden = true;
    connectWs();
  } catch (err) {
    console.error('Failed to create session:', err);
    joinCodeEl.textContent = '（尚未建立）';
    sessionErrorTextEl.textContent = `建立場次失敗：${err.message}`;
    sessionErrorEl.hidden = false;
  }
}
retrySessionBtn.addEventListener('click', () => { initSession(); });

await initSession();

function logSent(original, translations) {
  const line = document.createElement('div');
  line.textContent = `→ ${original}  ⇒  ${JSON.stringify(translations)}`;
  sentLogEl.appendChild(line);
  sentLogEl.scrollTop = sentLogEl.scrollHeight;
}

// Send one finalized segment to the server as the §3 contract's raw
// ingredients — server stamps id/ts and broadcasts. handleResult already
// mirrors 'none'-status (passthrough) tokens into `translation`, so this
// empty-string fallback is just a last-resort backstop (e.g. a pair that
// somehow closed with zero tokens at all) — it should rarely fire in
// practice, but still guarantees viewers never see an empty line.
function sendUtterance(original, translation) {
  const trimmedOriginal = original.trim();
  if (!trimmedOriginal) return;
  const target = targetLangSelect.value;
  const translations = { [target]: (translation.trim() || trimmedOriginal) };
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'host_utterance', original: trimmedOriginal, translations }));
  }
  logSent(trimmedOriginal, translations);
}

function requestTemporaryKey(secret) {
  return fetch('/api/temporary-key', {
    method: 'POST',
    headers: { 'x-host-secret': secret },
  });
}

async function fetchTemporaryKey() {
  let res = await requestTemporaryKey(hostSecret);
  if (res.status === 401) {
    clearStoredHostSecret();
    alert('密碼錯誤，請重新輸入');
    hostSecret = promptForHostSecret();
    res = await requestTemporaryKey(hostSecret);
  }
  if (!res.ok) throw new Error('Failed to fetch temporary key from server');
  const { api_key } = await res.json();
  return api_key;
}

// --- Soniox client (temporary key fetched fresh per recording session) --
const client = new SonioxClient({
  config: async () => {
    const api_key = await fetchTemporaryKey();
    return { api_key };
  },
});

let recording = null;

// Each stream (original / translation) keeps finalized items (tokens and
// endpoint markers, in order) plus the current in-flight non-final tokens,
// which get fully replaced on every message per the Soniox protocol. This
// is purely for the host's own monitoring panes — it is never sent anywhere.
function makeStream() {
  return { finalItems: [], nonFinalTokens: [] };
}
let originalStream = makeStream();
let translationStream = makeStream();

// --- Pair tracking (Soniox's own original↔translation chunk pairing) ------
// A "pair" is one contiguous run of original-side final tokens
// (translation_status 'original'/'none') immediately followed by its
// translation-side run ('translation') — exactly how Soniox's own SDK
// pairs original/translation chunks internally (see @soniox/node's
// mergeChunks: original chunk → its translation chunk → next original
// chunk, in strict order). The pair closes — and gets sent to viewers as
// one group — the instant a NEW original-side run starts after a
// translation-side run. This is the only grouping unit; endpoint is kept
// only as a safety-net flush for whatever's still open when a real pause
// or Stop happens.
let pairOriginal = [];    // finalized original-side text pieces of the OPEN pair
let pairTranslation = []; // finalized translation-side text pieces of the OPEN pair
let pairLastSide = null;  // 'orig' | 'trans' | null — side of the last final token seen

// --- Interim snapshot (viewer's word-by-word feel) --------------------------
// The viewer gets its "逐字浮現" feel from periodic full-sentence snapshots of
// the OPEN pair's finalized text + still in-flight, throttled so we don't
// spam a message per token. Always a snapshot (never a delta) — the viewer
// just overwrites, so a Soniox correction can never leave stale text behind.
const INTERIM_THROTTLE_MS = 120;
let interimTimer = null;
let interimDirty = false;

function currentInterimOriginal() {
  const finalText = pairOriginal.join('');
  const liveText = originalStream.nonFinalTokens.map((t) => t.text).join('');
  return toTraditional(finalText + liveText);
}

function currentInterimTranslation() {
  const finalText = pairTranslation.join('');
  const liveText = translationStream.nonFinalTokens.map((t) => t.text).join('');
  return toTraditional(finalText + liveText);
}

function sendInterimSnapshot() {
  const original = currentInterimOriginal();
  if (!original.trim()) return;
  const target = targetLangSelect.value;
  const translationText = currentInterimTranslation();
  const translations = { [target]: (translationText.trim() || original) };
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'host_interim', original, translations }));
  }
}

function scheduleInterimSend() {
  interimDirty = true;
  if (interimTimer) return;
  interimTimer = setTimeout(() => {
    interimTimer = null;
    if (interimDirty) {
      interimDirty = false;
      sendInterimSnapshot();
    }
  }, INTERIM_THROTTLE_MS);
}

function cancelInterimSend() {
  clearTimeout(interimTimer);
  interimTimer = null;
  interimDirty = false;
}

function renderStream(stream, containerEl) {
  containerEl.innerHTML = '';
  for (const item of stream.finalItems) {
    containerEl.appendChild(renderItem(item, false));
  }
  for (const token of stream.nonFinalTokens) {
    containerEl.appendChild(renderItem(token, true));
  }
  containerEl.scrollTop = containerEl.scrollHeight;
}

function renderItem(item, nonFinal) {
  if (item.endpoint) {
    const span = document.createElement('span');
    span.className = 'endpoint-marker';
    span.textContent = ' ⏸ ';
    return span;
  }
  const span = document.createElement('span');
  span.className = `tok ${langClass(item.language)}${nonFinal ? ' non-final' : ''}`;
  span.textContent = toTraditional(item.text);
  if (item.language) span.title = item.language;
  return span;
}

function renderAll() {
  renderStream(originalStream, originalTextEl);
  renderStream(translationStream, translationTextEl);

  const fullOriginalText = originalStream.finalItems
    .filter((i) => !i.endpoint)
    .map((i) => i.text)
    .concat(originalStream.nonFinalTokens.map((t) => t.text))
    .join('');
  const fullTranslationText = translationStream.finalItems
    .map((i) => i.text)
    .concat(translationStream.nonFinalTokens.map((t) => t.text))
    .join('');

  const originalRaw = detectHanziScript(fullOriginalText);
  originalScriptEl.textContent = originalRaw ? `Soniox 原始：${originalRaw}` : '';

  if (targetLangSelect.value === 'zh') {
    const translationRaw = detectHanziScript(fullTranslationText);
    translationScriptEl.textContent = translationRaw ? `Soniox 原始：${translationRaw}` : '（尚無中文字元）';
  } else {
    translationScriptEl.textContent = '';
  }
}

// Only is_final tokens ever reach pairOriginal/pairTranslation — non-final
// tokens only update the local monitoring panes above.
//
// translation_status 'none' = Soniox recognized this token but performed no
// translation on it, because it's already in the target language (e.g. host
// speaks Chinese with target_language 'zh' — pure dictation, no translation
// needed for that stretch of speech). Such a token is *content* that must
// still reach viewers' translation side, so it's mirrored into both
// pairOriginal and pairTranslation (and both streams' live tokens) rather
// than only landing in the original side. This also covers a host who
// mostly speaks the target language but occasionally switches — those
// passthrough words would otherwise vanish from the translation output
// entirely, since sendUtterance's whole-pair fallback only helps when an
// ENTIRE pair has zero translation content.
function handleResult(result) {
  originalStream.nonFinalTokens = [];
  translationStream.nonFinalTokens = [];

  for (const token of result.tokens) {
    const isTranslation = token.translation_status === 'translation';
    const isPassthrough = token.translation_status === 'none';
    const stream = isTranslation ? translationStream : originalStream;
    if (token.is_final) {
      stream.finalItems.push(token);
      const side = isTranslation ? 'trans' : 'orig';
      if (pairLastSide === 'trans' && side === 'orig') {
        flushPair(); // translation chunk just ended and a new original chunk started — pair complete
      }
      pairLastSide = side;
      if (isTranslation) {
        pairTranslation.push(token.text);
      } else {
        pairOriginal.push(token.text);
        if (isPassthrough) pairTranslation.push(token.text);
      }
    } else {
      stream.nonFinalTokens.push(token);
      if (isPassthrough) translationStream.nonFinalTokens.push(token);
    }
  }
  renderAll();
  scheduleInterimSend();
}

// Send the currently-open pair as one group and reset for the next one.
function flushPair() {
  cancelInterimSend(); // this pair is becoming final — no more snapshots for it
  const original = toTraditional(pairOriginal.join(''));
  const translation = toTraditional(pairTranslation.join(''));
  pairOriginal = [];
  pairTranslation = [];
  pairLastSide = null;
  if (original.trim()) sendUtterance(original, translation);
}

// Safety net: force-flush whatever's open when Soniox detects a real pause,
// even if it hasn't naturally closed via a trans→orig transition yet (e.g.
// a passthrough segment with no translation at all).
function handleEndpoint() {
  originalStream.finalItems.push({ endpoint: true });
  renderAll();
  flushPair();
}

function setUiRecording(isRecording) {
  startBtn.disabled = isRecording;
  stopBtn.disabled = !isRecording;
  targetLangSelect.disabled = isRecording;
  termsInput.disabled = isRecording;
}

function parseTerms(raw) {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- Recording error messages ----------------------------------------------
// The Soniox client SDK wraps getUserMedia failures in typed errors with a
// `.code` (see @soniox/client's audio/errors.ts: AudioPermissionError,
// AudioDeviceError, AudioUnavailableError) — translate those into something
// a non-technical host can act on, instead of the bare string "error".
const NON_RETRIABLE_ERROR_CODES = new Set(['permission_denied', 'device_not_found', 'audio_unavailable']);

function describeRecordingError(err) {
  const code = err && err.code;
  const message = (err && err.message) || String(err);
  if (code === 'permission_denied') {
    return '麥克風權限被拒絕，請點瀏覽器網址列的麥克風/鎖頭圖示允許存取，再按 Start 重試。';
  }
  if (code === 'device_not_found') {
    if (/already in use|not readable/i.test(message)) {
      return '麥克風可能正被其他程式占用（例如視訊通話軟體），請關閉後再按 Start 重試。';
    }
    return '找不到麥克風裝置，請確認已接上麥克風或耳麥，再按 Start 重試。';
  }
  if (code === 'audio_unavailable') {
    return '此瀏覽器或連線環境無法使用麥克風（可能不是用 https 或 localhost 開啟，或瀏覽器版本不支援錄音），請確認後再試。';
  }
  return `error: ${message}`;
}

// --- Soniox session (auto-restart on unexpected drop) -----------------------
// `userWantsRecording` is the source of truth for "should a Soniox session
// be running right now" — true from Start until an explicit Stop, false
// otherwise. state_change/error handlers use it to tell an unexpected drop
// apart from a real user Stop (stopBtn flips it to false BEFORE calling
// recording.stop(), so that state_change firing as a result of the stop()
// call itself sees the flag already false and correctly does nothing).
//
// TODO: this is deliberately simple — one fixed-delay retry loop with a
// retry cap, not full exponential backoff, and it doesn't distinguish
// *why* Soniox dropped (network blip vs. e.g. an expired/invalid key,
// which no amount of retrying fixes). Revisit if repeated real-world drops
// show this isn't enough.
let userWantsRecording = false;
let sonioxRetryTimer = null;
let sonioxRetryCount = 0;
const SONIOX_RETRY_DELAY_MS = 2000;
const SONIOX_MAX_AUTO_RETRIES = 5;

function maybeAutoReconnectSoniox() {
  if (!userWantsRecording) return; // a real user Stop — don't fight it
  if (sonioxRetryCount >= SONIOX_MAX_AUTO_RETRIES) {
    statusEl.textContent = 'error: 自動重連失敗，請手動按 Start';
    userWantsRecording = false;
    return;
  }
  sonioxRetryCount++;
  statusEl.textContent = `連線中斷，${SONIOX_RETRY_DELAY_MS / 1000}s 後自動重試 (${sonioxRetryCount}/${SONIOX_MAX_AUTO_RETRIES})…`;
  clearTimeout(sonioxRetryTimer);
  sonioxRetryTimer = setTimeout(() => {
    if (userWantsRecording) startRecording();
  }, SONIOX_RETRY_DELAY_MS);
}

function startRecording() {
  originalStream = makeStream();
  translationStream = makeStream();
  pairOriginal = [];
  pairTranslation = [];
  pairLastSide = null;
  cancelInterimSend();
  renderAll();
  statusEl.textContent = 'connecting…';
  setUiRecording(true);

  const terms = parseTerms(termsInput.value);
  const config = {
    model: 'stt-rt-v5',
    language_hints: ['zh', 'en', 'es'],
    enable_language_identification: true,
    enable_endpoint_detection: true,
    translation: { type: 'one_way', target_language: targetLangSelect.value },
  };
  if (terms.length) config.context = { terms };

  // The client's config callback (see `new SonioxClient` above) fetches a
  // fresh temporary key on every call to .record(), so an auto-retry here
  // naturally avoids reusing a stale/expired key.
  recording = client.realtime.record(config);

  recording.on('connected', () => {
    statusEl.textContent = 'recording';
    sonioxRetryCount = 0; // this attempt actually succeeded — reset the budget
  });
  recording.on('result', handleResult);
  recording.on('endpoint', handleEndpoint);
  // The SDK emits 'error' (with the real Error object) and then a
  // 'state_change' to 'error' (just the state name, no error object) right
  // after — stash the friendly message here so state_change doesn't clobber
  // it with the bare word "error".
  let lastRecordingErrorMessage = null;
  recording.on('error', (err) => {
    console.error('Soniox error:', err);
    lastRecordingErrorMessage = describeRecordingError(err);
    if (NON_RETRIABLE_ERROR_CODES.has(err && err.code)) {
      userWantsRecording = false; // a mic/permission problem won't fix itself by retrying
    }
  });
  recording.on('state_change', ({ new_state }) => {
    if (new_state === 'stopped' || new_state === 'canceled') {
      setUiRecording(false);
      statusEl.textContent = new_state;
    } else if (new_state === 'error') {
      setUiRecording(false);
      statusEl.textContent = lastRecordingErrorMessage || 'error: 連線發生未知錯誤';
      lastRecordingErrorMessage = null;
      maybeAutoReconnectSoniox();
    }
  });
}

startBtn.addEventListener('click', () => {
  sonioxRetryCount = 0; // manual Start always gets a fresh retry budget
  userWantsRecording = true;
  // First Start flips the session created → live (SPEC §4); a later
  // pause/Start cycle re-sends this but the server treats it as a no-op.
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'host_start' }));
  }
  startRecording();
});

// This is a pause, not a wipe: it only stops the Soniox session. History on
// the server and on every viewer is untouched, and Start can pick back up
// right after. Only clearBtn below ever clears anything.
stopBtn.addEventListener('click', async () => {
  if (!recording) return;
  userWantsRecording = false; // must be set before recording.stop() — see comment above
  clearTimeout(sonioxRetryTimer);
  statusEl.textContent = 'stopping…';
  try {
    await recording.stop();
  } catch (err) {
    console.error('Stop failed:', err);
  }
  // Catch any trailing segment that finalized without a closing endpoint.
  flushPair();
  setUiRecording(false);
  statusEl.textContent = 'idle';
});

clearBtn.addEventListener('click', () => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'host_clear' }));
  }
});

// Ends the session for good (live/created → ended, SPEC §4) — distinct from
// stopBtn's pause. The join_code stops admitting viewers the moment this
// lands; starting a new session means reloading this page (§0: "用完即拋").
endSessionBtn.addEventListener('click', async () => {
  if (!confirm('確定要結束本場嗎？結束後這個場次代碼就不能再進場了。')) return;
  if (recording && userWantsRecording) {
    userWantsRecording = false;
    clearTimeout(sonioxRetryTimer);
    statusEl.textContent = 'stopping…';
    try {
      await recording.stop();
    } catch (err) {
      console.error('Stop failed:', err);
    }
    flushPair();
    setUiRecording(false);
  }
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'host_end_session' }));
  }
  startBtn.disabled = true;
  stopBtn.disabled = true;
  clearBtn.disabled = true;
  endSessionBtn.disabled = true;
  statusEl.textContent = 'session ended';
  startTranscriptPolling();
});
