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

import { canEverList } from './repo-gate.ts'
import type { RepoCandidate } from './types.ts'

/**
 * The version of the rule that writes a repository candidate's `peers` and
 * `compatibility`, stamped beside them as {@link RepoCandidate.declarationsRule}.
 *
 * Bump it whenever `peerNamesOf` or `compatibilityOf` (npm-client.ts) changes
 * what it returns, or whenever WHERE a candidate's declarations are read from
 * changes — a release-rescued root reading its tarball's manifest instead of
 * HEAD's was that kind of change. Every recorded listable candidate stamped
 * with any other value is then re-read once, cheaply: one manifest at the
 * recorded commit, or the recorded release asset (`harvestRepos` in
 * github-client.ts, under its own per-run budget), and stamped again.
 *
 * A version, not the presence of `peers`, because `tier.ts` republishes a
 * carried candidate's two fields verbatim, so a record is only as current as
 * the rule that wrote it. The presence marker this replaced knew "read or not"
 * and never "read under which rule": a reader change reached npm entries on
 * the next build and never reached a dormant repository — a carried
 * `['react', 'left-pad']` stayed as it was while npm's reader returned
 * `['react']` — which broke `peerNamesOf`'s promise that the two channels
 * cannot be recorded under two different rules.
 *
 * Compared for equality, so a stamp from a LATER rule — a build that was rolled
 * back — is re-read as well rather than trusted.
 */
export const DECLARATIONS_RULE = 1

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
 * A repository {@link diffRepoState} wants fetched, and why.
 *
 * `backfillOnly` means nothing about the repository changed — it is queued to
 * re-ask a question about the commit already recorded (an unverified release,
 * a missing size probe). The distinction exists because the budget is smaller
 * than the backlog: 13,443 recorded repositories entered the size backfill at
 * once against a `REPO_BACKFILL_BUDGET` of 2,000, and an undifferentiated queue
 * sorted by NAME served an unchanged repository being re-measured for a
 * decoration ahead of a repository that had actually published a fix. For
 * roughly seven consecutive runs, everything late in the alphabet would not
 * have reached the catalog at all.
 *
 * A repository whose only need is a current declarations stamp is NOT one of
 * these: it goes to the diff's separate re-read queue, which harvestRepos
 * serves with a manifest-only read under its own budget. That backfill queued
 * 10,629 repositories at once (2026-09-24), and sending them down this path
 * cost a head commit, a sizing tree, a release probe and subpackage discovery
 * each, to learn what one package.json at the recorded commit says.
 */
export interface RepoToFetch extends RepoSeen {
  backfillOnly: boolean
}

/**
 * Re-bound the one figure a candidate carries forward without ever being
 * re-derived.
 *
 * `installSize` passes {@link treeInstallSize}'s validation exactly once, at
 * the commit where it was measured, and `sizeProbed` then guarantees it is
 * never measured again — so without this it reaches `plugins.json` through an
 * unchecked cast. The npm half does the opposite and says why in its own
 * comment: `npm-client.ts` re-bounds `dist.unpackedSize` with the same two
 * tests on EVERY run. The asymmetry mattered in proportion — the 2026-09-08
 * dry run fetched 405 repositories and carried 15,063, so ~97% of github
 * figures reached the emitter without passing a check again, and nothing
 * downstream re-tests one: `repo-gate` and `tier` only ask `!== undefined`,
 * and `toWellFormedEntry` repairs strings.
 *
 * The consequence a bad row buys is not local. `1e999` parses to Infinity and
 * `JSON.stringify` emits `"installSize": null`; `-1`, `1.5` and `"big"` are
 * republished verbatim. Once the client adds `z.number().int().nonnegative()`
 * behind its throwing parse, one such row costs every installed shop the
 * WHOLE catalog — the exact blast radius the second key was introduced to
 * avoid (design § 2026-09-08).
 *
 * The marker goes with the figure, and that is the whole repair: dropping
 * `installSize` alone would leave the row `sizeProbed` and therefore sizeless
 * forever, while dropping both re-queues the repository for one honest
 * re-measurement. Self-healing, so a corrupt row costs a decoration for one
 * run instead of stopping a build over a number the next run can just take
 * again.
 */
