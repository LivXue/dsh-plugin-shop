/** Self-update driving hook for the shop itself: start, poll to terminal.
 * Shares the install view machine and the keyed registry's polling; the start
 * mapping is the uninstall one — a business refusal (a non-semver version)
 * lands in the `failed` view with the host's detail, never in the install
 * `rejected` codes. */

import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import type { ShopInstallStatusResult, ShopUpdateResult } from '../host/index.ts'
import { beginUpdate, createFlowRegistry, IDLE_VIEW, type FlowRegistry, type FlowRegistryDeps } from './flow-registry.ts'
import type { InstallView } from './present.ts'

export interface UseUpdateSelfResult {
  view: InstallView
  start: (args: { version: string }) => Promise<void>
  /** Return the view to `idle` when `predicate` selects it; stable across
   * renders. dsh restarting under the page settles an update that was
   * waiting for exactly that (design §8, 2026-10-06 amendment). */
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

/** Drive one self-update from a registry this component owns: the host's
 * business union, the registry's polling, and terminal states. The
 * `rejected` install state never occurs. */
export function useUpdateSelf(
  updateStart: (args: { version: string }) => Promise<ShopUpdateResult>,
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>,
): UseUpdateSelfResult {
  const deps = useRef<FlowRegistryDeps<{ version: string }>>({ begin: beginUpdate(updateStart), installStatus })
  deps.current = { begin: beginUpdate(updateStart), installStatus }
  const [registry] = useState(() => createFlowRegistry<{ version: string }>(() => deps.current, { pollUnwatched: false }))
  return useRegistrySelf(registry)
}
