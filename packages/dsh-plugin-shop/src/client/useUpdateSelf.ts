/** The shop's own update as the tab renders it: the face over the registry
 * that holds it, a page store's `self` (page-store.ts). It shares the install
 * view machine and the registry's polling; its start mapping is
 * flow-registry.ts's `beginUpdate`, which shares the uninstall's refusal
 * rule — a business refusal (a non-semver version) lands in the `failed`
 * view with the host's detail, never in the install `rejected` codes. */

import { useCallback, useSyncExternalStore } from 'react'
import { IDLE_VIEW, type FlowRegistry } from './flow-registry.ts'
import type { InstallView } from './present.ts'

export interface UseUpdateSelfResult {
  view: InstallView
  start: (args: { version: string }) => Promise<void>
  /** Return the view to `idle` when `predicate` selects it; stable across
   * renders. The failed panel's Dismiss uses it, so the version row decides
   * again; an update waiting for a restart is settled at the store instead,
   * when dsh restarts under the page (page-store.ts `noteRestarted`; design
   * §8, 2026-10-06 amendment). */
  resetWhere: (predicate: (view: InstallView) => boolean) => void
}

/** The one key the self-update registry holds: the shop has one update. */
export const SELF_UPDATE_KEY = 'self'

/** The self-update face over a registry: a component's own, or the page
 * store's, which outlives the component. */
export function useRegistrySelf(registry: FlowRegistry<{ version: string }>): UseUpdateSelfResult {
  const { views } = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const view = views.get(SELF_UPDATE_KEY) ?? IDLE_VIEW
  const start = useCallback((args: { version: string }) => registry.start(SELF_UPDATE_KEY, args), [registry])
  const resetWhere = useCallback((predicate: (view: InstallView) => boolean): void => { registry.resetWhere(predicate) }, [registry])
  return { view, start, resetWhere }
}
