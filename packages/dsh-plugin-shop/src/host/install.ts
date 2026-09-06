/** Install gate: the gate rejection paths of §7.2, as a pure function. */

import type { CatalogSnapshot } from './catalog.ts'
import type { CatalogEntry } from './types.ts'
import { displayRepoSpec, identityKey, installedSpecMatches } from '../shared/identity.ts'

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
 * Two same-named bundles CANNOT coexist, and the binding constraint is not the
 * manifest key — pnpm holds both fine under an alias, measured. It is the
 * loader entry id the bundle declares in its own patch: two copies of
 * `dsh-skill-manager` both declare `id: skill-manager`, and dsh then refuses
 * to load the tree at all —
 *
 *   Error: dsh: plugin tree failed to load: failed to apply loader entry
 *   include (cordis:include): duplicate loader entry id: skill-manager
 *
 * — so the profile does not boot until one is removed. Through the shop the
 * outcome is milder and quieter: the manifest keys by bundle name, so the
 * second install overwrites the first, and a plugin the user chose is gone
 * with no notice. 177 of the live catalog's names are claimed by more than one
 * entry and `dsh-skill-manager` alone by 14.
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
  // Last, so the acknowledgement gate is not spent on a request that cannot
  // proceed: the name belongs to a DIFFERENT plugin that is already installed.
  // A same-identity request is the ordinary update path and passes here — the
  // manifest key it shares is its own.
  if (installedSpec !== undefined && !installedSpecMatches(entry, installedSpec)) {
    const holder = displayRepoSpec(installedSpec) ?? `the npm package ${args.name}`
    return {
      ok: false,
      code: 'name-taken',
      detail: `dsh-plugin-shop: ${args.name} is already installed from ${holder}.`
        + ' Two plugins of the same name cannot both be loaded — they declare the same loader entry id —'
        + ' so installing this one would replace it. Uninstall the one you have first if you mean to switch.',
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
