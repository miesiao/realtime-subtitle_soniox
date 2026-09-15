import { SonioxClient } from '/vendor/soniox-client.mjs';
import * as OpenCC from '/vendor/opencc-cn2t.mjs';
import { COMMON_LANGUAGES, MORE_LANGUAGES, DEFAULT_SOURCE_LANG_CODES } from '/languages.js';

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
const commonLangsEl = document.getElementById('commonLangs');
const autoDetectLangEl = document.getElementById('autoDetectLang');
const moreLangsDetailsEl = document.getElementById('moreLangsDetails');
const moreLangSearchEl = document.getElementById('moreLangSearch');
const moreLangsEl = document.getElementById('moreLangs');
const sourceLangErrorEl = document.getElementById('sourceLangError');
const translateEnabledEl = document.getElementById('translateEnabled');
const targetLangWrapEl = document.getElementById('targetLangWrap');
const targetLangSelect = document.getElementById('targetLang');
const columnsMainEl = document.getElementById('columnsMain');
const translationPaneWrapEl = document.getElementById('translationPaneWrap');
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
const whoAmIEl = document.getElementById('whoAmI');
const hostLogoLinkEl = document.getElementById('hostLogoLink');
const creditsPausedBannerEl = document.getElementById('creditsPausedBanner');
const lowBalanceBannerEl = document.getElementById('lowBalanceBanner');
const lowBalanceMinutesEl = document.getElementById('lowBalanceMinutes');
const creditsChipEl = document.getElementById('creditsChip');
const creditsChipGuestEl = document.getElementById('creditsChipGuest');
const creditsDisplayEl = document.getElementById('creditsDisplay');
const topupToggleBtn = document.getElementById('topupToggleBtn');
const topupPanelEl = document.getElementById('topupPanel');
const topupTierBtns = document.querySelectorAll('.topup-tier-btn');
const topupStepChooseEl = document.getElementById('topupStepChoose');
const topupStepConfirmEl = document.getElementById('topupStepConfirm');
const confirmAmountTextEl = document.getElementById('confirmAmountText');
const confirmCreditsTextEl = document.getElementById('confirmCreditsText');
const backToChooseBtn = document.getElementById('backToChooseBtn');
const confirmCreateOrderBtn = document.getElementById('confirmCreateOrderBtn');
const createOrderStatusTextEl = document.getElementById('createOrderStatusText');
const orderInfoEl = document.getElementById('orderInfo');
const orderIdTextEl = document.getElementById('orderIdText');
const orderAmountTextEl = document.getElementById('orderAmountText');
const orderBankInfoTextEl = document.getElementById('orderBankInfoText');
const copyBtns = document.querySelectorAll('.copyBtn');
const lastFiveInputEl = document.getElementById('lastFiveInput');
const submitLastFiveBtn = document.getElementById('submitLastFiveBtn');
const orderStatusTextEl = document.getElementById('orderStatusText');

// --- Login status (SPEC guest-mode) -----------------------------------------
// /host no longer requires login server-side (GET /host doesn't redirect a
// signed-out visitor away) — this is what actually decides whether the page
// is running in guest mode or not. /api/me itself now answers 200
// { guest: true } rather than 401 for a signed-out caller (see server.js),
// specifically so this branch never fires a redirect on its own; only
// Start and "確認，建立訂單" ever send a guest to login, and only when
// they're actually pressed (see their handlers below).
function redirectToLogin() {
  location.href = `/auth/google?returnTo=${encodeURIComponent(location.pathname)}`;
}

