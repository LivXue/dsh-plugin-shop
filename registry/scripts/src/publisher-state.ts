/**
 * The committed memory of the npm harvest's PUBLISHER axis: every maintainer
 * username the harvest has seen on a search result, plus the grammar that
 * decides what may be one.
 *
 * `keywords:<harvest>,<refinement>` cells cannot reach a package that carries
 * only the harvest keyword; `keywords:<harvest> maintainer:<user>` cells have
 * no such blind spot, because every package has a maintainer. What they DO
 * need is to have seen the maintainer, which is why this file exists: the
 * vocabulary accumulates monotonically across runs instead of being re-derived
 * each time from a window that is a shrinking fraction of the keyword.
 *
 * A deterministic build input like `verified.yml` and `repo-state.json`:
 * sorted by code unit, and a malformed one throws rather than silently
 * harvesting with half a partition. To be committed daily — stated in the
 * future tense because it is not yet: no module reads or writes
 * `registry/publisher-state.json`, the file does not exist, and `daily.yml`
 * does not stage it. Task 6 of the plan wires all three, and
 * `workflow.test.ts` asserts the staged set by equality, so the write cannot
 * land without the `git add`.
 *
 * PURE, and the grammar lives here rather than in `npm-client.ts` for that
 * reason: it is a policy decision, the core owns those, and no pure module in
 * this repo imports from the shell.
 *
 * @module publisher-state
 */
import { compareStrings } from './identity.ts'

/**
 * Bound on a maintainer username. npm's own limit is smaller, but this value
 * is interpolated into a search `text=` parameter, so the bound is ours and
 * {@link isMaintainerName}'s grammar is what actually keeps it safe.
 *
 * Deliberately NOT `gate.ts`'s `PUBLISHER_MAX_LENGTH` (128), which bounds a
 * different question: what may be PUBLISHED as an entry's `publisher` field,
 * where the value is a packument's `maintainers[].name` and may be arbitrary
 * text npm never validated. This one bounds what may be SENT as a query
 * argument. The gap between them is stated rather than closed: an account of
 * 65 to 128 characters is published verbatim as a `publisher` and is simply
 * not reachable by this axis. The longest of 647 distinct usernames sampled
 * live was 19 characters (2026-09-09), so the gap is empty today.
 */
export const MAINTAINER_MAX_LENGTH = 64

/**
 * Bound on the vocabulary itself. The per-name bound above is half a policy:
 * every other list this repo reads from npm carries both halves
 * (`PEER_NAME_MAX_LENGTH` with `PEERS_MAX_COUNT`, `MAX_SUBPACKAGES`,
 * `REPO_BACKFILL_BUDGET`), and this one needs the count half more than most
 * because {@link mergePublishers} never removes: without it a single hostile
 * page of grammar-valid usernames is committed to git permanently and buys a
 * live request every run forever.
 *
 * 20,000 is 5.9x the ~3,390 usernames `PARTITION_KEYWORDS`' comment measures
 * the axis at, and a large multiple of the per-run probe budget — whose value
 * and its own bracketing live in `PUBLISHER_PROBE_BUDGET_DEFAULT`'s comment in
 * `npm-client.ts` and are deliberately not restated here, because that budget
 * moved once already and a copy of it in this file went stale the same day.
 * The relation is what matters: the FILE must not
 * truncate before the BUDGET does, because the vocabulary is meant to outlive
 * what one run can spend on it, which is the entire reason it is persisted
 * rather than re-derived. File size is not the constraint being defended: at
 * ~26 bytes a name this is ~520 KB against `repo-state.json`'s committed
 * 12 MB.
 *
 * Over the cap the code-unit TAIL is dropped, not the newest arrivals, so the
 * kept set stays a pure function of the union and a full vocabulary does not
 * churn the committed file as names arrive and re-arrive. Dropped rather than
 * thrown for the reason `maintainersOf` states about one malformed name: this
 * file is re-observable and a build must not stop over it. Enforced on the
 * WRITE side alone for the same reason — lowering the cap later self-heals on
 * the next write instead of refusing every file already committed above it.
 */
export const MAX_PUBLISHERS = 20_000

/**
 * The names this repo will put in a `maintainer:` argument: lowercase letters,
 * digits, hyphen, underscore, dot. Deliberately a SUBSET of what npm accepts
 * as an account name, which is why a name outside it is dropped rather than
 * treated as impossible — `dsh-import-from-agents`' only maintainer is
 * `4*astral_`, and `keywords:dsh-plugin maintainer:4*astral_` answers 1 live.
 *
 * Lowercase-only is not part of that narrowing. `maintainer:` is
 * case-sensitive: `maintainer:HUANLIN` answers 0 where `maintainer:huanlin`
 * answers 92 (measured 2026-09-09), so an uppercase spelling is not a value
 * this qualifier has an answer for, and admitting one would buy a cell that
 * enumerates nothing.
 */
const MAINTAINER_NAME = /^[a-z0-9._-]+$/

/** Whether `value` may be put in a query as a `maintainer:` argument. */
export function isMaintainerName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAINTAINER_MAX_LENGTH
    && MAINTAINER_NAME.test(value)
}

