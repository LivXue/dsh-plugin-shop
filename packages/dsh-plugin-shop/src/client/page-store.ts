/**
 * The shop page's state, held by the page rather than by the components that
 * show it (design 2026-10-16-shop-sidebar-page §5).
 *
 * dsh mounts the shop only while it is on screen — the Settings shell renders
 * only the open section, the main column only the selected panel — so what a
 * component held in its own state went the moment the reader looked
 * elsewhere: the search text, the filters, an install's progress and its
 * receipt, the restart offer included (the shop design's §5.1, "Leaving the
 * section"). This store keeps them, and it owns the flows' polling
 * (flow-registry.ts), so an install the reader left still has its status
 * folded and its receipt written.
 *
 * It sits on `globalThis` under a registry symbol for the reason
 * `restart-monitor.ts` does: the symbol is the one thing a hot-swapped module
 * instance shares with the one it replaced. Each `apply` still builds a new
 * store (index.ts), because a re-applied bundle is a new page.
 */

import type { InstallArgs, ShopInstallResult, ShopInstallStatusResult, ShopUninstallResult, ShopUpdateResult } from '../host/index.ts'
import { beginInstall, beginUninstall, beginUpdate, createFlowRegistry, type FlowRegistry, type FlowRegistryOptions } from './flow-registry.ts'
import { SHOP_VISIBLE_BATCH, settledByRestart, type Category, type ShelfOrder } from './present.ts'

/** The reader's controls over the shelf, kept across leaving and returning. */
export interface ShelfView {
  readonly query: string
  /** `installed` is a filter mode alongside the catalog categories: it selects
   * by installed state, not by `catalog.category`. */
  readonly category: Category | 'installed' | null
  /** Design 2026-10-12-shelf-orders §4. In memory like every control here: a
   * page reload starts at the star order. */
  readonly order: ShelfOrder
  /** Off by default: a filter nobody asked for must not hide listings on
   * first open. Independent of `category`, because it subtracts from
   * whatever the categories selected rather than competing with them. */
  readonly hideIncompatible: boolean
  /** How far the shelf has grown, in §A1's batches. */
  readonly visibleCount: number
  /** Identities whose card is expanded. */
  readonly expanded: ReadonlySet<string>
}

/** What a switch owes before the page shows the truth (ShopTab's
 * `EnabledSwitch`). */
export type OwedNotice = 'reload' | 'restart'

export interface PageSnapshot {
  readonly view: ShelfView
  /** Keyed by the switch: `<surface>:<identity>`, since an outdated plugin
   * draws two switches and each owes only what was done to it. */
  readonly owed: ReadonlyMap<string, OwedNotice>
  /** A settle changed what the catalog's verdicts depend on, and no page has
   * asked for them again since (design 2026-09-01-harness-compatibility
   * section 9.1). */
  readonly reverdictPending: boolean
  /** Bumped by every settle that may have changed the profile and by dsh
   * restarting under the page: a mounted page re-reads the installed list. */
  readonly settled: number
}

/** The RPCs the store's flows run on: the shop's injected face. */
export interface PageStoreDeps {
  install: (args: InstallArgs) => Promise<ShopInstallResult>
  uninstall: (args: { name: string }) => Promise<ShopUninstallResult>
  updateStart: (args: { version: string }) => Promise<ShopUpdateResult>
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>
  /** Tells the client half a package left the profile: index.ts's
   * page-removed set, which the module table must never override. */
  noteUninstalled?: (name: string) => void
}

export interface ShopPageStore {
  /** The shape a successor may read (design §6). */
  readonly schema: 1
  readonly installs: FlowRegistry<InstallArgs>
  readonly uninstalls: FlowRegistry<{ name: string }>
  readonly self: FlowRegistry<{ version: string }>
  getSnapshot: () => PageSnapshot
  subscribe: (listener: () => void) => () => void
  setView: (patch: Partial<ShelfView>) => void
  updateView: (update: (view: ShelfView) => Partial<ShelfView>) => void
  toggleExpanded: (key: string) => void
  /** Sticky, and a restart outranks a reload. */
  setOwed: (switchKey: string, owed: OwedNotice) => void
  clearReverdict: () => void
  /** dsh restarted under the page (index.ts `onRestarted`). */
  noteRestarted: () => void
  /** Stop the flows' polling and drop every listener. Snapshots stay
   * readable, and the store stays under its page key until the next `apply`
   * replaces it: a successor reads what this instance left from there
   * (design 2026-10-16-shop-sidebar-page §5.1, §6). */
  dispose: () => void
}

/** The shelf a page opens on: the star order, every category, one batch. */
export const INITIAL_VIEW: ShelfView = {
  query: '',
  category: null,
  order: 'stars',
  hideIncompatible: false,
  visibleCount: SHOP_VISIBLE_BATCH,
  expanded: new Set(),
}

/**
 * @param deps read on every call, so the owner can hand over its latest
 *   functions without rebuilding the store.
 * @param options the page's own store polls unwatched; a store a tab builds
 *   for itself does not, and stops with the tab (ShopTab).
 */