async function apiFetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, credentials: 'same-origin' });
  if (res.status === 401) {
    redirectToLogin();
    throw new Error('login_required');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

// Set once loadWhoAmI resolves; read by Start / confirmCreateOrderBtn (both
// redirect to login immediately instead of ever hitting a 401) and by the
// credits chip / whoAmI display below.
let isGuest = false;
// Cosmetic only ("訪客" + a random tag, SPEC: "顯示「訪客」加一組隨機代號") —
// stable for the life of this tab/reload via sessionStorage, so it doesn't
// change every time loadWhoAmI happens to re-run.
const GUEST_TAG_STORAGE_KEY = 'guestTag';
function getOrCreateGuestTag() {
  let tag = sessionStorage.getItem(GUEST_TAG_STORAGE_KEY);
  if (!tag) {
    tag = Math.random().toString(36).slice(2, 8).toUpperCase();
    sessionStorage.setItem(GUEST_TAG_STORAGE_KEY, tag);
  }
  return tag;
}

// Deliberately fire-and-forget (not top-level awaited) — same as before this
// change — so it never delays wiring up every other button handler below.
// isGuest is a `let` in this module's scope, so every closure that reads it
// (Start, confirmCreateOrderBtn, hostLogoLink...) always sees its current
// value at the moment of the actual click/interaction, which — human
// reaction time being what it is — is always well after this same-origin
// fetch has resolved. refreshCredits() is deliberately called from inside
// here rather than as its own unconditional top-level statement (see below):
// that statement would otherwise run before this async function's first
// await resolves, while isGuest is still its default `false`, and fire an
// unwanted /api/credits call — and 401 redirect — for an actual guest.
async function loadWhoAmI() {
  try {
    const me = await apiFetchJson('/api/me');
    if (me.guest) {
      isGuest = true;
      whoAmIEl.textContent = `登入身分：訪客 #${getOrCreateGuestTag()}`;
      // No real balance to show a guest (SPEC: "不要顯示假餘額") — a badge
      // inviting signup replaces the credits chip entirely.
      creditsChipEl.hidden = true;
      creditsChipGuestEl.hidden = false;
    } else {
      whoAmIEl.textContent = `登入身分：${me.name || me.email || me.id}`;
      refreshCredits();
    }
  } catch (err) {
    if (err.message !== 'login_required') whoAmIEl.textContent = `無法確認登入狀態：${err.message}`;
  }
}
loadWhoAmI();

// --- Credits / top-up (SPEC steps 3/6) --------------------------------------
// currentCredits is a display cache only — every enforcement decision is
// made server-side (POST /api/temporary-key, the WS host_start handler);
// this value is never trusted for anything except what number to show and
// whether to bother the user with a client-side "you probably can't afford
// this" heads-up before they even try Start.
let currentCredits = null;

function renderCredits() {
  creditsDisplayEl.textContent = currentCredits === null ? '…' : String(currentCredits);
}

async function refreshCredits() {
  try {
    const data = await apiFetchJson('/api/credits');
    currentCredits = data.credits;
    renderCredits();
  } catch (err) {
    if (err.message !== 'login_required') console.error('Failed to load credits:', err);
  }
}
// Not called unconditionally here — see loadWhoAmI above, which calls this
// itself only once it knows the caller isn't a guest. /api/credits still
// requires login (unchanged); a guest has no balance to show
// (creditsChipGuestEl covers that instead) and must never trigger
// apiFetchJson's 401-redirect-to-login just from loading the page.

// Same formula as server.js's creditsPerMinuteFor — kept in sync by hand
// since this is only ever a pre-flight courtesy check; /api/temporary-key
// and the WS host_start handler are the actual source of truth for cost.
function currentRequiredCreditsPerMinute() {
  return 2 + (translateEnabledEl.checked ? 1 : 0);
}

// --- Top-up wizard: 選方案 → 確認方案 → (建單後)匯款資訊 ---------------------
// Picking a tier is just a client-side selection — nothing hits the network
// until the host explicitly presses "確認，建立訂單" on the confirm step, so
// idle browsing of the price list never creates a pending order in the DB.
let selectedTier = null; // { tier, credits } — set on step 1, read on confirm

function showTopupStep(step) {
  topupStepChooseEl.hidden = step !== 'choose';
  topupStepConfirmEl.hidden = step !== 'confirm';
  orderInfoEl.hidden = step !== 'payment';
}

// Every fresh open of the panel starts over at step 1 — otherwise a host who
// closes it mid-flow (or right after finishing one order) would reopen it
// straight into stale confirm/payment-step leftovers from last time.
function resetTopupWizard() {
  selectedTier = null;
  createOrderStatusTextEl.textContent = '';
  orderStatusTextEl.textContent = '';
  lastFiveInputEl.value = '';
  showTopupStep('choose');
}

topupToggleBtn.addEventListener('click', () => {
  const opening = topupPanelEl.hidden;
  topupPanelEl.hidden = !topupPanelEl.hidden;
  if (opening) resetTopupWizard();
});
// Dialog chrome (design 2h): a dedicated close button and a click on the
// backdrop itself (but not the card) both just hide the same panel — same
// mechanism topupToggleBtn already uses above, no new state.
document.getElementById('closeTopupBtn')?.addEventListener('click', () => {
  topupPanelEl.hidden = true;
});
topupPanelEl.addEventListener('click', (e) => {
  if (e.target === topupPanelEl) topupPanelEl.hidden = true;
});
// The low-balance banner's shortcut button opens the same top-up panel as
// the top bar's 儲值 button.
document.getElementById('lowBalanceTopupBtn')?.addEventListener('click', () => {
  topupPanelEl.hidden = false;
  resetTopupWizard();
});

// Step 1 → 1.5: select only, no API call.
for (const btn of topupTierBtns) {
  btn.addEventListener('click', () => {
    selectedTier = { tier: Number(btn.dataset.tier), credits: Number(btn.dataset.credits) };
    confirmAmountTextEl.textContent = `NT$${selectedTier.tier}`;
    confirmCreditsTextEl.textContent = String(selectedTier.credits);
    createOrderStatusTextEl.textContent = '';
    showTopupStep('confirm');
  });
}

backToChooseBtn.addEventListener('click', () => {
  showTopupStep('choose');
});

// Step 1.5 → 2: the only place that actually calls POST /api/orders.
confirmCreateOrderBtn.addEventListener('click', async () => {
  if (!selectedTier) return;
  // Guest-mode (SPEC): judge this BEFORE ever sending the request, not after
  // eating a 401 — /api/orders itself still requires login (unchanged), this
  // is purely so a guest gets sent straight to login instead of a confusing
  // "建立訂單失敗" message first.
  if (isGuest) {
    location.href = `/auth/google?returnTo=${encodeURIComponent(location.pathname)}`;
    return;
  }
  confirmCreateOrderBtn.disabled = true;
  backToChooseBtn.disabled = true;
  createOrderStatusTextEl.textContent = '建立訂單中…';
  try {
    const order = await apiFetchJson('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: selectedTier.tier }),
    });
    orderIdTextEl.textContent = order.id;
    orderAmountTextEl.textContent = `NT$${order.amountPaid}`;
    // bankInfo/bankAccount come from the order response, not a hardcoded
    // string here — server.js's BANK_INFO/BANK_ACCOUNT_NUMBER constants are
    // the single source of truth. orderBankInfoTextEl shows all 3 lines
    // (white-space: pre-line, see host.css); the copy button on this field
    // copies only the bare account number (data-copy-account), never the
    // whole 3-line block.
    orderBankInfoTextEl.textContent = order.bankInfo;
    const bankCopyBtn = document.querySelector('[data-copy-target="orderBankInfoText"]');
    if (bankCopyBtn) bankCopyBtn.dataset.copyAccount = order.bankAccount;
    lastFiveInputEl.value = '';
    orderStatusTextEl.textContent = '';
    orderInfoEl.dataset.orderId = order.id;
    showTopupStep('payment');
  } catch (err) {
    console.error('Failed to create order:', err);
    createOrderStatusTextEl.textContent = `建立訂單失敗：${err.message}`;
  } finally {
    confirmCreateOrderBtn.disabled = false;
    backToChooseBtn.disabled = false;
  }
});

