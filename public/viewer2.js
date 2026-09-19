// viewer2: plain top/bottom split — original on top, translation on bottom,
// each a continuously growing transcript (same rhythm as host's own
// monitor panes: text accumulates, currently-open pair shown as a dimmer
// live tail). Uses the same interim/utterance feed as /viewer. Sentences
// are split into their own lines on terminal punctuation — pure string
// matching, no model involved (see splitIntoSentenceSegments below).

const appEl = document.getElementById('app');
const connStatusEl = document.getElementById('connStatus');
const connBannerEl = document.getElementById('connBanner');
const sessionOverlayEl = document.getElementById('sessionOverlay');
const showOriginalEl = document.getElementById('showOriginal');
const toggleOriginalLabelEl = document.getElementById('toggleOriginal');
const originalPaneEl = document.getElementById('originalPane');
const originalContentEl = document.getElementById('originalContent');
const translationPaneEl = document.getElementById('translationPane');
const translationContentEl = document.getElementById('translationContent');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomLevelEl = document.getElementById('zoomLevel');
const themeToggleBtn = document.getElementById('themeToggleBtn');

// --- Session join_code (SPEC §3): the capability-based ticket from the QR
// link/URL — "?code=xxxxxx". No code, no session; the overlay covers
// the feed the whole time and the WS layer never even connects.
const joinCode = new URLSearchParams(location.search).get('code');

// --- Session overlay (design 2d/3d): a small branded card while there's
// nothing a viewer is allowed to see yet — no code, invalid code, not
// started, or ended. The brand mark only ever appears here: once captions
// are live the overlay is hidden and the top bar stays brand-free (3d).
function showSessionOverlay({ tag, tagClass = 'tag-accent', title, subtitle, body }) {
  sessionOverlayEl.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'overlay-card';

  const head = document.createElement('div');
  head.className = 'overlay-head';
  // A viewer's logo just goes home directly, no confirm — unlike host's (see
  // host.js), leaving this page mid-session costs the viewer nothing.
  // #sessionOverlay always renders on the light-theme background token (it
  // sits outside #app, so #app's own dark-mode toggle never reaches it —
  // see viewer2.css) — logo-black.png is the correct ink color regardless
  // of which theme the viewer picked for the caption panes themselves.
  head.innerHTML = '<a href="/" class="brand-lockup"><img src="/logo-black.png" alt="Subtii 開字幕" class="brand-logo-img" /></a>';
  if (joinCode) {
    const code = document.createElement('span');
    code.className = 'm text-muted overlay-code';
    code.textContent = joinCode;
    head.appendChild(code);
  }
  card.appendChild(head);

  if (tag) {
    const tagEl = document.createElement('span');
    tagEl.className = `tag ${tagClass} overlay-tag`;
    tagEl.textContent = tag;
    card.appendChild(tagEl);
  }

  const h2 = document.createElement('h2');
  h2.textContent = title;
  card.appendChild(h2);

  if (subtitle) {
    const sub = document.createElement('div');
    sub.className = 'overlay-sub text-muted';
    sub.textContent = subtitle;
    card.appendChild(sub);
  }

  card.appendChild(document.createElement('hr')).className = 'hr';

  const p = document.createElement('p');
  p.className = 'overlay-body text-muted';
  p.textContent = body;
  card.appendChild(p);

  sessionOverlayEl.appendChild(card);
  sessionOverlayEl.hidden = false;
}
function hideSessionOverlay() {
  sessionOverlayEl.hidden = true;
}

// --- Light/dark toggle (design 2d default, 2e viewer-switchable) -----------
const THEME_STORAGE_KEY = 'viewer2.theme';
function applyStoredTheme() {
  const dark = localStorage.getItem(THEME_STORAGE_KEY) === 'dark';
  appEl.classList.toggle('theme-dark', dark);
  if (themeToggleBtn) themeToggleBtn.textContent = dark ? '☀' : '☾';
}
themeToggleBtn?.addEventListener('click', () => {
  const dark = !appEl.classList.contains('theme-dark');
  localStorage.setItem(THEME_STORAGE_KEY, dark ? 'dark' : 'light');
  applyStoredTheme();
});
applyStoredTheme();

