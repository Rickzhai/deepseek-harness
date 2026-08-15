/**
 * The gateway's self-contained login page (inline HTML/CSS/JS, no build).
 * The `<!-- __OIDC__ -->` marker is replaced at render time with the SSO link
 * when an OIDC provider is configured.
 * @module @deepseek-ai/dsh-host-web-gateway/src/login-page
 */

export const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness — Sign in</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 14px/1.5 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #0d1117; color: #e6edf3;
  }
  .card {
    width: min(360px, calc(100vw - 32px)); padding: 32px 28px;
    background: #161b22; border: 1px solid #30363d; border-radius: 12px;
  }
  .wordmark { font-size: 20px; font-weight: 700; letter-spacing: .5px; margin-bottom: 4px; }
  .sub { color: #8b949e; margin-bottom: 24px; }
  label { display: block; margin: 12px 0 4px; color: #c9d1d9; }
  input {
    width: 100%; padding: 8px 10px; border-radius: 6px;
    border: 1px solid #30363d; background: #0d1117; color: #e6edf3; font-size: 14px;
  }
  input:focus { outline: 2px solid #1f6feb; border-color: transparent; }
  button {
    width: 100%; margin-top: 20px; padding: 9px 0; border: 0; border-radius: 6px;
    background: #1f6feb; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  button:hover { background: #388bfd; }
  button:disabled { opacity: .6; cursor: default; }
  .sso {
    display: block; margin-top: 16px; text-align: center; color: #8b949e;
    text-decoration: none; font-size: 13px;
  }
  .sso:hover { color: #e6edf3; }
  .error { color: #f85149; margin-top: 12px; min-height: 20px; font-size: 13px; }
  .separator { margin: 20px 0 0; border-top: 1px solid #21262d; }
</style>
</head>
<body>
  <div class="card">
    <div class="wordmark">DeepSeek Harness</div>
    <div class="sub">Sign in to your workspace</div>
    <form id="login">
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="username" autofocus required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
      <div class="error" id="error"></div>
    </form>
    <!-- __OIDC__ -->
    <div class="separator"></div>
  </div>
<script>
  const form = document.getElementById('login');
  const error = document.getElementById('error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const submit = form.querySelector('button');
    submit.disabled = true;
    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value,
          password: document.getElementById('password').value,
        }),
      });
      if (response.ok) {
        window.location.assign('/');
        return;
      }
      const body = await response.json().catch(() => ({}));
      error.textContent = body.error === 'too-many-attempts'
        ? 'Too many attempts. Try again later.'
        : 'Invalid username or password.';
    } catch {
      error.textContent = 'Network error. Please retry.';
    } finally {
      submit.disabled = false;
    }
  });
</script>
</body>
</html>
`
