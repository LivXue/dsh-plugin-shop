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
import storeRemote from 'dsh-plugin-store/remote'
import type { StoreLocaleKey } from './locales.ts'
import { en, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Store settings tab copy. */
    'settings.store': StoreLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.store'

/** Services required by the tab registration and the Remote mount. */
export const inject = ['remote', 'slots', 'locale']

/** Mount the store Remote and contribute the store tab. */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-store: dictionaries')

  // `ctx.on('dispose')` never fires in cordis 4.0.1; an effect whose body
  // returns the mount disposer is what actually runs it on teardown.
  const dispose = await ctx.remote.$mount(storeRemote)
  ctx.effect(() => dispose, 'dsh-plugin-store: store remote mount')
}
