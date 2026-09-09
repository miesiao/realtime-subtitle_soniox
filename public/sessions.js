// "My sessions" list (SPEC §3a point 5) — this is the page that fixes "host
// disappeared, transcript gone forever": log back in, everything you own is
// still here, keyed by account rather than by browser memory.
//
// Identity is entirely server-side (httpOnly session cookie) — this page
// never stores or reasons about who's logged in on its own, it just asks
// /api/me and renders whatever comes back. The server also gates GET
// /sessions itself (redirects to /auth/google if you're signed out), so the
// 401 handling here is a defense-in-depth fallback for a cookie that expired
// after the page already loaded, not the primary gate.
const whoAmIEl = document.getElementById('whoAmI');
const listBodyEl = document.getElementById('listBody');
const listStatusEl = document.getElementById('listStatus');
const refreshBtn = document.getElementById('refreshBtn');
const rowTemplate = document.getElementById('sessionRowTemplate');

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

const STATUS_LABELS = { created: '尚未開播', live: '直播中', ended: '已結束' };
const PROCESSING_LABELS = { idle: '', processing: '整理中…', ready: '逐字稿已就緒', failed: '整理失敗' };

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function renderSessionRow(session) {
  const node = rowTemplate.content.cloneNode(true);
  const row = node.querySelector('.session-row');
  const nameInput = node.querySelector('.session-name-input');
  const renameBtn = node.querySelector('.renameBtn');
  const renameStatusEl = node.querySelector('.renameStatus');
  const statusBadge = node.querySelector('.statusBadge');
  const processingBadge = node.querySelector('.processingBadge');
  const createdAtEl = node.querySelector('.createdAt');
  const transcriptSection = node.querySelector('.session-row-transcript');
  const downloadBtn = node.querySelector('.downloadBtn');
  const retryBtn = node.querySelector('.retryBtn');
  const transcriptTextEl = node.querySelector('.transcriptText');

  nameInput.value = session.name || '';
  statusBadge.textContent = STATUS_LABELS[session.status] || session.status;
  processingBadge.textContent = PROCESSING_LABELS[session.processingStatus] || '';
  createdAtEl.textContent = formatDate(session.createdAt);

  renameBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { renameStatusEl.textContent = '名稱不可為空'; return; }
    renameBtn.disabled = true;
    renameStatusEl.textContent = '改名中…';
    try {
      await apiFetchJson(`/api/sessions/${session.id}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      renameStatusEl.textContent = '已更新';
    } catch (err) {
      console.error('Rename failed:', err);
      renameStatusEl.textContent = `改名失敗：${err.message}`;
    } finally {
      renameBtn.disabled = false;
    }
  });

  async function loadTranscript() {
    try {
      const data = await apiFetchJson(`/api/sessions/${session.id}/transcript`);
      if (data.processingStatus === 'ready' && data.cleanedTranscript) {
        transcriptTextEl.textContent = data.cleanedTranscript;
        downloadBtn.hidden = false;
        downloadBtn.onclick = () => {
          const blob = new Blob([data.cleanedTranscript], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${data.name || 'transcript'}.txt`;
          a.click();
          URL.revokeObjectURL(url);
        };
      }
    } catch (err) {
      console.error('Transcript fetch failed:', err);
      transcriptTextEl.textContent = `讀取逐字稿失敗：${err.message}`;
    }
  }

  if (session.status === 'ended') {
    transcriptSection.hidden = false;
    if (session.processingStatus === 'ready') {
      loadTranscript();
    } else if (session.processingStatus === 'failed') {
      retryBtn.hidden = false;
      retryBtn.addEventListener('click', async () => {
        retryBtn.disabled = true;
        try {
          await apiFetchJson(`/api/sessions/${session.id}/transcript/retry`, { method: 'POST' });
          processingBadge.textContent = PROCESSING_LABELS.processing;
        } catch (err) {
          console.error('Retry failed:', err);
        } finally {
          retryBtn.disabled = false;
        }
      });
    }
  }

  return row;
}

async function loadSessions() {
  listStatusEl.textContent = '載入中…';
  listStatusEl.hidden = false;
  try {
    const sessionList = await apiFetchJson('/api/sessions');
    listBodyEl.querySelectorAll('.session-row').forEach((el) => el.remove());
    if (sessionList.length === 0) {
      listStatusEl.textContent = '還沒有任何場次 — 去開一場吧。';
      return;
    }
    listStatusEl.hidden = true;
    for (const session of sessionList) {
      listBodyEl.appendChild(renderSessionRow(session));
    }
  } catch (err) {
    if (err.message === 'login_required') return; // already redirecting
    console.error('Failed to load sessions:', err);
    listStatusEl.hidden = false;
    listStatusEl.textContent = `載入失敗：${err.message}`;
  }
}

refreshBtn.addEventListener('click', loadSessions);

async function init() {
  try {
    const me = await apiFetchJson('/api/me');
    whoAmIEl.textContent = `登入身分：${me.name || me.email || me.id}`;
  } catch (err) {
    if (err.message === 'login_required') return; // already redirecting
    whoAmIEl.textContent = `無法確認登入狀態：${err.message}`;
  }
  await loadSessions();
}

init();
