/**
 * Shop settings surface, browser half — one tab in `settings.plugins.tab`
 * that browses the catalog, installs with acknowledgement, toggles
 * enablement, lists installed plugins, and restarts dsh after installs.
 * Mounts the shop Remote itself (the assembly does not know this package)
 * and holds no privilege beyond the nine `shop/*` methods (§5.3).
 */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import shopRemote from 'dsh-plugin-shop/remote'
import type { ShopCatalogResult } from '../host/index.ts'
import type { ShopLocaleKey } from './locales.ts'
import { en, zh } from './locales.ts'
import { refineAgainstModuleTable } from './module-table.ts'
import { ShopTab, type ShopTabInjected } from './ShopTab.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shop settings tab copy. */
    'settings.shop': ShopLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.shop'

/** How long a stashed catalog may satisfy a plain open. The host applies the
 * same five-minute freshness window, so the client stash must not outlive it. */
export const WARM_TTL_MS = 5 * 60 * 1000

/** The boot-time warm fetch: the catalog the tab wants on its first open.
 * Started in apply — the client bundle boots with the web app, long before
 * the user reaches Settings — so the host's slow network fetch runs while
 * nobody is looking at the shop, and the tab's mount consumes this promise
 * instead of starting its own fetch. A rejection stays stored (the injected
 * catalog falls back to a fresh call); the extra catch keeps the
 * fire-and-forget from surfacing as an unhandled rejection. Every later
 * result, including an explicit refresh, replaces this timestamped stash. */
let warmCatalog: { at: number; result: Promise<ShopCatalogResult> } | null = null

/** Package names THIS PAGE has uninstalled since it loaded (finding #8): the
 * module table can still hold a graph row or a `loadCache` record for one
 * after a restart-free uninstall (module-table.ts's header explains why), so
 * the refinement must never clear a name here on the table's say-so — the
 * host's verdict stands unconditionally. Module-level so it survives the tab
 * closing and reopening; reset in `apply` beside `warmCatalog`, because a
 * re-applied bundle is a new page that has uninstalled nothing yet. An
 * uninstall made from another tab, another window, or the CLI is never added
 * here and stays unknown to this page until it reloads. */
let pageRemoved = new Set<string>()

/** Services required by the tab registration and the Remote mount.
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

/** Mount the shop Remote and contribute the shop tab. */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-shop: dictionaries')

  // `ctx.on('dispose')` never fires in cordis 4.0.1; an effect whose body
  // returns the mount disposer is what actually runs it on teardown.
  const dispose = await ctx.remote.$mount(shopRemote)
  ctx.effect(() => dispose, 'dsh-plugin-shop: shop remote mount')

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
  void Promise.resolve(ns.version()).then(result => unwrap(result)).catch(() => {})

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
    // `refresh` is checked FIRST (Minor 11): it also bypasses the stash and
    // restashes, exactly like reverdict, so checking it first costs the
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
      // Dropped before asking, not after (Minor 8): a failed reverdict must
      // not leave the PRE-mutation stash standing for the next plain open to
      // replay — the mutation already landed, so no stash is safer than a
      // stale one.
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

  const injected = (): ShopTabInjected => ({
    catalog: async args => handOver(await hostCatalog(args)),
    // Each mutator drops the stash the MOMENT it starts, not when it settles
    // (Minor 8): a mutation always changes what a reverdict would say, and if
    // this tab unmounts before the mutation settles, no reverdict is ever
    // requested (ShopTab's settle callbacks live in state that unmounted with
    // it) — so the next plain open, on this tab or a fresh one, must ask the
    // host rather than replay a stash from before the mutation. Residual: a
    // re-mount DURING the mutation runs its own boot-time warm fetch (above)
    // and can refill the stash before this call's own mutation settles, in
    // which case that later boot's fetch — not this one — decides what the
    // next plain open serves.
    install: async args => { warmCatalog = null; return unwrap(await ns.installStart(args)) },
    installStatus: async args => unwrap(await ns.installStatus(args)),
    setEnabled: async args => unwrap(await ns.setEnabled(args)),
    installed: async () => unwrap(await ns.installed()),
    installedSpecs: async () => unwrap(await ns.installedSpecs()),
    uninstall: async args => { warmCatalog = null; return unwrap(await ns.uninstallStart(args)) },
    noteUninstalled: name => { pageRemoved.add(name) },
    restart: async () => unwrap(await ns.restart()),
    version: async () => unwrap(await ns.version()),
    updateStart: async args => { warmCatalog = null; return unwrap(await ns.updateStart(args)) },
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'shop',
    order: 20,
    label: () => ctx.locale.bind(NS)('tab'),
    locale: NS,
    inject: injected,
  }, ShopTab))
}
