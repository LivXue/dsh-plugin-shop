/** Self-update driving hook for the shop itself: start, poll to terminal.
 * Shares the install view machine and poll loop; the start mapping is the
 * uninstall one — a business refusal (a non-semver version) lands in the
 * `failed` view with the host's detail, never in the install `rejected`
 * codes. */

import { useCallback, useState } from 'react'
import type { ShopInstallStatusResult, ShopUpdateResult } from '../host/index.ts'
import { phaseOf, type InstallView } from './present.ts'
import { usePollStatus } from './useInstall.ts'

export interface UseUpdateSelfResult {
  view: InstallView
  start: (args: { version: string }) => Promise<void>
  /** Return the view to `idle` when `predicate` selects it; stable across
   * renders. The keyed registries' `resetWhere`, for the one self-update:
   * dsh restarting under the page settles an update that was waiting for
   * exactly that (design §8, 2026-10-06 amendment). */
  resetWhere: (predicate: (view: InstallView) => boolean) => void
}

/** Drive one self-update: the host's business union, the shared polling
 * loop, and terminal states. The `rejected` install state never occurs. */
export function useUpdateSelf(
  updateStart: (args: { version: string }) => Promise<ShopUpdateResult>,
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>,
): UseUpdateSelfResult {
  const [view, setView] = useState<InstallView>({ kind: 'idle' })

  const start = useCallback(async (args: { version: string }) => {
    setView({ kind: 'idle' })
    try {
      const result = await updateStart(args)
      if (!result.ok) {
        setView({ kind: 'failed', detail: result.detail, log: [] })
        return
      }
      setView({ kind: 'running', installId: result.installId, log: [], phase: phaseOf(result.state) })
    } catch {
      // Same transport-failure rule as useInstall/useUninstall: the thrown
      // wire detail (hosts and ports) is private and never rendered — the
      // empty detail falls back to the localized line.
      setView({ kind: 'failed', detail: '', log: [] })
    }
  }, [updateStart])

  const resetWhere = useCallback((predicate: (view: InstallView) => boolean) => {
    setView(current => (predicate(current) ? { kind: 'idle' } : current))
  }, [])

  usePollStatus(view, setView, installStatus)

  return { view, start, resetWhere }
}
