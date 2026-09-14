/**
 * What a reader must do before a change the shop just made becomes visible
 * (design 2026-09-11-activation-model §2).
 *
 * A dsh plugin has two halves that go live by different routes. The host half
 * is composed by the loader. The browser half reaches a tab only through
 * `window.__DSH_BOOT__`, which the harness composes and the webserver injects
 * on every index request — so where that graph already holds the change, a
 * tab predating it is stale by one RELOAD rather than by one restart.
 *
 * Three values, not two booleans: `needsRestart` plus `needsReload` would
 * admit a true/true that the system cannot be in, and would make every reader
 * re-derive the precedence.
 *
 * This answers about VISIBILITY, never about correctness. `live` does not
 * claim the plugin works; tiering (§9) and harness compatibility
 * (2026-09-01-harness-compatibility) are what speak to that.
 */
export type Activation = 'live' | 'reload' | 'restart'

/**
 * Decide what the reader must do.
 *
 * @param input.hostLive - whether the plugin's host half is in its intended
 * post-change state in this process right now: the hot-mount outcome for an
 * install or update, whether the fiber actually went away for an uninstall,
 * and true for a toggle (the user layer is hot-reloaded).
 * @param input.hasClientHalf - whether the package declares `dsh.client`. An
 * unreadable manifest reports `true`; see `client-half.ts` for why.
 * @param input.clientLive - whether THIS change's browser half is in the
 * graph the webserver hands a reloading tab.
 *
 * `clientLive` is the difference between the two routes a change can take,
 * and it is measured rather than assumed:
 *
 * - A change to the BOOT COMPOSITION — a toggle, an uninstall — moves an
 *   entry the registry already enumerates, and the served graph follows it
 *   within seconds (§2, measured 2026-09-11). `true`.
 * - A HOT MOUNT — an install or an update — adds to the live loader entries
 *   without entering that composition, so the graph a tab reloads into does
 *   not contain the package. Measured 2026-09-14 against dsh 0.1.5-rc.1 in
 *   `web-full-flow.e2e.ts`: across a reload following a hot mount the graph
 *   is byte-identical, same `rev`, while the package's host half is live the
 *   whole time. `false` — and a `restart` is then the only honest answer,
 *   because there is nothing a reload could fetch.
 *
 * The asymmetry that decides every unknown still runs the same way: offering
 * a step that was not needed costs the reader one action, withholding one
 * that was needed is the defect this module exists to fix. What changed on
 * 2026-09-14 is which step is the needed one after a hot mount.
 */
export function activationOf(input: { hostLive: boolean; clientLive: boolean; hasClientHalf: boolean }): Activation {
  if (!input.hostLive) return 'restart'
  if (!input.hasClientHalf) return 'live'
  return input.clientLive ? 'reload' : 'restart'
}