// Copy-to-clipboard on each payment-info field — best-effort: a blocked
// clipboard (permissions, insecure context) just silently does nothing.
for (const btn of copyBtns) {
  const original = btn.textContent;
  btn.addEventListener('click', async () => {
    // The 匯款帳戶 button copies only the bare account number
    // (data-copy-account, set once the order response arrives — see
    // confirmCreateOrderBtn above), never the full 3-line bank info text
    // that's actually displayed. Every other copy button has no
    // data-copy-account, so this just falls through to its usual target text.
    const text = btn.dataset.copyAccount || document.getElementById(btn.dataset.copyTarget)?.textContent || '';
    if (!text || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '已複製';
      setTimeout(() => { btn.textContent = original; }, 1200);
    } catch {
      // Clipboard blocked — no-op per spec.
    }
  });
}

submitLastFiveBtn.addEventListener('click', async () => {
  const orderId = orderInfoEl.dataset.orderId;
  if (!orderId) return;
  const lastFive = lastFiveInputEl.value.trim();
  if (!/^[0-9]{5}$/.test(lastFive)) {
    orderStatusTextEl.textContent = '請輸入 5 位數字（轉帳帳號後五碼）';
    return;
  }
  submitLastFiveBtn.disabled = true;
  orderStatusTextEl.textContent = '送出中…';
  try {
    await apiFetchJson(`/api/orders/${orderId}/last-five`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastFive }),
    });
    orderStatusTextEl.textContent = '已送出，請等候人工確認入帳（confirmed 後點數會自動更新，可重新整理頁面查詢餘額）。';
  } catch (err) {
    console.error('Failed to submit last-five:', err);
    orderStatusTextEl.textContent = `送出失敗：${err.message}`;
  } finally {
    submitLastFiveBtn.disabled = false;
  }
});

