/**
 * The committed memory of the GitHub half of the harvest: per repository,
 * the `pushed_at` the search last saw, the commit it resolved, the
 * candidates it produced, and — when the fetch ended deterministically —
 * the failure that left it without candidates. The daily build re-runs the
 * (cheap) partitioned topic search, compares `pushed_at`, and re-fetches
 * only the changed or new repositories; the candidates of an untouched repo
 * are carried over verbatim, and so is a recorded deterministic failure —
 * a known `no-manifest`/`no-bundle` repo must not re-consume the per-run
 * fetch budget every day (measured 2026-08-31: the failures re-fetched
 * forever, and the subpackage probe multiplies their cost).
 *
 * The file is a deterministic build input like `verified.yml`: committed
 * daily, sorted, and a malformed one throws rather than silently dropping
 * the harvest memory.
 */

import type { RepoCandidate } from './types.ts'

/** One repository's recorded state. Exactly one of the outcome fields is
 * present: candidates for a usable fetch, or a failure reason. */
export interface RepoStateEntry {
  /** The `pushed_at` the search API reported; changes mean "re-fetch". */
  pushedAt: string
  /** The pinned commit of the default branch, 40 hex chars. */
  commit: string
  /** The candidates produced; carried over while `pushedAt` is unchanged. */
  candidates: RepoCandidate[]
  /** The recorded deterministic failure; re-fetched only when `pushedAt` changes. */
  failure?: { code: 'no-manifest' | 'fetch-failed'; detail: string }
  /**
   * Subpackage-level failures, keyed `owner/slug#subdir`, carried across runs
   * exactly like {@link RepoStateEntry.failure}.
   *
   * These were deliberately NOT persisted while the only one was a name-grammar
   * failure on a repo that still produced candidates. A size refusal broke that
   * assumption: it rides the `ok` branch with no candidates at all, so without
   * a record here the reason is published on the run that fetched the repo and
   * never again — `diffRepoState` re-fetches only on a changed `pushedAt`, and
   * an entry with `candidates: []` and no failure looks like a repo with
   * nothing to say. Reported once, then silent forever, is worse against
   * "nothing disappears without a reason attached to its name" than the wrong
   * reason it replaced.
   */
  subpackageFailures?: { repo: string; code: 'no-manifest' | 'fetch-failed'; detail: string }[]
}

/** Repo full name (`owner/slug`) to its recorded state. */
export type RepoState = Record<string, RepoStateEntry>

/** One repository the partitioned search saw, before any state comparison. */
export interface RepoSeen {
  repo: string
  pushedAt: string
}

/**
 * Parse the committed state file; a malformed file throws (it is a build
 * input, and silently dropping it would schedule a fresh full sweep). The
 * pre-subpackage shape (`candidate`, singular) still parses — the committed
 * file predates the candidates array — and serializes back in the new
 * shape.
 */
