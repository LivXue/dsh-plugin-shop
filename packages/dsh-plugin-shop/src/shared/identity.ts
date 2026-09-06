/**
 * One entry's install identity, defined once for both halves of the package.
 *
 * `name` is not an identity. The registry's uniqueness rule is `npm:<name>`
 * for an npm entry and `github:<repo>#<subdir>` for a repository entry, so
 * two repositories publishing the same package name remain distinct.
 */

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

/** `owner/slug`, lowercased, or null when this is not a repository reference. */
const REPO = '([\\w.-]+)\\/([\\w.-]+?)'
const GITHUB_SHORTHAND = new RegExp(`^github:${REPO}(?:[#&].*)?$`)
const GITHUB_URL = new RegExp(`^(?:git\\+)?https?:\\/\\/(?:www\\.)?github\\.com\\/${REPO}(?:\\.git)?(?:[\\/?#].*)?$`)

/**
 * Read the repository out of a profile dependency spec, or return null for
 * an npm range/spec that does not identify a GitHub repository.
 */
export function parseRepoSpec(spec: string): string | null {
  const shorthand = GITHUB_SHORTHAND.exec(spec)
  if (shorthand !== null && shorthand[1] !== undefined && shorthand[2] !== undefined) {
    return `${shorthand[1]}/${shorthand[2]}`.toLowerCase()
  }
  const url = GITHUB_URL.exec(spec)
  if (url !== null && url[1] !== undefined && url[2] !== undefined) {
    return `${url[1]}/${url[2]}`.toLowerCase()
  }
  return null
}

/**
 * The `owner/slug` a spec names, spelled as the spec spells it.
 *
 * `parseRepoSpec` lowercases because it exists to COMPARE. This one exists to
 * be READ: a rejection detail sends someone to look at that repository, and
 * `CLAPEILL` rendered as `clapeill` is a repository they then have to guess at.
 */
export function displayRepoSpec(spec: string): string | null {
  const shorthand = GITHUB_SHORTHAND.exec(spec)
  if (shorthand?.[1] !== undefined && shorthand[2] !== undefined) return `${shorthand[1]}/${shorthand[2]}`
  const url = GITHUB_URL.exec(spec)
  if (url?.[1] !== undefined && url[2] !== undefined) return `${url[1]}/${url[2]}`
  return null
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

/** Whether an installed dependency spec names this catalog entry. The
 * spec-string form of `sameInstall`, so the host's refusal and the client's
 * badge can never disagree about what counts as a different plugin. */
export function installedSpecMatches(entry: EntryIdentity, spec: string): boolean {
  const repo = parseRepoSpec(spec)
  return sameInstall(entry, repo === null
    ? { source: 'npm', name: entry.name }
    : { source: 'github', name: entry.name, repo })
}
