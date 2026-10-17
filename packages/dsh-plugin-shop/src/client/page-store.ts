/**
 * The shop page's state, held by the page rather than by the components that
 * show it (design 2026-10-16-shop-sidebar-page §5).
 *
 * dsh mounts the shop only while it is on screen — the main column renders
 * only the selected panel, as the Settings shell, the shop's home through
 * 0.8.7, rendered only the open section — so what a component held in its
 * own state went the moment the reader looked elsewhere: the search text,
 * the filters, an install's progress and its receipt, the restart offer
 * included (the shop design's §5.1, "Leaving the section"). This store keeps
 * them, and it owns the flows' polling (flow-registry.ts), so an install the
 * reader left still has its status folded and its receipt written.
 *
 * It sits on `globalThis` under a registry symbol for the reason
 * `restart-monitor.ts` does: the symbol is the one thing a hot-swapped module
 * instance shares with the one it replaced. Each `apply` still builds a new
 * store (index.ts), because a re-applied bundle is a new page.
 */

import type { InstallArgs, ShopInstallResult, ShopInstallStatusResult, ShopUninstallResult, ShopUpdateResult } from '../host/index.ts'
import { beginInstall, beginUninstall, beginUpdate, createFlowRegistry, pruned, type FlowRegistry, type FlowRegistryOptions } from './flow-registry.ts'
import { forget, listen, notify } from './listeners.ts'
import { SHOP_VISIBLE_BATCH, settledByRestart, type Category, type InstallView, type ShelfOrder } from './present.ts'
import { hasRestartMonitorStore } from './restart-monitor.ts'

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
}

/** What a switch owes before the page shows the truth (ShopTab's
 * `EnabledSwitch`). */
export type OwedNotice = 'reload' | 'restart'

/** Where a switch is drawn. An outdated plugin draws two, its card's and its
 * Updatable row's, and each owes only what was done to it. */
const SWITCH_SURFACES = ['card', 'row'] as const
export type SwitchSurface = (typeof SWITCH_SURFACES)[number]

/** The owed map's key for one switch: `<surface>:<identity>`. */
export function switchKey(surface: SwitchSurface, identity: string): string {
  return `${surface}:${identity}`
}

/** The identity a switch key names. A surface holds no colon, so it is
 * everything after the first. */
const identityOf = (key: string): string => key.slice(key.indexOf(':') + 1)

/** The card the reader is at: the first on the shelf whose bottom lies below
 * the page's top edge (design 2026-10-16-shop-sidebar-page §5.7). */