export function createPageStore(deps: () => PageStoreDeps, options: FlowRegistryOptions): ShopPageStore {
  let snapshot: PageSnapshot = { view: INITIAL_VIEW, owed: new Map(), reverdictPending: false, settled: 0 }
  const listeners = new Set<() => void>()
  const publish = (next: Partial<PageSnapshot>): void => {
    snapshot = { ...snapshot, ...next }
    for (const listener of [...listeners]) listener()
  }
  /** One settle the page reacts to: re-read the installed list and, when the
   * catalog's verdicts may have moved, judge them again. */
  const settle = (reverdict: boolean): void => {
    publish({ settled: snapshot.settled + 1, reverdictPending: snapshot.reverdictPending || reverdict })
  }

  /** The owed map without one notice kind, or null when it holds none of
   * them — so a caller can publish an unchanged map by saying nothing. */
  const withoutOwed = (kind: OwedNotice): Map<string, OwedNotice> | null => {
    let next: Map<string, OwedNotice> | null = null
    for (const [key, value] of snapshot.owed) {
      if (value !== kind) continue
      next ??= new Map(snapshot.owed)
      next.delete(key)
    }
    return next
  }

  // Install and uninstall are mutually exclusive answers about one identity,
  // so each one's settle supersedes the other's receipt for that key.
  const installs = createFlowRegistry<InstallArgs>(() => ({
    begin: beginInstall(deps().install),
    installStatus: deps().installStatus,
    onSettled: (key, outcome) => {
      // A FAILED install installed nothing, so a previous uninstall's
      // receipt is still the truth about this identity.
      if (outcome === 'done') uninstalls.reset(key)
      // An install that lands can resolve another entry's missing peer, so
      // the catalog is judged again — never after a failed one, which
      // changed nothing. Either outcome re-reads the installed list.
      settle(outcome === 'done')
    },
  }), options)
  const uninstalls = createFlowRegistry<{ name: string }>(() => ({
    begin: beginUninstall(deps().uninstall),
    installStatus: deps().installStatus,
    onSettled: (key, outcome, args) => {
      // A FAILED uninstall removed nothing: the package is still installed,
      // and an update before it still owes its restart.
      if (outcome !== 'done') return
      installs.reset(key)
      // The page-removed set keys on the bare package name the uninstall was
      // started with, never on the identity key (module-table.ts).
      deps().noteUninstalled?.(args.name)
      // Uninstalling can free another entry's blocked peer, and stops the
      // module table vouching for the name just removed.
      settle(true)
    },
  }), options)
  const self = createFlowRegistry<{ version: string }>(() => ({
    begin: beginUpdate(deps().updateStart),
    installStatus: deps().installStatus,
  }), options)

  return {
    schema: 1,
    installs,
    uninstalls,
    self,
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setView: patch => { publish({ view: { ...snapshot.view, ...patch } }) },
    updateView: update => { publish({ view: { ...snapshot.view, ...update(snapshot.view) } }) },
    toggleExpanded: key => {
      const expanded = new Set(snapshot.view.expanded)
      if (!expanded.delete(key)) expanded.add(key)
      publish({ view: { ...snapshot.view, expanded } })
    },
    setOwed: (switchKey, owed) => {
      const current = snapshot.owed.get(switchKey)
      // A later toggle that applied live does not say an earlier restart is
      // no longer owed, so nothing but a restart under the page lowers one.
      if (current === 'restart' || current === owed) return
      const next = new Map(snapshot.owed)
      next.set(switchKey, owed)
      publish({ owed: next })
    },
    clearReverdict: () => {
      if (snapshot.reverdictPending) publish({ reverdictPending: false })
    },
    noteRestarted: () => {
      // What the restart settled: every receipt waiting for exactly that, and
      // every switch's restart notice. A reload is still owed by a page
      // nobody reloaded, a failure still happened, and a flow still running
      // settles by its own poll (design §8, 2026-10-06 amendment).
      self.resetWhere(settledByRestart)
      installs.resetWhere(settledByRestart)
      uninstalls.resetWhere(settledByRestart)
      const owed = withoutOwed('restart')
      publish({ ...(owed === null ? {} : { owed }), settled: snapshot.settled + 1, reverdictPending: true })
    },
    dispose: () => {
      installs.dispose()
      uninstalls.dispose()
      self.dispose()
      listeners.clear()
    },
  }
}

/** Registry symbol, so every module instance on the page finds one store. */
const STORE_KEY = Symbol.for('dsh-plugin-shop.page')

type PageGlobal = Record<symbol, ShopPageStore | undefined>

/** The store a 0.9.0-or-later shop left on this page, if one did. */
export function readPageStore(): ShopPageStore | undefined {
  return (globalThis as unknown as PageGlobal)[STORE_KEY]
}

/** Make `store` the page's. Returns the store it replaces. */
export function installPageStore(store: ShopPageStore): ShopPageStore | undefined {
  const page = globalThis as unknown as PageGlobal
  const previous = page[STORE_KEY]
  page[STORE_KEY] = store
  return previous
}

/** Test-only: dispose the page's store and forget it, as a reload does. Only
 * a `dispose` that exists is called, as `apply` disposes the store it
 * replaces (index.ts): a case that left a store of another shape must not
 * have its cleanup throw over its own failure. */
export function resetPageStore(): void {
  const page = globalThis as unknown as PageGlobal
  const held: { dispose?: unknown } | undefined = page[STORE_KEY]
  if (typeof held?.dispose === 'function') held.dispose()
  delete page[STORE_KEY]
}
