/**
 * What a reader must do before a change the shop just made becomes visible
 * (design 2026-09-11-activation-model §2).
 *
 * A dsh plugin has two halves that go live by different routes. The host
 * half is composed by the loader; the browser half reaches a tab only
 * through `window.__DSH_BOOT__`, which the harness rebuilds from the live
 * loader entries on every index request. So a tab that predates the change
 * is stale by one RELOAD, not by one restart — measured 2026-09-11 against
 * dsh 0.1.5-rc.1, where a runtime disable, a runtime enable and a hot mount
 * each moved the served graph within seconds without the process
 * restarting.
 *
 * Three values, not two booleans: `needsRestart` plus `needsReload` would
 * admit a true/true that the system cannot be in, and would make every
 * reader re-derive the precedence.
 *
 * This answers about VISIBILITY, never about correctness. `live` does not
 * claim the plugin works; tiering (§9) and harness compatibility
 * (2026-09-01-harness-compatibility) are what speak to that.
 */
export type Activation = 'live' | 'reload' | 'restart'

/**
 * Decide what the reader must do.
 *
 * @param input.hostLive - whether the plugin's host half is running in this
 * process right now: the hot-mount outcome for an install or update, and
 * unconditionally true for an uninstall (the fiber is gone) and for a
 * toggle (the user layer is hot-reloaded).
 * @param input.hasClientHalf - whether the package declares `dsh.client`.
 * An unreadable manifest reports `true`; see `client-half.ts` for why.
 */
export function activationOf(input: { hostLive: boolean; hasClientHalf: boolean }): Activation {
  if (!input.hostLive) return 'restart'
  return input.hasClientHalf ? 'reload' : 'live'
}
