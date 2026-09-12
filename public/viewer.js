// Step 3 (viewer 呈現) — single-language only. One continuous scrolling
// feed (mask-faded at top, anchored to bottom). Each item is one Soniox
// original↔translation pair (see host.js's pair tracking): original line(s)
// small/dim immediately followed by translation line(s) large/bright. The
// item currently being spoken sits at the bottom, growing live; once its
// pair closes it settles to the small/dim tier like everything above it.

const appEl = document.getElementById('app');
const connStatusEl = document.getElementById('connStatus');
const connBannerEl = document.getElementById('connBanner');
const sessionOverlayEl = document.getElementById('sessionOverlay');
const showOriginalEl = document.getElementById('showOriginal');
const toggleOriginalLabelEl = document.getElementById('toggleOriginal');
const feedPaneEl = document.getElementById('feedPane');
const feedInnerEl = document.getElementById('feedInner');
const loadMoreEl = document.getElementById('loadMoreIndicator');

const LOAD_MORE_THRESHOLD = 48; // px from top of #feedPane that triggers a load

// --- Session join_code (SPEC §3): the capability-based ticket from the QR
// link/URL — "?code=xxx-xxxx-xxx". No code, no session; the overlay covers
// the feed the whole time and the WS layer never even connects.
const joinCode = new URLSearchParams(location.search).get('code');

function showSessionOverlay(text) {
  sessionOverlayEl.textContent = text;
  sessionOverlayEl.hidden = false;
}
function hideSessionOverlay() {
  sessionOverlayEl.hidden = true;
}

// --- "顯示原文" toggle ------------------------------------------------------
function applyOriginalVisibility() {
  appEl.classList.toggle('hide-original', !showOriginalEl.checked);
}
showOriginalEl.addEventListener('change', applyOriginalVisibility);
applyOriginalVisibility();

// --- Translation pick (single-language: whichever key the host sent) ------
function pickTranslation(u) {
  const values = Object.values(u.translations || {});
  return values.length && values[0] ? values[0] : u.original;
}

// --- Translate on/off (host's 純轉錄模式) -----------------------------------
// See viewer2.js's identical comment: decided from the session's own record
// (targetLangs, relayed in session_status) at join time, not guessed from
// utterance content.
let translateMode = null;
function applyTranslateMode() {
  if (translateMode !== false) return;
  appEl.classList.add('no-translation');
  appEl.classList.remove('hide-original');
  toggleOriginalLabelEl.hidden = true;
}
function setTranslateMode(targetLangs) {
  if (translateMode !== null || !Array.isArray(targetLangs)) return;
  translateMode = targetLangs.length > 0;
  applyTranslateMode();
}

// --- Sentence splitting (cosmetic, in-item only) -----------------------------
// Punctuation-based line wrapping so a long original/translation doesn't
// render as one dense run. Purely cosmetic within one item — the pairing
// unit itself is the whole Soniox original↔translation pair (see host.js),
// never re-split/re-aligned by sentence here.
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

function renderSentenceLines(containerEl, text) {
  containerEl.innerHTML = '';
  const segments = splitIntoSentenceSegments(text).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const line = document.createElement('div');
    line.textContent = seg;
    containerEl.appendChild(line);
  }
}

// --- Feed items --------------------------------------------------------------
function updateFeedItemContent(itemEl, original, translationText) {
  renderSentenceLines(itemEl.querySelector('.item-original'), original);
  renderSentenceLines(itemEl.querySelector('.item-translation'), translationText);
}

function createFeedItem(original, translationText, { live = false, id } = {}) {
  const div = document.createElement('div');
  div.className = `feed-item ${live ? 'live' : 'settled'}`;
  if (id !== undefined) div.dataset.id = String(id);

  const originalEl = document.createElement('div');
  originalEl.className = 'item-original';
  const translationEl = document.createElement('div');
  translationEl.className = 'item-translation';
  div.appendChild(originalEl);
  div.appendChild(translationEl);

  updateFeedItemContent(div, original, translationText);
  return div;
}

