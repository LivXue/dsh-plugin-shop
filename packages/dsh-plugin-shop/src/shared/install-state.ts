/** The lifecycle of one install or uninstall command (§7.2, §7.3).
 *
 * Declared here rather than beside either consumer because it crosses the RPC
 * boundary: `executor.ts` produces it, `present.ts` consumes it, and each
 * used to spell the union itself with nothing keeping the two in agreement.
 *
 * `downloading` and `running` are BOTH non-terminal. Until `downloading`
 * existed there was exactly one non-terminal state, so `!== 'running'` was a
 * safe synonym for "finished" and three call sites wrote it that way. Ask
 * `isTerminalInstallState` instead — the next state added must not silently
 * reclassify a live install as finished.
 */
export type InstallState = 'downloading' | 'running' | 'done' | 'failed'

/** Whether the host is done with this record: it will not change again, and a
 * poller may stop. */
export function isTerminalInstallState(state: InstallState): state is 'done' | 'failed' {
  return state === 'done' || state === 'failed'
}
