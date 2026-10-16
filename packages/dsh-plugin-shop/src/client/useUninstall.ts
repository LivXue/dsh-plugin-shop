/** Uninstall driving hook: the tab's keyed registry, one start mapping. */

import type { ShopInstallStatusResult, ShopUninstallResult } from '../host/index.ts'
import { beginUninstall } from './flow-registry.ts'
import { useKeyedFlows, type KeyedFlow, type UseKeyedFlows } from './useFlows.ts'

/** One entry's uninstall flow, as the tab hands it to a panel. */
export type UninstallFlow = KeyedFlow<{ name: string }>
export type UseUninstallFlows = UseKeyedFlows<{ name: string }>

/**
 * Uninstall flows owned by the tab and keyed by install identity. Lifting the
 * state above individual cards is what lets a completed uninstall's outcome
 * survive the installed-projection refresh that follows it — the row backing
 * the card disappears, but the flow keyed by identity does not.
 *
 * The registry itself is `useKeyedFlows`; this supplies the one thing that is
 * uninstall-specific — what the starting RPC's answer means.
 */
export function useUninstallFlows(
  uninstall: (args: { name: string }) => Promise<ShopUninstallResult>,
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>,
  onSettled?: (key: string, outcome: 'done' | 'failed') => void,
): UseUninstallFlows {
  return useKeyedFlows(beginUninstall(uninstall), installStatus, onSettled)
}
