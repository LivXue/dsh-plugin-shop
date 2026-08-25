/** Pure presentation core for the store tab (§5.1 Client half). No React, no
 * timers, no I/O: every function here maps a value to a value, so fixtures
 * drive all of it. */

import type { StoreLocaleKey } from './locales.ts'
import type { CatalogEntry, InstallRejectionCode } from '../host/index.ts'

/** Tier → locale key, for the entry-card tier badge (§6.2). */
export function tierKey(tier: CatalogEntry['tier']): StoreLocaleKey {
  switch (tier) {
    case 'verified': return 'tierVerified'
    case 'verified-stale': return 'tierVerifiedStale'
    case 'community': return 'tierCommunity'
  }
}

/** A derived listing has no author-declared catalog section; the store
 * presents it as unclaimed, which is the signal that prompts an author to add
 * one (§6.1). Never present a derived entry as though the author wrote it. */
export function isUnclaimed(entry: CatalogEntry): boolean {
  return entry.metadata === 'derived'
}

/** Locale key for the §10 stale badge; the date is formatted at render time
 * from `builtAt`. */
export function staleLabelKey(): StoreLocaleKey {
  return 'staleLabel'
}

/** Spec §9.3 verbatim — the community-tier acknowledgement. The zh dictionary
 * states the same facts in its own register; never soften this wording. */
export const ACKNOWLEDGEMENT_EN =
  'Once installed, this plugin holds the same privileges as a built-in one: reading and writing your files, running shell commands, and reading and modifying the requests sent to the model. It has not been reviewed.'

/** One polled install status (§7.3 wire data), structural. */
export interface InstallStatusShape {
  found: boolean
  state: 'running' | 'done' | 'failed'
  log: string[]
  needsRestart?: boolean
  detail?: string
}

/** The install view state machine (§7.2). */
export type InstallView =
  | { kind: 'idle' }
  | { kind: 'rejected'; code: InstallRejectionCode; detail: string }
  | { kind: 'running'; installId: string; log: string[] }
  | { kind: 'done'; needsRestart: boolean }
  | { kind: 'failed'; detail: string; log: string[] }

/** One event the install view reacts to. */
export type InstallEvent =
  | { type: 'rejected'; code: InstallRejectionCode; detail: string }
  | { type: 'started'; installId: string }
  | { type: 'status'; status: InstallStatusShape }

/** §7.2 once-per-second poll cadence, as a named constant. */
export const INSTALL_POLL_MS = 1000

/** Pure install view reducer. A `status` event only applies to the install the
 * view is tracking — a status for an install it never started (idle) is an
 * unrelated event and a no-op, like any other event it does not recognize. */
export function reduceInstall(state: InstallView, event: InstallEvent): InstallView {
  switch (event.type) {
    case 'started':
      return { kind: 'running', installId: event.installId, log: [] }
    case 'rejected':
      return { kind: 'rejected', code: event.code, detail: event.detail }
    case 'status': {
      if (state.kind !== 'running') return state
      const { status } = event
      // The host retains finished records, so a poll that reports no record
      // after a successful start is genuinely anomalous. Surface the host's
      // own detail when it has one; otherwise the honest generic line.
      if (!status.found) {
        return { kind: 'failed', detail: status.detail ?? 'install record lost', log: status.log }
      }
      if (status.state === 'running') {
        return { kind: 'running', installId: state.installId, log: status.log }
      }
      if (status.state === 'done') {
        return { kind: 'done', needsRestart: !!status.needsRestart }
      }
      return { kind: 'failed', detail: status.detail ?? '', log: status.log }
    }
  }
}