function reboundCarriedSize(candidate: RepoCandidate): RepoCandidate {
  const { installSize, sizeProbed, sizeCappedAt } = candidate as {
    installSize?: unknown
    sizeProbed?: unknown
    sizeCappedAt?: unknown
  }
  const sizeOk = installSize === undefined
    || (typeof installSize === 'number' && Number.isSafeInteger(installSize) && installSize >= 0)
  // Bounded like the figure: it is compared against the live cap to decide a
  // re-probe, and a NaN or a string would make that comparison silently false
  // — the one outcome this field exists to prevent.
  const capOk = sizeCappedAt === undefined
    || (typeof sizeCappedAt === 'number' && Number.isSafeInteger(sizeCappedAt) && sizeCappedAt >= 0)
  // `sizeProbed?: true` in the type, so anything else is a shape this build
  // never wrote. A falsy one already reads as unprobed; normalizing it away
  // keeps it from being serialized back out.
  const probeOk = sizeProbed === undefined || sizeProbed === true
  if (sizeOk && probeOk && capOk) return candidate
  const { installSize: _size, sizeProbed: _probe, sizeCappedAt: _cap, ...rest } = candidate
  return rest
}

/**
 * Refuse a carried candidate whose `peers`, `compatibility` or declarations
 * stamp is a shape this build never writes, and return it typed.
 *
 * All three ride the bare cast `parseRepoState` revives candidates with, and
 * none is re-derived on the way out: `tier.ts` copies the first two into the
 * published entry as they stand, and the stamp decides whether they are ever
 * read again. This build is their only writer, so a wrong shape means the file
 * was edited or corrupted by something else, and it throws — the rule for a
 * malformed registry file, as for a malformed `failure` record. `installSize`
 * is repaired instead (`reboundCarriedSize`) because a size is a decoration;
 * these feed a warning published against someone's plugin, which is the kind
 * of output this project would rather stop than publish wrong. A stamp in
 * particular has to be exact: one that compared unequal by accident would
 * re-read its repository every run, and one that compared equal by accident
 * would freeze its declarations under a rule nobody applied.
 *
 * ABSENT is not a wrong shape for any of the three. A record written before a
 * field existed carries none of it, and it stays absent: a missing stamp is
 * what queues `diffRepoState`'s re-read, and a missing `peers` is what that
 * re-read fills in.
 *
 * Types only, not the harvest's length and count bounds. Those are applied
 * where the value is read (`peerNamesOf`, `compatibilityOf`), and a bound
 * lowered later must not turn every row written under the old one into a
 * build that cannot start; the payload budget in `repo-gate.ts` still
 * measures whatever a carried row would publish.
 * @param repo - the state key, for the error.
 * @param candidate - one carried candidate, unvalidated.
 */
function checkCarriedDeclarations(repo: string, candidate: unknown): RepoCandidate {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error(`repo-state.json: ${repo} has a candidate that is not an object`)
  }
  const { peers, compatibility, declarationsRule } = candidate as {
    peers?: unknown
    compatibility?: unknown
    declarationsRule?: unknown
  }
  if (peers !== undefined && !isStringArray(peers)) {
    throw new Error(`repo-state.json: ${repo} has a candidate with a malformed peers record`)
  }
  if (compatibility !== undefined && !isCompatibilityRecord(compatibility)) {
    throw new Error(`repo-state.json: ${repo} has a candidate with a malformed compatibility record`)
  }
  // A positive integer, the only thing DECLARATIONS_RULE can be. Not compared
  // with the current rule: a stamp from another rule is a record to re-read,
  // not a corrupt one.
  if (declarationsRule !== undefined
    && !(typeof declarationsRule === 'number' && Number.isSafeInteger(declarationsRule) && declarationsRule > 0)) {
    throw new Error(`repo-state.json: ${repo} has a candidate with a malformed declarationsRule stamp`)
  }
  return candidate as RepoCandidate
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * The shape `compatibilityOf` writes and nothing else: a plain object carrying
 * at least one of `dsh` (a NON-EMPTY string) and `profiles` (a NON-EMPTY array
 * of non-empty strings), and no other key. Empty is refused because that
 * reader returns nothing rather than `{}` — an empty object in the artifact
 * reads as a declaration the author did not make — and a foreign key because
 * the object is published whole, so a key the harvest never read would go out
 * under the author's name. `{dsh: ''}` and `{profiles: []}` are refused for
 * the same reason as `{}`: that reader cannot produce either, so one in the
 * committed file is a shape no build wrote. The harvest's length bounds are
 * NOT re-applied here — they are that reader's policy, and a copy of them
 * would be a second place to keep in step.
 */
