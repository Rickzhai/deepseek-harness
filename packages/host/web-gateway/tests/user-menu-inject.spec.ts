/**
 * User-menu HTML injection unit tests.
 */

import { describe, expect, it } from 'vitest'
import { injectUserMenu, USER_MENU_INJECT } from '../src/user-menu-inject.ts'

describe('injectUserMenu', () => {
  it('injects the menu before the closing </head>', () => {
    const html = '<!doctype html><html><head><title>x</title></head><body></body></html>'
    const out = injectUserMenu(html)
    expect(out).toContain('data-dsh-gateway-user')
    expect(out.indexOf('data-dsh-gateway-user')).toBeLessThan(out.indexOf('</head>'))
  })

  it('is idempotent (marker present → unchanged)', () => {
    const html = '<html><head>' + USER_MENU_INJECT + '</head><body></body></html>'
    expect(injectUserMenu(html)).toBe(html)
  })

  it('leaves a document without </head> unchanged', () => {
    const html = '<html><body>no head close</body></html>'
    expect(injectUserMenu(html)).toBe(html)
  })

  it('calls /auth/me and /auth/logout against the gateway origin', () => {
    // The injected script is self-contained; assert the two endpoint paths it
    // depends on are present so a regression in the fetch targets is caught.
    expect(USER_MENU_INJECT).toContain('/auth/me')
    expect(USER_MENU_INJECT).toContain('/auth/logout')
  })
})
