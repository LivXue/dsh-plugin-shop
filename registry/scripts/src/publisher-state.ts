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
 * harvesting with half a partition. Originally specified to be committed
 * daily while nothing yet read or wrote `registry/publisher-state.json` and
 * `daily.yml` did not stage it — Task 6 of the plan was to wire all three.
 *
 * Done as of 2026-09-18: the file exists (3,775 publishers and a cursor as of
 * 2026-09-16), `build.ts` reads and writes it, and `daily.yml` stages it
 * alongside `repo-state.json` and `first-seen.yml` — `workflow.test.ts`
 * asserts the staged set by equality, so the write cannot land without the
 * `git add`.
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

/**
 * Own-property names that hijack a plain object through bracket assignment.
 * `pinned` and the local map every {@link pinFor}, {@link unpinFor} and
 * {@link readPinned} build are ordinary objects, so `obj[key] = value` for
 * `key === '__proto__'` does not create a property at all — it runs the
 * inherited `Object.prototype.__proto__` SETTER and replaces the object's own
 * prototype. A subsequent `Object.keys` never sees the entry (a silent drop
 * on read), and a subsequent read of `obj[key]` returns whatever was just
 * installed as the prototype rather than `undefined`, so an `?? []` fallback
 * never fires and the value reaches `Set`/`Array` methods that do not exist
 * on it (a raw, unfiled crash on write). `constructor` and `prototype` are
 * refused alongside it: both already name a non-array value on the same
 * prototype chain, and reach the identical class of crash.
 *
 * A harvest keyword is never one of these three in practice — they come from
 * `PARTITION_KEYWORDS` in `npm-client.ts` — but this file's `pinned` map is
 * keyed by whatever string a caller hands in, and per CLAUDE.md's "Untrusted
 * input" policy the `--harvest-from` handoff that supplies it is exactly
 * that: untrusted. The boundary has to refuse these by name rather than
 * assume the source is friendly.
 */
const DANGEROUS_KEYWORD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Bound on a keyword used as a `pinned` map key. Real harvest keywords are
 * `PARTITION_KEYWORDS` entries — a handful of characters — so this is a
 * defensive ceiling rather than a measured one, sized like this file's other
 * bounds on registry-controlled input.
 */
const KEYWORD_KEY_MAX_LENGTH = 128

/**
 * Whether `value` may be used as a `pinned` map key without corrupting the
 * object it is set on. Exported so `npm-client.ts`'s `parsePublisherAxisReport`
 * can hold its `keyword` field to the same grammar at the handoff boundary,
 * rather than leaving a bad value to surface only when `pinFor`/`unpinFor`
 * happen to be called with it.
 */
export function isPinnableKeyword(value: string): boolean {
  return value.length > 0 && value.length <= KEYWORD_KEY_MAX_LENGTH && !DANGEROUS_KEYWORD_KEYS.has(value)
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
  /**
   * Maintainers pinned for one harvest keyword: probed on every run rather
   * than waited for by rotation.
   *
   * Keyed by harvest keyword because the cells are `{keywords: [K],
   * maintainer}` and so the verdict is per keyword — a maintainer pinned for
   * `dsh-plugin` must not be dropped because its `deepseek-harness` cell
   * supplied nothing. Optional because a file written before this existed
   * carries none, and absent means empty rather than malformed.
   */
  readonly pinned?: Readonly<Record<string, readonly string[]>>
}

/**
 * Parse the pinned map, validating that it is an object of arrays of usernames.
 * Returns an empty object for missing or undefined pinned field.
 * @throws when the shape is invalid or usernames are outside the grammar.
 */
function readPinned(parsed: unknown): Record<string, string[]> {
  const pinned = (parsed as { pinned?: unknown }).pinned
  if (pinned === undefined) return {}
  if (typeof pinned !== 'object' || pinned === null || Array.isArray(pinned)) {
    throw new Error('publisher-state.json: pinned must be an object')
  }
  const out: Record<string, string[]> = Object.create(null)
  for (const keyword of Object.keys(pinned).sort(compareStrings)) {
    if (!isPinnableKeyword(keyword)) {
      throw new Error(`publisher-state.json: pinned key ${JSON.stringify(keyword)} is not a valid harvest keyword`)
    }
    const users = (pinned as Record<string, unknown>)[keyword]
    if (!Array.isArray(users)) {
      throw new Error(`publisher-state.json: pinned[${JSON.stringify(keyword)}] must be an array`)
    }
    const kept = new Set<string>()
    users.forEach((user, i) => {
      if (!isMaintainerName(user)) {
        throw new Error(`publisher-state.json: pinned[${JSON.stringify(keyword)}][${i}] is not a maintainer username`)
      }
      kept.add(user)
    })
    out[keyword] = [...kept].sort(compareStrings)
  }
  return out
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
  return { publishers: [...out].sort(compareStrings), cursor: cursor ?? 0, pinned: readPinned(parsed) }
}

