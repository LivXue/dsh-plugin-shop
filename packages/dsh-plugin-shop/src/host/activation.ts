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
 * - A HOT MOUNT — an install — adds entries under the shop's own loader
 *   entry, which the registry enumerates like any other: across a reload
 *   following the mount the served graph gains the package and the page runs
 *   its browser half (measured 2026-09-26 on 0.1.5-rc.3 and 0.1.7-rc.2, in
 *   `web-full-flow.e2e.ts`). `true`.
 *
 * The asymmetry that decides every unknown still runs the same way: offering
 * a step that was not needed costs the reader one action, withholding one
 * that was needed is the defect this module exists to fix. Which step a hot
 * mount needs has been measured twice. On 2026-09-14 the graph came back
 * byte-identical across the reload, and installs moved to `restart` — but the
 * shop then registered the tree from whichever context made the RPC call, the
 * typert gateway's, and the registry never composed a tree hung there. Once
 * the tree hung off the shop's own entry (2026-09-26), the same measurement
 * found the package in the graph, and installs moved back to `reload`.
 */
export function activationOf(input: { hostLive: boolean; clientLive: boolean; hasClientHalf: boolean }): Activation {
  if (!input.hostLive) return 'restart'
  if (!input.hasClientHalf) return 'live'
  return input.clientLive ? 'reload' : 'restart'
}
