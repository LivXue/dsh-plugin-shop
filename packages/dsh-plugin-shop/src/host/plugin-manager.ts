// src/host/plugin-manager.ts
/**
 * dsh's `pluginManager` service (0.1.7 on), as far as this shop calls it:
 * design 2026-09-26-plugin-manager-delegation. Structural throughout: the
 * build compiles against the 0.1.1-rc.2 harness floor, where
 * `@deepseek-ai/dsh-plugin-manager` does not exist.
 */

/** The operations the shop calls. `cancelInstall` is optional because only
 * the install deadline uses it. Answers stay `unknown` until `readChange`
 * reads them: a later harness may add or drop fields. */
export interface PluginManagerLike {
  installBundle(spec: string, options: { requestId: string }): Promise<unknown>
  removeBundle(name: string): Promise<unknown>
  /** `id` is the live loader entry id `listPlugins` reports (`include:...`),
   * not the patch row id (dsh 0.1.7-rc.2 `setPluginEnabled`). */
  setPluginEnabled(id: string, enabled: boolean): Promise<unknown>
  setBundleEnabled(name: string, enabled: boolean): Promise<unknown>
  cancelInstall?(requestId: string): Promise<unknown>
}

const REQUIRED = ['installBundle', 'removeBundle', 'setPluginEnabled', 'setBundleEnabled'] as const

/** The service, when `service` offers every required operation; else null.
 * All or nothing: half a service would take an install and fail its
 * uninstall. */
export function asPluginManager(service: unknown): PluginManagerLike | null {
  if (typeof service !== 'object' || service === null) return null
  const candidate = service as Record<string, unknown>
  if (!REQUIRED.every(method => typeof candidate[method] === 'function')) return null
  if (candidate.cancelInstall !== undefined && typeof candidate.cancelInstall !== 'function') return null
  return service as PluginManagerLike
}