// --- "顯示原文" toggle: unchecked hides the original pane entirely, and
// the translation pane's flex:1 fills the freed space automatically. ------
function applyOriginalVisibility() {
  appEl.classList.toggle('hide-original', !showOriginalEl.checked);
}
showOriginalEl.addEventListener('change', applyOriginalVisibility);
applyOriginalVisibility();

// --- 字級縮放（原文＋譯文一起）：使用者自己調整，存在 localStorage 下次開啟記得 --
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STORAGE_KEY = 'viewer2.zoomScale';

function loadStoredScale() {
  const v = parseFloat(localStorage.getItem(ZOOM_STORAGE_KEY));
  return Number.isFinite(v) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v)) : 1;
}

let zoomScale = loadStoredScale();

function applyZoomScale() {
  document.documentElement.style.setProperty('--zoom-scale', String(zoomScale));
  zoomLevelEl.textContent = `${Math.round(zoomScale * 100)}%`;
}

function setZoomScale(next) {
  zoomScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  localStorage.setItem(ZOOM_STORAGE_KEY, String(zoomScale));
  applyZoomScale();
}

zoomOutBtn.addEventListener('click', () => setZoomScale(zoomScale - ZOOM_STEP));
zoomInBtn.addEventListener('click', () => setZoomScale(zoomScale + ZOOM_STEP));
applyZoomScale();

function pickTranslation(u) {
  const values = Object.values(u.translations || {});
  return values.length && values[0] ? values[0] : u.original;
}

// --- Translate on/off (host's 純轉錄模式) -----------------------------------
// This is never "decided once" — it's a pure function of the MOST RECENT
// session_status.targetLangs, re-derived every single time one arrives
// (server re-broadcasts session_status with the current targetLangs on
// every host_start, not just the first — see server.js). `translateMode`
// below is only a memo of what was last *applied*, purely so a repeat
// broadcast of the same mode (e.g. a pause/Start cycle that didn't touch the
// translate toggle) doesn't reset a viewer's own mid-session "顯示原文"
// choice. It is NOT a one-time lock: any session_status whose targetLangs
// actually differs from the current mode re-triggers a full transition
// below, including the very first one (null never equals true/false, so the
// first real message always transitions).
let translateMode = null; // null = no session_status seen yet (still on the HTML's own defaults)

// Pure-transcription: only the original ever renders, and there is no UI
// left to fight that — the toggle is hidden AND the checkbox is force-reset
// to checked so that IF translation mode returns later, it starts from the
// correct default rather than whatever the checkbox happened to hold.
function enterTranscriptionMode() {
  translationPaneEl.hidden = true;
  toggleOriginalLabelEl.hidden = true;
  showOriginalEl.checked = true;
  appEl.classList.remove('hide-original'); // single pane must show original regardless of the checkbox
}

// Translation mode: "顯示原文" always starts checked on (re-)entry — never
// carries over whatever a *previous* translation-mode stint left it at —
// but is left alone for as long as we stay in this mode, so a viewer's own
// toggle click mid-session survives redundant same-mode session_status
// broadcasts (see translateMode comment above).
function enterTranslationMode() {
  translationPaneEl.hidden = false;
  toggleOriginalLabelEl.hidden = false;
  showOriginalEl.checked = true;
  applyOriginalVisibility();
}

function setTranslateMode(targetLangs) {
  if (!Array.isArray(targetLangs)) return; // status 'created' — host hasn't chosen yet
  const next = targetLangs.length > 0;
  if (next === translateMode) return; // same mode as last time — not a transition
  translateMode = next;
  if (next) enterTranslationMode(); else enterTranscriptionMode();
}

// --- Sentence splitting (pure punctuation matching, no AI) -----------------
// Only real sentence-enders break a line — commas never do. Keeps the mark
// with the sentence it closes; trailing text with no terminal punctuation
// stays its own (incomplete) segment.
const SENTENCE_PUNCT = new Set(['。', '！', '？', '.', '?', '!']);
const SENTENCE_SPLIT_RE = /([。！？.?!])/;