function scrollFeedToBottom() {
  feedPaneEl.scrollTop = feedPaneEl.scrollHeight;
}

// --- Live item (currently-open pair) + placeholder ---------------------------
let liveItemEl = null;
let placeholderEl = null;

function showPlaceholder() {
  if (placeholderEl) return;
  placeholderEl = document.createElement('div');
  placeholderEl.className = 'feed-placeholder';
  placeholderEl.textContent = '等待字幕…';
  feedInnerEl.appendChild(placeholderEl);
}

function hidePlaceholder() {
  if (!placeholderEl) return;
  placeholderEl.remove();
  placeholderEl = null;
}

function ensureLiveItem() {
  if (liveItemEl) return liveItemEl;
  hidePlaceholder();
  liveItemEl = createFeedItem('', '', { live: true });
  feedInnerEl.appendChild(liveItemEl);
  return liveItemEl;
}

// --- Live utterance processing (interim + final) -----------------------------
let earliestId = null; // smallest utterance id currently loaded, for history_request paging
let hasMoreHistory = false;
let loadingMore = false;

// Interim = the currently-open pair's growing snapshot (never a delta — see
// server.js host_interim relay). Just overwrite the live item's content
// wholesale each time; no diffing, so a dropped packet self-corrects the
// instant the next snapshot arrives.
function applyInterim(u) {
  const original = u.original || '';
  const translationText = translateMode === false ? '' : pickTranslation(u);
  if (!original.trim() && !translationText.trim()) return; // nothing to show yet
  const item = ensureLiveItem();
  updateFeedItemContent(item, original, translationText);
  scrollFeedToBottom();
}

// Final: the pair is done. Settle the live item (create one first if a
// final somehow arrived with no preceding interim) with the authoritative
// text, then clear the live slot so the next interim starts a fresh item.
function applyFinalUtterance(u) {
  if (earliestId === null) earliestId = u.id;
  const item = ensureLiveItem();
  item.dataset.id = String(u.id);
  item.className = 'feed-item settled';
  updateFeedItemContent(item, u.original || '', translateMode === false ? '' : pickTranslation(u));
  liveItemEl = null;
  showPlaceholder();
  scrollFeedToBottom();
}

// --- Backfill / history paging / clear ---------------------------------------
function resetToEmpty() {
  feedInnerEl.innerHTML = '';
  feedInnerEl.appendChild(loadMoreEl);
  loadMoreEl.textContent = '';
  loadingMore = false;
  earliestId = null;
  hasMoreHistory = false;
  liveItemEl = null;
  placeholderEl = null;
  showPlaceholder();
  scrollFeedToBottom();
}

// Backfill (initial join or reconnect) always fully replaces the feed —
// short reconnects are the common case and a clean re-render avoids any
// risk of duplicated/out-of-order items. All backfilled utterances are
// already-final, so they all render settled; the live slot starts at the
// placeholder until the currently-connected host actually says something new.
function renderBackfill(utterances) {
  feedInnerEl.innerHTML = '';
  feedInnerEl.appendChild(loadMoreEl);
  loadMoreEl.textContent = '';
  loadingMore = false;
  earliestId = null;
  hasMoreHistory = false;
  liveItemEl = null;
  placeholderEl = null;

  for (const u of utterances) {
    feedInnerEl.appendChild(createFeedItem(u.original, translateMode === false ? '' : pickTranslation(u), { live: false, id: u.id }));
  }
  showPlaceholder();

  if (utterances.length) {
    earliestId = utterances[0].id;
    // Server doesn't tell us definitively; optimistically assume there may be
    // more and let the first history_request's hasMore correct it.
    hasMoreHistory = true;
  }
  scrollFeedToBottom();
}

