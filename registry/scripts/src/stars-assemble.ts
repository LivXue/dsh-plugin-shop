/**
 * Assembles and serializes the stars sidecar. Pure: the "which count wins"
 * policy and the sidecar's exact bytes both live here, so fixtures drive them.
 * @module stars-assemble
 */

import { createHash } from 'node:crypto'
import { githubOwnerName, isHarnessRepo } from './github-repo.ts'
import { compareStrings } from './identity.ts'
import type { Entry } from './types.ts'

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

/** The sidecar as bytes: what to write, under what name, and its hash. */
export interface SerializedStars {
  /** Content-addressed file name the index points at. */
  fileName: string
  json: string
  sha256: string
}

/**
 * Merge the two star sources over the entries that are actually LISTED.
 *
 * Entries, not candidates: the sidecar used to be keyed by the harvest, so
 * every candidate got a row whether or not it was ever published — and every
 * reader downloaded all of them. The parameter type is the fix; a rejected
 * candidate can no longer be expressed here.
 *
 * A search-derived count wins whenever the repo appears in the daily topic
 * enumeration: it rides a response the harvest already paid for and is exactly
 * as fresh as the build. GraphQL covers the repos the search did not see.
 * `null` repository urls and repos with no count in either source are skipped;
 * a zero count is a real count.
 * @param entries - the accepted, tiered catalog entries.
 * @param searchStars - counts the topic search carried, by repo full name.
 * @param graphqlStars - counts the GraphQL fetch answered, by repo full name.
 */
export function assembleStarsForEntries(
  entries: readonly Entry[],
  searchStars: Map<string, number>,
  graphqlStars: Map<string, number>,
): AssembledStars {
  const stars: Record<string, number> = {}
  let fromSearch = 0
  let fromGraphql = 0
  const assign = (key: string, repository: string | null): void => {
    // Each KEY is tallied once. A monorepo contributes one entry per plugin
    // subpackage and they share both the repo key and its star count, so the
    // old per-candidate increment made the build note read "1 starred (3 from
    // the search, 0 from GraphQL)" — a line contradicting its own count.
    if (Object.hasOwn(stars, key)) return
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
  for (const entry of entries) {
    if (entry.source === 'github') {
      // A github entry is keyed by its repo. `repo` is optional on Entry for
      // the npm channel's sake, so a github entry without one is skipped
      // rather than keyed under `undefined`.
      if (entry.repo !== undefined) assign(entry.repo, entry.repository)
      continue
    }
    // An npm entry declaring the harness as its repository is a
    // misdeclaration; the harness's own count is not this plugin's stars. A
    // github entry that IS the harness keeps its own factually correct count.
    if (isHarnessRepo(entry.repository)) continue
    assign(entry.name, entry.repository)
  }
  return { stars, fromSearch, fromGraphql }
}

/**
 * Serialize the sidecar to the exact bytes that get published.
 *
 * The sort, the `Object.fromEntries`, the sha256 and the file name were four
 * lines inside `build.ts` with no test over any of them. The sort is
 * load-bearing: it is what keeps the content hash stable between two builds
 * that assembled the same counts in a different order, and it is by code unit
 * because a locale-aware one would make the published bytes depend on the
 * machine.
 * @param assembled - the merged counts from {@link assembleStarsForEntries}.
 */
export function serializeStars(assembled: AssembledStars): SerializedStars {
  const sorted = Object.fromEntries(
    Object.entries(assembled.stars).sort(([a], [b]) => compareStrings(a, b)),
  )
  const json = `${JSON.stringify({ stars: sorted }, null, 2)}\n`
  const sha256 = createHash('sha256').update(json).digest('hex')
  return { fileName: `stars.${sha256}.json`, json, sha256 }
}
