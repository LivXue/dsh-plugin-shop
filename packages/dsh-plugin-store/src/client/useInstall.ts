/** Install driving hook for one entry: start, poll to terminal, reset. */

import { useCallback, useEffect, useState } from 'react'
import { INSTALL_POLL_MS, reduceInstall, type InstallView } from './present.ts'
import type { InstallArgs, StoreInstallResult, StoreInstallStatusResult } from '../host/index.ts'

export interface UseInstallResult {
  view: InstallView
  start: (args: InstallArgs) => Promise<void>
  reset: () => void
}

/** Drive one install: rejections, the polling loop at INSTALL_POLL_MS, and
 * terminal states. The interval is cleared on unmount and whenever the view
 * leaves `running`, so a done/failed/rejected install never polls again. */
export function useInstall(
  install: (args: InstallArgs) => Promise<StoreInstallResult>,
  installStatus: (args: { installId: string }) => Promise<StoreInstallStatusResult>,
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
    } catch (error) {
      // A thrown install is a TRANSPORT failure (the wire envelope rejected —
      // index.ts's unwrap throws the prefixed wire code and message), not a
      // business rejection: the `rejected` state stays reserved for the host's
      // StoreInstallResult union (§7.2). The thrown message maps verbatim into
      // the failed view; nothing else can reach this catch, because the
      // business union is a resolved value, never a throw.
      setView({ kind: 'failed', detail: error instanceof Error ? error.message : String(error), log: [] })
    }
  }, [install])

  useEffect(() => {
    if (view.kind !== 'running') return
    const timer = setInterval(() => {
      // A poll failure is transient: the host retains the record, so the next
      // tick finds it. The rejection handler must be present — an unhandled
      // rejection here would escape the poll loop.
      void installStatus({ installId: view.installId }).then(status => {
        setView(current => reduceInstall(current, { type: 'status', status }))
      }, () => {})
    }, INSTALL_POLL_MS)
    return () => clearInterval(timer)
  }, [view, installStatus])

  return { view, start, reset: useCallback(() => setView({ kind: 'idle' }), []) }
}
