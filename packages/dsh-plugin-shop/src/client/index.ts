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
import { ShopTab, type ShopTabInjected } from './ShopTab.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shop settings tab copy. */
    'settings.shop': ShopLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.shop'

/** The boot-time warm fetch: the catalog the tab wants on its first open.
 * Started in apply — the client bundle boots with the web app, long before
 * the user reaches Settings — so the host's slow network fetch runs while
 * nobody is looking at the shop, and the tab's mount consumes this promise
 * instead of starting its own fetch. A rejection stays stored (the injected
 * catalog falls back to a fresh call); the extra catch keeps the
 * fire-and-forget from surfacing as an unhandled rejection. */
let warmCatalog: Promise<ShopCatalogResult> | null = null

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
  // Promise.resolve wraps the wire result so a stub or an ill-behaved
  // transport can never throw synchronously out of apply.
  warmCatalog = Promise.resolve(ns.catalog(undefined)).then(result => unwrap(result))
  void warmCatalog.catch(() => {})
  void Promise.resolve(ns.installed()).then(result => unwrap(result)).catch(() => {})
  void Promise.resolve(ns.version()).then(result => unwrap(result)).catch(() => {})

  const injected = (): ShopTabInjected => ({
    catalog: async args => {
      // A refresh always goes to the wire; a plain open consumes the
      // boot-time fetch when it exists — the host's snapshot is the same
      // one a fresh call would serve, so freshness semantics are
      // unchanged (§10).
      if (args?.refresh === true) return unwrap(await ns.catalog(args))
      const warm = warmCatalog
      if (warm !== null) {
        try {
          return await warm
        } catch {
          // The boot-time fetch failed; a fresh call is the retry.
        }
      }
      const fresh = unwrap(await ns.catalog(args))
      warmCatalog = Promise.resolve(fresh)
      return fresh
    },
    install: async args => unwrap(await ns.installStart(args)),
    installStatus: async args => unwrap(await ns.installStatus(args)),
    setEnabled: async args => unwrap(await ns.setEnabled(args)),
    installed: async () => unwrap(await ns.installed()),
    uninstall: async args => unwrap(await ns.uninstallStart(args)),
    restart: async () => unwrap(await ns.restart()),
    version: async () => unwrap(await ns.version()),
    updateStart: async args => unwrap(await ns.updateStart(args)),
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
