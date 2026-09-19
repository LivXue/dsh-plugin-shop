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
 * **This list is not, and cannot be, complete under that criterion, and is
 * not what actually closes the class.** `toString`, `valueOf`,
 * `hasOwnProperty` and every other `Object.prototype` member match it just as
 * well — on a plain `{}`, `pinned['toString'] ?? []` returns a function, so
 * the fallback never fires and `new Set(fn)` throws exactly as `constructor`
 * does. What closes the class is that every `pinned` map in this file is
 * built with `Object.create(null)`, which inherits none of those names, so
 * such a key is created as an ordinary entry, round-trips, and is inert. The
 * three names below are the demonstrated cases, kept as defence in depth at
 * the boundary — a second refusal for the two that hijack an object outright
 * and the one that replaces its prototype. Widening the list would chase a
 * prototype chain the maps no longer have; do not grow it in place of the
 * null-prototype construction, which is load-bearing.
 *
 * A harvest keyword is never one of these three in practice — they come from
 * `PARTITION_KEYWORDS` in `npm-client.ts` — but this file's `pinned` map is
 * keyed by whatever string a caller hands in, and per CLAUDE.md's "Untrusted
 * input" policy the `--harvest-from` handoff that supplies it is exactly
 * that: untrusted. The boundary refuses these by name rather than assume the
 * source is friendly.
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
   * The seed a keyword's rotation starts from when {@link
   * PublisherState.cursors} carries no entry of its own for it — a keyword
   * newly added to `HARVEST_KEYWORDS`, or a file written before `cursors`
   * existed. Optional, and absent means zero rather than malformed.
   *
   * A rotation exists at all because the budget is a PREFIX, not a sample.
   * {@link probeOrder} walks the sorted vocabulary and stops at {@link
   * PUBLISHER_PROBE_BUDGET_DEFAULT}, so with no rotation the same first N are
   * probed on every run and everything sorted after them is never probed at
   * all — deterministic starvation rather than a partial run, and invisible
   * because a name that is never probed cannot be reported missing.
   *
   * {@link serializePublisherState} writes this as the MINIMUM over `cursors`,
   * so it names the least-advanced position any keyword holds. That is the
   * conservative seed in both directions: a keyword joining the harvest starts
   * where the vocabulary is least covered, and a reader predating `cursors`
   * resumes behind every keyword rather than ahead of one — re-probing a band
   * rather than skipping it.
   */
  readonly cursor?: number
  /**
   * Where each harvest keyword's rotation starts next run, as an index into
   * `publishers`.
   *
   * PER KEYWORD for the same reason `pinned` is, and it is the same argument:
   * {@link probeOrder} leaves a keyword's rotation `budget - |pinned[K]|`
   * slots, so two keywords with different pinned sets walk different distances
   * in one run. One shared cursor must advance by ONE of those distances and
   * is wrong for the other keyword either way — advance by the larger and the
   * more-pinned keyword skips a band every run, which at a vocabulary
   * commensurate with the advance is the SAME band forever (at 4,000
   * publishers, a 500 budget and 250 pins, half the vocabulary is never
   * reached); advance by the smaller and the other keyword re-probes ground it
   * already covered. A cursor of its own lets each keyword complete its own
   * lap, and the keyword the axis exists for is precisely the one that
   * accumulates the most pins.
   *
   * Optional because a file written before this existed carries none, and
   * absent means "seed every keyword from `cursor`" rather than malformed.
   */
  readonly cursors?: Readonly<Record<string, number>>
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
  // `Object.create(null)` on this path too, not a `{}` literal. The comment on
  // DANGEROUS_KEYWORD_KEYS rests its whole safety argument on every `pinned`
  // map in this file being built that way, and THIS is the path today's
  // committed file takes — it carries no `pinned` key at all. A plain object
  // here put `Object.prototype` back on the chain for the one map that reaches
  // production, where `probeOrder`'s `state.pinned?.['toString'] ?? []` returns
  // a function, the fallback never fires, and the spread throws
  // "pinnedAll is not iterable" as a raw, unfiled TypeError.
  if (pinned === undefined) return Object.create(null)
  if (typeof pinned !== 'object' || pinned === null || Array.isArray(pinned)) {
    throw new Error('publisher-state.json: pinned must be an object')
  }
  const keywords = Object.keys(pinned).sort(compareStrings)
  // Both halves of the bound, as every other list this module reads carries
  // both: MAX_PINNED_PER_KEYWORD caps the names under one key and this caps
  // the keys. Without it nothing bounded the map's width at all — a key, once
  // written, round-trips forever (see `retainPinned`, which is what prunes a
  // key the harvest no longer uses), so an unbounded count is an unbounded
  // committed file. Throws rather than truncating because the only writer is
  // `pinFor`, which cannot produce a key `retainPinned` has not kept: a file
  // over this bound was hand-edited or badly merged, and silently dropping
  // keys would discard real pins under the name of a repair.
  if (keywords.length > MAX_PINNED_KEYWORDS) {
    throw new Error(`publisher-state.json: pinned names ${keywords.length} keywords, more than the ${MAX_PINNED_KEYWORDS} this harvest can have`)
  }
  const out: Record<string, string[]> = Object.create(null)
  for (const keyword of keywords) {
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
    // Dropped, not kept: `pinFor` and `unpinFor` both delete a keyword whose
    // list empties, because `serializePublisherState` copies every existing
    // key forward and an empty entry once written round-trips forever. The
    // parser was the one path that did not hold to that, so a hand edit or a
    // bad merge re-introduced exactly what the writers exist to prevent — and
    // self-healing reaches it only for a keyword some axis report names, since
    // the writers are called per report keyword.
    if (kept.size > 0) out[keyword] = [...kept].sort(compareStrings)
  }
  return out
}