export interface ScrollAnchor {
  /** Its identity (`identityKey`), since two listed entries can share a
   * name. */
  readonly key: string
  /** Its top relative to the page's top edge, in px: zero or negative while
   * the card spans the edge, and at most the shelf's gap between cards while
   * the edge falls in that gap. A reader above the shelf has no card. */
  readonly offset: number
}
export interface PageSnapshot {
  readonly view: ShelfView
  /** A settle changed what the catalog's verdicts depend on, and no answer to
   * a page's request for them since has landed (design
   * 2026-09-01-harness-compatibility section 9.1;
   * 2026-10-16-shop-sidebar-page §5.4). */
  readonly reverdictPending: boolean
  /** How many reverdicts the page has been asked for: bumped with
   * `reverdictPending` by every settle that raises one. A request carries the
   * count it was asked at, so its answer clears only the latest. */
  readonly reverdicts: number
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
  /** The shape a successor may read
   * (design 2026-10-16-shop-sidebar-page §6). */
  readonly schema: 1
  readonly installs: FlowRegistry<InstallArgs>
  readonly uninstalls: FlowRegistry<{ name: string }>
  readonly self: FlowRegistry<{ version: string }>
  getSnapshot: () => PageSnapshot
  subscribe: (listener: () => void) => () => void
  /** Publish the view with `patch` applied, unless that changes nothing: a
   * pill pressed again, or a batch the shelf already shows. */
  setView: (patch: Partial<ShelfView>) => void
  updateView: (update: (view: ShelfView) => Partial<ShelfView>) => void
  /** Whether the card of one identity is expanded. A channel of its own,
   * apart from the page snapshot, as the owed notices below are: one card
   * opens, and the shelf re-renders whole whenever the snapshot is
   * replaced. */
  isExpanded: (key: string) => boolean
  /** Be told when any card opens or closes. */
  subscribeExpanded: (listener: () => void) => () => void
  /** Open the card if it is closed, close it if it is open. */
  toggleExpanded: (key: string) => void
  /** Open the card, and leave it open if it is: a jump to one plugin opens
   * its card from outside it. */
  expand: (key: string) => void
  /** Put one plugin on the shelf, as the Plugins page's "View in Plugin
   * shop" asks (design 2026-10-16-shop-sidebar-page §7): the search text
   * set to its name, every category, nothing subtracted, the first batch,
   * the top of the page, and the one card `card` names opened. Whatever
   * search the reader left is replaced: they asked to see this plugin. */
  focus: (name: string, card: string | null) => void
  /** What one switch owes (`switchKey`), or undefined when it owes nothing.
   * A channel of its own, apart from the page snapshot: one switch renders a
   * notice, and the shelf, which re-renders whole whenever the snapshot is
   * replaced, has no use for it. */
  getOwed: (switchKey: string) => OwedNotice | undefined
  /** Be told when any switch's notice changes. */
  subscribeOwed: (listener: () => void) => () => void
  /** Read when a switch's toggle starts, and handed back with its answer
   * (`setOwed`): it counts the times this page saw an installation leave the
   * profile. */
  owedEpoch: () => number
  /** Sticky, and a restart outranks a reload. `since` is the `owedEpoch` the
   * toggle started at. An answer that lands after its identity left the
   * profile, by an uninstall that landed or from the installed list a page
   * read, re-creates nothing: it describes the installation before, and a
   * reinstall draws fresh switches under the same keys. A restart under the
   * page leaves every answer standing: the page notes one only from the new
   * process's version answer, the old process sent its answers before it
   * exited, and an answer that lands after the restart is noted is the new
   * process's, whose restart is owed. */
  setOwed: (switchKey: string, owed: OwedNotice, since: number) => void
  /** The identities the installed list a page read holds. Every switch of an
   * identity it no longer holds owes nothing: the plugin left the profile,
   * removed outside the shop (dsh's Plugins page, `dsh plugin remove`) when
   * no uninstall of this page settled for it. */
  noteInstalled: (identities: Iterable<string>) => void
  /** The answer to a page's reverdict request landed, a failed one
   * included; `asked` is the `reverdicts` count it was asked at. An answer to
   * an earlier one clears nothing: a settle since raised another, which the
   * page has yet to ask for or to hear back about. */
  clearReverdict: (asked: number) => void
  /** dsh restarted under the page (index.ts `onRestarted`). */
  noteRestarted: () => void
  /** Where the page was scrolled to, and the card at its top edge (design
   * 2026-10-16-shop-sidebar-page §5.7). Written on every scroll without
   * telling anyone, since nothing renders from it; read once, when the page
   * comes back. A position written without a card has none. */
  recordScroll: (top: number, anchor?: ScrollAnchor | null) => void
  readScroll: () => number
  /** The card written with the position, or null. A view change that
   * refilters or reorders the shelf forgets it, as `focus` does: the card is
   * somewhere else on the new shelf, or gone, and no scroll event need follow
   * to write the card the reader sees now. */
  readAnchor: () => ScrollAnchor | null
  /** ShopPage reports its own mount here. The page is the only surface that
   * knows it is on screen, and it knows it without asking dsh anything:
   * `main` mounts a key's panel only while it is selected. Not published
   * either: what reads it is the hot-swap hand-over record, which this
   * instance's `main` entry takes as it leaves and the next instance's
   * `apply` reads (index.ts; design 2026-10-16-shop-sidebar-page §6). */
  notePageMounted: (mounted: boolean) => void
  /** As this instance's `main` entry leaves, record whether the page showed
   * (index.ts; design 2026-10-16-shop-sidebar-page §6). Reads the mount flag
   * above — NEVER dsh's layout service, whose selection observable is not
   * the same object on every leg (measured 2026-10-16,
   * design 2026-10-16-shop-sidebar-page §3.1; see index.ts's layout-face
   * comment). */
  recordTeardown: () => void
  /** What a successor reads of this instance. */
  handover: () => Handover
  /** Stop the flows' polling and drop every listener. A disposed store
   * publishes nothing and registers no listener again, so a hot swap's
   * window cannot change it. What it held stays readable, and the store
   * stays under its page key until the next `apply` replaces it: a successor
   * reads what this instance left from there (design
   * 2026-10-16-shop-sidebar-page §5.1, §6). */
  dispose: () => void
}