// --- Source language picker (language_hints) --------------------------------
// language_hints only ever *biases* Soniox toward these languages — it's not
// a hard lock — so the tighter and more accurate the set, the better the
// recognition; leaving it empty (auto-detect) is the least accurate option,
// which is why it's an opt-in escape hatch rather than the default. Fully
// independent of the translate on/off switch below: source language and
// target/translation are two unrelated Soniox settings.
const langCheckboxByCode = new Map();

function createLangCheckboxLabel(lang, checked) {
  const label = document.createElement('label');
  label.className = 'lang-checkbox';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.value = lang.code;
  input.checked = checked;
  input.addEventListener('change', () => {
    sourceLangErrorEl.hidden = true; // any change clears a stale validation error
  });
  label.appendChild(input);
  label.appendChild(document.createTextNode(` ${lang.name} (${lang.code})`));
  langCheckboxByCode.set(lang.code, input);
  return label;
}

for (const lang of COMMON_LANGUAGES) {
  commonLangsEl.appendChild(createLangCheckboxLabel(lang, DEFAULT_SOURCE_LANG_CODES.includes(lang.code)));
}
for (const lang of MORE_LANGUAGES) {
  const label = createLangCheckboxLabel(lang, false);
  label.dataset.searchText = `${lang.name} ${lang.code}`.toLowerCase();
  moreLangsEl.appendChild(label);
}

moreLangSearchEl.addEventListener('input', () => {
  const q = moreLangSearchEl.value.trim().toLowerCase();
  for (const label of moreLangsEl.children) {
    label.hidden = q.length > 0 && !label.dataset.searchText.includes(q);
  }
});

// Auto-detect and the language checkboxes are mutually exclusive: turning
// auto-detect on disables AND clears every checkbox (not just disables —
// SPEC: "清空"), so the two states can never coexist.
function applyAutoDetectUI() {
  const auto = autoDetectLangEl.checked;
  for (const cb of langCheckboxByCode.values()) {
    cb.disabled = auto;
    if (auto) cb.checked = false;
  }
  moreLangSearchEl.disabled = auto;
  sourceLangErrorEl.hidden = true;
}
autoDetectLangEl.addEventListener('change', applyAutoDetectUI);
applyAutoDetectUI();

function currentSourceLangSelection() {
  const autoDetect = autoDetectLangEl.checked;
  const codes = autoDetect
    ? []
    : [...langCheckboxByCode.entries()].filter(([, cb]) => cb.checked).map(([code]) => code);
  return { autoDetect, codes };
}

// Boundary case (SPEC point 3): everything unchecked AND not auto-detect is
// blocked, never silently treated as "no hints" — that's exactly the
// auto-detect state, and it must be chosen explicitly, not fallen into.
function validateSourceLangSelection(selection) {
  const invalid = !selection.autoDetect && selection.codes.length === 0;
  sourceLangErrorEl.hidden = !invalid;
  return !invalid;
}

