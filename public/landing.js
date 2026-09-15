// Landing page CTA (SPEC-adjacent, not in the original v2 doc): if you're
// already logged in, sends you straight to your sessions list instead of
// back through Google again. A signed-out visitor just sees the default
// login/register link already in the HTML — no need to wait on this fetch.
const ctaBtn = document.getElementById('ctaBtn');

fetch('/api/me', { credentials: 'same-origin' })
  .then((res) => (res.ok ? res.json() : null))
  .then((me) => {
    // /api/me now returns 200 { guest: true } for a signed-out caller (SPEC
    // guest-mode change, so /host can tell "not logged in" apart from an
    // error) instead of 401 — a guest must still see the default login link,
    // not be sent to /sessions, which they don't have access to.
    if (!me || me.guest) return;
    ctaBtn.textContent = '前往字幕場次 →';
    ctaBtn.href = '/sessions';
  })
  .catch(() => {}); // stay on the default login link if this fails
