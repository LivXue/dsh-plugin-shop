/** Install driving hooks: the shared poll loop, and the tab's keyed registry. */

import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react'
import { INSTALL_POLL_MS, reduceInstall, type InstallView } from './present.ts'
import { useKeyedFlows, type KeyedFlow, type UseKeyedFlows } from './useFlows.ts'
import type { InstallArgs, ShopInstallResult, ShopInstallStatusResult } from '../host/index.ts'
import { isTerminalInstallState } from '../shared/install-state.ts'

/** The single-view poll loop: while the view is `running`, poll once per
 * second and fold each status through the reducer. A poll failure is
 * transient — the host retains the record, so the next tick finds it. The
 * rejection handler must be present: an unhandled rejection here would
 * escape the poll loop.
 *
 * Kept for the self-update (`useUpdateSelf`), which drives ONE flow with no
 * identity to key it by. Everything per-plugin goes through `useKeyedFlows`,
 * whose own loop polls every running identity from one interval. */
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

/** One entry's install flow, as the tab hands it to a panel. */
export type InstallFlow = KeyedFlow<InstallArgs>
export type UseInstallFlows = UseKeyedFlows<InstallArgs>

/**
 * Install flows owned by the tab and keyed by install identity. Keeping the
 * state above individual cards preserves a running operation when filtering
 * unmounts its card, and makes the shelf and Outdated panels agree.
 *
 * The registry itself is `useKeyedFlows`; this supplies the one thing that is
 * install-specific — what the starting RPC's answer means.
 */
export function useInstallFlows(
  install: (args: InstallArgs) => Promise<ShopInstallResult>,
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>,
  onSettled?: (key: string, outcome: 'done' | 'failed') => void,
): UseInstallFlows {
  const begin = useCallback(async (args: InstallArgs): Promise<InstallView> => {
    try {
      const result = await install(args)
      if (!result.ok) return { kind: 'rejected', code: result.code, detail: result.detail }
      return { kind: 'running', installId: result.installId, log: [], phase: result.state === 'downloading' ? 'downloading' : 'installing' }
    } catch {
      // A thrown install is a TRANSPORT failure (the wire envelope rejected —
      // index.ts's unwrap throws the prefixed wire code and message), not a
      // business rejection: the `rejected` state stays reserved for the host's
      // ShopInstallResult union (§7.2). The transport detail is private (it
      // can name hosts and ports) and never rendered: the failed view carries
      // an EMPTY detail, and ShopTab falls back to the localized
      // `installTransportFailed` line. Nothing else can reach this catch,
      // because the business union is a resolved value, never a throw.
      return { kind: 'failed', detail: '', log: [] }
    }
  }, [install])

  return useKeyedFlows(begin, installStatus, onSettled)
}
