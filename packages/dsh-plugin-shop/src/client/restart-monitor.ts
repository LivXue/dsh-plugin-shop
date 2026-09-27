/**
 * The restart handoff's browser half (design §8), held by the page rather
 * than by the tab that confirmed the restart.
 *
 * It lived in a RestartPanel effect until 2026-09-27, and a self-update
 * killed it. dsh's client HMR (`@deepseek-ai/dsh-client-hmr`, mounted by the
 * web bundle unconditionally) stat-polls every client bundle and hot-swaps
 * one whose file changed; a self-update rewrites this package's own
 * `lib/client.js`, so the swap disposes the tab's fiber and mounts a fresh
 * instance of a freshly imported module. The effect's cleanup then stopped
 * the probe, and once the restart finished nothing reloaded the page: it sat
 * on the old process's answers while dsh's socket quietly reconnected to the
 * new one. Measured on dsh 0.1.5-rc.3 updating 0.8.2 to 0.8.3; with the
 * `/plugins/events` channel blocked the same flow reloaded.
 *
 * So the state sits on `globalThis` under a registry symbol — the one thing a
 * swapped-in module instance shares with the one it replaced — and the probe
 * loop is plain timers owned by no fiber. Any tab reads the state, so the
 * replacement renders the restart under way instead of offering another.
 */

import { INSTALL_POLL_MS, RESTART_GRACE_MS, restartMonitorVerdict } from './present.ts'

/** A restart this page committed: still waiting for the new server, or
 * given up on it. `logFile` is where the host said the new process writes;
 * a host older than that field sends none. */
export type RestartMonitorState =
  | { kind: 'restarting'; logFile?: string }
  | { kind: 'failed'; logFile?: string }

interface MonitorStore {
  state: RestartMonitorState | null
  listeners: Set<() => void>
  /** Stops the running probe loop; null when none runs. */
  stop: (() => void) | null
}

/** Registry symbol, so every module instance on the page finds the same store. */
const STORE_KEY = Symbol.for('dsh-plugin-shop.restart-monitor')

function monitorStore(): MonitorStore {
  const page = globalThis as unknown as Record<symbol, MonitorStore | undefined>
  let store = page[STORE_KEY]
  if (store === undefined) {
    store = { state: null, listeners: new Set(), stop: null }
    page[STORE_KEY] = store
  }
  return store
}

function settle(store: MonitorStore, state: RestartMonitorState | null): void {
  store.state = state
  for (const listener of [...store.listeners]) listener()
}

/** The page's restart, or null when it has committed none. The same object
 * until the state changes, as `useSyncExternalStore` requires. */
export function readRestartMonitor(): RestartMonitorState | null {
  return monitorStore().state
}

/** Be told when the page's restart changes state. */
export function subscribeRestartMonitor(listener: () => void): () => void {
  const store = monitorStore()
  store.listeners.add(listener)
  return () => { store.listeners.delete(listener) }
}

/**
 * Watch the origin for the restarted server and reload into it: probe once
 * the grace period is over (the host exits within it, so an answer is the NEW
 * server), and reload only after it has KEPT answering for the stable window.
 * A boot that is about to fail can bind the port and answer before its plugin
 * tree is audited and it exits; reloading on that one answer left the reader
 * on a blank page instead of the notice naming the log (design
 * 2026-09-26-market-borrowings §3). `restartMonitorVerdict` decides; this
 * loop only probes. Probes never overlap: each is scheduled one poll interval
 * after the previous one settled.
 *
 * A restart already being watched is left alone — every offer on the page
 * renders this state, so a second press can only come from a panel that has
 * not re-rendered yet, and a second loop would probe the same origin twice.
 */
export function startRestartMonitor(options: { reload: () => void; logFile?: string }): void {
  const store = monitorStore()
  if (store.state?.kind === 'restarting') return
  store.stop?.()
  const { reload, logFile } = options
  const started = Date.now()
  let stableSince: number | null = null
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const probe = async (): Promise<void> => {
    if (Date.now() - started >= RESTART_GRACE_MS) {
      let up = false
      try {
        // A fetch resolves on ANY status, and a proxy's 502 is not dsh
        // answering: only a 2xx counts.
        up = (await fetch(globalThis.location.href, { cache: 'no-store' })).ok
      } catch {
        // Refused or reset: the new server is not up — yet, or any more.
      }
      if (stopped) return
      const elapsed = Date.now() - started
      stableSince = up ? (stableSince ?? elapsed) : null
      const verdict = restartMonitorVerdict({ elapsedMs: elapsed, stableSinceMs: stableSince })
      if (verdict === 'reload') {
        store.stop = null
        reload()
        return
      }
      if (verdict === 'failed') {
        store.stop = null
        settle(store, logFile === undefined ? { kind: 'failed' } : { kind: 'failed', logFile })
        return
      }
    }
    timer = setTimeout(() => { void probe() }, INSTALL_POLL_MS)
  }
  store.stop = () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
  timer = setTimeout(() => { void probe() }, INSTALL_POLL_MS)
  settle(store, logFile === undefined ? { kind: 'restarting' } : { kind: 'restarting', logFile })
}

/** Stop the probe loop and forget the page's restart. Nothing in the page
 * calls this — a committed restart ends in a reload or a failure — so its
 * caller is a test isolating one case from the next. */
export function resetRestartMonitor(): void {
  const store = monitorStore()
  store.stop?.()
  store.stop = null
  settle(store, null)
}
