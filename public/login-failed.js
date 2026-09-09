// Explains why /auth/google/callback redirected here instead of logging
// the user in (SPEC: allowlist rejection needs a message a real person can
// act on, not a bare "login=failed"). `reason`/`email` come from the
// server's redirect query string — still untrusted input from the client's
// own address bar, so this only ever sets .textContent, never innerHTML.
const params = new URLSearchParams(location.search);
const reason = params.get('reason');
const email = params.get('email');
const messageEl = document.getElementById('messageText');

const MESSAGES = {
  not_allowlisted: email
    ? `你的 Google 帳號（${email}）目前未獲授權使用本服務。請聯繫管理員，將這個帳號加入允許清單後再試一次。`
    : '你的 Google 帳號目前未獲授權使用本服務。請聯繫管理員，將這個帳號加入允許清單後再試一次。',
  oauth_failed: 'Google 登入過程發生問題（可能是取消了授權，或連線逾時），請回首頁再試一次。',
};

messageEl.textContent = MESSAGES[reason] || MESSAGES.oauth_failed;
