/**
 * This project's own packages, which must never appear in its own catalog.
 *
 * The shop is a dsh plugin, and its `package.json` declares both harvest
 * keywords — the same two it asks every plugin author to declare. That makes
 * it a candidate in the catalog it builds. Nothing else would stop it: the npm
 * gate has no build-script or workspace check, so it would pass and be listed.
 *
 * Leaving that to the client's shop-like NAME filter is not enough. That
 * filter hides an entry from the shelf while the entry still sits in the data
 * and counts toward `index.json`'s `count` — the exact gap between the All
 * tab's number and the header's that this catalog has already had to explain
 * once. Excluding here keeps one number true everywhere, and puts a reason
 * next to the name in the build report rather than making it vanish.
 *
 * @module own
 */
import { githubOwnerName } from './github-repo.ts'

/**
 * The npm packages this project publishes. Exact names: npm names are unique,
 * so an exact match is this project and nothing else. A fork, a scoped
 * republish or a near-miss belongs to somebody else and is judged on its
 * merits — the shop-like name filter is what keeps a competing market off the
 * shelf, and it is a separate decision from this one.
 */
export const OWN_PACKAGES: readonly string[] = ['dsh-plugin-shop', 'dsh-plugin-shop-catalog']

/** This project's repository, lowercased for comparison. */
export const OWN_REPO = 'livxue/dsh-plugin-shop'

/**
 * Is this one of the packages this project publishes?
 * @param name - the candidate's npm name.
 */
export function isOwnPackage(name: string): boolean {
  return OWN_PACKAGES.includes(name)
}

/**
 * Is this this project's own repository?
 *
 * Owner AND name, because the repository name alone is not distinctive: a
 * `dsh-plugin-shop` under another owner is a different project.
 *
 * @param repository - a repository URL, or an `owner/name` slug.
 */
export function isOwnRepo(repository: string | null): boolean {
  if (repository === null || repository === '') return false
  const parsed = githubOwnerName(repository)
  if (parsed !== null) return `${parsed.owner}/${parsed.name}`.toLowerCase() === OWN_REPO
  return repository.toLowerCase() === OWN_REPO
}
