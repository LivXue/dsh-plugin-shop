/**
 * One entry's install identity, defined once for both halves of the package.
 *
 * `name` is not an identity. The registry's uniqueness rule is `npm:<name>`
 * for an npm entry and `github:<repo>#<subdir>` for a repository entry, so
 * two repositories publishing the same package name remain distinct.
 */

import { validRange } from 'semver'

/** The fields that decide which catalog row a request is about. */
export interface EntryIdentity {
  source: 'npm' | 'github'
  name: string
  repo?: string
  subdir?: string
}

/** The registry's uniqueness rule, shared with the presentation layer. */
export function identityKey(identity: EntryIdentity): string {
  return identity.source === 'npm'
    ? `npm:${identity.name}`
    : `github:${identity.repo ?? identity.name}#${identity.subdir ?? ''}`
}

/** A GitHub commit pin. */
export const COMMIT_SHA = /^[0-9a-f]{40}$/

/** A GitHub release tag accepted as the version/pin of a rescued entry. */
export const RELEASE_TAG = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/

/** `owner/slug` inside a GitHub reference. */
const REPO = '([\\w.-]+)\\/([\\w.-]+?)'
const GITHUB_SHORTHAND = new RegExp(`^github:${REPO}(?:[#&].*)?$`)
const GITHUB_URL = new RegExp(`^(?:git\\+)?https?:\\/\\/(?:www\\.)?github\\.com\\/${REPO}(?:\\.git)?(?:[\\/?#].*)?$`)

/** Where a profile dependency spec says its package came from. */
export type SpecOrigin =
  | { kind: 'npm' }
  /** `owner/slug` spelled as the spec spells it — GitHub does not preserve
   * case for comparison, but a reader sent to look at `clapeill/x` when the
   * repository is `CLAPEILL/x` has to guess at it. */
  | { kind: 'github'; repo: string }

/**
 * Attribute a profile dependency spec to where its package came from.
 *
 * The single parse: every other function here reads its answer rather than
 * re-applying the regexes, so the grammar cannot be widened in one place and
 * not the other.
 *
 * `null` means this spec is a form the grammar does not cover — `git+ssh://`,
 * `git@github.com:`, a `file:`/`link:` checkout, `workspace:*`, an `npm:`
 * alias to a different package, a non-GitHub URL. Attribution is POSITIVE on
 * both arms and null is never guessed away: reading an unattributable spec as
 * npm is what let an npm entry silently replace a git install, and what
 * printed "already installed from the npm package X" about a local checkout.
 */
export function parseSpec(spec: string): SpecOrigin | null {
  // `validRange('')` is `*`, so a blank value would otherwise read as "any
  // version from npm". A manifest holding one is a hand-edit or a tooling
  // slip, and the safe reading of "something is here and I cannot say what"
  // is the same as for every other form the grammar misses.
  if (spec.trim() === '') return null
  const shorthand = GITHUB_SHORTHAND.exec(spec)
  if (shorthand?.[1] !== undefined && shorthand[2] !== undefined) {
    return { kind: 'github', repo: `${shorthand[1]}/${shorthand[2]}` }
  }
  const url = GITHUB_URL.exec(spec)
  if (url?.[1] !== undefined && url[2] !== undefined) {
    return { kind: 'github', repo: `${url[1]}/${url[2]}` }
  }
  // An npm dependency is a version or a range, which is what npm and pnpm
  // write. `validRange` accepts `1.2.0`, `^1.2.0`, `1.x` and `*`; it rejects
  // `workspace:*`, `file:…`, `link:…` and `npm:other@1`, all of which name
  // something the shop must not assume it may overwrite.
  return validRange(spec) !== null ? { kind: 'npm' } : null
}

/** `owner/slug`, lowercased, or null when this spec is not a GitHub
 * reference. Lowercased because it exists to COMPARE. */
export function parseRepoSpec(spec: string): string | null {
  const origin = parseSpec(spec)
  return origin?.kind === 'github' ? origin.repo.toLowerCase() : null
}

/**
 * Whether two identities of the SAME bundle name are the same install.
 *
 * Deliberately coarser than `identityKey`: a profile records a dependency
 * spec, which carries the repository but not the subdirectory, so this is the
 * finest distinction the installed state can actually support. It ignores
 * `name` — every caller has already matched on it — and answers only "is the
 * thing under that name this one, or a different one?".
 */
export function sameInstall(a: EntryIdentity, b: EntryIdentity): boolean {
  if (a.source !== b.source) return false
  if (a.source === 'npm') return true
  return a.repo !== undefined && a.repo.toLowerCase() === b.repo?.toLowerCase()
}

/**
 * What the profile's dependency spec for a name says about this entry.
 *
 * Three-valued on purpose. `unknown` is a spec `parseSpec` cannot attribute,
 * and the two callers need opposite defaults for it while sharing one rule:
 * `installed()` shows the row (it is the only row that can represent that
 * dependency, and dropping it would take the uninstall control with it),
 * while the install gate refuses (overwriting a checkout it cannot identify
 * is exactly the silent replacement it exists to prevent). Collapsing the two
 * into a boolean is what forced one of them to be wrong.
 */
export type SpecVerdict = 'same' | 'different' | 'unknown'

export function specVerdict(entry: EntryIdentity, spec: string): SpecVerdict {
  const origin = parseSpec(spec)
  if (origin === null) return 'unknown'
  const other: EntryIdentity = origin.kind === 'npm'
    ? { source: 'npm', name: entry.name }
    : { source: 'github', name: entry.name, repo: origin.repo }
  return sameInstall(entry, other) ? 'same' : 'different'
}

/**
 * Whether an installed dependency spec may be shown as this catalog entry's
 * row — the DISPLAY default of {@link specVerdict}.
 *
 * An unattributable spec still needs exactly one row to represent it, or the
 * same dependency shows twice under two same-named entries and the uninstall
 * control appears on both. The npm entry claims it: it is the shape with
 * nothing else to distinguish it, and this is the tie-break the installed
 * list has always used.
 */
export function installedSpecMatches(entry: EntryIdentity, spec: string): boolean {
  const verdict = specVerdict(entry, spec)
  return verdict === 'unknown' ? entry.source === 'npm' : verdict === 'same'
}

/** How long a raw spec may be when it is quoted back to a reader as the thing
 * holding a name. A profile manifest is not ours; a pathological value must
 * not become a wall of text in a rejection detail or a card. */
const HOLDER_SPEC_CAP = 80

/**
 * The token naming whatever holds a bundle name, for someone deciding what to
 * do about it.
 *
 * One function for both halves. The host's refusal and the card's badge wrap
 * it in their own sentence — the host in English prose, the card in the
 * reader's language — but the token itself is identical, so the two surfaces
 * can never name one plugin two ways. It is language-neutral for that reason:
 * a github holder is its repository (the only thing that tells it apart from
 * the entry it blocks), an npm holder is `npm:<name>`, and a spec we cannot
 * attribute is quoted verbatim, because saying which string is in the way is
 * the only honest thing left to say about it.
 */
export function holderLabel(spec: string, name: string): string {
  const origin = parseSpec(spec)
  if (origin?.kind === 'github') return origin.repo
  if (origin?.kind === 'npm') return `npm:${name}`
  // A blank value quoted verbatim would render as nothing at all, and a
  // sentence with a hole in it reads as a bug in the shop rather than as a
  // fact about the profile.
  if (spec.trim() === '') return '\"\"'
  return spec.length > HOLDER_SPEC_CAP ? `${spec.slice(0, HOLDER_SPEC_CAP - 1)}…` : spec
}
