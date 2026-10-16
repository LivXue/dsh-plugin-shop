/**
 * One keyed registry of install-shaped flows: start, poll to terminal, reset.
 *
 * Framework-free, so a flow can belong to the page rather than to a component
 * (design 2026-10-16-shop-sidebar-page §5). dsh mounts the shop only while it
 * is on screen, and a flow held in a component's state — the poll loop an
 * effect of that component — stopped the moment the reader looked elsewhere:
 * the install ran on in the host, and nothing was left to fold its status or
 * write its receipt. `useKeyedFlows` (useFlows.ts) renders a registry a
 * component owns; the page store (page-store.ts) owns three that outlive
 * every component showing them.
 *
 * Install and uninstall are the same machine, and so is the shop's own
 * update: they differ only in what the STARTING RPC's answer means, which is
 * the three `begin*` mappings at the foot of this file.
 */

import type { InstallArgs, ShopInstallResult, ShopInstallStatusResult, ShopUninstallResult, ShopUpdateResult } from '../host/index.ts'
import { isTerminalInstallState } from '../shared/install-state.ts'
import { INSTALL_POLL_MS, phaseOf, reduceInstall, type InstallView } from './present.ts'

/** The one idle view, so a key the registry holds no flow for and a key it
 * reset to idle hand a memoized consumer the same object. */
export const IDLE_VIEW: InstallView = { kind: 'idle' }

/** What a registry holds at one moment. Replaced whole on every change, so a
 * consumer can tell "changed" from "same" by identity. */
export interface FlowSnapshot {
  readonly views: ReadonlyMap<string, InstallView>
  /** Identities whose start is in flight and unanswered. */
  readonly starting: ReadonlySet<string>
}

export interface FlowRegistryDeps<TArgs> {
  /** The starting RPC with its answer mapped to the first view. Never
   * rejects: the mapping folds a transport throw into a view. */
  begin: (args: TArgs) => Promise<InstallView>
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>
  /** Once per identity that reaches a terminal state: which one, and the
   * arguments its flow was started with. The outcome is load-bearing: a
   * failed flow changed nothing on the server. */
  onSettled?: (key: string, outcome: 'done' | 'failed', args: TArgs) => void
}

export interface FlowRegistryOptions {
  /** Keep polling while nothing subscribes. The page store's registries do,
   * so an install the reader left finishes its receipt with no page showing
   * it; a component's own registry does not, so its polling stops when the
   * component unmounts and resumes if it mounts again. */
  pollUnwatched: boolean
}

export interface FlowRegistry<TArgs> {
  getSnapshot: () => FlowSnapshot
  subscribe: (listener: () => void) => () => void
  /** Start `key`'s flow. A second start while the first is unanswered is
   * ignored: the host does not dedupe, so a second RPC would download and
   * install the same thing twice. */
  start: (key: string, args: TArgs) => Promise<void>
  reset: (key: string) => void
  resetWhere: (predicate: (view: InstallView) => boolean) => void
  /** Stop for good: no more polling, starts or listeners. The snapshot stays
   * readable. */
  dispose: () => void
}

/**
 * @param deps read on every call, so an owner can hand over its latest
 *   functions without rebuilding the registry.
 */