function prependHistoryBatch(utterances, hasMore) {
  loadingMore = false;
  hasMoreHistory = hasMore;

  if (!utterances.length) {
    loadMoreEl.textContent = '— 已是最早紀錄 —';
    setTimeout(() => { loadMoreEl.textContent = ''; }, 1500);
    return;
  }

  const prevScrollHeight = feedPaneEl.scrollHeight;
  const prevScrollTop = feedPaneEl.scrollTop;

  const frag = document.createDocumentFragment();
  for (const u of utterances) frag.appendChild(createFeedItem(u.original, translateMode === false ? '' : pickTranslation(u), { live: false, id: u.id })); // already oldest→newest
  feedInnerEl.insertBefore(frag, loadMoreEl.nextSibling);
  // Compensate scroll position so inserting above doesn't jump the view.
  feedPaneEl.scrollTop = prevScrollTop + (feedPaneEl.scrollHeight - prevScrollHeight);

  earliestId = utterances[0].id;
  if (!hasMore) {
    loadMoreEl.textContent = '— 已是最早紀錄 —';
    setTimeout(() => { loadMoreEl.textContent = ''; }, 1500);
  } else {
    loadMoreEl.textContent = '';
  }
}

function maybeLoadMore() {
  if (loadingMore || !hasMoreHistory || earliestId === null) return;
  loadingMore = true;
  loadMoreEl.textContent = '載入更早的字幕…';
  wsSend({ type: 'history_request', before: earliestId });
}

feedPaneEl.addEventListener('scroll', () => {
  if (feedPaneEl.scrollTop < LOAD_MORE_THRESHOLD) maybeLoadMore();
});

// --- WebSocket (auto-reconnect) --------------------------------------------
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
let ws = null;
let reconnectTimer = null;
let wasDisconnected = false; // only show the "reconnected" banner after a real disconnect
let bannerFadeTimer = null;

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

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

function connect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  ws = new WebSocket(`${wsProtocol}//${location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'register', role: 'viewer', joinCode }));
    connStatusEl.textContent = '已連線';
    connStatusEl.className = 'connected';
    if (wasDisconnected) showReconnectedBanner();
  };

  ws.onclose = () => {
    connStatusEl.textContent = '重新連線中…';
    connStatusEl.className = 'reconnecting';
    wasDisconnected = true;
    showDisconnectedBanner();
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => {};

  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'backfill') {
      renderBackfill(msg.utterances || []);
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
    if (msg.type === 'history_batch') {
      prependHistoryBatch(msg.utterances || [], !!msg.hasMore);
      return;
    }
    if (msg.type === 'clear') {
      resetToEmpty();
      return;
    }
    if (msg.type === 'register_error') {
      showSessionOverlay(msg.reason === 'invalid_code'
        ? '找不到此場次，請確認網址或 QR code 是否正確。'
        : '無法加入場次。');
      return;
    }
    if (msg.type === 'session_status') {
      setTranslateMode(msg.targetLangs);
      if (msg.status === 'live') {
        hideSessionOverlay();
      } else if (msg.status === 'created') {
        showSessionOverlay('尚未開始，請稍候…');
      } else if (msg.status === 'ended') {
        showSessionOverlay('本場已結束。');
      }
      return;
    }
  };
}

if (joinCode) {
  connect();
} else {
  showSessionOverlay('缺少場次代碼，請重新掃描 QR code 或確認網址。');
}

// Manual reconnect: close the old socket without letting its own onclose
// schedule a second retry, then connect immediately. Used when we don't
// trust a backgrounded connection to still be alive (see visibilitychange
// below) — server re-sends backfill on registration, which is how missed
// utterances get backfilled after a real gap.
function forceReconnect() {
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch { /* already closed */ }
  }
  wasDisconnected = true;
  connect();
}

// --- Wake Lock + background/foreground reconnect ---------------------------
// Viewers are phones on a table outdoors: the screen must not sleep, and a
// backgrounded tab's WebSocket may or may not survive (iOS Safari often
// kills it). Rather than guess, force a reconnect after any backgrounding
// longer than 5s so we're never silently stuck on stale state.
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