// --- Translate on/off (純轉錄模式) -----------------------------------------
// Off means: no `translation` key at all in the Soniox config (not an empty
// one) — see startRecording — so pure-dictation sessions never trigger
// Soniox's translation tokens. Purely a host-side switch; server/viewer
// already treat an empty `translations` object as "nothing to show", so no
// server or viewer changes are needed for this to render correctly.
function applyTranslateModeUI() {
  const on = translateEnabledEl.checked;
  targetLangWrapEl.hidden = !on;
  translationPaneWrapEl.hidden = !on;
  columnsMainEl.classList.toggle('single-column', !on);
}
translateEnabledEl.addEventListener('change', applyTranslateModeUI);
applyTranslateModeUI();

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
    } else if (msg.type === 'credits_update') {
      currentCredits = msg.credits;
      renderCredits();
    } else if (msg.type === 'low_balance_warning') {
      currentCredits = msg.credits;
      renderCredits();
      lowBalanceMinutesEl.textContent = String(msg.minutesRemaining);
      lowBalanceBannerEl.hidden = false;
    } else if (msg.type === 'force_pause') {
      // Server-driven auto-pause (SPEC step 6): credits ran out mid-session.
      // Reuses the exact same client-side pause path as the Pause button —
      // stops Soniox, keeps join_code/viewers/history untouched — the only
      // difference from a manual Pause is who pressed it.
      lowBalanceBannerEl.hidden = true;
      creditsPausedBannerEl.hidden = false;
      pauseRecording();
    }
  });
}

// --- Session creation (SPEC §2/§4: internal id + public join_code + QR) ----
// One session per page load — "開一場即生成新亂碼網址", Meet-mode. The
// internal id only ever travels over this authenticated fetch response and
// this page's own WS registration; it never gets embedded in the QR/viewer
// link (that's `joinCode`, the capability-based ticket — see §3).
let currentSession = null; // { id, joinCode, viewerUrl, qrDataUrl }

// /host now operates on ONE EXISTING session, created explicitly by the
// "＋ 開新場次" button on 字幕場次 (POST /api/sessions happens there, not
// here) — loading/refreshing this page must never create a new session on
// its own, or every visit leaves behind another zombie `created` row. The
// session id travels in the URL (?id=...) from that button's redirect.
const sessionId = new URLSearchParams(location.search).get('id');

async function loadSession(id) {
  return apiFetchJson(`/api/sessions/${id}`);
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

renameBtn.addEventListener('click', async () => {
  if (!currentSession) return;
  const name = sessionNameInput.value.trim();
  if (!name) { renameStatusEl.textContent = '名稱不可為空'; return; }
  renameBtn.disabled = true;
  renameStatusEl.textContent = '改名中…';
  try {
    const result = await apiFetchJson(`/api/sessions/${currentSession.id}/name`, {
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
// This is the live "just ended" view; /sessions is the durable "come back
// later" list (SPEC §3a point 5) built on the same ownership-gated endpoint.
// Starts polling right after host_end_session is sent; keeps polling while
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
    const data = await apiFetchJson(`/api/sessions/${currentSession.id}/transcript`);
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
    await apiFetchJson(`/api/sessions/${currentSession.id}/transcript/retry`, { method: 'POST' });
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
// Mirrors currentSession.status — read by hostLogoLink's click handler
// (below) to decide whether leaving needs a confirm(). Kept as its own flag
// rather than re-reading currentSession.status every time, since it also
// needs updating from host_start/host_end_session's own optimistic client
// state, not just from the server's GET response.
let sessionIsLive = false;

async function initSession() {
  if (!sessionId) {
    // Guest-mode (SPEC): a guest visiting /host with no session id isn't an
    // error to fix — they simply haven't logged in to create one yet. A
    // logged-in host with no id really is missing one (SPEC naming fix:
    // the list page is now called 字幕場次, not 字幕間).
    joinCodeEl.textContent = isGuest ? '（登入後即可建立場次）' : '（缺少場次 id）';
    sessionErrorTextEl.textContent = isGuest
      ? '訪客模式僅能預覽設定與儲值方案；註冊登入後即可建立場次、取得 QR code。'
      : '缺少場次 id，請從「字幕場次」清單點「回到控場」或「＋ 開新場次」進入這個頁面。';
    sessionErrorEl.hidden = false;
    return;
  }
  try {
    currentSession = await loadSession(sessionId);
    renderSession(currentSession);
    // 'paused' (server auto-paused after a lost host connection — see
    // server.js's endSession/dbMarkSessionPaused) still counts as "in
    // progress" for the logo-click confirm below: the join_code and viewer
    // history are still live, only the host's own connection dropped.
    sessionIsLive = currentSession.status === 'live' || currentSession.status === 'paused';
    sessionErrorEl.hidden = true;
    connectWs();
  } catch (err) {
    if (err.message === 'login_required') return; // already redirecting
    console.error('Failed to load session:', err);
    joinCodeEl.textContent = '（無法載入）';
    sessionErrorTextEl.textContent = `載入場次失敗：${err.message}`;
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
  const translations = translateEnabledEl.checked
    ? { [targetLangSelect.value]: (translation.trim() || trimmedOriginal) }
    : {};
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'host_utterance', original: trimmedOriginal, translations }));
  }
  logSent(trimmedOriginal, translations);
}

function requestTemporaryKey(secret) {
  // targetLangCount travels with this request so the server can check
  // credits against the SAME rate host_start/the billing timer will use
  // (SPEC step 6) — see currentRequiredCreditsPerMinute's comment.
  return fetch('/api/temporary-key', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-host-secret': secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetLangCount: translateEnabledEl.checked ? 1 : 0 }),
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
  if (res.status === 402) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(`點數不足，請先儲值（目前 ${body.credits ?? 0} 點，開播需要 ${body.required ?? '?'} 點/分鐘）`);
    err.code = 'insufficient_credits';
    throw err;
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
  const translations = translateEnabledEl.checked
    ? { [targetLangSelect.value]: (currentInterimTranslation().trim() || original) }
    : {};
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

// --- Screen Wake Lock (keep the host's screen from sleeping while live) ----
// Purely additive to the recording lifecycle below — never blocks or throws
// into it. Feature-detected (silently no-op on browsers without
// navigator.wakeLock) and every failure is caught-and-logged only, since a
// wake lock is a nice-to-have, not something that should ever stop a
// recording from starting.
let wakeLockSentinel = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
    });
  } catch (err) {
    // e.g. battery saver mode rejecting the request — log only.
    console.log('Wake lock request failed:', err);
  }
}

async function releaseWakeLock() {
  if (!wakeLockSentinel) return;
  const sentinel = wakeLockSentinel;
  wakeLockSentinel = null;
  try {
    await sentinel.release();
  } catch (err) {
    console.log('Wake lock release failed:', err);
  }
}

// The OS/browser force-releases the lock whenever the tab goes to the
// background — there is no way to prevent that, only to notice coming back
// and re-acquire it. Without this, a host who switches apps mid-session and
// returns would silently lose wake-lock protection for the rest of the talk.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && userWantsRecording) {
    console.log('Tab back in foreground while live — re-requesting wake lock');
    requestWakeLock();
  }
});

