/** Install driving hook for one entry: start, poll to terminal, reset. */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { INSTALL_POLL_MS, reduceInstall, type InstallEvent, type InstallView } from './present.ts'
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

/** One entry's install flow, as the tab hands it to a panel. */
export interface InstallFlow {
  view: InstallView
  start: (args: InstallArgs) => Promise<void>
}

export interface UseInstallFlows {
  /** Two panels asking for the same install identity receive one flow. */
  flowFor: (key: string) => InstallFlow
}

/**
 * Install flows owned by the tab and keyed by install identity. Keeping the
 * state above individual cards preserves a running operation when filtering
 * unmounts its card, and makes the shelf and Outdated panels agree.
 */
export function useInstallFlows(
  install: (args: InstallArgs) => Promise<ShopInstallResult>,
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>,
  onSettled?: (key: string) => void,
): UseInstallFlows {
  const [views, setViews] = useState<ReadonlyMap<string, InstallView>>(() => new Map())
  const settled = useRef(onSettled)
  settled.current = onSettled

  const put = useCallback((key: string, view: InstallView): void => {
    setViews(current => {
      const next = new Map(current)
      next.set(key, view)
      return next
    })
  }, [])

  const apply = useCallback((key: string, event: InstallEvent): void => {
    setViews(current => {
      const before = current.get(key) ?? { kind: 'idle' as const }
      const after = reduceInstall(before, event)
      if (after === before) return current
      const next = new Map(current)
      next.set(key, after)
      return next
    })
  }, [])

  const start = useCallback(async (key: string, args: InstallArgs): Promise<void> => {
    put(key, { kind: 'idle' })
    try {
      const result = await install(args)
      if (!result.ok) {
        put(key, { kind: 'rejected', code: result.code, detail: result.detail })
        return
      }
      put(key, { kind: 'running', installId: result.installId, log: [] })
    } catch {
      put(key, { kind: 'failed', detail: '', log: [] })
    }
  }, [install, put])

  // One interval polls every running identity; duplicate panels never poll
  // the same host record independently.
  useEffect(() => {
    const running: Array<[string, string]> = []
    for (const [key, view] of views) {
      if (view.kind === 'running') running.push([key, view.installId])
    }
    if (running.length === 0) return
    const timer = setInterval(() => {
      for (const [key, installId] of running) {
        void installStatus({ installId }).then(status => {
          apply(key, { type: 'status', status })
          if (status.found && status.state !== 'running') settled.current?.(key)
        }, () => {
          // Poll failures are transient; the retained host record is retried.
        })
      }
    }, INSTALL_POLL_MS)
    return () => clearInterval(timer)
  }, [views, installStatus, apply])

  const flowFor = useCallback((key: string): InstallFlow => ({
    view: views.get(key) ?? { kind: 'idle' },
    start: args => start(key, args),
  }), [views, start])

  return { flowFor }
}
