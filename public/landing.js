// Landing page CTA (SPEC-adjacent, not in the original v2 doc): if you're
// already logged in, sends you straight to your sessions list instead of
// back through Google again. A signed-out visitor just sees the default
// login/register link already in the HTML — no need to wait on this fetch.
const ctaBtn = document.getElementById('ctaBtn');

fetch('/api/me', { credentials: 'same-origin' })
  .then((res) => (res.ok ? res.json() : null))
  .then((me) => {
    if (!me) return;
    ctaBtn.textContent = '前往我的場次 →';
    ctaBtn.href = '/sessions';
  })
  .catch(() => {}); // stay on the default login link if this fails
