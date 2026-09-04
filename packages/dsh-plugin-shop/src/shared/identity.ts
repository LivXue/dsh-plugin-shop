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

/** Whether an installed dependency spec names this catalog entry. */
export function installedSpecMatches(entry: EntryIdentity, spec: string): boolean {
  const repo = parseRepoSpec(spec)
  if (entry.source === 'npm') return repo === null
  if (entry.repo === undefined) return false
  return repo === entry.repo.toLowerCase()
}