window.addEventListener('pagehide', () => {
  releaseWakeLock();
});

function setUiRecording(isRecording) {
  startBtn.disabled = isRecording;
  stopBtn.disabled = !isRecording;
  autoDetectLangEl.disabled = isRecording;
  moreLangSearchEl.disabled = isRecording;
  for (const cb of langCheckboxByCode.values()) {
    // Don't fight applyAutoDetectUI's own disabling of these while
    // auto-detect is checked — only re-enable on stop if auto-detect isn't
    // also holding them disabled.
    cb.disabled = isRecording || autoDetectLangEl.checked;
  }
  translateEnabledEl.disabled = isRecording;
  targetLangSelect.disabled = isRecording;
  termsInput.disabled = isRecording;
  if (isRecording) {
    requestWakeLock();
  } else {
    releaseWakeLock();
  }
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
// insufficient_credits (SPEC step 6) comes from fetchTemporaryKey above, not
// the SDK — same non-retriable treatment as a real device/permission error:
// retrying against an empty wallet can't ever succeed on its own.
const NON_RETRIABLE_ERROR_CODES = new Set(['permission_denied', 'device_not_found', 'audio_unavailable', 'insufficient_credits']);

function describeRecordingError(err) {
  const code = err && err.code;
  const message = (err && err.message) || String(err);
  if (code === 'insufficient_credits') {
    return message;
  }
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
    enable_language_identification: true,
    enable_endpoint_detection: true,
  };
  // Auto-detect omits this key entirely — see currentSourceLangSelection and
  // the "自動偵測" toggle above. startBtn's click handler already validated
  // this selection before startRecording() was ever called.
  const sourceSelection = currentSourceLangSelection();
  if (!sourceSelection.autoDetect) {
    config.language_hints = sourceSelection.codes;
  }
  // Pure-transcription mode omits this key entirely (not an empty/no-op
  // value) so Soniox never runs translation on the stream at all — see the
  // "啟用翻譯" toggle and applyTranslateModeUI above.
  if (translateEnabledEl.checked) {
    config.translation = { type: 'one_way', target_language: targetLangSelect.value };
  }
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

startBtn.addEventListener('click', async () => {
  // Guest-mode (SPEC): Start always goes straight to login for a guest,
  // never attempts to open a Soniox recording session first — checked before
  // any other validation below, so a guest never sees a mic-permission
  // prompt or any other Start side effect before being sent to log in.
  if (isGuest) {
    location.href = `/auth/google?returnTo=${encodeURIComponent(location.pathname)}`;
    return;
  }
  // Boundary case (SPEC point 3): block Start rather than silently falling
  // back to "no hints" if nothing is checked and auto-detect isn't chosen.
  const sourceSelection = currentSourceLangSelection();
  if (!validateSourceLangSelection(sourceSelection)) return;

  // Pre-flight credit check (SPEC step 6 "開場預檢") — purely a courtesy so
  // a 0-point (or too-low) host gets an immediate, clear message instead of
  // a confusing Soniox connection failure a moment later. This is NOT the
  // enforcement point: /api/temporary-key and the WS host_start handler
  // check the same thing server-side and are what actually can't be
  // bypassed, so a stale currentCredits here can only over-block, never
  // let an unaffordable session through.
  await refreshCredits();
  const requiredCredits = currentRequiredCreditsPerMinute();
  if (currentCredits === null || currentCredits < requiredCredits) {
    alert(`點數不足，請先儲值再開播（目前 ${currentCredits ?? 0} 點，開播需要至少 ${requiredCredits} 點/分鐘）`);
    return;
  }
  creditsPausedBannerEl.hidden = true;

  sonioxRetryCount = 0; // manual Start always gets a fresh retry budget
  userWantsRecording = true;
  // First Start flips the session created → live (SPEC §4); a later
  // pause/Start cycle re-sends this but the server treats it as a no-op.
  // translateEnabled/targetLanguage/sourceLangs are only for the session's DB
  // record (SPEC §6.5 "如實記錄") — they don't affect Soniox itself, which is
  // config'd separately in startRecording() below from the same controls.
  // The server independently re-derives and re-checks the credit rate from
  // these same fields before actually starting its billing timer (SPEC step
  // 6) — see server.js's host_start handler.
  sessionIsLive = true; // this session is now "in progress" — see hostLogoLink below
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'host_start',
      translateEnabled: translateEnabledEl.checked,
      targetLanguage: targetLangSelect.value,
      sourceLangs: sourceSelection.autoDetect ? ['auto'] : sourceSelection.codes,
    }));
  }
  startRecording();
});

