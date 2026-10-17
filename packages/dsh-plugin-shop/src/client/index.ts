/**
 * Shop surface, browser half — the shop's own page in dsh's main column
 * (`main`) with its row in the left sidebar (`sidebar.panellist`), which
 * browses the catalog, installs on one click, toggles enablement, lists
 * installed plugins, and restarts dsh after installs (design
 * 2026-10-16-shop-sidebar-page).
 * Mounts the shop Remote itself (the assembly does not know this package)
 * and holds no privilege beyond the nine `shop/*` methods (the shop design's
 * §5.3).
 */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import shopRemote from 'dsh-plugin-shop/remote'
import type { ShopCatalogResult, ShopRestartResult, ShopVersionResult } from '../host/index.ts'
import type { ShopLocaleKey } from './locales.ts'
import { en, zh } from './locales.ts'
import { refineAgainstModuleTable } from './module-table.ts'
import { createPageStore, disposeOccupant, installPageStore } from './page-store.ts'
import { answeredByAnotherProcess } from './present.ts'
import { noteBoot, registerRestartCarrier } from './restart-monitor.ts'
import { ShopGlyph } from './ShopGlyph.tsx'
import { ShopPage } from './ShopPage.tsx'
import type { ShopTabInjected } from './ShopTab.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The shop page's copy. */
    'settings.shop': ShopLocaleKey
  }
  interface SlotMap {
    /** dsh's left column of global panels (`dsh-client-ui-sidebar`, on
     * 0.1.5-rc.3, 0.1.7-rc.2 and 0.2.0-rc.2): one row per entry, which owns
     * the button, its label and its selection, and renders the entry's glyph
     * at the size it asks. Declared here, in dsh's own terms, because the
     * 0.1.1-rc.2 protocol this package builds against predates it — as
     * `connection/reset` is below. */
    'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: { size: number; active: boolean } }
    /** The main column, keyed by panel id (`dsh-client-ui-layout`, the same
     * harnesses): only the selected key is mounted, and the sidebar row with
     * the same id selects it. Declared here for the same reason. */
    'main': { kind: 'keyed'; scope: 'root' }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A connection generation was established: the first connect after
     * plugin boot, and every reconnect. `@deepseek-ai/dsh-client-connection`
     * declares it, in these words, from 0.1.5-rc.3 on, and dsh-api-gateway's
     * client emits it there through 0.2.0-rc.2; the 0.1.1-rc.2 this package
     * builds against predates the declaration. A harness that never emits
     * it leaves the shop as it was before it listened. */
    'connection/reset'(): void
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.shop'

/** The id the shop's sidebar row and its main-column page share (design
 * 2026-10-16-shop-sidebar-page §4.1). */
export const SHOP_PANEL = 'shop'

/** How long a stashed catalog may satisfy a plain open. The host applies the
 * same five-minute freshness window, so the client stash must not outlive it. */
export const WARM_TTL_MS = 5 * 60 * 1000

/** The boot-time warm fetch: the catalog the tab wants on its first open.
 * Started in apply — the client bundle boots with the web app, long before
 * the user opens the shop — so the host's slow network fetch runs while
 * nobody is looking at the shop, and the tab's mount consumes this promise
 * instead of starting its own fetch. A rejection stays stored (the injected
 * catalog falls back to a fresh call); the extra catch keeps the
 * fire-and-forget from surfacing as an unhandled rejection. Every later
 * result, including an explicit refresh, replaces this timestamped stash. */
let warmCatalog: { at: number; result: Promise<ShopCatalogResult> } | null = null

/** Package names THIS PAGE has uninstalled since it loaded (design
 * 2026-09-01-harness-compatibility section 9.1): the module table can still
 * hold a graph row or a `loadCache` record for one after a restart-free
 * uninstall (module-table.ts's header explains why), so
 * the refinement must never clear a name here on the table's say-so — the
 * host's verdict stands unconditionally. Module-level so it survives the tab
 * closing and reopening; reset in `apply` beside `warmCatalog`, because a
 * re-applied bundle is a new page that has uninstalled nothing yet. An
 * uninstall made from another tab, another window, or the CLI is never added
 * here and stays unknown to this page until it reloads. */
let pageRemoved = new Set<string>()

/** Services required by the page and row registrations and the Remote mount.
 *
 * `remote.shop` is deliberately ABSENT: this package both mounts its own
 * Remote (the assembly does not know it, §7.3) and consumes it, and cordis
 * will not let one package do both through the inject face. Declaring the
 * face makes the boot's activation gate wait for the `remote.shop` service —
 * which only this package's own apply can register — and the real web boot
 * deadlocked on exactly that ("waiting for service: remote.shop"). The
 * namespace is therefore read through the reflect shop instead (`ctx.get`,
 * see apply), which has no inject requirement. */
export const inject = ['remote', 'slots', 'locale']

/** The shop's own mounted Remote namespace: the generated client surface
 * `ctx.remote.shop` would expose, read here without the inject gate. */
type ShopRemoteNamespace = TypertRemoteNamespaceMap['shop']

/** Mount the shop Remote and contribute the shop's page and its sidebar row. */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-shop: dictionaries')

  // `ctx.on('dispose')` never fires in cordis 4.0.1; an effect whose body
  // returns the mount disposer is what actually runs it on teardown. The
  // restart path registered below is withdrawn in that same teardown, and
  // FIRST: disposing the mount aborts a restart call still in flight on it
  // (dsh binds every call to its mount), and that abort has to find a
  // request the page already knows to ask again, not one it would report as
  // undeliverable (restart-monitor.ts).
  const dispose = await ctx.remote.$mount(shopRemote)
  let withdrawRestart = (): void => {}
  ctx.effect(() => () => {
    withdrawRestart()
    return dispose()
  }, 'dsh-plugin-shop: shop remote mount')

  // The mount registered the `remote.shop` service on the gateway's fiber;
  // `ctx.remote.shop` would still refuse it here ("cannot get property
  // remote.shop without inject"), because cordis hands a mounted namespace
  // out through the facade only to a fiber whose inject face names it. The
  // reflect shop has no such gate: `ctx.get` reads a registered service from
  // any fiber, and the mount above has settled, so the strict availability
  // check passes.
  const ns = ctx.get('remote.shop') as ShopRemoteNamespace | undefined
  if (ns === undefined) {
    throw new Error('dsh-plugin-shop: the shop remote did not register (service "remote.shop" missing after $mount)')
  }

  // The wire envelope is unwrapped here, once: the tab sees either the value
  // or a thrown error, never the transport shape (§5.3).
  const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`shop remote: ${result.error.code}: ${result.error.message}`)
    return result.value
  }

  // The boot-time warm: the catalog fetch starts now, in the background;
  // the tab's first open consumes it instead of waiting on it. The smaller
  // reads warm the host's snapshot too (their results are discarded — the
  // tab re-requests them on mount and the host serves them from memory).
  // Each boot starts its own warm fetch — a re-applied bundle must not
  // serve the previous boot's catalog.
  warmCatalog = null
  pageRemoved = new Set()
  // Promise.resolve wraps the wire result so a stub or an ill-behaved
  // transport can never throw synchronously out of apply.
  const warmed = Promise.resolve(ns.catalog(undefined)).then(result => unwrap(result))
  warmCatalog = { at: Date.now(), result: warmed }
  void warmed.catch(() => {})
  void Promise.resolve(ns.installed()).then(result => unwrap(result)).catch(() => {})

  // Which process answers the page (design §8, 2026-10-06 amendment). Every
  // version answer passes through here — the boot warm-up just below, the
  // tab's own checks, and the re-ask on every reconnect — so whichever is
  // first to come from a new process is the one that says so, and the first
  // a reloaded page gets judges the restart it reloaded after (`noteBoot`),
  // before any tab is open. A process that differs from the last answer's is
  // dsh restarted under the page: the warm catalog holds the old process's
  // verdicts, and the tab holds receipts the restart has settled.
  let lastVersion: ShopVersionResult | null = null
  const restartListeners = new Set<(fresh: ShopVersionResult) => void>()
  const version = async (): Promise<ShopVersionResult> => {
    const result = unwrap(await ns.version())
    noteBoot(result.bootId)
    const previous = lastVersion
    lastVersion = result
    if (previous !== null && answeredByAnotherProcess(previous, result)) {
      warmCatalog = null
      for (const listener of [...restartListeners]) listener(result)
    }
    return result
  }
  // The check is advisory, and so is its failure: a transport that cannot
  // answer leaves the last answer standing, which is all this path can do.
  void version().catch(() => {})
  // dsh reconnects to whatever server holds the origin and reloads nothing,
  // so a restart from a terminal, by a supervisor, or one whose own reload
  // never came leaves the page on the old process's answers. Asking again on
  // every connection — the first one after boot included, which only finds
  // the process the warm-up already found — is how the page learns it.
  ctx.on('connection/reset', () => {
    // Advisory, like the warm-up above: a failed ask changes nothing.
    void version().catch(() => {})
  })

  // The host's own result: the stash when it is fresh, the wire otherwise.
  // Every result becomes the stash, refresh included. A plain open only
  // consumes it inside the host's own freshness window.
  //
  // `reverdict` is not a network refresh: it is "judge again against the
  // installation as it stands now", asked with the same plain call as a
  // stash-expired open, so it gets the host's own snapshot and freshness
  // window rather than forcing npm/registry work a refresh would. It always
  // bypasses the stash (an install or uninstall just settled, so the stash
  // predates it) and always becomes the new one. Every branch below builds
  // its own literal for `ns.catalog(...)` rather than forwarding the
  // caller's `args` — the host RPC accepts only `{ refresh?: boolean }`, and
  // a client-only key like `reverdict` must never reach the wire, even by a
  // future field added to `args` and forwarded by accident.
  const hostCatalog = async (args?: { refresh?: boolean; reverdict?: boolean }): Promise<ShopCatalogResult> => {
    // `refresh` is checked FIRST: it also bypasses the stash and restashes,
    // exactly like reverdict, so checking it first costs the
    // refresh branch nothing — but checking reverdict first would have let a
    // caller-supplied `{ refresh: true, reverdict: true }` fall into the
    // reverdict branch and silently drop the network refresh the caller
    // asked for.
    if (args?.refresh === true) {
      const refreshed = unwrap(await ns.catalog({ refresh: true }))
      warmCatalog = { at: Date.now(), result: Promise.resolve(refreshed) }
      return refreshed
    }
    if (args?.reverdict === true) {
      // Dropped before asking, not after: a failed reverdict must not leave
      // the PRE-mutation stash standing for the next plain open to replay —
      // the mutation already landed, so no stash is safer than a stale one.
      warmCatalog = null
      const judged = unwrap(await ns.catalog(undefined))
      warmCatalog = { at: Date.now(), result: Promise.resolve(judged) }
      return judged
    }
    const warm = warmCatalog
    if (warm !== null && Date.now() - warm.at < WARM_TTL_MS) {
      try {
        return await warm.result
      } catch {
        // The stashed fetch failed; a fresh call is the retry.
      }
    }
    const fresh = unwrap(await ns.catalog(undefined))
    warmCatalog = { at: Date.now(), result: Promise.resolve(fresh) }
    return fresh
  }

  // The host's peer list is only half a verdict (module-table.ts says why and
  // how much of it is wrong), so every result is refined against this page's
  // module table on its way to the tab — warm, stashed, fresh and refreshed
  // alike, exactly once each. On the way OUT, never on the way in: the warm
  // fetch starts during plugin boot, when nothing guarantees the `modules`
  // service is registered yet, while the tab cannot be opened before it is —
  // the web shell mounts its UI only once plugin boot has run (`runPluginBoot`
  // then `mountApp`, on 0.1.5-rc.3). The table also grows as modules
  // materialize, so the stash keeps the host's own result and each hand-over
  // judges it against the table as it stands then.
  //
  // Read through the reflect shop rather than declared in `inject`: an inject
  // requirement would hold the whole tab back on a harness that publishes no
  // table, where the right cost is the peer badges alone
  // (`refineAgainstModuleTable` answers `{}` there).
  const handOver = async (result: ShopCatalogResult): Promise<ShopCatalogResult> => ({
    ...result,
    // `result.incompatible` is `?? {}`'d before it ever reaches the
    // refinement: a host built at 0.5.4 or earlier answers without the field
    // at all, and `refineIncompatible` reads it with an unguarded
    // `Object.entries`, so an absent field would reject a function this
    // module documents as never rejecting.
    incompatible: await refineAgainstModuleTable(result.incompatible ?? {}, ctx.get('modules') as unknown, pageRemoved),
  })

  // The restart the tab is handed, registered as this instance's path to the
  // host: when a self-update's HMR swap tears this mount down with a restart
  // in flight, the page asks again through the instance that replaces it.
  const restart = async (): Promise<ShopRestartResult> => unwrap(await ns.restart())
  withdrawRestart = registerRestartCarrier(restart)

  // The face's mutators, named because the page store runs its flows on them
  // too. Each drops the stash the MOMENT it starts, not when it settles
  // (design 2026-09-01-harness-compatibility section 9.1): a mutation always
  // changes what a reverdict would say, and the next plain open, on this tab
  // or a fresh one, must ask the host rather than replay a stash from before
  // the mutation. Residual: a mount DURING the mutation refills the stash
  // before the mutation settles. The page store covers that case: a settle
  // leaves it a pending reverdict, and the next mount asks for that first
  // (design 2026-10-16-shop-sidebar-page §5.4).
  const install: ShopTabInjected['install'] = async args => { warmCatalog = null; return unwrap(await ns.installStart(args)) }
  const installStatus: ShopTabInjected['installStatus'] = async args => unwrap(await ns.installStatus(args))
  const uninstall: ShopTabInjected['uninstall'] = async args => { warmCatalog = null; return unwrap(await ns.uninstallStart(args)) }
  const updateStart: ShopTabInjected['updateStart'] = async args => { warmCatalog = null; return unwrap(await ns.updateStart(args)) }
  const noteUninstalled = (name: string): void => { pageRemoved.add(name) }

  // The page's store (page-store.ts): the reader's place on the shelf and
  // every flow, kept across leaving and returning (design
  // 2026-10-16-shop-sidebar-page §5). Built per apply, since a re-applied
  // bundle is a new page, and disposed with this instance, so its polling
  // never outlives the code that started it. It hears every restart under
  // the page, whether or not a tab is mounted to hear it.
  const page = createPageStore(() => ({ install, uninstall, updateStart, installStatus, noteUninstalled }), { pollUnwatched: true })
  // The store this one replaces is disposed with its own instance; disposing
  // it here as well covers an instance whose teardown never ran. Disposal is
  // idempotent, and its hand-over stays readable (design
  // 2026-10-16-shop-sidebar-page §5.1). A later shop's store, met after a
  // downgrade, need not share this shape: it is read as another schema's,
  // and only a `dispose` it has is called (`disposeOccupant`), so a missing
  // one cannot throw the shop off the page.
  disposeOccupant(installPageStore(page))
  ctx.effect(() => () => { page.dispose() }, 'dsh-plugin-shop: page store')
  restartListeners.add(() => { page.noteRestarted() })

  const injected = (): ShopTabInjected => ({
    catalog: async args => handOver(await hostCatalog(args)),
    install,
    installStatus,
    setEnabled: async args => unwrap(await ns.setEnabled(args)),
    installed: async () => unwrap(await ns.installed()),
    installedSpecs: async () => unwrap(await ns.installedSpecs()),
    uninstall,
    noteUninstalled,
    restart,
    version,
    onRestarted: listener => {
      restartListeners.add(listener)
      return () => { restartListeners.delete(listener) }
    },
    updateStart,
    page,
  })

  // The shop's own page in dsh's main column (design
  // 2026-10-16-shop-sidebar-page §4.1), under the key its sidebar row
  // selects. The page first: the row's click selects `shop`, which dsh
  // refuses while no `main` entry holds that key.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: SHOP_PANEL,
    locale: NS,
    inject: injected,
  }, ShopPage))
  // Its row in the sidebar, directly under dsh's own Plugins row (order 0)
  // and above Automation (10). The sidebar owns the button, its label and its
  // selection; the shop supplies the glyph.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: SHOP_PANEL,
    order: 5,
    label: () => ctx.locale.bind(NS)('title'),
    locale: NS,
  }, ShopGlyph))
}