function isCompatibilityRecord(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length === 0 || keys.some(key => key !== 'dsh' && key !== 'profiles')) return false
  const { dsh, profiles } = value as { dsh?: unknown; profiles?: unknown }
  if (dsh !== undefined && (typeof dsh !== 'string' || dsh.length === 0)) return false
  if (profiles !== undefined) {
    if (!isStringArray(profiles) || profiles.length === 0) return false
    if (profiles.some(profile => profile.length === 0)) return false
  }
  return true
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
      candidates = entry.candidates.map(candidate => reboundCarriedSize(checkCarriedDeclarations(repo, candidate)))
    } else if (typeof entry.candidate === 'object' && entry.candidate !== null) {
      candidates = [reboundCarriedSize(checkCarriedDeclarations(repo, entry.candidate))]
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
 * @returns `toFetch` — repos new or with a changed `pushed_at`, plus the
 *   full-fetch backfills (an unverified release, a missing size probe);
 *   `toReread` — unchanged repos whose ONLY need is a current declarations
 *   stamp, disjoint from `toFetch` because a full fetch re-projects and stamps
 *   every candidate itself; `gone` — recorded repos the search no longer
 *   returns (deleted, renamed, private — the catalog must drop them with the
 *   reason attached).
 */
export function diffRepoState(
  state: RepoState,
  seen: RepoSeen[],
  /**
   * The tree body cap this build applies ({@link MAX_TREE_BYTES}). A candidate
   * recorded as refused under a SMALLER cap is re-queued, so raising the cap
   * re-measures what the old one excluded.
   *
   * Defaults to Infinity, which re-queues every cap-refused candidate. That is
   * the wasteful direction on purpose: a caller that forgets spends one
   * re-probe, where the other default would silently leave those repositories
   * sizeless forever — and this project prefers the failure it can see.
   */
  treeCap: number = Number.POSITIVE_INFINITY,
): { toFetch: RepoToFetch[]; toReread: string[]; gone: string[] } {
  const seenByName = new Map(seen.map(entry => [entry.repo, entry]))
  const toFetch: RepoToFetch[] = []
  const toReread: string[] = []
  for (const [repo, entry] of seenByName) {
    const recorded = state[repo]
    // A repo the search has never recorded, or one whose head moved, has
    // something NEW to say. The other two reasons re-ask a question about a
    // commit already recorded — worth asking, but never at a changed repo's
    // expense, which is what `backfillOnly` lets the caller enforce.
    const changed = recorded === undefined || recorded.pushedAt !== entry.pushedAt
    if (changed || hasUnverifiedRelease(recorded) || lacksSizeProbe(recorded, treeCap)) {
      toFetch.push({ ...entry, backfillOnly: !changed })
    } else if (hasStaleDeclarations(recorded)) {
      // Only when nothing above applies: every full fetch re-projects the
      // manifest and stamps it, so a repository in both queues would be read
      // twice for the same answer.
      toReread.push(repo)
    }
  }
  const gone = Object.keys(state).filter(repo => !seenByName.has(repo))
  return { toFetch, toReread, gone }
}

/**
 * Whether a recorded repo has candidates the sizing probe never reached.
 *
 * The same retroactivity hole as {@link hasUnverifiedRelease}, for the same
 * reason: `pushedAt` gates the re-fetch, so every repository recorded before
 * `installSize` existed would keep no size until it happened to push. That is
 * not a theoretical wait — the 2026-09-08 dry run fetched 405 repositories and
 * carried 15,063, so the field would arrive for a few percent and then trickle
 * in behind whatever pushes happen to occur, which for a dormant repository is
 * never.
 *
 * Absence of `sizeProbed` queues the repo for ONE re-probe, after which the
 * marker is present either way and the repo returns to being re-fetched only
 * when it changes. The backfill is therefore bounded and self-terminating:
 * every recorded repo once, and then done. Not at REPO_BACKFILL_BUDGET a run,
 * though — `harvestOnce` serves changed repos first and the backfill spends
 * what they leave over, because 13,443 recorded repos against a budget of
 * 2,000 is seven runs during which an undifferentiated name-sorted queue
 * would have starved every alphabetically-late repo that actually changed.
 *
 * It deliberately does NOT test `installSize`. A tree can answer and yield no
 * figure — truncated, a hostile blob size, a `subdir` matching nothing — and
 * keying on the size would put those repositories in every run's queue
 * forever, spending the backfill budget on repositories that can never
 * satisfy it. The marker is the same device `assetVerified` is, for the same
 * reason its comment gives.
 *
 * The cost this DOES accept, stated because it is a behaviour change for an
 * unchanged repository: a sizing read that fails in transport marks nothing,
 * so that repo is re-fetched on every run until one read answers. That is the
 * `fetch-failed` rule — a transport failure says nothing about the repository
 * and is never made durable — but it now spends a re-fetch rather than
 * nothing, and a broadly failing tree endpoint would spend the whole budget
 * re-fetching instead of advancing the backfill. Bounded by the budget, so
 * the failure mode is a slower backfill and not an unbounded run.
 */
function lacksSizeProbe(recorded: RepoState[string], treeCap: number): boolean {
  // Only candidates that could actually list. One that cannot is never
  // measured and never marked, so counting it here would queue its repository
  // in every run forever — and skipping it unconditionally would leave it
  // unmeasured if a gate rule later loosens. Asking the same predicate the
  // skip asks makes the loosening re-queue exactly what it made listable.
  return (recorded.candidates ?? []).some(
    candidate => canEverList(candidate)
      && (candidate.sizeProbed !== true
        // Refused by a cap smaller than the one this build applies, so the
        // refusal was ours and is worth re-asking exactly once.
        || (candidate.sizeCappedAt !== undefined && candidate.sizeCappedAt < treeCap)),
  )
}

/**
 * Whether a recorded repo has listable candidates whose `peers` and
 * `compatibility` were not written under the current {@link DECLARATIONS_RULE}
 * — never stamped at all included, which is every record from before the stamp.
 *
 * The same retroactivity hole as {@link lacksSizeProbe}, and this time nothing
 * else closes it. The size backfill re-read every recorded repository once,
 * and it is over: measured on the committed repo-state.json of 2026-09-24, 0
 * of 10,864 listable candidates still lacked `sizeProbed`, so with unchanged
 * heads the diff queued nothing at all. Without a marker of its own, the
 * declarations would reach the 10,629 repositories holding those candidates
 * only as each happened to push — for a dormant one, never — and the
 * compatibility badge would stay blind to them.
 *
 * The marker is a rule VERSION, where it used to be the bare presence of
 * `peers`. Presence could say "read or not" and never "read under which rule",
 * so a change to `peerNamesOf` or `compatibilityOf` reached npm entries on the
 * next build and no dormant repository ever (see {@link DECLARATIONS_RULE}).
 * Every projection writes the stamp beside `peers` — `[]` when the manifest
 * requires nothing, so keying on an EMPTY list, which would re-queue every
 * peerless plugin forever, is not the test — and a successful re-read writes
 * it too, so the queue is once per repository per rule and self-terminating.
 * One stamp serves both fields because one writer writes both.
 *
 * What it queues is a RE-READ, not a fetch: the diff's separate `toReread`,
 * which harvestRepos serves after every full fetch with one manifest read per
 * candidate at the recorded commit (or the recorded release asset). A re-read
 * that fails changes nothing and persists nothing, so its repository simply
 * queues again next run — never as a failure record, never as a published
 * row, and never toward the systematic-failure bound. The failure mode is a
 * slower backfill. Its COUNT per run is bounded by the re-read's own
 * repository budget; its TIME is not, because a stalled host holds each read
 * for a whole deadline, and is bounded separately by the phase's wall-clock
 * budget and consecutive-failure breaker (`DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT`
 * in github-client.ts). What they stop is deferred, unchanged.
 *
 * Only candidates that could list, by {@link canEverList}, for the reason
 * `lacksSizeProbe` gives: declarations on an entry that can never exist reach
 * no reader, and asking the same predicate means a loosened gate rule
 * re-queues exactly the candidates it made listable.
 */
function hasStaleDeclarations(recorded: RepoState[string]): boolean {
  return (recorded.candidates ?? []).some(
    candidate => canEverList(candidate) && candidate.declarationsRule !== DECLARATIONS_RULE,
  )
}

/**
 * Whether a recorded repo carries a release the CURRENT rules never checked.
 *
 * A rescue recorded before `verifyReleaseAsset` was never opened: it was taken
 * on the release metadata alone. Those records are not evidence, and nothing
 * would ever re-examine them — `pushedAt` gates the re-fetch, so an unchanged
 * repo keeps its unverified rescue forever. Two of the bad ones measured on
 * 2026-09-06 had been quiet since 2026-08-22 and 2026-08-24, so "it will sort
 * itself out on the next push" is not true in any useful sense.
 *
 * `assetVerified` is the marker the probe now writes. Its ABSENCE queues the
 * repo for one re-probe, after which the flag is present either way and the
 * repo returns to being re-fetched only when it changes. This is the same
 * shape as {@link staleFailureRepos}: state recorded under a rule that has
 * since changed is invalidated once, deliberately, rather than trusted. The
 * declarations re-read removes the flag too, when the recorded asset no longer
 * hashes to its pin — the verified bytes are gone, so the rescue is re-probed.
 *
 * Clearing the recorded `release` instead would have been wrong — the
 * candidate is REUSED verbatim for an unchanged repo, so it would delist all
 * 328 rescued entries, the ~321 legitimate ones included, until each happened
 * to push again.
 */
function hasUnverifiedRelease(recorded: RepoState[string]): boolean {
  return (recorded.candidates ?? []).some(candidate =>
    candidate.release !== undefined && candidate.release.assetVerified !== true)
}

/**
 * The published reason a recorded repository is no longer listed.
 *
 * It lives beside {@link diffRepoState}, which is what DECIDES a repo is gone.
 * The detail is an author-readable published string — CLAUDE.md counts a
 * misattributed one as a defect rather than a wording nit — so it belongs with
 * the rule it describes rather than inlined in build.ts's shell, where nothing
 * could test it and where it was the only rejection reason not minted by a
 * pure module.
 *
 * `gone` means one thing only: neither harvest topic returned the repository.
 * The old wording named three causes and left out the likeliest — the owner
 * edited the topics. That repository still exists, is public and was never
 * renamed, so all three published causes were false for it, and it is the only
 * one of the four its author can act on: re-add the topic and the next build
 * lists it again.
 * @param topics - the harvest topics, passed in because this module is pure and
 *   the list lives in the network module; restating it here would be a third copy.
 */
export function repoGoneDetail(topics: readonly string[]): string {
  return `The topic search no longer returns this repository: its ${topics.join('/')} topic was removed, or the repository was deleted, renamed, or made private.`
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
