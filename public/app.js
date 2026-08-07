import { SonioxClient } from '/vendor/soniox-client.mjs';
import * as OpenCC from '/vendor/opencc-cn2t.mjs';

// Soniox's language codes only have generic "zh" — no zh-Hant/zh-Hans, and
// there is no API parameter to force Traditional output. In practice the
// model often emits Simplified. So we force-convert everything we render
// to Traditional (Taiwan phrasing) client-side before it hits the DOM.
// Non-Chinese text passes through unchanged.
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });

// --- Traditional/Simplified Chinese heuristic ---------------------------
// This runs on Soniox's RAW (pre-conversion) text, purely to show what
// script Soniox itself actually produced (diagnostic badge) — it is not
// authoritative and not used to decide the displayed text, which is always
// force-converted to Traditional above regardless of this result.
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
const targetLangSelect = document.getElementById('targetLang');
const termsInput = document.getElementById('terms');
const statusEl = document.getElementById('status');
const originalTextEl = document.getElementById('originalText');
const translationTextEl = document.getElementById('translationText');
const originalScriptEl = document.getElementById('originalScript');
const translationScriptEl = document.getElementById('translationScript');

const LANG_CLASS = { zh: 'lang-zh', en: 'lang-en', es: 'lang-es' };
function langClass(lang) {
  return LANG_CLASS[lang] || 'lang-other';
}

// --- Soniox client (temporary key fetched fresh per recording session) --
const client = new SonioxClient({
  config: async () => {
    const res = await fetch('/api/temporary-key', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to fetch temporary key from server');
    const { api_key } = await res.json();
    return { api_key };
  },
});

let recording = null;

// Each stream (original / translation) keeps finalized items (tokens and
// endpoint markers, in order) plus the current in-flight non-final tokens,
// which get fully replaced on every message per the Soniox protocol.
function makeStream() {
  return { finalItems: [], nonFinalTokens: [] };
}
let originalStream = makeStream();
let translationStream = makeStream();

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

  // Labelled "Soniox 原始" because this reflects Soniox's raw output before
  // our forced Traditional conversion above — the text actually shown in
  // the panes is always Traditional regardless of what this badge says.
  const originalRaw = detectHanziScript(fullOriginalText);
  originalScriptEl.textContent = originalRaw ? `Soniox 原始：${originalRaw}` : '';

  if (targetLangSelect.value === 'zh') {
    const translationRaw = detectHanziScript(fullTranslationText);
    translationScriptEl.textContent = translationRaw ? `Soniox 原始：${translationRaw}` : '（尚無中文字元）';
  } else {
    translationScriptEl.textContent = '';
  }
}

function handleResult(result) {
  originalStream.nonFinalTokens = [];
  translationStream.nonFinalTokens = [];

  for (const token of result.tokens) {
    const isTranslation = token.translation_status === 'translation';
    const stream = isTranslation ? translationStream : originalStream;
    if (token.is_final) {
      stream.finalItems.push(token);
    } else {
      stream.nonFinalTokens.push(token);
    }
  }
  renderAll();
}

function handleEndpoint() {
  originalStream.finalItems.push({ endpoint: true });
  renderAll();
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

startBtn.addEventListener('click', () => {
  originalStream = makeStream();
  translationStream = makeStream();
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

  recording = client.realtime.record(config);

  recording.on('connected', () => {
    statusEl.textContent = 'recording';
  });
  recording.on('result', handleResult);
  recording.on('endpoint', handleEndpoint);
  recording.on('error', (err) => {
    console.error('Soniox error:', err);
    statusEl.textContent = `error: ${err.message || err}`;
    setUiRecording(false);
  });
  recording.on('state_change', ({ new_state }) => {
    if (new_state === 'stopped' || new_state === 'canceled' || new_state === 'error') {
      setUiRecording(false);
      statusEl.textContent = new_state;
    }
  });
});

stopBtn.addEventListener('click', async () => {
  if (!recording) return;
  statusEl.textContent = 'stopping…';
  try {
    await recording.stop();
  } catch (err) {
    console.error('Stop failed:', err);
  }
  setUiRecording(false);
  statusEl.textContent = 'idle';
});
