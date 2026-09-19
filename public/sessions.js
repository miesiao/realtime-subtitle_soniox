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
const creditsAmountEl = document.getElementById('creditsAmount');
const filterChipsEl = document.getElementById('filterChips');
const newSessionBtn = document.getElementById('newSessionBtn');

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

const STATUS_LABELS = { created: '尚未開播', live: '直播中', paused: '暫停中', ended: '已結束' };
// Lines shown before the 展開/收合 toggle appears (SPEC: "只顯示前 5 行,不要
// 整份攤開"). The full text is already in hand once loadTranscript's fetch
// resolves (there's no separate "just the first N lines" endpoint) — this
// only limits what gets rendered into the DOM up front; expanding swaps in
// the same in-memory text rather than firing a second fetch.
const TRANSCRIPT_PREVIEW_LINES = 5;
const PROCESSING_LABELS = { queued:'等待整理', incomplete:'整理不完整', expired:'逐字稿已到期刪除', idle: '', processing: '整理中…', ready: '逐字稿已就緒', failed: '整理失敗' };

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function renderSessionRow(session) {
  if(session.transcriptExpired)session.processingStatus='expired';
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
  const deleteBtn = node.querySelector('.deleteBtn');
  const openBtn = node.querySelector('.openBtn');
  const endBtn = node.querySelector('.endBtn');
  const toggleTranscriptBtn = node.querySelector('.toggleTranscriptBtn');

  row.dataset.status = session.status;
  nameInput.value = session.name || '';
  statusBadge.textContent = STATUS_LABELS[session.status] || session.status;
  statusBadge.dataset.status = session.status;
  processingBadge.textContent = PROCESSING_LABELS[session.processingStatus] || '';
  processingBadge.dataset.processing = session.processingStatus || '';
  createdAtEl.textContent = formatDate(session.createdAt)+(session.expiresAt?' · 逐字稿保存至 '+formatDate(session.expiresAt):'');
  if(session.transcriptWarning){const warning=document.createElement('p');warning.textContent='逐字稿可能不完整，請下載原始稿核對。';row.append(warning);}
  const raw=document.createElement('a');raw.textContent='下載原始逐字稿';raw.href='/api/sessions/'+session.id+'/transcript/raw';raw.hidden=!!session.transcriptExpired;transcriptSection.append(raw);

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
        const lines = data.cleanedTranscript.split('\n');
        let expanded = false;
        const renderTranscript = () => {
          if (lines.length > TRANSCRIPT_PREVIEW_LINES) {
            toggleTranscriptBtn.hidden = false;
            toggleTranscriptBtn.textContent = expanded ? '收合' : '展開';
            transcriptTextEl.textContent = expanded
              ? data.cleanedTranscript
              : lines.slice(0, TRANSCRIPT_PREVIEW_LINES).join('\n');
          } else {
            toggleTranscriptBtn.hidden = true;
            transcriptTextEl.textContent = data.cleanedTranscript;
          }
        };
        renderTranscript();
        toggleTranscriptBtn.addEventListener('click', () => {
          expanded = !expanded;
          renderTranscript();
        });
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
    } else if (['failed','incomplete'].includes(session.processingStatus)) {
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

  // Reopen /host for this exact session (created-but-not-started, or still
  // live) — there is otherwise no way back in once the tab that created it
  // is gone, since /host no longer creates a session on its own.
  if (session.status === 'ended') {
    openBtn.hidden = true;
  } else {
    openBtn.href = `/host?id=${encodeURIComponent(session.id)}`;
  }

  // Manual safety net (SPEC fix: "場次沒結束一直掛 live") — offered for any
  // row still displaying as live or auto-paused, so a host can force-close a
  // session even when the tab/device that was running it is long gone.
  if (session.status === 'live' || session.status === 'paused') {
    endBtn.hidden = false;
    endBtn.addEventListener('click', async () => {
      if (!confirm('確定要結束本場嗎？結束後這個場次代碼就不能再進場了。')) return;
      endBtn.disabled = true;
      try {
        await apiFetchJson(`/api/sessions/${session.id}/end`, { method: 'POST' });
        await loadSessions();
        applyFilter();
        window.dispatchEvent(new Event('tours-changed'));
      } catch (err) {
        if (err.message === 'login_required') return;
        console.error('End session failed:', err);
        alert(`結束失敗：${err.message}`);
        endBtn.disabled = false;
      }
    });
  }

  // Delete (SPEC: "刪除場次") — never offered for a currently-live/paused
  // session (the server also blocks it with 409; hiding it here just avoids
  // surfacing a confusing error). A never-started session deletes instantly;
  // an ended one (has real history) needs an explicit confirm first.
  if (session.status === 'live' || session.status === 'paused') {
    deleteBtn.hidden = true;
  } else {
    deleteBtn.addEventListener('click', async () => {
      if (session.status === 'ended' && !confirm('這場已經有記錄，確定要刪除嗎？此動作無法復原。')) return;
      deleteBtn.disabled = true;
      try {
        await apiFetchJson(`/api/sessions/${session.id}`, { method: 'DELETE' });
        row.remove();
      } catch (err) {
        if (err.message === 'login_required') return;
        console.error('Delete failed:', err);
        alert(`刪除失敗：${err.message}`);
        deleteBtn.disabled = false;
      }
    });
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

refreshBtn.addEventListener('click', async () => {
  await loadSessions();
  applyFilter();
});

// --- Filter chips (全部/進行中/已結束) — purely client-side over rows already
// rendered by loadSessions; each row carries its own status via
// row.dataset.status (set in renderSessionRow above).
let activeFilter = 'all';
// 'paused' (server auto-paused — see STATUS_LABELS) counts as "進行中" here:
// it's the same "still open, not ended" state as 'live' from a host's
// point of view, just temporarily without an active connection.
function matchesFilter(status, filter) {
  if (filter === 'all') return true;
  if (filter === 'live') return status === 'live' || status === 'paused';
  return status === filter;
}
function applyFilter() {
  for (const row of listBodyEl.querySelectorAll('.session-row')) {
    row.hidden = !matchesFilter(row.dataset.status, activeFilter);
  }
}
filterChipsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-chip');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  for (const chip of filterChipsEl.querySelectorAll('.filter-chip')) {
    chip.classList.toggle('is-active', chip === btn);
  }
  applyFilter();
});

