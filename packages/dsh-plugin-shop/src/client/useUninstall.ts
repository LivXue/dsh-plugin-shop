/** Uninstall driving hook for one entry: start, poll to terminal, reset.
 * Mirrors useInstallFlows (useInstall.ts) exactly — the same lifted, keyed
 * registry and the same poll loop, because both drivers share InstallView /
 * InstallEvent and a completed uninstall must stay visible across the
 * installed-projection refresh the same way a completed install already
 * does (I-1, §7.2). The one difference from install is the start mapping:
 * an uninstall business failure (not in the catalog / not installed) lands
 * in the `failed` view with the host's published detail — never in the
 * install `rejected` codes, which belong to the install gate, and which
 * ShopUninstallResult's failure variant has no `code` field to populate. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ShopInstallStatusResult, ShopUninstallResult } from '../host/index.ts'
import { INSTALL_POLL_MS, reduceInstall, type InstallEvent, type InstallView } from './present.ts'

/** One entry's uninstall flow, as the tab hands it to a panel. */
export interface UninstallFlow {
  view: InstallView
  start: (args: { name: string }) => Promise<void>
  reset: () => void
}

export interface UseUninstallFlows {
  /** Two panels asking for the same uninstall identity receive one flow. */
  flowFor: (key: string) => UninstallFlow
}

/**
 * Uninstall flows owned by the tab and keyed by install identity. Lifting the
 * state above individual cards is what lets a completed uninstall's outcome
 * survive the installed-projection refresh that follows it — the row backing
 * the card disappears, but the flow keyed by identity does not.
 */
export function useUninstallFlows(
  uninstall: (args: { name: string }) => Promise<ShopUninstallResult>,
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>,
  onSettled?: (key: string) => void,
): UseUninstallFlows {
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

  const start = useCallback(async (key: string, args: { name: string }): Promise<void> => {
    put(key, { kind: 'idle' })
    try {
      const result = await uninstall(args)
      if (!result.ok) {
        put(key, { kind: 'failed', detail: result.detail, log: [] })
        return
      }
      put(key, { kind: 'running', installId: result.installId, log: [] })
    } catch {
      // Same transport-failure rule as useInstallFlows: a thrown uninstall is
      // the wire envelope rejecting, and its detail (hosts and ports) is
      // private and never rendered — the empty detail falls back to the
      // localized uninstall transport line. Nothing else can reach this catch.
      put(key, { kind: 'failed', detail: '', log: [] })
    }
  }, [uninstall, put])

  const reset = useCallback((key: string): void => {
    setViews(current => {
      if (!current.has(key)) return current
      const next = new Map(current)
      next.delete(key)
      return next
    })
  }, [])

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

  const flowFor = useCallback((key: string): UninstallFlow => ({
    view: views.get(key) ?? { kind: 'idle' },
    start: args => start(key, args),
    reset: () => reset(key),
  }), [views, start, reset])

  return { flowFor }
}
