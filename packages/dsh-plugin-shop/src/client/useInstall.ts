/** Install driving hook: the tab's keyed registry, one start mapping. */

import type { InstallArgs, ShopInstallResult, ShopInstallStatusResult } from '../host/index.ts'
import { beginInstall } from './flow-registry.ts'
import { useKeyedFlows, type KeyedFlow, type UseKeyedFlows } from './useFlows.ts'

/** One entry's install flow, as the tab hands it to a panel. */
export type InstallFlow = KeyedFlow<InstallArgs>
export type UseInstallFlows = UseKeyedFlows<InstallArgs>

/**
 * Install flows owned by the calling component and keyed by install
 * identity. Keeping the state above individual cards preserves a running
 * operation when filtering unmounts its card, and makes the shelf and
 * Outdated panels agree. The page store holds the page's own (page-store.ts);
 * this is the same registry for a component that owns one.
 */
export function useInstallFlows(
  install: (args: InstallArgs) => Promise<ShopInstallResult>,
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>,
  onSettled?: (key: string, outcome: 'done' | 'failed') => void,
): UseInstallFlows {
  return useKeyedFlows(beginInstall(install), installStatus, onSettled)
}
