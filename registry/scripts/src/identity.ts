/**
 * A listing's identity, and the orderings built on it.
 *
 * The catalog's uniqueness rule is `npm:<name>` for npm entries and
 * `github:<repo>#<subdir>` for repository entries. Everything else in the
 * registry used to key on the bare `name`: reviews, denials, the similarity
 * hold, first-seen dates and every sort comparator. That mismatch is one
 * defect with many faces — 151 live names are shared by 243 entries and
 * `dsh-skill-manager` is claimed by 14 repositories — so the strings live
 * here, once, and every consumer imports them.
 *
 * The host reaches the same serialisation independently, as `identityKey` in
 * `packages/dsh-plugin-shop/src/shared/identity.ts`: the two halves share no
 * code by design, only the schema, so the FORMAT is a published contract
 * between them. The names differ; the bytes must not.
 *
 * Pure: no clock, no network, no filesystem, no environment, and no locale
 * (every comparison is code-unit, so the artifacts are byte-identical under
 * any LANG).
 *
 * @module identity
 */
import type { Entry, Rejection } from './types.ts'

/** Code-unit comparison. Never `localeCompare`: a locale-aware order would
 * make the published bytes depend on the machine that built them. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The unit an author acts on for a repository candidate: the repo, or
 * `repo#subdir` for a monorepo subpackage. Rejection names, the shadow row
 * and `allowed-similar` reasoning all point at this string, so it has one
 * definition.
 */
export function repoUnit(candidate: { repo: string; subdir?: string }): string {
  return candidate.subdir === undefined ? candidate.repo : `${candidate.repo}#${candidate.subdir}`
}

/**
 * The install identity of an emitted entry — what `assertCatalogInvariants`
 * requires to be unique and what the Host must address an install by.
 * `repo` is optional on {@link Entry}, so a github entry that somehow lacks
 * it falls back to its name rather than emitting `github:undefined#`.
 */
export function installIdentity(entry: Pick<Entry, 'source' | 'name' | 'repo' | 'subdir'>): string {
  return entry.source === 'npm'
    ? `npm:${entry.name}`
    : `github:${entry.repo ?? entry.name}#${entry.subdir ?? ''}`
}

/**
 * The `first-seen.yml` key for an entry: the npm name, or the repository
 * `owner/slug`.
 *
 * Not the full install identity: `manifest.lock` records repo entries as
 * `owner/slug name version` with no subdir, so `owner/slug` is the finest
 * grain the committed history can prove a date for, and two subpackages of
 * one repository share the repository's first appearance. `owner/slug` always
 * contains a slash and never a leading `@`, so it cannot collide with an npm
 * name in the one map.
 *
 * The repo key is lowercased — GitHub resolves repository names
 * case-insensitively, so a repository that changes its casing must not read
 * as a new listing and re-stamp `added`. The npm name is not: an npm name is
 * a distinct string and the registry still serves legacy uppercase ones.
 * {@link installIdentity} does NOT fold, because that string is an install
 * target and must stay as published.
 */
export function firstSeenKey(entry: Pick<Entry, 'source' | 'name' | 'repo'>): string {
  return entry.source === 'npm' ? entry.name : (entry.repo ?? entry.name).toLowerCase()
}

/**
 * Total order on entries: the name first — that is the order a reader of
 * `plugins.json` expects and the one §7.1 names — then the rest of the
 * identity, so a tie can never fall back to the order npm or GitHub happened
 * to answer in.
 */
export function compareEntries(a: Entry, b: Entry): number {
  return compareStrings(a.name, b.name)
    || compareStrings(a.source, b.source)
    || compareStrings(a.repo ?? '', b.repo ?? '')
    || compareStrings(a.subdir ?? '', b.subdir ?? '')
}

/**
 * Total order on rejections. The name alone is not unique — one monorepo can
 * emit several rows under one repo, and one name can be rejected by both
 * channels — so the code and the author-readable detail break the tie.
 */
export function compareRejections(a: Rejection, b: Rejection): number {
  return compareStrings(a.name, b.name)
    || compareStrings(a.code, b.code)
    || compareStrings(a.detail, b.detail)
}
