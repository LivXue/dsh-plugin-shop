/**
 * The committed memory of the GitHub half of the harvest: per repository,
 * the `pushed_at` the search last saw, the commit it resolved, and the
 * candidate it produced. The daily build re-runs the (cheap) partitioned
 * topic search, compares `pushed_at`, and re-fetches only the changed or
 * new repositories — the candidate of an untouched repo is carried over
 * verbatim, so a full manifest sweep of the ~20k-repo pool never has to fit
 * inside one run's quota.
 *
 * The file is a deterministic build input like `verified.yml`: committed
 * daily, sorted, and a malformed one throws rather than silently dropping
 * the harvest memory.
 */

import type { RepoCandidate } from './types.ts'

/** One repository's recorded state. */
export interface RepoStateEntry {
  /** The `pushed_at` the search API reported; changes mean "re-fetch". */
  pushedAt: string
  /** The pinned commit of the default branch, 40 hex chars. */
  commit: string
  /** The last candidate produced; carried over while `pushedAt` is unchanged. */
  candidate: RepoCandidate
}

/** Repo full name (`owner/slug`) to its recorded state. */
export type RepoState = Record<string, RepoStateEntry>

/** One repository the partitioned search saw, before any state comparison. */
export interface RepoSeen {
  repo: string
  pushedAt: string
}

/** Parse the committed state file; a malformed file throws (it is a build
 * input, and silently dropping it would schedule a fresh full sweep). */
export function parseRepoState(text: string): RepoState {
  const raw = JSON.parse(text) as unknown
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('repo-state.json: expected an object')
  }
  const state: RepoState = {}
  for (const [repo, value] of Object.entries(raw)) {
    const entry = value as { pushedAt?: unknown; commit?: unknown; candidate?: unknown }
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`repo-state.json: ${repo} is not an object`)
    }
    if (typeof entry.pushedAt !== 'string' || typeof entry.commit !== 'string'
      || typeof entry.candidate !== 'object' || entry.candidate === null) {
      throw new Error(`repo-state.json: ${repo} is missing pushedAt/commit/candidate`)
    }
    state[repo] = entry as RepoStateEntry
  }
  return state
}

/** Serialize the state: sorted keys, trailing newline, deterministic. */
export function serializeRepoState(state: RepoState): string {
  const sorted = Object.fromEntries(
    Object.entries(state).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  return `${JSON.stringify(sorted, null, 2)}\n`
}

/**
 * Compare the search's view of the pool against the recorded state.
 * @returns `toFetch` — repos new or with a changed `pushed_at`; `gone` —
 *   recorded repos the search no longer returns (deleted, renamed, private —
 *   the catalog must drop them with the reason attached).
 */
export function diffRepoState(state: RepoState, seen: RepoSeen[]): { toFetch: RepoSeen[]; gone: string[] } {
  const seenByName = new Map(seen.map(entry => [entry.repo, entry]))
  const toFetch: RepoSeen[] = []
  for (const [repo, entry] of seenByName) {
    const recorded = state[repo]
    if (recorded === undefined || recorded.pushedAt !== entry.pushedAt) toFetch.push(entry)
  }
  const gone = Object.keys(state).filter(repo => !seenByName.has(repo))
  return { toFetch, gone }
}

/**
 * Merge one run's results into the next state: fetched repos record their
 * fresh candidate; carried repos keep the recorded one; gone repos drop.
 * @param state - the previous state.
 * @param seen - everything the search saw this run.
 * @param fetched - fresh candidates this run produced, keyed by repo.
 */
export function nextRepoState(
  state: RepoState,
  seen: RepoSeen[],
  fetched: Map<string, RepoCandidate>,
): RepoState {
  const next: RepoState = {}
  for (const entry of seen) {
    const fresh = fetched.get(entry.repo)
    const recorded = state[entry.repo]
    if (fresh !== undefined) {
      next[entry.repo] = { pushedAt: entry.pushedAt, commit: fresh.commit, candidate: fresh }
    } else if (recorded !== undefined) {
      next[entry.repo] = recorded
    }
    // A seen repo with neither a fresh candidate nor a recorded one stays
    // out of the state — its fetch was deferred past the budget and it has
    // never been fetched; next run's toFetch picks it up again.
  }
  return next
}
