/** Uninstall driving hook: the tab's keyed registry, one start mapping. */

import { useCallback } from 'react'
import type { ShopInstallStatusResult, ShopUninstallResult } from '../host/index.ts'
import type { InstallView } from './present.ts'
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
 * uninstall-specific — what the starting RPC's answer means. An uninstall
 * business failure (not in the catalog / not installed) lands in the `failed`
 * view with the host's published detail, never in the install `rejected`
 * codes: those belong to the install gate, and `ShopUninstallResult`'s
 * failure variant has no `code` field to populate.
 */
export function useUninstallFlows(
  uninstall: (args: { name: string }) => Promise<ShopUninstallResult>,
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>,
  onSettled?: (key: string, outcome: 'done' | 'failed') => void,
): UseUninstallFlows {
  const begin = useCallback(async (args: { name: string }): Promise<InstallView> => {
    try {
      const result = await uninstall(args)
      if (!result.ok) return { kind: 'failed', detail: result.detail, log: [] }
      return { kind: 'running', installId: result.installId, log: [] }
    } catch {
      // Same transport-failure rule as the install registry: a thrown
      // uninstall is the wire envelope rejecting, and its detail (hosts and
      // ports) is private and never rendered — the empty detail falls back to
      // the localized uninstall transport line. Nothing else can reach this
      // catch, because the business result is a resolved value, never a throw.
      return { kind: 'failed', detail: '', log: [] }
    }
  }, [uninstall])

  return useKeyedFlows(begin, installStatus, onSettled)
}