// This is a pause, not a wipe: it only stops the Soniox session. History on
// the server and on every viewer is untouched, and Start can pick back up
// right after. Only clearBtn below ever clears anything. Shared by the
// manual Pause button below AND the server-driven force_pause message (SPEC
// step 6's auto-pause) — from this function's point of view the two are
// identical, only who triggered it differs.
async function pauseRecording() {
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
  // Billing (SPEC step 6): stop the server's per-minute meter — mirrors
  // host_start's role in starting it. Sent unconditionally; if the server
  // already stopped it on its own (this pause WAS the force_pause), it's a
  // harmless no-op there.
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'host_stop' }));
  }
}

stopBtn.addEventListener('click', () => {
  pauseRecording();
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
  await pauseRecording(); // no-op if nothing was recording — see its own guard
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'host_end_session' }));
  }
  sessionIsLive = false; // already confirmed above — logo click needs no second confirm now
  startBtn.disabled = true;
  stopBtn.disabled = true;
  clearBtn.disabled = true;
  endSessionBtn.disabled = true;
  statusEl.textContent = 'session ended';
  startTranscriptPolling();
});

// Logo → home (design: 各頁 logo 可回首頁). host's one rule: while the
// session is actually in progress, clicking it must confirm first — unlike
// every other page's logo, leaving here mid-broadcast can strand viewers
// without anyone noticing the tab is gone.
hostLogoLinkEl?.addEventListener('click', (e) => {
  if (!sessionIsLive) return; // not live — just let the <a href="/"> navigate normally
  e.preventDefault();
  if (confirm('本場仍在進行，確定離開？')) location.href = '/';
});
