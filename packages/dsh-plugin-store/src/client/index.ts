/**
 * Store settings surface, browser half — one tab in `settings.plugins.tab`
 * that browses the catalog, installs with acknowledgement, toggles
 * enablement, and lists outdated installs. Mounts the store Remote itself
 * (the assembly does not know this package) and holds no privilege beyond
 * the five `store/*` methods (§5.3).
 */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import storeRemote from 'dsh-plugin-store/remote'
import type { StoreLocaleKey } from './locales.ts'
import { en, zh } from './locales.ts'
import { StoreTab, type StoreTabInjected } from './StoreTab.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Store settings tab copy. */
    'settings.store': StoreLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.store'

/** Services required by the tab registration and the Remote mount.
 *
 * `remote.store` is deliberately ABSENT: this package both mounts its own
 * Remote (the assembly does not know it, §7.3) and consumes it, and cordis
 * will not let one package do both through the inject face. Declaring the
 * face makes the boot's activation gate wait for the `remote.store` service —
 * which only this package's own apply can register — and the real web boot
 * deadlocked on exactly that ("waiting for service: remote.store"). The
 * namespace is therefore read through the reflect store instead (`ctx.get`,
 * see apply), which has no inject requirement. */
export const inject = ['remote', 'slots', 'locale']

/** The store's own mounted Remote namespace: the generated client surface
 * `ctx.remote.store` would expose, read here without the inject gate. */
type StoreRemoteNamespace = TypertRemoteNamespaceMap['store']

/** Mount the store Remote and contribute the store tab. */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-store: dictionaries')

  // `ctx.on('dispose')` never fires in cordis 4.0.1; an effect whose body
  // returns the mount disposer is what actually runs it on teardown.
  const dispose = await ctx.remote.$mount(storeRemote)
  ctx.effect(() => dispose, 'dsh-plugin-store: store remote mount')

  // The mount registered the `remote.store` service on the gateway's fiber;
  // `ctx.remote.store` would still refuse it here ("cannot get property
  // remote.store without inject"), because cordis hands a mounted namespace
  // out through the facade only to a fiber whose inject face names it. The
  // reflect store has no such gate: `ctx.get` reads a registered service from
  // any fiber, and the mount above has settled, so the strict availability
  // check passes.
  const ns = ctx.get('remote.store') as StoreRemoteNamespace | undefined
  if (ns === undefined) {
    throw new Error('dsh-plugin-store: the store remote did not register (service "remote.store" missing after $mount)')
  }

  // The wire envelope is unwrapped here, once: the tab sees either the value
  // or a thrown error, never the transport shape (§5.3).
  const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`store remote: ${result.error.code}: ${result.error.message}`)
    return result.value
  }

  const injected = (): StoreTabInjected => ({
    catalog: async args => unwrap(await ns.catalog(args)),
    install: async args => unwrap(await ns.installStart(args)),
    installStatus: async args => unwrap(await ns.installStatus(args)),
    setEnabled: async args => unwrap(await ns.setEnabled(args)),
    outdated: async () => unwrap(await ns.outdated()),
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'store',
    order: 20,
    label: () => ctx.locale.bind(NS)('tab'),
    locale: NS,
    inject: injected,
  }, StoreTab))
}