// "＋ 開新場次" (SPEC fix: session creation is now an explicit action, not a
// side effect of loading /host — that was the source of the zombie
// `created` rows this whole flow is meant to fix). Creates the session here
// and hands its id to /host, which loads that ONE session instead of
// creating a new one on every page load.
newSessionBtn.addEventListener('click', async () => {
  newSessionBtn.disabled = true;
  try {
    const newSession = await apiFetchJson('/api/sessions', { method: 'POST' });
    location.href = `/host?id=${encodeURIComponent(newSession.id)}`;
  } catch (err) {
    if (err.message === 'login_required') return;
    console.error('Failed to create session:', err);
    alert(`建立場次失敗：${err.message}`);
    newSessionBtn.disabled = false;
  }
});

async function loadCredits() {
  try {
    const { credits } = await apiFetchJson('/api/credits');
    creditsAmountEl.textContent = credits;
  } catch (err) {
    if (err.message === 'login_required') return; // already redirecting
    creditsAmountEl.textContent = '—';
  }
}

async function init() {
  try {
    const me = await apiFetchJson('/api/me');
    // /sessions itself already requires login server-side (redirects before
    // this script ever runs) — a guest response here only happens if the
    // login cookie expired in the gap between that page load and this fetch,
    // so this is a defense-in-depth fallback, not the primary gate.
    if (me.guest) { redirectToLogin(); return; }
    whoAmIEl.textContent = me.name || me.email || me.id;
  } catch (err) {
    if (err.message === 'login_required') return; // already redirecting
    whoAmIEl.textContent = `無法確認登入狀態：${err.message}`;
  }
  await Promise.all([loadSessions(), loadCredits()]);
  applyFilter();
}

init();