/** Serialize, sorted by code unit and newline-terminated. */
export function serializePublisherState(state: PublisherState): string {
  const publishers = [...state.publishers].sort(compareStrings)
  const pinned: Record<string, string[]> = {}
  for (const keyword of Object.keys(state.pinned ?? {}).sort(compareStrings)) {
    pinned[keyword] = [...(state.pinned?.[keyword] ?? [])].sort(compareStrings)
  }
  return `${JSON.stringify({ publishers, cursor: state.cursor ?? 0, pinned }, null, 2)}\n`
}

/**
 * Where the next run should start, given how many publishers this one
 * ROTATED to — not how large its budget was.
 *
 * Pinned probes do not advance the rotation: they are probed every run by
 * definition, so counting them here would step the cursor past
 * `pinned.length` publishers per snapshot, permanently and silently. The
 * vocabulary would grow, every build would stay green, and a band of it would
 * never be probed.
 */
export function nextCursor(state: PublisherState, rotated: number): number {
  const size = state.publishers.length
  if (size <= rotated) return 0
  if (rotated <= 0) return state.cursor ?? 0
  return ((state.cursor ?? 0) + rotated) % size
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
  // The cursor and pinned map ride through: a merge grows the vocabulary, it
  // does not restart the rotation or disturb the pinned map. Advancing the
  // cursor is `nextCursor`'s job and the caller's decision, because only the
  // caller knows what budget the run actually spent.
  return { publishers: [...kept].sort(compareStrings).slice(0, MAX_PUBLISHERS), cursor: state.cursor ?? 0, pinned: state.pinned ?? {} }
}

/** One harvested name, reduced to the two fields the at-risk rule reads. */
export interface HarvestedName {
  readonly keywords: readonly string[]
  readonly maintainers: readonly string[]
}

/**
 * Whether `name` is reachable ONLY while its rank sits inside the harvest
 * keyword's search window — the shared rule behind {@link atRiskOwners} and
 * {@link atRiskNameCount}.
 *
 * A `keywords:<harvest>,<refinement>` cell selects a name only if the name
 * carries that refinement. A name whose only listed refinement is the harvest
 * keyword itself is therefore reachable ONLY while its rank sits inside the
 * keyword's window, and passes permanently out of reach when the keyword
 * outgrows `SEARCH_WINDOW`. Those names are what the publisher axis exists
 * for.
 *
 * RANK IS NOT PART OF THIS RULE. A name carrying a refinement is reachable at
 * any rank, so rank decides WHEN a name leaves reach and never WHICH names
 * can. Selecting by rank would also mean predicting future ranks, where the
 * rate-times-tail model over-predicted fivefold
 * (`docs/plans/2026-09-08-publisher-partition.md`); this rule is exact and
 * measurable while the keyword is still enumerable.
 *
 * A name carrying no keywords at all is never at risk: it did not reach the
 * harvest through a keyword search, so attributing it to this keyword's
 * residue is unfounded.
 *
 * Takes the refinement set pre-built rather than the raw list so a caller
 * iterating many names builds it once, not once per name.
 */
function isAtRisk(
  name: HarvestedName,
  harvestKeyword: string,
  refinementSet: ReadonlySet<string>,
): boolean {
  if (name.keywords.length === 0) return false
  for (const keyword of name.keywords) {
    if (keyword !== harvestKeyword && refinementSet.has(keyword)) return false
  }
  return true
}

/**
 * The maintainers of names that no refinement cell can reach — see {@link
 * isAtRisk} for the rule that selects them.
 *
 * An owner is counted only once no matter how many at-risk names it
 * maintains, and only when it passes {@link isMaintainerName}: this list
 * feeds a `maintainer:` query argument, so a name outside that grammar has no
 * cell it could be probed with. That silently drops an at-risk name whose
 * every maintainer fails the grammar — the count of names is a different
 * question, answered by {@link atRiskNameCount}, which does not share this
 * blind spot because it never needs a probeable username.
 */
export function atRiskOwners(
  names: readonly HarvestedName[],
  harvestKeyword: string,
  refinements: readonly string[],
): string[] {
  const refinementSet = new Set(refinements)
  const out = new Set<string>()
  for (const name of names) {
    if (!isAtRisk(name, harvestKeyword, refinementSet)) continue
    for (const owner of name.maintainers) {
      if (isMaintainerName(owner)) out.add(owner)
    }
  }
  return [...out].sort(compareStrings)
}

/**
 * How many names are at risk — see {@link isAtRisk} for the rule.
 *
 * Deliberately NOT derived from {@link atRiskOwners}'s output. That list is
 * OWNERS, filtered to {@link isMaintainerName} and de-duplicated, so neither
 * its length nor a sum over it recovers the name count: a name with two
 * maintainers is not two names, and a name whose only maintainer fails the
 * grammar is at risk but contributes no owner at all. This function counts
 * names directly against the same {@link isAtRisk} predicate instead, so a
 * report's `atRiskNames` reflects every at-risk name regardless of whether
 * any of its maintainers are usable as a probe argument.
 */
