/**
 * Assembles the stars sidecar's content from its two sources. Pure: the
 * "which count wins" policy lives here, so fixtures drive it.
 * @module stars-assemble
 */

import { githubOwnerName, isHarnessRepo } from './github-repo.ts'
import type { Candidate, RepoCandidate } from './types.ts'

/**
 * The sidecar's `stars` object plus the per-source tallies the build note
 * reports. npm entries key by package name, github entries by repo full
 * name — the two keyspaces stay disjoint.
 */
export interface AssembledStars {
  stars: Record<string, number>
  fromSearch: number
  fromGraphql: number
}

/**
 * Merge the two star sources. A search-derived count wins whenever the repo
 * appears in the daily topic enumeration: the count rides a response the
 * harvest already paid for and is exactly as fresh as the build. GraphQL
 * covers the repos the search did not see. `null` repository urls and repos
 * with no count in either source are skipped; a zero count is a real count.
 */
export function assembleStarsByKey(
  candidates: Candidate[],
  repoCandidates: RepoCandidate[],
  searchStars: Map<string, number>,
  graphqlStars: Map<string, number>,
): AssembledStars {
  const stars: Record<string, number> = {}
  let fromSearch = 0
  let fromGraphql = 0
  const assign = (key: string, repository: string | null): void => {
    const parsed = githubOwnerName(repository)
    if (parsed === null) return
    const fullName = `${parsed.owner}/${parsed.name}`
    const searchCount = searchStars.get(fullName)
    const count = searchCount ?? graphqlStars.get(fullName)
    if (count === undefined) return
    stars[key] = count
    if (searchCount !== undefined) fromSearch += 1
    else fromGraphql += 1
  }
  for (const candidate of candidates) {
    // An npm entry declaring the harness as its repository is a
    // misdeclaration; the harness's own count is not this plugin's stars.
    if (isHarnessRepo(candidate.repository)) continue
    assign(candidate.name, candidate.repository)
  }
  for (const repo of repoCandidates) assign(repo.repo, repo.repository)
  return { stars, fromSearch, fromGraphql }
}
