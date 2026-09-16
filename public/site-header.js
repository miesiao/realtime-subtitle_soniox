// Registration and sign-in share the existing Google OAuth flow.
const header = document.querySelector('.site-header');
if (header) {
  const login = header.querySelector('[data-header-login]');
  const returnTo = ['/host', '/login-failed', '/login-failed.html'].includes(location.pathname) ? '/sessions' : location.pathname + location.search;
  if (login) login.href = '/auth/google?returnTo=' + encodeURIComponent(returnTo);
  fetch('/api/me', { credentials: 'same-origin' })
    .then(response => response.ok ? response.json() : null)
    .then(me => {
      if (!me || me.guest) return;
      if (login) login.hidden = true;
      for (const element of header.querySelectorAll('[data-header-account]')) element.hidden = false;
      const name = header.querySelector('[data-header-name]');
      if (name) { name.textContent = me.name || me.email || '已登入'; name.title = name.textContent; }
    })
    .catch(() => {}); // The sign-in link stays usable if identity lookup fails.
}
