/** Install gate: the gate rejection paths of §7.2, as a pure function. */

import type { CatalogSnapshot } from './catalog.ts'
import type { CatalogEntry } from './types.ts'
import { holderLabel, identityKey, specVerdict } from '../shared/identity.ts'

export type InstallRejectionCode =
  | 'not-in-catalog'
  | 'denied'
  | 'version-mismatch'
  | 'needs-acknowledgement'
  | 'tarball-integrity'
  | 'ambiguous-identity'
  | 'name-taken'

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

/**
 * Decide whether an install request may proceed and return the resolved row.
 *
 * `installedSpec` is the profile manifest's dependency for `args.name`, when
 * it has one.
 *
 * What this refuses is REPLACEMENT, and the mechanism is the manifest key: a
 * profile holds one dependency per name, the shop writes `dependencies[name]`,
 * so installing a second plugin of that name overwrites the first and a plugin
 * the user chose is gone with no notice. 177 of the live catalog's names are
 * claimed by more than one entry, `dsh-skill-manager` alone by 14.
 *
 * That is the whole of what the name buys. It is NOT the same rule as the
 * loader's, and the two must not be confused — an earlier version of this
 * comment and of the published detail said "they declare the same loader entry
 * id", which is false for a measurable share of the pairs refused here:
 * `Anyway-one/dsh-balance` declares `id: balance` while `ZHIZHU4410/deepseek-
 * balance`, also bundle-named `dsh-balance`, declares `id: dsh-balance`. Those
 * two would load side by side happily if a profile could hold both.
 *
 * The loader's own rule cuts the other way and this gate does not reach it:
 * two DIFFERENTLY-named bundles declaring one entry id make dsh refuse the
 * whole tree —
 *
 *   Error: dsh: plugin tree failed to load: failed to apply loader entry
 *   include (cordis:include): duplicate loader entry id: plugin-manager
 *
 * — and the profile does not boot at all. `2768651338/dsh-plugin-manager` and
 * `Dingpenghui-good/dsh-plugin-manager` carry different bundle names and both
 * declare `id: plugin-manager`, so this gate passes them. A candidate's entry
 * ids are not knowable before its files are on disk, which is why the check
 * for that lives after the install lands rather than here (see
 * `collidingEntryId` in index.ts).
 *
 * Passing the spec in rather than reading the manifest here keeps the whole
 * gate a pure function driven by fixtures.
 */
export function validateInstall(
  snapshot: CatalogSnapshot,
  args: InstallArgs,
  installedSpec?: string,
): ValidateResult {
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
  // Ahead of the acknowledgement gate, so a request that cannot proceed never
  // asks the reader to accept a plugin's privileges first. The shipped client
  // opens its own §9.3 dialog before it calls, so this ordering is what any
  // OTHER caller of the RPC gets; the client closes its own gate on the same
  // verdict (see ShopTab's nameTakenBy).
  //
  // A same-identity request is the ordinary update path and passes — the
  // manifest key it would overwrite is its own.
  if (installedSpec !== undefined) {
    const verdict = specVerdict(entry, installedSpec)
    if (verdict !== 'same') {
      const holder = holderLabel(installedSpec, args.name)
      // `unknown` is a spec the grammar does not cover — a git remote, a
      // `file:` checkout, an `npm:` alias. Refusing it is the point: the shop
      // must not overwrite something it cannot identify, and saying which
      // string is in the way is the only honest thing left to say about it.
      const what = verdict === 'unknown'
        ? `dsh-plugin-shop: ${args.name} is already installed from ${holder}, which the shop cannot identify as any catalog entry.`
        : `dsh-plugin-shop: ${args.name} is already installed from ${holder}.`
      return {
        ok: false,
        code: 'name-taken',
        detail: `${what} A profile holds one dependency per name, so installing this one would overwrite it`
          + ' and the plugin you have would be gone. Uninstall it first if you mean to switch.',
      }
    }
  }
  if (entry.tier !== 'verified' && !args.acknowledged) {
    const detail = entry.tier === 'verified-stale'
      ? `dsh-plugin-shop: ${args.name} is verified-stale: a newer version than the review is current and has not been reviewed; acknowledgement is required`
      : `dsh-plugin-shop: ${args.name} is ${entry.tier}-tier and has not been reviewed; acknowledgement is required`
    return { ok: false, code: 'needs-acknowledgement', detail }
  }
  return { ok: true, entry }
}
