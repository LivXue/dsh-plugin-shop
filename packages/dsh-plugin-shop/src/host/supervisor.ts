/** systemd-supervisor detection for `shop/restart` (design 2026-08-31
 * market-borrowings C-1).
 *
 * Pure: the environment and the process snapshot are parameters, so the
 * policy is fixture-driven. Two signals are required on purpose:
 * `INVOCATION_ID` (and `JOURNAL_STREAM`) are inherited by every descendant
 * of a unit — an ordinary terminal opened inside a service would carry them
 * too. Only the unit's own main process has ppid 1; hiding the restart button
 * for anything else would be the worse bug (dsh-market's restart.ts:31-44
 * documents the same measured failure). */
export type Supervisor = 'systemd' | null

export interface ProcessSnapshot { ppid: number }

export function detectSupervisor(
  env: Record<string, string | undefined>,
  proc: ProcessSnapshot,
): Supervisor {
  const marked = env.INVOCATION_ID !== undefined || env.JOURNAL_STREAM !== undefined
  return marked && proc.ppid === 1 ? 'systemd' : null
}