/** Selects `key`'s receipt: its view, unless that is a flow still running.
 * A running flow settles by its own poll, and resetting it would drop every
 * later answer for it — its settle with them. */
const receiptOf = (key: string) => (view: InstallView, each: string): boolean => each === key && view.kind !== 'running'

/** The shelf a page opens on: the star order, every category, one batch. */
export const INITIAL_VIEW: ShelfView = {
  query: '',
  category: null,
  order: 'stars',
  hideIncompatible: false,
  visibleCount: SHOP_VISIBLE_BATCH,
}

/** Whether going from one view to the other changes which cards the shelf
 * shows, or their order. Growing the shelf and opening a card change
 * neither. */
function reshelves(before: ShelfView, after: ShelfView): boolean {
  return before.query !== after.query
    || before.category !== after.category
    || before.order !== after.order
    || before.hideIncompatible !== after.hideIncompatible
}

/**
 * @param deps read on every call, so the owner can hand over its latest
 *   functions without rebuilding the store.
 * @param options the page's own store polls unwatched; a store a tab builds
 *   for itself does not, and stops with the tab (ShopTab).
 */
export function createPageStore(deps: () => PageStoreDeps, options: FlowRegistryOptions): ShopPageStore {
  let snapshot: PageSnapshot = { view: INITIAL_VIEW, reverdictPending: false, reverdicts: 0, settled: 0 }
  let scrollTop = 0
  let scrollAnchor: ScrollAnchor | null = null
  let pageMounted = false
  let handover: Handover = { showing: false }
  // Set by `dispose`. Every change reaches the page through one of the three
  // publishes below, and a disposed store publishes nothing: what it held is
  // what a successor reads.
  let disposed = false
  const listeners = new Set<() => void>()
  const publish = (next: Partial<PageSnapshot>): void => {
    if (disposed) return
    snapshot = { ...snapshot, ...next }
    notify(listeners)
  }
  /** The view with `patch` applied, published only when it differs: the
   * view's fields are primitives, so a field-by-field compare is the
   * whole question. One that refilters or reorders the shelf forgets the
   * card the reader was at: the restore then sets the position, which is
   * what the reader last saw, and their next scroll writes a card again. */
  const showView = (patch: Partial<ShelfView>): void => {
    const view = { ...snapshot.view, ...patch }
    if ((Object.keys(view) as Array<keyof ShelfView>).every(field => view[field] === snapshot.view[field])) return
    if (reshelves(snapshot.view, view)) scrollAnchor = null
    publish({ view })
  }
  // Which cards are expanded, by identity, told to listeners of their own
  // (`isExpanded`).
  let expanded: ReadonlySet<string> = new Set()
  const expandedListeners = new Set<() => void>()
  const publishExpanded = (next: ReadonlySet<string>): void => {
    if (disposed) return
    expanded = next
    notify(expandedListeners)
  }
  /** Open one card, and leave it open: a card's own header toggles it, and
   * `expand` opens one from outside it (design
   * 2026-10-16-shop-sidebar-page §5.6). */
  const openCard = (key: string): void => {
    if (!expanded.has(key)) publishExpanded(new Set(expanded).add(key))
  }
  // What each switch owes, by `switchKey`, told to listeners of its own
  // (`getOwed`).
  let owed: ReadonlyMap<string, OwedNotice> = new Map()
  const owedListeners = new Set<() => void>()
  const publishOwed = (next: ReadonlyMap<string, OwedNotice>): void => {
    if (disposed) return
    owed = next
    notify(owedListeners)
  }
  /** A reverdict raised: pending, and counted. */
  const raisedReverdict = (): Pick<PageSnapshot, 'reverdictPending' | 'reverdicts'> => ({ reverdictPending: true, reverdicts: snapshot.reverdicts + 1 })
  /** One settle the page reacts to: re-read the installed list and, when the
   * catalog's verdicts may have moved, judge them again. */
  const settle = (reverdict: boolean): void => {
    publish({ settled: snapshot.settled + 1, ...(reverdict ? raisedReverdict() : {}) })
  }

  /** The owed map without one notice kind, or null when it holds none of
   * them (`pruned`), so a caller publishes nothing for an unchanged map. */
  const withoutOwed = (kind: OwedNotice): Map<string, OwedNotice> | null => pruned(owed, value => value === kind)
  /** The owed map without any switch of `identities`, on every surface, or
   * null when it holds none. */
  const withoutSwitchesOf = (identities: ReadonlySet<string>): Map<string, OwedNotice> | null =>
    pruned(owed, (_, key) => identities.has(identityOf(key)))

  // A toggle's answer can land after its installation left the profile, so
  // every such drop is counted (`owedEpoch`) and stamped with its count, and
  // an answer asked for before a stamp re-creates nothing that drop took.
  let drops = 0
  /** By identity: the stamp of the last drop because it left the profile. */
  const leftAt = new Map<string, number>()
  /** The identities the installed list a page last read held: the switches
   * on screen are theirs, and so is any toggle still out. */
  let listed: ReadonlySet<string> = new Set()
  /** `identities` left the profile: their switches owe nothing, and a toggle
   * of one still out re-creates nothing. */
  const leave = (identities: ReadonlySet<string>): void => {
    if (identities.size === 0) return
    drops += 1
    for (const identity of identities) leftAt.set(identity, drops)
    const next = withoutSwitchesOf(identities)
    if (next !== null) publishOwed(next)
  }

  // Install and uninstall are mutually exclusive answers about one identity,
  // so each one's settle supersedes the other's receipt for that key — a
  // receipt only: a flow of the other kind still running for it, an
  // uninstall pressed while an update ran, settles by its own poll.
  const installs = createFlowRegistry<InstallArgs>(() => ({
    begin: beginInstall(deps().install),
    installStatus: deps().installStatus,
    onSettled: (key, outcome) => {
      // A FAILED install installed nothing, so a previous uninstall's
      // receipt is still the truth about this identity.
      if (outcome === 'done') uninstalls.resetWhere(receiptOf(key))
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
      installs.resetWhere(receiptOf(key))
      // The removed installation's switches are gone, and a reinstall draws
      // fresh ones under the same keys: a notice left there would describe a
      // toggle made against the installation before.
      leave(new Set([key]))
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
    subscribe: listener => listen(listeners, listener),
    setView: patch => { showView(patch) },
    updateView: update => { showView(update(snapshot.view)) },
    isExpanded: key => expanded.has(key),
    subscribeExpanded: listener => listen(expandedListeners, listener),
    toggleExpanded: key => {
      const next = new Set(expanded)
      if (!next.delete(key)) next.add(key)
      publishExpanded(next)
    },
    expand: openCard,
    focus: (name, card) => {
      scrollTop = 0
      // The view's fields through `showView`, so a view that changes nothing
      // publishes nothing, and the card on its own channel: opening one card
      // re-renders that card, never the shelf. The anchor goes whatever the
      // view says: the reader asked for this plugin, not for where they were.
      scrollAnchor = null
      showView({ query: name, category: null, hideIncompatible: false, visibleCount: SHOP_VISIBLE_BATCH })
      if (card !== null) openCard(card)
    },
    getOwed: key => owed.get(key),
    subscribeOwed: listener => listen(owedListeners, listener),
    owedEpoch: () => drops,
    setOwed: (key, notice, since) => {
      // Asked for before a drop that took what this answer would owe.
      if ((leftAt.get(identityOf(key)) ?? 0) > since) return
      const current = owed.get(key)
      // A later toggle that applied live does not say an earlier restart is
      // no longer owed, so nothing but a restart under the page lowers one.
      if (current === 'restart' || current === notice) return
      publishOwed(new Map(owed).set(key, notice))
    },
    noteInstalled: identities => {
      const held = new Set(identities)
      // Every identity the last list held, and every one owing a notice, that
      // this list does not.
      const gone = new Set<string>()
      for (const identity of listed) if (!held.has(identity)) gone.add(identity)
      for (const key of owed.keys()) if (!held.has(identityOf(key))) gone.add(identityOf(key))
      listed = held
      leave(gone)
    },
    clearReverdict: asked => {
      if (snapshot.reverdictPending && asked === snapshot.reverdicts) publish({ reverdictPending: false })
    },
    noteRestarted: () => {
      // What the restart settled: every receipt waiting for exactly that, and
      // every switch's restart notice. A reload is still owed by a page
      // nobody reloaded, a failure still happened, and a flow still running
      // settles by its own poll (design §8, 2026-10-06 amendment).
      self.resetWhere(settledByRestart)
      installs.resetWhere(settledByRestart)
      uninstalls.resetWhere(settledByRestart)
      const next = withoutOwed('restart')
      if (next !== null) publishOwed(next)
      settle(true)
    },
    recordScroll: (top, anchor = null) => {
      scrollTop = top
      scrollAnchor = anchor
    },
    readScroll: () => scrollTop,
    readAnchor: () => scrollAnchor,
    notePageMounted: mounted => { pageMounted = mounted },
    recordTeardown: () => { handover = { showing: pageMounted } },
    handover: () => handover,
    dispose: () => {
      disposed = true
      installs.dispose()
      uninstalls.dispose()
      self.dispose()
      forget(listeners)
      forget(owedListeners)
      forget(expandedListeners)
    },
  }
}

/** Registry symbol, so every module instance on the page finds one store. */
const STORE_KEY = Symbol.for('dsh-plugin-shop.page')

type PageGlobal = Record<symbol, unknown>

/** What sits at the page key. A later shop's store, met after a downgrade,
 * need not share this one's shape, so only an object that says it is of
 * this `schema` is handed out as this store; anything else is reported as
 * another schema's and goes no further (design 2026-10-16-shop-sidebar-page
 * §5.1). */
export type PageKeyOccupant =
  | { readonly kind: 'none' }
  | { readonly kind: 'store'; readonly store: ShopPageStore }
  | { readonly kind: 'other'; readonly occupant: unknown }

function occupantOf(held: unknown): PageKeyOccupant {
  if (held === undefined) return { kind: 'none' }
  if (typeof held === 'object' && held !== null && (held as { schema?: unknown }).schema === 1) {
    return { kind: 'store', store: held as ShopPageStore }
  }
  return { kind: 'other', occupant: held }
}

/** What a shop applied earlier left on this page: nothing, a store of this
 * schema, or another schema's object. */
export function readPageStore(): PageKeyOccupant {
  return occupantOf((globalThis as unknown as PageGlobal)[STORE_KEY])
}

/** Make `store` the page's. Returns what it replaces. */
export function installPageStore(store: ShopPageStore): PageKeyOccupant {
  const page = globalThis as unknown as PageGlobal
  const previous = occupantOf(page[STORE_KEY])
  page[STORE_KEY] = store
  return previous
}

/** What a successor reads of the instance it replaces
 * (design 2026-10-16-shop-sidebar-page §6). */
export interface Handover {
  /** Whether the shop page was showing when the instance's teardown began. */
  readonly showing: boolean
}

/** What applied on this page before the instance reading it
 * (design 2026-10-16-shop-sidebar-page §6). */
export type Predecessor =
  | { readonly kind: 'none' }
  /** A shop that still lived in Settings: a 0.8.4–0.8.7 shop, which left the
   * restart monitor's store and no page store, or a build with the page store
   * but not yet the page, whose schema-1 store cannot hand over. */
  | { readonly kind: 'section' }
  /** A 0.9.0-or-later shop, and whether its page showed as it was torn down.
   * A later shop's store of another schema reads as not showing: its
   * hand-over cannot be read. */
  | { readonly kind: 'page'; readonly showing: boolean }

/** Read at the very start of `apply`, before this instance puts its own
 * stores on the page. */
export function readPredecessor(): Predecessor {
  const previous = readPageStore()
  // Nothing at the key: a shop that still lived in Settings, or a fresh page.
  if (previous.kind === 'none') return hasRestartMonitorStore() ? { kind: 'section' } : { kind: 'none' }
  // A store of another shape (a later shop's, after a downgrade) names no
  // hand-over this instance can read.
  if (previous.kind === 'other') return { kind: 'page', showing: false }
  // A schema-1 store that cannot hand over was left by a build with the page
  // store but not yet the page: its shop still lived in Settings.
  if (typeof (previous.store as { handover?: unknown }).handover !== 'function') return { kind: 'section' }
  return { kind: 'page', showing: previous.store.handover().showing }
}

/** Stop what the page key held, through the `dispose` it has and no other:
 * an object that claims this schema and lacks one is stopped no more than a
 * schema-2 object is, and neither can throw the shop off the page. */
export function disposeOccupant(occupant: PageKeyOccupant): void {
  if (occupant.kind === 'none') return
  const held = (occupant.kind === 'store' ? occupant.store : occupant.occupant) as { dispose?: unknown } | null | undefined
  if (typeof held?.dispose === 'function') held.dispose()
}

/** Test-only: dispose the page's store and forget it, as a reload does, a
 * store of another shape included (`disposeOccupant`): a case that left one
 * must not have its cleanup throw over its own failure. */
export function resetPageStore(): void {
  disposeOccupant(readPageStore())
  delete (globalThis as unknown as PageGlobal)[STORE_KEY]
}