export function parseRepoState(text: string): RepoState {
  const raw = JSON.parse(text) as unknown
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('repo-state.json: expected an object')
  }
  const state: RepoState = {}
  for (const [repo, value] of Object.entries(raw)) {
    const entry = value as {
      pushedAt?: unknown
      commit?: unknown
      candidate?: unknown
      candidates?: unknown
      failure?: unknown
      subpackageFailures?: unknown
    }
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`repo-state.json: ${repo} is not an object`)
    }
    if (typeof entry.pushedAt !== 'string' || typeof entry.commit !== 'string') {
      throw new Error(`repo-state.json: ${repo} is missing pushedAt/commit`)
    }
    let candidates: RepoCandidate[]
    if (Array.isArray(entry.candidates)) {
      candidates = entry.candidates as RepoCandidate[]
    } else if (typeof entry.candidate === 'object' && entry.candidate !== null) {
      candidates = [entry.candidate as RepoCandidate]
    } else {
      throw new Error(`repo-state.json: ${repo} has neither candidates nor a candidate`)
    }
    state[repo] = { pushedAt: entry.pushedAt, commit: entry.commit, candidates }
    if (entry.failure !== undefined) {
      const failure = entry.failure as { code?: unknown; detail?: unknown }
      if (typeof failure !== 'object' || failure === null
        || (failure.code !== 'no-manifest' && failure.code !== 'fetch-failed')
        || typeof failure.detail !== 'string') {
        throw new Error(`repo-state.json: ${repo} has a malformed failure record`)
      }
      state[repo]!.failure = { code: failure.code, detail: failure.detail }
    }
    if (entry.subpackageFailures !== undefined) {
      // An EMPTY array is rejected, not tolerated: nextRepoState only writes
      // the key when there is at least one row, so `subpackageFailures: []` in
      // a committed file was never written by this build. Accepting it would
      // let a shape the writer cannot produce round-trip silently, and a
      // malformed registry file throws here rather than being normalized.
      if (!Array.isArray(entry.subpackageFailures) || entry.subpackageFailures.length === 0) {
        throw new Error(`repo-state.json: ${repo} has a malformed subpackageFailures record`)
      }
      const rows = entry.subpackageFailures.map((value): NonNullable<RepoStateEntry['subpackageFailures']>[number] => {
        const row = value as { repo?: unknown; code?: unknown; detail?: unknown }
        if (typeof row !== 'object' || row === null
          || typeof row.repo !== 'string' || typeof row.detail !== 'string') {
          throw new Error(`repo-state.json: ${repo} has a malformed subpackageFailures record`)
        }
        if (row.code !== 'no-manifest' && row.code !== 'fetch-failed') {
          throw new Error(`repo-state.json: ${repo} has a malformed subpackageFailures record`)
        }
        return { repo: row.repo, code: row.code, detail: row.detail }
      })
      state[repo]!.subpackageFailures = rows
    }
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
 * The recorded repos whose failure record was written by the rule that
 * labelled every non-ok manifest response `no-manifest` (audit D-3).
 *
 * They cannot be told apart from genuine 404s — the old code wrote the same
 * code and the same detail for a 404, a 403, a 451 and a 503 — so the whole
 * class is invalidated once and re-fetched under the corrected rule.
 * Deleting the ENTRY, not just its `failure`, is what schedules the
 * re-fetch: {@link diffRepoState} re-fetches a repo only when it is absent
 * or its `pushed_at` moved, and a repo whose manifest fetch failed has
 * neither.
 * @param state - the recorded state.
 * @param code - the failure code to invalidate.
 * @param detail - the exact detail string the superseded rule wrote.
 * @param limit - at most this many, in sorted order, so a large
 *   invalidation can be paced across runs and every slice is deterministic
 *   and disjoint from the last.
 * @returns the repo full names to delete, sorted.
 */
export function staleFailureRepos(
  state: RepoState,
  code: 'no-manifest' | 'fetch-failed',
  detail: string,
  limit: number,
): string[] {
  return Object.entries(state)
    .filter(([, entry]) => entry.failure?.code === code && entry.failure.detail === detail)
    .map(([repo]) => repo)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, limit)
}

/**
 * Merge one run's results into the next state: fetched repos record their
 * fresh outcome (candidates or a failure); carried repos keep the recorded
 * one; gone repos drop.
 * @param state - the previous state.
 * @param seen - everything the search saw this run.
 * @param fetched - fresh outcomes this run produced, keyed by repo.
 */
export function nextRepoState(
  state: RepoState,
  seen: RepoSeen[],
  fetched: Map<string, {
    candidates: RepoCandidate[]
    failure?: { code: 'no-manifest' | 'fetch-failed'; detail: string }
    subpackageFailures?: { repo: string; code: 'no-manifest' | 'fetch-failed'; detail: string }[]
  }>,
): RepoState {
  const next: RepoState = {}
  for (const entry of seen) {
    const fresh = fetched.get(entry.repo)
    const recorded = state[entry.repo]
    if (fresh !== undefined) {
      next[entry.repo] = {
        pushedAt: entry.pushedAt,
        commit: fresh.candidates[0]?.commit ?? recorded?.commit ?? '',
        candidates: fresh.candidates,
        ...(fresh.failure !== undefined ? { failure: fresh.failure } : {}),
        ...(fresh.subpackageFailures !== undefined && fresh.subpackageFailures.length > 0
          ? { subpackageFailures: fresh.subpackageFailures }
          : {}),
      }
    } else if (recorded !== undefined) {
      next[entry.repo] = recorded
    }
    // A seen repo with neither a fresh outcome nor a recorded one stays out
    // of the state — its fetch was deferred past the budget and it has never
    // been fetched; next run's toFetch picks it up again.
  }
  return next
}
