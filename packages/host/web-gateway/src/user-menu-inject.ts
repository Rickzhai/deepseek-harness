/**
 * User-menu HTML injection for the gateway reverse proxy. The gateway serves
 * the login page, then proxies everything else to each user's own dsh web
 * instance; the proxied SPA knows nothing about the gateway, so this module
 * injects a small self-contained <style>+<script> into the SPA's index.html.
 * The script calls the gateway's own `/auth/me` (same-origin, cookie-authentic)
 * and renders an avatar + username + sign-out menu in the top-right corner.
 * When the gateway is absent (plain single-user dsh) `/auth/me` answers 401
 * and the script renders nothing, so the injection is harmless there too.
 * @module @deepseek-ai/dsh-host-web-gateway/src/user-menu-inject
 */

/** The injected HTML fragment, inserted before the SPA's closing </head>. */
export const USER_MENU_INJECT = `<!-- dsh-web-gateway user menu -->
<style data-dsh-gateway-user>
  .dsh-gu-user { position: fixed; top: 12px; right: 12px; z-index: 2147483000;
    font: 13px/1.5 -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .dsh-gu-user .avatar { width: 34px; height: 34px; border-radius: 50%;
    background: #1f6feb; color: #fff; display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 15px; cursor: pointer; user-select: none;
    border: 1px solid rgba(255,255,255,.15); }
  .dsh-gu-user .menu { display: none; position: absolute; top: 42px; right: 0;
    min-width: 200px; background: #161b22; border: 1px solid #30363d; border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); padding: 6px 0; }
  .dsh-gu-user .menu.open { display: block; }
  .dsh-gu-user .menu .name { padding: 8px 14px 2px; color: #e6edf3; font-weight: 700; font-size: 14px; }
  .dsh-gu-user .menu .meta { padding: 0 14px 8px; color: #8b949e; font-size: 12px; }
  .dsh-gu-user .menu .item { display: block; width: 100%; text-align: left; padding: 7px 14px;
    background: none; border: 0; color: #e6edf3; font-size: 13px; cursor: pointer; }
  .dsh-gu-user .menu .item:hover { background: #21262d; }
  .dsh-gu-user .menu .item.danger { color: #f85149; }
  .dsh-gu-user .menu .divider { border-top: 1px solid #21262d; margin: 5px 0; }
</style>
<script data-dsh-gateway-user>
(function () {
  function render(user) {
    var initial = (user.username || '?').charAt(0).toUpperCase()
    var roles = (user.roles || []).join(', ') || 'member'
    var wrap = document.createElement('div')
    wrap.className = 'dsh-gu-user'
    var menu = document.createElement('div')
    menu.className = 'menu'
    menu.innerHTML = ''
    var nameEl = document.createElement('div')
    nameEl.className = 'name'
    nameEl.textContent = user.username
    var metaEl = document.createElement('div')
    metaEl.className = 'meta'
    metaEl.textContent = roles
    var divider = document.createElement('div')
    divider.className = 'divider'
    var signOut = document.createElement('button')
    signOut.className = 'item danger'
    signOut.textContent = 'Sign out'
    signOut.addEventListener('click', function () {
      fetch('/auth/logout', { method: 'POST' }).finally(function () {
        window.location.assign('/login')
      })
    })
    menu.appendChild(nameEl)
    menu.appendChild(metaEl)
    menu.appendChild(divider)
    menu.appendChild(signOut)
    var avatar = document.createElement('div')
    avatar.className = 'avatar'
    avatar.textContent = initial
    avatar.title = user.username
    avatar.addEventListener('click', function (e) {
      e.stopPropagation()
      menu.classList.toggle('open')
    })
    document.addEventListener('click', function () { menu.classList.remove('open') })
    wrap.appendChild(avatar)
    wrap.appendChild(menu)
    document.body.appendChild(wrap)
  }
  fetch('/auth/me', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null })
    .then(function (data) { if (data && data.user) render(data.user) })
    .catch(function () { /* no gateway / not authenticated — render nothing */ })
})()
</script>`

/**
 * Inject the user menu before the first closing </head> of an SPA document.
 * Idempotent: a document already carrying the marker is returned unchanged.
 * @param html - the raw index.html body.
 * @returns the transformed body.
 */
export function injectUserMenu(html: string): string {
  if (html.includes('data-dsh-gateway-user')) return html
  const at = html.indexOf('</head>')
  if (at === -1) return html
  return html.slice(0, at) + USER_MENU_INJECT + html.slice(at)
}
