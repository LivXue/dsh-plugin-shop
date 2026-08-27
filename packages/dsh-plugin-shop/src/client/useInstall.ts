/** Install driving hook for one entry: start, poll to terminal, reset. */

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { INSTALL_POLL_MS, reduceInstall, type InstallView } from './present.ts'
import type { InstallArgs, ShopInstallResult, ShopInstallStatusResult } from '../host/index.ts'

export interface UseInstallResult {
  view: InstallView
  start: (args: InstallArgs) => Promise<void>
  reset: () => void
}

/** The poll loop shared by the install and uninstall drivers: while the view
 * is `running`, poll once per second and fold each status through the
 * reducer. A poll failure is transient — the host retains the record, so the
 * next tick finds it. The rejection handler must be present: an unhandled
 * rejection here would escape the poll loop. */
export function usePollStatus(
  view: InstallView,
  setView: Dispatch<SetStateAction<InstallView>>,
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>,
): void {
  useEffect(() => {
    if (view.kind !== 'running') return
    const timer = setInterval(() => {
      void installStatus({ installId: view.installId }).then(status => {
        setView(current => reduceInstall(current, { type: 'status', status }))
      }, () => {})
    }, INSTALL_POLL_MS)
    return () => clearInterval(timer)
  }, [view, setView, installStatus])
}

/** Drive one install: rejections, the polling loop at INSTALL_POLL_MS, and
 * terminal states. The interval is cleared on unmount and whenever the view
 * leaves `running`, so a done/failed/rejected install never polls again. */
export function useInstall(
  install: (args: InstallArgs) => Promise<ShopInstallResult>,
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>,
): UseInstallResult {
  const [view, setView] = useState<InstallView>({ kind: 'idle' })

  const start = useCallback(async (args: InstallArgs) => {
    setView({ kind: 'idle' })
    try {
      const result = await install(args)
      if (!result.ok) {
        setView({ kind: 'rejected', code: result.code, detail: result.detail })
        return
      }
      setView({ kind: 'running', installId: result.installId, log: [] })
    } catch {
      // A thrown install is a TRANSPORT failure (the wire envelope rejected —
      // index.ts's unwrap throws the prefixed wire code and message), not a
      // business rejection: the `rejected` state stays reserved for the host's
      // ShopInstallResult union (§7.2). The transport detail is private (it
      // can name hosts and ports) and never rendered: the failed view carries
      // an EMPTY detail, and ShopTab falls back to the localized
      // `installTransportFailed` line. Nothing else can reach this catch,
      // because the business union is a resolved value, never a throw.
      setView({ kind: 'failed', detail: '', log: [] })
    }
  }, [install])

  usePollStatus(view, setView, installStatus)

  return { view, start, reset: useCallback(() => setView({ kind: 'idle' }), []) }
}
