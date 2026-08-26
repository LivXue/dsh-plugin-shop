/** Install gate: the four rejection paths of §7.2, as a pure function. */

import type { CatalogSnapshot } from './catalog.ts'

export type InstallRejectionCode = 'not-in-catalog' | 'denied' | 'version-mismatch' | 'needs-acknowledgement'

export interface InstallArgs { name: string; version: string; acknowledged?: boolean }

export type ValidateResult = { ok: true } | { ok: false; code: InstallRejectionCode; detail: string }

/**
 * Decide whether one install request may proceed, against the Host's own
 * snapshot (§5.3). The browser sends a name; nothing the browser says about
 * the package is trusted.
 */
export function validateInstall(snapshot: CatalogSnapshot, args: InstallArgs): ValidateResult {
  const denied = snapshot.denied.find(d => d.name === args.name)
  if (denied !== undefined) {
    return { ok: false, code: 'denied', detail: `dsh-plugin-shop: ${args.name} is denied: ${denied.detail}` }
  }
  const entry = snapshot.entries.find(e => e.name === args.name)
  if (entry === undefined) {
    return { ok: false, code: 'not-in-catalog', detail: `dsh-plugin-shop: ${args.name} is not in the catalog` }
  }
  if (entry.version !== args.version) {
    return { ok: false, code: 'version-mismatch', detail: `dsh-plugin-shop: ${args.name}@${args.version} is not the cataloged version (${entry.version})` }
  }
  if (entry.tier !== 'verified' && !args.acknowledged) {
    const detail = entry.tier === 'verified-stale'
      ? `dsh-plugin-shop: ${args.name} is verified-stale: a newer version than the review is current and has not been reviewed; acknowledgement is required`
      : `dsh-plugin-shop: ${args.name} is ${entry.tier}-tier and has not been reviewed; acknowledgement is required`
    return { ok: false, code: 'needs-acknowledgement', detail }
  }
  return { ok: true }
}