function splitIntoSentenceSegments(text) {
  if (!text) return [];
  const parts = text.split(SENTENCE_SPLIT_RE);
  const segments = [];
  let buf = '';
  for (let i = 0; i < parts.length; i++) {
    buf += parts[i];
    if (i % 2 === 1) { // parts[i] here is a captured punctuation mark
      segments.push(buf);
      buf = '';
    }
  }
  if (buf) segments.push(buf);
  return segments;
}

function linesFromText(text) {
  return splitIntoSentenceSegments(text).map((s) => s.trim()).filter(Boolean);
}

function isSentenceComplete(segment) {
  const last = segment[segment.length - 1];
  return !!(last && SENTENCE_PUNCT.has(last));
}

// --- Growing transcript state ------------------------------------------------
// A pair boundary (see host.js's Soniox chunk pairing) doesn't necessarily
// land on a sentence end — Soniox pauses/chunks wherever it likes, comma or
// not. So each side keeps a "pending" incomplete tail that carries over
// ACROSS pair boundaries: only once combined text actually reaches a real
// 。！？.?! does it get pushed into the permanent settled lines. `lines` is
// therefore one full sentence per entry, never a comma-truncated fragment.
function makeFoldState() {
  return { lines: [], pending: '' };
}
let originalFold = makeFoldState();
let translationFold = makeFoldState();

function foldText(state, text) {
  const combined = state.pending + text;
  const segments = splitIntoSentenceSegments(combined);
  if (!segments.length) {
    state.pending = '';
    return;
  }
  const lastComplete = isSentenceComplete(segments[segments.length - 1]);
  const completeSegments = lastComplete ? segments : segments.slice(0, -1);
  for (const seg of completeSegments) {
    const trimmed = seg.trim();
    if (trimmed) state.lines.push(trimmed);
  }
  state.pending = lastComplete ? '' : segments[segments.length - 1];
}

function renderPane(containerEl, settledLines, liveText) {
  containerEl.innerHTML = '';
  for (const line of settledLines) {
    const div = document.createElement('div');
    div.textContent = line;
    containerEl.appendChild(div);
  }
  for (const line of linesFromText(liveText)) {
    const div = document.createElement('div');
    div.className = 'live-tail';
    div.textContent = line;
    containerEl.appendChild(div);
  }
}

// liveOriginal/liveTranslation are whatever's actively growing right now
// (empty when nothing's mid-speech) — the still-pending incomplete tail
// from prior pairs is always prepended so a comma-interrupted sentence
// keeps reading as one continuous line.
function render(liveOriginal, liveTranslation) {
  renderPane(originalContentEl, originalFold.lines, originalFold.pending + liveOriginal);
  renderPane(translationContentEl, translationFold.lines, translationFold.pending + liveTranslation);
  originalPaneEl.scrollTop = originalPaneEl.scrollHeight;
  translationPaneEl.scrollTop = translationPaneEl.scrollHeight;
}

// Interim = the currently-open pair's growing snapshot (never a delta) —
// just show it as the live tail after whatever's already settled.
function applyInterim(u) {
  render(u.original || '', translateMode === false ? '' : pickTranslation(u));
}

// The last utterance id this page has actually folded into its transcript.
// Drives precise reconnect catch-up below — null means "never seen one yet"
// (first-ever connect), which is the only time the automatic `backfill` is
// used as-is instead of a targeted resync.
let lastSeenId = null;

// Final: fold this pair into the transcript (a comma-ending pair just
// extends the pending tail rather than becoming its own line), then clear
// the live tail until the next interim starts.
function applyFinalUtterance(u) {
  foldText(originalFold, u.original || '');
  if (translateMode !== false) foldText(translationFold, pickTranslation(u));
  lastSeenId = u.id;
  render('', '');
}

function renderBackfill(utterances) {
  originalFold = makeFoldState();
  translationFold = makeFoldState();
  for (const u of utterances) {
    foldText(originalFold, u.original || '');
    if (translateMode !== false) foldText(translationFold, pickTranslation(u));
  }
  lastSeenId = utterances.length ? utterances[utterances.length - 1].id : lastSeenId;
  render('', '');
}