/** Every maintainer username the harvest has seen, sorted, unique. */
export interface PublisherState {
  readonly publishers: readonly string[]
  /**
   * Where the next run starts spending its probe budget, as an index into
   * `publishers`. Optional because a file written before this existed carries
   * none, and absent means zero rather than malformed.
   *
   * It exists because the budget is a PREFIX, not a sample. `selectPublisherCells`
   * walks the sorted vocabulary and stops at {@link
   * PUBLISHER_PROBE_BUDGET_DEFAULT}, so with no rotation the same first N are
   * probed on every run and everything sorted after them is never probed at
   * all — deterministic starvation rather than a partial run, and invisible
   * because a name that is never probed cannot be reported missing.
   *
   * The inverse failure is just as silent and has already happened: {@link
   * nextCursor} returns 0 while the whole vocabulary fits one budget, so a
   * budget sized ABOVE the vocabulary leaves this field pinned at 0 and every
   * run probes everything. {@link PUBLISHER_PROBE_BUDGET_DEFAULT}'s comment
   * owns that incident and the bracket that now keeps the budget under the
   * committed vocabulary.
   */
  readonly cursor?: number
}

/**
 * Parse the committed file.
 * @throws when it is not an object with a `publishers` array of usernames this
 *   module would itself have written. Unknown keys are ignored, so an older
 *   reader does not refuse a newer file.
 */
export function parsePublisherState(raw: string): PublisherState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Named, not swallowed: JSON.parse throws here for exactly one reason and
    // the caller needs the file named, not a bare SyntaxError.
    throw new Error('publisher-state.json is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('publisher-state.json must be an object')
  }
  const publishers = (parsed as { publishers?: unknown }).publishers
  if (!Array.isArray(publishers)) {
    throw new Error('publisher-state.json: publishers must be an array')
  }
  const out = new Set<string>()
  publishers.forEach((name, i) => {
    if (!isMaintainerName(name)) {
      throw new Error(`publisher-state.json: publishers[${i}] is not a maintainer username`)
    }
    out.add(name)
  })
  // De-duplicated, not merely sorted: the interface above says unique, and
  // `mergePublishers` cannot produce a repeat, so a file carrying one was hand
  // edited or badly merged. Collapsing rather than throwing is what the
  // sibling shape gets for free — `repo-state.ts` is a `Record`, where a
  // repeated JSON key collapses silently — and the throw-on-duplicate rule is
  // about `verified.yml`, where two rows for one identity are two conflicting
  // REVIEWS and last-one-wins would silently pick one. Two identical
  // usernames carry no payload to pick between. Left in, a duplicate
  // round-trips forever and costs one wasted probe and one wasted paged sweep
  // on every build.
  const cursor = (parsed as { cursor?: unknown }).cursor
  if (cursor !== undefined && (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0)) {
    // Stops the run rather than silently restarting the rotation at zero. A
    // reset looks like nothing at all from the outside, and what it costs is
    // the tail of the vocabulary never being probed again.
    throw new Error('publisher-state.json: cursor must be a non-negative integer')
  }
  return { publishers: [...out].sort(compareStrings), cursor: cursor ?? 0 }
}

/** Serialize, sorted by code unit and newline-terminated. */
export function serializePublisherState(state: PublisherState): string {
  const publishers = [...state.publishers].sort(compareStrings)
  return `${JSON.stringify({ publishers, cursor: state.cursor ?? 0 }, null, 2)}\n`
}

/**
 * Where the next run should start, given what this one could afford.
 *
 * Zero while the whole vocabulary fits one budget: rotating a list that is
 * probed in full every run is churn in a committed file for nothing. Past
 * that it advances by exactly one budget and wraps, so a vocabulary of
 * `MAX_PUBLISHERS` against the default budget is covered in five runs.
 */
export function nextCursor(state: PublisherState, budget: number): number {
  const size = state.publishers.length
  if (size <= budget || budget <= 0) return 0
  return ((state.cursor ?? 0) + budget) % size
}

/**
 * The state plus everything in `seen`: filtered to the grammar, unique, sorted
 * and capped at {@link MAX_PUBLISHERS}. Never removes a name it keeps.
 *
 * `seen` is `readonly string[]` rather than `Iterable<string>` on purpose. A
 * bare `string` IS an `Iterable<string>`, so `mergePublishers(state, 'sayedev')`
 * type-checked and merged six single-character publishers — each one passing
 * the grammar, and then never removed.
 *
 * The filter is the other half of that. {@link parsePublisherState} throws on a
 * name outside the grammar, so a writer that does not apply the same rule can
 * commit a file every subsequent build refuses to read: a self-inflicted stop
 * one run away from its cause, repairable only by hand-editing a generated
 * file. Both ends of the round trip enforce one rule, and the state's own rows
 * are filtered too so a hand-built value cannot smuggle one past either.
 */
export function mergePublishers(state: PublisherState, seen: readonly string[]): PublisherState {
  const kept = new Set([...state.publishers, ...seen].filter(isMaintainerName))
  // The cursor rides through: a merge grows the vocabulary, it does not restart
  // the rotation. Advancing it is `nextCursor`'s job and the caller's decision,
  // because only the caller knows what budget the run actually spent.
  return { publishers: [...kept].sort(compareStrings).slice(0, MAX_PUBLISHERS), cursor: state.cursor ?? 0 }
}
