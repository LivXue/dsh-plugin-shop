/** Uninstall driving hook for one entry: start, poll to terminal. Shares the
 * install view machine and poll loop; the only difference is the start
 * mapping — an uninstall business failure (not in the catalog / not
 * installed) lands in the `failed` view with the host's published detail,
 * never in the install `rejected` codes, which belong to the install gate
 * (§7.2). */

import { useCallback, useState } from 'react'
import type { ShopInstallStatusResult, ShopUninstallResult } from '../host/index.ts'
import type { InstallView } from './present.ts'
import { usePollStatus } from './useInstall.ts'

export interface UseUninstallResult {
  view: InstallView
  start: (args: { name: string }) => Promise<void>
}

/** Drive one uninstall: the host's business union, the shared polling loop,
 * and terminal states. The `rejected` install state never occurs here. */
export function useUninstall(
  uninstall: (args: { name: string }) => Promise<ShopUninstallResult>,
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>,
): UseUninstallResult {
  const [view, setView] = useState<InstallView>({ kind: 'idle' })

  const start = useCallback(async (args: { name: string }) => {
    setView({ kind: 'idle' })
    try {
      const result = await uninstall(args)
      if (!result.ok) {
        setView({ kind: 'failed', detail: result.detail, log: [] })
        return
      }
      setView({ kind: 'running', installId: result.installId, log: [] })
    } catch {
      // Same transport-failure rule as useInstall: a thrown uninstall is the
      // wire envelope rejecting, and its detail (hosts and ports) is private
      // and never rendered — the empty detail falls back to the localized
      // uninstall transport line. Nothing else can reach this catch.
      setView({ kind: 'failed', detail: '', log: [] })
    }
  }, [uninstall])

  usePollStatus(view, setView, installStatus)

  return { view, start }
}