// Reconnect catch-up: fold in only what was actually missed, id-by-id, in
// order — never touches originalFold/translationFold's existing settled
// lines, so whatever's already on screen survives the reconnect untouched.
function applyResync(msg) {
  const utterances = msg.utterances || [];
  if (msg.reset) {
    renderBackfill(utterances); // id sequence restarted (host_clear while we were away) — full reset
    return;
  }
  for (const u of utterances) applyFinalUtterance(u);
}

function resetTranscript() {
  originalFold = makeFoldState();
  translationFold = makeFoldState();
  lastSeenId = null;
  render('', '');
}

// --- WebSocket (auto-reconnect, exponential backoff) ------------------------
// 1s → 2s → 4s → 8s → capped at 10s, then fixed 10s retries. Resets to 1s
// the moment a connection actually succeeds, so a long outage doesn't leave
// us waiting a full 10s for the very next attempt after it's already back.
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;
let ws = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let wasDisconnected = false; // only show the "reconnected" banner after a real disconnect
let bannerFadeTimer = null;
let activeSessionId = null;
let hasGoneLive = false; // once true, a later 'paused' status stays on the transcript page instead of the full overlay

function nextReconnectDelay() {
  const delay = Math.min(RECONNECT_BASE_MS * (2 ** reconnectAttempt), RECONNECT_MAX_MS);
  reconnectAttempt++;
  return delay;
}

// Low-key by design (same as /viewer): a reconnect is routine, not an
// emergency — the transcript already on screen is untouched throughout.
function showDisconnectedBanner() {
  clearTimeout(bannerFadeTimer);
  bannerFadeTimer = null;
  connBannerEl.className = 'disconnected';
  connBannerEl.textContent = '連線中斷，正在重新連接…';
}

function showReconnectedBanner() {
  clearTimeout(bannerFadeTimer);
  connBannerEl.className = 'reconnected';
  connBannerEl.textContent = '已重新連上';
  bannerFadeTimer = setTimeout(() => {
    connBannerEl.classList.add('fade');
    bannerFadeTimer = setTimeout(() => {
      connBannerEl.className = '';
      connBannerEl.textContent = '';
    }, 500);
  }, 2000);
}

// Server-driven auto-pause once captions have already started (SPEC fix
// "場次沒結束一直掛 live"): same low-key treatment as a socket reconnect —
// the transcript already on screen stays put, this is routine not an
// emergency. Persistent (no fade) until session_status reports 'live' again.
let pausedBannerShown = false;
function showPausedBanner() {
  clearTimeout(bannerFadeTimer);
  bannerFadeTimer = null;
  connBannerEl.className = 'disconnected';
  connBannerEl.textContent = '主辦單位暫時離線，字幕暫停中…';
  pausedBannerShown = true;
}
function hidePausedBanner() {
  if (!pausedBannerShown) return;
  connBannerEl.className = '';
  connBannerEl.textContent = '';
  pausedBannerShown = false;
}

