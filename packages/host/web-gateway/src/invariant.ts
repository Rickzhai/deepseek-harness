/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-web-gateway`.
 * @module @deepseek-ai/dsh-host-web-gateway/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-web-gateway'

/** Cordis companion plugin name. */
export const name = 'host-web-gateway-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the gateway is a standalone edge process whose
 * session/user/instance invariants are enforced by its own request gate and
 * covered by the package's unit tests, not by teardown-stream probes.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
