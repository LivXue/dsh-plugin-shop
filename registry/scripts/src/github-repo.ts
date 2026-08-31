/**
 * Extract `{ owner, name }` from a normalized npm `repository` value, or null
 * when it is not a plain `https://github.com/<owner>/<name>` URL. Pure — the
 * only policy here is "no guesses": a value that merely LOOKS like a repo
 * path (extra segments, ssh spellings, other hosts) yields no stars rather
 * than a wrong repository (spec 2026-08-26-github-stars-design.md §2.1).
 */
export function githubOwnerName(repository: string | null): { owner: string; name: string } | null {
  if (repository === null) return null
  let url: URL
  try {
    url = new URL(repository)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
  const parts = url.pathname.split('/').filter(part => part !== '')
  if (parts.length !== 2) return null
  const owner = parts[0]
  let name = parts[1]
  if (owner === undefined || name === undefined || owner === '' || name === '') return null
  if (name.endsWith('.git')) name = name.slice(0, -4)
  if (name === '') return null
  return { owner, name }
}

/** Full name of the DeepSeek Harness repository, the host project itself. */
export const HARNESS_REPO = 'deepseek-ai/deepseek-harness'

/**
 * Whether a repository URL names the harness repository itself. A plugin
 * declaring the host project as its repository is a misdeclaration — the
 * declared URL holds none of the plugin's source.
 */
export function isHarnessRepo(repository: string | null): boolean {
  const parsed = githubOwnerName(repository)
  return parsed !== null && `${parsed.owner}/${parsed.name}` === HARNESS_REPO
}
