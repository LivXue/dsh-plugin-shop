/** Install gate: the gate rejection paths of §7.2, as a pure function. */

import type { CatalogSnapshot } from './catalog.ts'
import type { CatalogEntry } from './types.ts'
import { identityKey } from '../shared/identity.ts'

export type InstallRejectionCode =
  | 'not-in-catalog'
  | 'denied'
  | 'version-mismatch'
  | 'needs-acknowledgement'
  | 'tarball-integrity'
  | 'ambiguous-identity'

export interface InstallArgs {
  name: string
  version: string
  acknowledged?: boolean
  /** Optional identity fields keep old clients readable while refusing an
   * ambiguous name-only request when the catalog has duplicate names. */
  source?: 'npm' | 'github'
  repo?: string
  subdir?: string
}

export type ValidateResult =
  | { ok: true; entry: CatalogEntry }
  | { ok: false; code: InstallRejectionCode; detail: string }

/** Decide whether an install request may proceed and return the resolved row. */
export function validateInstall(snapshot: CatalogSnapshot, args: InstallArgs): ValidateResult {
  const denied = snapshot.denied.find(d => d.name === args.name)
  if (denied !== undefined) {
    return { ok: false, code: 'denied', detail: `dsh-plugin-shop: ${args.name} is denied: ${denied.detail}` }
  }

  let entry: CatalogEntry | undefined
  if (args.source === undefined) {
    // Compatibility with an old client: unique names remain answerable, but
    // guessing among duplicate repositories would install the wrong code.
    const named = snapshot.entries.filter(e => e.name === args.name)
    if (named.length > 1) {
      return {
        ok: false,
        code: 'ambiguous-identity',
        detail: `dsh-plugin-shop: the catalog holds ${named.length} entries named ${args.name}, and this request does not say which one; refresh the shop and try again`,
      }
    }
    entry = named[0]
  } else {
    const wanted = identityKey({ source: args.source, name: args.name, repo: args.repo, subdir: args.subdir })
    entry = snapshot.entries.find(candidate => identityKey(candidate) === wanted)
    if (entry === undefined) {
      return { ok: false, code: 'not-in-catalog', detail: `dsh-plugin-shop: ${wanted} is not in the catalog` }
    }
  }

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
  return { ok: true, entry }
}