function connect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  ws = new WebSocket(`${wsProtocol}//${location.host}`);

  ws.onopen = () => {
    reconnectAttempt = 0;
    ws.send(JSON.stringify({ type: 'register', role: 'viewer', joinCode }));
    // Wait for the server to identify the current room first. A tour link
    // may now point at a different session with its own transcript sequence.
    connStatusEl.textContent = '已連線';
    connStatusEl.className = 'connected';
    if (wasDisconnected) showReconnectedBanner();
  };

  ws.onclose = () => {
    connStatusEl.textContent = '重新連線中…';
    connStatusEl.className = 'reconnecting';
    wasDisconnected = true;
    showDisconnectedBanner();
    reconnectTimer = setTimeout(connect, nextReconnectDelay());
  };

  ws.onerror = () => {};

  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'viewer_registered') {
      const nextId = msg.sessionId || null;
      if (activeSessionId !== nextId) {
        resetTranscript();
        hidePausedBanner();
        hasGoneLive = false;
        activeSessionId = nextId;
      } else if (nextId && lastSeenId !== null) {
        ws.send(JSON.stringify({ type: 'resync', after: lastSeenId, sessionId: nextId }));
      }
      return;
    }
    if (msg.type === 'backfill') {
      // Only the very first connection uses this as-is. On a reconnect
      // (lastSeenId already set) the resync response above is the
      // authoritative catch-up — applying backfill on top would wipe the
      // transcript that's supposed to survive the reconnect untouched.
      if (lastSeenId === null) renderBackfill(msg.utterances || []);
      return;
    }
    if (msg.type === 'utterance') {
      applyFinalUtterance(msg);
      return;
    }
    if (msg.type === 'interim') {
      applyInterim(msg);
      return;
    }
    if (msg.type === 'resync') {
      applyResync(msg);
      return;
    }
    if (msg.type === 'clear') {
      resetTranscript();
      return;
    }
    if (msg.type === 'register_error') {
      showSessionOverlay(msg.reason === 'invalid_code'
        ? { tag: '無法加入', tagClass: 'tag-neutral', title: '找不到此場次', body: '請確認網址或 QR code 是否正確。' }
        : { title: '無法加入場次', body: '請稍後再試一次。' });
      return;
    }
    if (msg.type === 'session_status') {
      setTranslateMode(msg.targetLangs);
      if (msg.status === 'waiting') {
        hidePausedBanner();
        showSessionOverlay({tag:'等待下一場',title:msg.name||'旅行團字幕',body:'主辦單位開啟下一場時，這裡會自動顯示字幕。請保留這個連結。'});
      } else if (msg.status === 'closed') {
        hidePausedBanner();
        showSessionOverlay({tag:'已關閉',tagClass:'tag-neutral',title:msg.name||'旅行團字幕',body:'這個固定入口已關閉。請向主辦單位索取新的連結。'});
      } else if (msg.status === 'live') {
        hasGoneLive = true;
        hidePausedBanner();
        hideSessionOverlay();
      } else if (msg.status === 'created') {
        showSessionOverlay({
          tag: '尚未開始',
          title: msg.name || '這場字幕',
          body: '講者一開播，這個畫面會自動跳成字幕。不用重新整理，手機放著就好。',
        });
      } else if (msg.status === 'paused') {
        // Server-driven auto-pause (SPEC fix "場次沒結束一直掛 live"): the
        // host's connection dropped and didn't come back in time — distinct
        // from 'ended', this is expected to resume. If captions had already
        // started, stay on the transcript page with a low-key banner (same
        // treatment as a socket reconnect) instead of covering it with the
        // "not started yet" overlay — the transcript already on screen is
        // still worth reading. Only fall back to the full overlay if the
        // session never actually went live yet.
        if (hasGoneLive) {
          showPausedBanner();
        } else {
          showSessionOverlay({
            tag: '暫停中',
            tagClass: 'tag-neutral',
            title: msg.name || '這場字幕',
            body: '主辦單位暫時離線，字幕先暫停。請留在這個畫面，恢復後會自動繼續。',
          });
        }
      } else if (msg.status === 'ended') {
        hidePausedBanner();
        showSessionOverlay({
          tag: '已結束',
          tagClass: 'tag-neutral',
          title: '本場已結束',
          subtitle: msg.name || undefined,
          body: '謝謝參與。這個連結不再提供字幕；逐字稿由主辦單位保管。',
        });
      }
      return;
    }
  };
}

if (joinCode) {
  connect();
} else {
  showSessionOverlay({ title: '缺少場次代碼', body: '請重新掃描 QR code 或確認網址。' });
}

// Manual reconnect: close the old socket without letting its own onclose
// schedule a second retry, then connect immediately. Used when we don't
// trust a backgrounded connection to still be alive (see visibilitychange
// below) — the resync-on-open above is what catches up on anything missed
// during the gap.
function forceReconnect() {
  clearTimeout(reconnectTimer);
  reconnectAttempt = 0; // this one's user/foreground-triggered, not a backoff retry
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch { /* already closed */ }
  }
  wasDisconnected = true;
  connect();
}

// --- Wake Lock + background/foreground reconnect ---------------------------
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
}
requestWakeLock();

let hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    return;
  }
  requestWakeLock();
  if (joinCode && hiddenAt !== null && Date.now() - hiddenAt > 5000) forceReconnect();
  hiddenAt = null;
});