/**
 * Bound on how many keywords the pinned map may carry.
 *
 * `HARVEST_KEYWORDS` holds two, and a rename or an addition is a code change,
 * so this is a defensive ceiling on a committed file rather than a measured
 * tail. It is deliberately loose: the point is that the map cannot grow
 * without bound, not that it matches today's harvest exactly — `retainPinned`
 * is what holds it to the keywords actually in use.
 */
export const MAX_PINNED_KEYWORDS = 16

/** A non-negative integer index, or a throw naming the field. */
function readCursorValue(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    // Stops the run rather than silently restarting the rotation at zero. A
    // reset looks like nothing at all from the outside, and what it costs is
    // the tail of the vocabulary never being probed again.
    throw new Error(`publisher-state.json: ${field} must be a non-negative integer`)
  }
  return value
}

/**
 * Parse the per-keyword cursor map, held to the same key grammar as `pinned`
 * and the same value rule as the legacy `cursor`.
 */
function readCursors(parsed: unknown): Record<string, number> {
  const cursors = (parsed as { cursors?: unknown }).cursors
  if (cursors === undefined) return Object.create(null)
  if (typeof cursors !== 'object' || cursors === null || Array.isArray(cursors)) {
    throw new Error('publisher-state.json: cursors must be an object')
  }
  const keywords = Object.keys(cursors).sort(compareStrings)
  if (keywords.length > MAX_PINNED_KEYWORDS) {
    throw new Error(`publisher-state.json: cursors names ${keywords.length} keywords, more than the ${MAX_PINNED_KEYWORDS} this harvest can have`)
  }
  const out: Record<string, number> = Object.create(null)
  for (const keyword of keywords) {
    if (!isPinnableKeyword(keyword)) {
      throw new Error(`publisher-state.json: cursors key ${JSON.stringify(keyword)} is not a valid harvest keyword`)
    }
    out[keyword] = readCursorValue((cursors as Record<string, unknown>)[keyword], `cursors[${JSON.stringify(keyword)}]`)
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
  return {
    publishers: [...out].sort(compareStrings),
    cursor: cursor === undefined ? 0 : readCursorValue(cursor, 'cursor'),
    cursors: readCursors(parsed),
    pinned: readPinned(parsed),
  }
}

/** Serialize, sorted by code unit and newline-terminated. */
export function serializePublisherState(state: PublisherState): string {
  const publishers = [...state.publishers].sort(compareStrings)
  // Null-prototype for the same reason as `readPinned`, `pinFor` and
  // `unpinFor`: this loop assigns `pinned[keyword]` for every own key of
  // `state.pinned`, so on a plain object a `__proto__` key would set the
  // prototype instead of an entry and vanish from the written file — a silent
  // drop in the one function that decides what gets committed. Unreachable
  // today, because every producer of a `PublisherState` refuses that key at
  // its own boundary; this is the fourth builder of the same map and there is
  // no reason for it to be the one that relies on its callers. Nothing
  // downstream notices: `JSON.stringify` serializes a null-prototype object
  // identically, and the file round-trips byte-equal.
  const pinned: Record<string, string[]> = Object.create(null)
  for (const keyword of Object.keys(state.pinned ?? {}).sort(compareStrings)) {
    pinned[keyword] = [...(state.pinned?.[keyword] ?? [])].sort(compareStrings)
  }
  // Same construction and the same reason, for the same class of key.
  const cursors: Record<string, number> = Object.create(null)
  const positions: number[] = []
  for (const keyword of Object.keys(state.cursors ?? {}).sort(compareStrings)) {
    const position = state.cursors?.[keyword] ?? 0
    cursors[keyword] = position
    positions.push(position)
  }
  // The legacy single cursor, derived rather than carried: the MINIMUM over
  // the per-keyword positions, which is the only value that cannot put a
  // reader AHEAD of a keyword's own lap. See {@link PublisherState.cursor}.
  const cursor = positions.length === 0 ? state.cursor ?? 0 : Math.min(...positions)
  return `${JSON.stringify({ publishers, cursor, cursors, pinned }, null, 2)}\n`
}

/** Where `keyword`'s rotation starts this run — its own position, or the seed. */
export function cursorFor(state: PublisherState, keyword: string): number {
  return state.cursors?.[keyword] ?? state.cursor ?? 0
}

/**
 * The state with `keyword`'s rotation advanced past the band it just walked.
 *
 * `stepped` is vocabulary POSITIONS examined, which {@link probeOrder} returns
 * and which is neither the budget nor the rotation length:
 *
 * - Not the budget. Pinned probes do not advance a rotation — they are probed
 *   every run by definition — so counting them would step past `pinned.length`
 *   publishers per snapshot, permanently and silently.
 * - Not `rotated.length` either. The walk SKIPS a candidate already in the
 *   pinned set, so it consumes a position without returning one; advancing by
 *   the shorter figure restarts the next run inside the band this one already
 *   covered, re-probing it. At the 250-pin bound over a 3,775-name vocabulary
 *   that is ~16 wasted probes a run and a correspondingly longer lap.
 *
 * Advancing by exactly what was walked also restores the no-churn property for
 * free: a run that walked the whole vocabulary has `stepped === size`, and
 * `(cursor + size) % size` is `cursor`, so a budget at or above the vocabulary
 * leaves the committed file untouched instead of rewriting it daily for a
 * rotation that is already covering everything.
 *
 * A run that walked nothing — no axis record, a keyword that did not
 * partition — leaves the position where it was rather than snapping to zero.
 */
export function advanceCursor(state: PublisherState, keyword: string, stepped: number): PublisherState {
  if (!isPinnableKeyword(keyword)) {
    throw new Error(`publisher-state.json: advanceCursor keyword ${JSON.stringify(keyword)} is not a valid harvest keyword`)
  }
  const size = state.publishers.length
  const cursors: Record<string, number> = Object.create(null)
  for (const key of Object.keys(state.cursors ?? {})) cursors[key] = state.cursors?.[key] ?? 0
  // Clamped to the vocabulary, because `probeOrder`'s walk stops at
  // `stepped < size` and so can never report more: a larger figure reaches
  // here only from a `--harvest-from` handoff, which is untrusted and which
  // `parsePublisherAxisReport` can only check for integer-ness — it does not
  // know the vocabulary. Clamping lands the cursor exactly where it started
  // (a full lap), which is the one reading of "walked further than there is
  // to walk" that skips nobody.
  const walked = Math.min(stepped, size)
  cursors[keyword] = size === 0 || walked <= 0 ? cursorFor(state, keyword) : (cursorFor(state, keyword) + walked) % size
  return { ...state, cursors }
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
  // The cursors and pinned map ride through: a merge grows the vocabulary, it
  // does not restart a rotation or disturb the pinned map. Advancing a cursor
  // is `advanceCursor`'s job and the caller's decision, because only the
  // caller knows how far the run actually walked.
  //
  // Rebuilt with `Object.create(null)` rather than passed through with `?? {}`.
  // A plain-object fallback made this the one builder in the file that could
  // hand `probeOrder` a map with `Object.prototype` on its chain — and it is
  // on the live path, because `build.ts` seeds from `{ publishers: [] }`
  // whenever `publisher-state.json` is absent.
  const pinned: Record<string, string[]> = Object.create(null)
  for (const key of Object.keys(state.pinned ?? {})) pinned[key] = [...(state.pinned?.[key] ?? [])]
  const cursors: Record<string, number> = Object.create(null)
  for (const key of Object.keys(state.cursors ?? {})) cursors[key] = state.cursors?.[key] ?? 0
  return {
    publishers: [...kept].sort(compareStrings).slice(0, MAX_PUBLISHERS),
    cursor: state.cursor ?? 0,
    cursors,
    pinned,
  }
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
 * Half {@link PUBLISHER_PROBE_BUDGET_DEFAULT}. The "rotation always keeps half
 * a run" guarantee is NOT this constant's job — {@link probeOrder} caps the
 * pinned half at `⌊budget/2⌋` itself, so the property holds at every budget
 * rather than only at the shipped pair. What the relation still buys is that
 * everything STORED can also be probed: a bound above half the budget would
 * let a pinned set grow a tail that `probeOrder` never reaches, pinned in name
 * only. Written as a literal rather than imported from `npm-client.ts`, which
 * would make this pure module depend on the shell; `publisher-state.test.ts`
 * asserts the relation instead.
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
  // The `break` above is what stops this call GROWING a set past the bound —
  // the size is tested before every `add`, and re-adding a name already
  // present does not raise it. What the slice covers is the other case: a
  // state handed in ALREADY over the bound, which `readPinned` accepts because
  // the alternative is a committed file no build can read. It shrinks such a
  // state to the alphabetically-first MAX_PINNED_PER_KEYWORD, which is a
  // repair and not a selection — the only writer is this function, so an
  // over-bound input was hand-edited, badly merged, or written before the
  // bound was lowered.
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
 * The state with every `pinned` and `cursors` key outside `keywords` dropped.
 *
 * Both maps are keyed by harvest keyword and every writer copies each existing
 * key forward, so a key written once — by a `HARVEST_KEYWORDS` entry that was
 * later renamed or removed, or by a `--harvest-from` handoff naming a keyword
 * this build does not harvest — round-trips into the committed file forever.
 * Nothing probes it, nothing can evict it (eviction only names a maintainer
 * the run PROBED), and nothing reports it: it simply accumulates in a
 * daily-committed artifact. The caller passes the keywords it actually
 * harvests, which is the only place that list is known.
 */
export function retainPinned(state: PublisherState, keywords: readonly string[]): PublisherState {
  const keep = new Set(keywords)
  const pinned: Record<string, string[]> = Object.create(null)
  for (const key of Object.keys(state.pinned ?? {})) {
    if (keep.has(key)) pinned[key] = [...(state.pinned?.[key] ?? [])]
  }
  const cursors: Record<string, number> = Object.create(null)
  for (const key of Object.keys(state.cursors ?? {})) {
    if (keep.has(key)) cursors[key] = state.cursors?.[key] ?? 0
  }
  return { ...state, cursors, pinned }
}

/**
 * How many pins one run may remove.
 *
 * A pinned cell answering zero is confirmed by a second probe before it is
 * reported at all, which covers a transient answer on ONE cell. It cannot
 * cover a correlated one: a search index degraded for a whole class of query
 * answers zero twice as readily as once, and the second probe lands
 * milliseconds after the first. What distinguishes the two is the COUNT —
 * pinned owners unpublish one at a time, and the set grows by roughly one
 * owner a day, so a run reporting many at once is describing the registry and
 * not the ecosystem.
 *
 * Over the cap `applyAxisReport` removes nothing and says so. The asymmetry is
 * deliberate and design doc §3 states it: a stale pin costs one probe per run,
 * a wrong eviction costs the crossing — for a keyword past the window, an
 * evicted owner's names sit past `SEARCH_WINDOW`, so the sweep can never put
 * them back into the harvest and seeding can never name that owner again.
 *
 * 8 rather than a measured figure: nothing has ever evicted in production, and
 * the number that matters is only that it is far below a pinned set's size and
 * far above a day's genuine churn.
 */
export const MAX_EVICTIONS_PER_RUN = 8

/**
 * What one keyword's publisher axis did in one run, reduced to the fields that
 * decide a WRITE. `npm-client.ts`'s `PublisherAxisReport` extends this with the
 * counters that are only ever printed.
 */
export interface AxisOutcome {
  readonly keyword: string
  /**
   * Whether `seeded` is the keyword's WHOLE at-risk owner set, which is what
   * licenses this run to remove a pin that `seeded` does not name.
   *
   * True only when the keyword enumerated whole AND inside its window: every
   * name it has was paged, so a pin `seeded` omits has stopped being at risk
   * (an unpublish, or a package that gained a refinement keyword). It is false
   * past the window — there `seeded` is only what the window sweep showed, and
   * the owners this axis exists for are precisely the ones it cannot show —
   * and false on a tolerated shortfall, where a handful of names went unseen
   * and one of them may be a pinned owner's only at-risk package. That
   * shortfall case is why this is not simply `!partitioned`: the cost of
   * getting it wrong is a pin missing on the day the keyword crosses, which is
   * the one day this whole mechanism exists for.
   */
  readonly seedingComplete: boolean
  /** At-risk owners observed this run, for the caller to pin. */
  readonly seeded: readonly string[]
  /** Pinned maintainers evicted this run: their cell answered zero. */
  readonly evicted: readonly string[]
  /** Vocabulary positions the rotation walked — see {@link advanceCursor}. */
  readonly stepped: number
}

/**
 * The committed state after one keyword's axis report: evictions applied,
 * seeds pinned, cursor advanced. The whole per-report transition, in the pure
 * module, because every step of it is a policy decision.
 *
 * ORDER: evict, then pin. The reverse loses a maintainer that both lists name
 * — `seeded`'s `atRiskOwners` half reads this run's own harvest, so it can
 * name a maintainer whose `maintainer:` probe answered zero (a lagging search
 * index, a rename, a scoped package whose `maintainers` array and the
 * `maintainer:` qualifier disagree). Pinning first lets the probe win over
 * direct evidence, and because `atRiskOwners` is recomputed from scratch every
 * run the two then alternate forever: pinned on odd runs, evicted on even
 * ones, a diff in the committed file every other day and the maintainer's cell
 * probed on only half of all runs. Evicting first lets the harvest win, which
 * is the evidence that cannot be a transient index answer. It also lets a
 * freed slot be reused in the SAME run: at the bound, pinning first refuses
 * new residue owners while dead pins still hold the set.
 *
 * `refused` is what `pinFor` could not take because the set is at {@link
 * MAX_PINNED_PER_KEYWORD} — returned rather than inferred later, because the
 * caller's report is built before this runs and a bound reported from the
 * PRIOR set names the failure one run after it first happened, without ever
 * naming how many owners it cost.
 */
export function applyAxisReport(
  state: PublisherState, outcome: AxisOutcome,
): { state: PublisherState; refused: string[]; evictionsRefused: number } {
  // All or nothing, and nothing past the cap: half a suspect eviction list is
  // no safer than all of it, and applying the first 8 of 200 would turn a
  // registry fault into a silent partial one. Enforced here rather than where
  // the probes run, because `evicted` also arrives from an untrusted
  // `--harvest-from` handoff that never probed anything at all.
  const evicted = outcome.evicted.length > MAX_EVICTIONS_PER_RUN ? [] : outcome.evicted
  const evictionsRefused = outcome.evicted.length > MAX_EVICTIONS_PER_RUN ? outcome.evicted.length : 0
  const keep = new Set(outcome.seeded)
  // With complete seeding a pin `seeded` does not name is an owner that has
  // stopped being at risk. Without this second exit the pinned set of a
  // keyword that has not yet crossed is MONOTONE: entry runs every run, while
  // the probe exit is `selectPublisherCells`'s alone and that only runs once
  // the keyword partitions. It would climb to the bound and then report itself
  // FULL about a set nothing had ever probed.
  const stale = outcome.seedingComplete
    ? [...evicted, ...(state.pinned?.[outcome.keyword] ?? []).filter(user => !keep.has(user))]
    : evicted
  let next = unpinFor(state, outcome.keyword, stale)
  next = pinFor(next, outcome.keyword, outcome.seeded)
  const pinnedNow = new Set(next.pinned?.[outcome.keyword] ?? [])
  // Only names the bound could have taken: one outside the grammar was never a
  // candidate, and reporting it as refused would send a reader looking for a
  // full set that is not there.
  const refused = outcome.seeded.filter(user => isMaintainerName(user) && !pinnedNow.has(user))
  return { state: advanceCursor(next, outcome.keyword, outcome.stepped), refused, evictionsRefused }
}

/**
 * The smallest allocation a keyword that partitions may receive.
 *
 * A POLICY FLOOR, not a measured optimum, and said so rather than dressed up.
 * What IS measured is what it costs and what it prevents.
 *
 * Costs: against the 3,887-name vocabulary committed 2026-09-19, a keyword
 * held at this floor walks its rotation in 39 runs — five and a half weeks at
 * the daily cadence, against the 14-run cycle
 * {@link PUBLISHER_PROBE_BUDGET_DEFAULT}'s comment sized for a keyword under
 * pressure. That is the right order for a keyword with nothing at risk, and
 * the wrong one for a keyword carrying a residual; which of the two it is
 * gets re-measured every run, and its share moves with the answer.
 *
 * Prevents: a per-keyword standing start. Only the rotation can seed a
 * keyword's FIRST pin, a pinned set accumulates across runs, and a purely
 * proportional split rounds the smallest tail toward nothing — so without a
 * floor the keyword with the least tail is the one permanently unable to
 * build the pinned set that keeps its tail small. That is the trap
 * `MAX_UNREACHABLE_RESIDUAL`'s comment records for the whole axis ("cannot
 * work from a standing start"), reproduced one keyword at a time.
 *
 * At the 2026-09-19 measurement the floors are 100 for `dsh-plugin` (whose 45
 * pins ask only 90) and 456 for `deepseek-harness` (228 pins), and neither is
 * what its keyword finally receives — 171 and 829 — because the proportional
 * remainder is added on top of the floor, not compared against it.
 */
export const MIN_PROBE_BUDGET_PER_KEYWORD = 100

/** One keyword's claim on a run's publisher probes. */
export interface ProbeDemand {
  /** The harvest keyword. */
  readonly keyword: string
  /**
   * Names this keyword's answered total puts PAST the search window. Zero
   * means it does not partition, so it spends no probes and adds nothing to
   * the pool. A count rather than the total, so this pure module needs no
   * window constant from the impure one that owns the search.
   */
  readonly tail: number
}

/**
 * Split `amount` whole probes across `weights`, largest remainder first.
 *
 * Integer throughout — `Math.floor((amount * weight) / total)` and the exact
 * `%` remainder beside it — so the shares sum to `amount` with no float drift
 * and two runs over the same measurements allocate identically. Ties break on
 * the caller's own ordering, which is the only tie-break available that does
 * not depend on a locale.
 */
function shareOut(weights: readonly number[], amount: number): number[] {
  if (weights.length === 0) return []
  if (amount <= 0) return weights.map(() => 0)
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const parts = weights.map((weight, index) => (total > 0
    ? { index, share: Math.floor((amount * weight) / total), remainder: (amount * weight) % total }
    // Nothing to go by. An even split rather than a throw: a caller reaching
    // here has already decided every claimant is entitled to something.
    : { index, share: Math.floor(amount / weights.length), remainder: 0 }))
  let left = amount - parts.reduce((sum, part) => sum + part.share, 0)
  for (const part of [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (left <= 0) break
    part.share += 1
    left -= 1
  }
  return parts.map(part => part.share)
}

/**
 * Split one run's publisher probes across the harvest keywords by demand.
 *
 * WHAT THIS REPLACED, and the measurement that condemned it: every keyword
 * that partitioned was handed {@link PUBLISHER_PROBE_BUDGET_DEFAULT}
 * outright. The 2026-09-19 published report records what one such run bought:
 *
 * | keyword          |  tail | residual | pinned probes | rotation probes |
 * | ---------------- | ----: | -------: | ------------: | --------------: |
 * | dsh-plugin       |   376 |        1 |     45 -> 0   |      455 -> 0   |
 * | deepseek-harness | 1,969 |       15 |    228 -> 13  |      272 -> 0   |
 *
 * So half the run's probes — about nine minutes of wall clock — went to the
 * keyword that was ONE name short and recovered nothing, while the keyword
 * sitting at 15 of the 20 names `MAX_UNREACHABLE_RESIDUAL` allows took the
 * SMALLER rotation. Not merely flat: anti-correlated with demand, because
 * {@link probeOrder} caps the pinned half at half the budget and gives the
 * remainder to the rotation, so a small pinned set is rewarded with a large
 * rotation share.
 *
 * THE POOL IS THE OLD SPEND, exactly — `perKeywordBudget` times the keywords
 * that partition. This is a redistribution and never a raise: one crossing
 * keyword is allocated precisely what the flat rule gave it, and the
 * per-run request arithmetic in `PUBLISHER_PROBE_BUDGET_DEFAULT`'s comment
 * still holds unchanged. Buying coverage with more requests is a different
 * decision from spending the same requests better, and only the first one
 * needs the rate limit re-measured.
 *
 * DEMAND IS THE TAIL, NOT THE RESIDUAL, though the residual is what the
 * probes are aimed at. In order of weight:
 *  - the residual is known only AFTER the cells page, and the allocation is
 *    decided before the first probe;
 *  - it is a small integer that reaches zero, so a share keyed to it would
 *    stop a keyword's rotation dead on the run after a clean one — which is
 *    the run its tail grew;
 *  - the tail is measured before any probe, is thousands of names wide and
 *    moves smoothly. Loose as a proxy but not wrong: on 2026-09-19 the tail
 *    per missing name was 376 and 131, within a factor of 2.9, and the two
 *    orderings agree on which keyword needs the probes.
 *
 * TWO FLOORS, each answering a way a bare proportional split fails:
 *  - twice the pinned set, so `probeOrder`'s `floor(budget / 2)` cap can
 *    still reach every pin. An unprobed pin supplies nothing AND is never
 *    evicted, so starving the pinned half raises the very residual this
 *    exists to lower — and that half is the productive one: 13 of 13
 *    recoveries on the run above. Written against `probeOrder`'s own rule
 *    rather than against `MAX_PINNED_PER_KEYWORD`, so the two cannot drift.
 *  - {@link MIN_PROBE_BUDGET_PER_KEYWORD}, so a keyword with no pins can
 *    still seed its first.
 * When the floors alone exceed the pool, the pool wins and is split in their
 * proportion: this is a CAP before it is an allocation. The rule that forgot
 * that spent 57m37s on 3,474 sequential probes and threw.
 *
 * @param state - the committed axis state, read for the pinned sets alone and
 *   read from the same place `probeOrder` reads them.
 * @param demands - one entry per harvest keyword, in the caller's order.
 * @param perKeywordBudget - the pool's per-keyword term.
 * @returns keyword to whole probes, summing to the pool. A keyword with no
 *   tail maps to 0 rather than going absent, so a caller reading one back
 *   cannot mistake "allocated nothing" for "not a harvest keyword".
 */
export function allocateProbeBudgets(
  state: PublisherState, demands: readonly ProbeDemand[], perKeywordBudget: number,
): Readonly<Record<string, number>> {
  const out: Record<string, number> = Object.create(null)
  for (const demand of demands) out[demand.keyword] = 0
  const live = demands.filter(demand => Number.isFinite(demand.tail) && demand.tail > 0)
  const perKeyword = Number.isFinite(perKeywordBudget) ? Math.floor(perKeywordBudget) : 0
  const pool = Math.max(0, perKeyword) * live.length
  if (pool === 0) return out
  // `Array.isArray` rather than `?.length`: a state built from a plain object
  // literal instead of `parsePublisherState` answers `Object.prototype` for a
  // keyword named `toString`, and a function has a `length` of its own.
  const claims = live.map(demand => {
    const pinned = state.pinned?.[demand.keyword]
    const floor = Math.max(
      2 * (Array.isArray(pinned) ? pinned.length : 0), MIN_PROBE_BUDGET_PER_KEYWORD)
    return { keyword: demand.keyword, tail: demand.tail, floor: Math.min(pool, floor) }
  })
  const floorTotal = claims.reduce((sum, claim) => sum + claim.floor, 0)
  const capped = floorTotal >= pool
  const shares = capped
    ? shareOut(claims.map(claim => claim.floor), pool)
    : shareOut(claims.map(claim => claim.tail), pool - floorTotal)
  claims.forEach((claim, index) => {
    out[claim.keyword] = (capped ? 0 : claim.floor) + (shares[index] ?? 0)
  })
  return out
}

/**
 * Which publishers this run probes for `keyword`, in order.
 *
 * Pinned first and always; the rotation spends what is left of the budget,
 * starting at this keyword's own cursor and skipping anyone already pinned —
 * probing one publisher twice in a run would spend budget to learn nothing.
 *
 * `stepped` is what the caller advances the cursor by: vocabulary POSITIONS
 * walked, which is neither the budget nor `rotated.length`. See {@link
 * advanceCursor}, which owns that argument.
 *
 * The pinned half is capped at HALF THE BUDGET rather than at {@link
 * MAX_PINNED_PER_KEYWORD}, so "rotation always keeps the other half" is a
 * property of this function instead of a coincidence between two constants
 * declared in different modules. The two coincided exactly (250 of 500) while
 * every keyword was handed a flat budget; a keyword allocated 829 has a cap
 * of 414 that `MAX_PINNED_PER_KEYWORD` reaches first. Below the pair — a
 * reduced-cost run, a rate-limit backoff, a future override — the old form
 * let the pinned set take the whole budget, leaving `rotated` empty and the
 * cursor frozen, which is the starvation the cursor exists to prevent.
 *
 * A BUDGET FROM {@link allocateProbeBudgets} NEVER TRUNCATES THE PINNED SET,
 * and that is by construction rather than by luck: its floor is twice the
 * pinned count precisely so this cap clears it. The two rules live in
 * different functions and `publisher-state.test.ts` pins the invariant
 * itself, not only the arithmetic on either side of it.
 */
export function probeOrder(
  state: PublisherState, keyword: string, budget: number,
): { pinned: string[]; rotated: string[]; stepped: number } {
  if (budget <= 0) return { pinned: [], rotated: [], stepped: 0 }
  const pinnedAll = state.pinned?.[keyword] ?? []
  const pinned = [...pinnedAll].slice(0, Math.floor(budget / 2))
  const size = state.publishers.length
  // AFTER the pinned slice, not before it. A pin is not a member of the
  // vocabulary — `probeOrder` reads it from `state.pinned`, and a pinned
  // maintainer survives `mergePublishers`'s MAX_PUBLISHERS truncation — so an
  // empty vocabulary is a reason to rotate to nobody, never a reason to stop
  // probing the pinned set. Returning early above it stranded the pins:
  // never probed, so never supplied and never evicted, with the axis line
  // reading as an ordinary empty-vocabulary no-op.
  if (size === 0) return { pinned, rotated: [], stepped: 0 }
  const already = new Set(pinned)
  const rotated: string[] = []
  const start = cursorFor(state, keyword) % size
  let stepped = 0
  while (pinned.length + rotated.length < budget && stepped < size) {
    const candidate = state.publishers[(start + stepped) % size]
    stepped++
    if (candidate === undefined || already.has(candidate)) continue
    already.add(candidate)
    rotated.push(candidate)
  }
  return { pinned, rotated, stepped }
}