export function createFlowRegistry<TArgs>(deps: () => FlowRegistryDeps<TArgs>, options: FlowRegistryOptions): FlowRegistry<TArgs> {
  let snapshot: FlowSnapshot = { views: new Map(), starting: new Set() }
  const listeners = new Set<() => void>()
  // The synchronous half of `starting`. Two clicks in one task both reach
  // `start` before any listener re-renders a button, and this is what the
  // second one sees.
  const inFlight = new Set<string>()
  const startedWith = new Map<string, TArgs>()
  let timer: ReturnType<typeof setInterval> | null = null
  let disposed = false

  const syncTimer = (): void => {
    const wanted = !disposed
      && (options.pollUnwatched || listeners.size > 0)
      && [...snapshot.views.values()].some(view => view.kind === 'running')
    if (wanted && timer === null) {
      timer = setInterval(poll, INSTALL_POLL_MS)
    } else if (!wanted && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const publish = (next: FlowSnapshot): void => {
    snapshot = next
    syncTimer()
    for (const listener of [...listeners]) listener()
  }

  const withView = (key: string, view: InstallView): ReadonlyMap<string, InstallView> => {
    const views = new Map(snapshot.views)
    views.set(key, view)
    return views
  }

  // One interval polls every running identity, so two panels showing one
  // install never poll the same host record twice.
  function poll(): void {
    for (const [key, view] of snapshot.views) {
      if (view.kind !== 'running') continue
      const { installId } = view
      void deps().installStatus({ installId }).then(status => {
        // A reset, or a newer start for the same identity, moved the view on
        // while this answer was out: it no longer describes what is shown,
        // and a second answer for one record must not settle it twice.
        const current = snapshot.views.get(key)
        if (disposed || current === undefined || current.kind !== 'running' || current.installId !== installId) return
        const next = reduceInstall(current, { type: 'status', status })
        if (next !== current) publish({ views: withView(key, next), starting: snapshot.starting })
        const args = startedWith.get(key)
        if (status.found && isTerminalInstallState(status.state) && args !== undefined) deps().onSettled?.(key, status.state, args)
      }, () => {
        // Poll failures are transient: the host retains the record, and the
        // next tick asks again.
      })
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      syncTimer()
      return () => {
        listeners.delete(listener)
        syncTimer()
      }
    },
    start: async (key, args) => {
      if (disposed || inFlight.has(key)) return
      inFlight.add(key)
      startedWith.set(key, args)
      // `idle` first, so a retry of a settled flow clears the previous
      // outcome before the new request is in flight rather than after it
      // answers.
      publish({ views: withView(key, IDLE_VIEW), starting: new Set(snapshot.starting).add(key) })
      try {
        const view = await deps().begin(args)
        if (!disposed) publish({ views: withView(key, view), starting: snapshot.starting })
      } finally {
        inFlight.delete(key)
        if (snapshot.starting.has(key)) {
          const starting = new Set(snapshot.starting)
          starting.delete(key)
          publish({ views: snapshot.views, starting })
        }
      }
    },
    reset: key => {
      if (!snapshot.views.has(key)) return
      const views = new Map(snapshot.views)
      views.delete(key)
      publish({ views, starting: snapshot.starting })
    },
    resetWhere: predicate => {
      let views: Map<string, InstallView> | null = null
      for (const [key, view] of snapshot.views) {
        if (!predicate(view)) continue
        views ??= new Map(snapshot.views)
        views.delete(key)
      }
      if (views !== null) publish({ views, starting: snapshot.starting })
    },
    dispose: () => {
      disposed = true
      listeners.clear()
      syncTimer()
    },
  }
}

/** The transport rule the three mappings share: a thrown start is a TRANSPORT
 * failure (index.ts's `unwrap` throws the prefixed wire code and message), not a
 * business rejection — `rejected` stays reserved for the host's ShopInstallResult
 * union (§7.2). The transport detail is private (it can name hosts and ports) and
 * never rendered, so the view carries an EMPTY detail and the surface falls back
 * to its localized transport line. Nothing else can reach these catches, because
 * every business union is a resolved value, never a throw. */
const transportFailed = (): InstallView => ({ kind: 'failed', detail: '', log: [] })

/** An install's start: the host's business union mapped to the first view. */
export function beginInstall(install: (args: InstallArgs) => Promise<ShopInstallResult>): (args: InstallArgs) => Promise<InstallView> {
  return async args => {
    try {
      const result = await install(args)
      if (!result.ok) return { kind: 'rejected', code: result.code, detail: result.detail }
      return { kind: 'running', installId: result.installId, log: [], phase: phaseOf(result.state) }
    } catch {
      return transportFailed()
    }
  }
}

/** An uninstall's start. A business refusal (not in the catalog, not
 * installed) is a `failed` view with the host's published detail, never an
 * install `rejected` code: those belong to the install gate, and
 * `ShopUninstallResult`'s refusal carries no code. */
export function beginUninstall(uninstall: (args: { name: string }) => Promise<ShopUninstallResult>): (args: { name: string }) => Promise<InstallView> {
  return async args => {
    try {
      const result = await uninstall(args)
      if (!result.ok) return { kind: 'failed', detail: result.detail, log: [] }
      return { kind: 'running', installId: result.installId, log: [], phase: 'installing' }
    } catch {
      return transportFailed()
    }
  }
}

/** The shop's own update's start: a refusal (a version that is not plain
 * semver) is a `failed` view with the host's detail, as an uninstall's is. */
export function beginUpdate(updateStart: (args: { version: string }) => Promise<ShopUpdateResult>): (args: { version: string }) => Promise<InstallView> {
  return async args => {
    try {
      const result = await updateStart(args)
      if (!result.ok) return { kind: 'failed', detail: result.detail, log: [] }
      return { kind: 'running', installId: result.installId, log: [], phase: phaseOf(result.state) }
    } catch {
      return transportFailed()
    }
  }
}