export function atRiskNameCount(
  names: readonly HarvestedName[],
  harvestKeyword: string,
  refinements: readonly string[],
): number {
  const refinementSet = new Set(refinements)
  let count = 0
  for (const name of names) {
    if (isAtRisk(name, harvestKeyword, refinementSet)) count++
  }
  return count
}

/**
 * How many maintainers one keyword may pin.
 *
 * Half {@link PUBLISHER_PROBE_BUDGET_DEFAULT}, so pinned probes can never take
 * more than half a run and rotation always keeps the other half: the axis
 * degrades under a large pinned set, it never starves. Written as a literal
 * rather than imported from `npm-client.ts`, which would make this pure module
 * depend on the shell; `publisher-state.test.ts` asserts the relation instead.
 *
 * At-risk names are ~2% of a keyword's names and the keyword grows ~70 a day,
 * so a pinned set grows by roughly one owner a day and this bound is months
 * out. It is here so that horizon is a bound and not a cliff, and a set AT the
 * bound is reported (see `describePublisherAxis`) because at that point new
 * residue owners are being refused.
 */
export const MAX_PINNED_PER_KEYWORD = 250

/** The state plus `users` pinned for `keyword`; filtered, unique, sorted, bounded. */
export function pinFor(state: PublisherState, keyword: string, users: readonly string[]): PublisherState {
  if (!isPinnableKeyword(keyword)) {
    throw new Error(`publisher-state.json: pinFor keyword ${JSON.stringify(keyword)} is not a valid harvest keyword`)
  }
  const pinned: Record<string, string[]> = Object.create(null)
  for (const key of Object.keys(state.pinned ?? {})) pinned[key] = [...(state.pinned?.[key] ?? [])]
  const kept = new Set(pinned[keyword] ?? [])
  for (const user of users) {
    if (kept.size >= MAX_PINNED_PER_KEYWORD) break
    if (isMaintainerName(user)) kept.add(user)
  }
  // Re-bounded after the merge: a state handed in already over the bound must
  // not be grown by this call, and `Set` insertion cannot be relied on to stop
  // at the limit when the incoming names were already present.
  const next = [...kept].sort(compareStrings).slice(0, MAX_PINNED_PER_KEYWORD)
  // Deletes rather than committing `keyword: []`: an empty array is inert to
  // `probeOrder` (`pinned?.[keyword] ?? []` reads the same either way), but it
  // is not inert to `serializePublisherState`, which copies every existing key
  // forward without ever dropping one — so an empty entry, once written,
  // round-trips into the committed file forever. Mirrors `unpinFor`, which
  // prunes for the same reason.
  if (next.length === 0) delete pinned[keyword]
  else pinned[keyword] = next
  return { ...state, pinned }
}

/** The state with `users` no longer pinned for `keyword`. */
export function unpinFor(state: PublisherState, keyword: string, users: readonly string[]): PublisherState {
  if (!isPinnableKeyword(keyword)) {
    throw new Error(`publisher-state.json: unpinFor keyword ${JSON.stringify(keyword)} is not a valid harvest keyword`)
  }
  const pinned: Record<string, string[]> = Object.create(null)
  for (const key of Object.keys(state.pinned ?? {})) pinned[key] = [...(state.pinned?.[key] ?? [])]
  const drop = new Set(users)
  const kept = (pinned[keyword] ?? []).filter(user => !drop.has(user))
  if (kept.length === 0) delete pinned[keyword]
  else pinned[keyword] = kept
  return { ...state, pinned }
}

/**
 * Which publishers this run probes for `keyword`, in order.
 *
 * Pinned first and always; the rotation spends what is left of the budget,
 * starting at the cursor and skipping anyone already pinned — probing one
 * publisher twice in a run would spend budget to learn nothing.
 *
 * The rotation length is what the cursor must advance by. Advancing by the
 * BUDGET instead would skip `pinned.length` publishers every snapshot,
 * permanently and silently: the vocabulary grows, every build is green, and a
 * band of the vocabulary is never rotated to.
 */
export function probeOrder(
  state: PublisherState, keyword: string, budget: number,
): { pinned: string[]; rotated: string[] } {
  const size = state.publishers.length
  if (size === 0 || budget <= 0) return { pinned: [], rotated: [] }
  const pinnedAll = state.pinned?.[keyword] ?? []
  const pinned = [...pinnedAll].slice(0, Math.min(budget, MAX_PINNED_PER_KEYWORD))
  const already = new Set(pinned)
  const rotated: string[] = []
  const start = (state.cursor ?? 0) % size
  let stepped = 0
  while (pinned.length + rotated.length < budget && stepped < size) {
    const candidate = state.publishers[(start + stepped) % size]
    stepped++
    if (candidate === undefined || already.has(candidate)) continue
    already.add(candidate)
    rotated.push(candidate)
  }
  return { pinned, rotated }
}
