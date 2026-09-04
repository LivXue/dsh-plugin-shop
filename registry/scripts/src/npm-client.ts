import { readCappedBody } from './http-body.ts'
import type { Candidate, Rejection } from './types.ts'

/**
 * The keywords a plugin author declares. Ecosystem-neutral by design: an
 * author declares "I am a dsh plugin" (or "I integrate with
 * deepseek-harness"), not membership of this shop. The first entry is the
 * primary keyword; the rest widen the net for authors who tag their package
 * by the harness it plugs into rather than the plugin ecosystem's own tag.
 */
export const HARVEST_KEYWORDS: readonly string[] = ['dsh-plugin', 'deepseek-harness']

const REGISTRY = 'https://registry.npmjs.org'
const PAGE_SIZE = 250

/**
 * The largest `from` the npm search API honors. A `from` past it silently
 * returns page 0 rather than an error — measured 2026-09-03:
 * `keywords:deepseek-harness&size=250&from=5000` returned the 95-name tail of
 * a 5,095-name result set, and `from=5001` returned the same 250 objects as
 * `from=0`. `size` is capped at 250 (a `size=1000` request returned 250), so
 * the window cannot be widened from the caller's side either.
 */
export const MAX_SEARCH_FROM = 5000

/**
 * How many names ONE search query can enumerate: the last reachable page plus
 * its size. Past it the registry has no way to serve the tail, so the harvest
 * must partition the query rather than page into the wrap. Harvesting a subset
 * would be indistinguishable from an ecosystem that shrank.
 */
export const SEARCH_WINDOW = MAX_SEARCH_FROM + PAGE_SIZE

/**
 * The largest per-keyword shortfall the harvest publishes through rather than
 * refusing.
 *
 * The coverage check below already absorbs churn two ways — `Math.min` of the
 * totals probed before and after, and one full re-page — and neither can close
 * the case this bound exists for: npm answering a `total` it cannot serve. On
 * 2026-09-04 `main`'s daily build died on `enumerated 3746 of 3747`, one name,
 * with both probes answering 3747 and the second pass finding the same 3746.
 * This module's own comment names the mechanism ("Same for a `total` npm
 * overstates by one"), so it is a shortfall no amount of re-reading closes. The
 * scheduled run that hour had passed and the push run failed, which makes it a
 * coin flip per run, and a lost flip freezes the shelf for the day.
 *
 * Why 3, and not a rounder number: two magnitudes for a REAL gap are recorded
 * in this file. A partition gap is "hundreds of names", and PARTITION_KEYWORDS
 * was measured FIFTEEN names short the day after it was documented as
 * complete. A bound at or above 15 would have absorbed that one silently. 3
 * covers what it is for — an overstated total, a page serving 249 objects of
 * 250 — and stops well short of anything this repo has seen go genuinely
 * wrong.
 *
 * A tolerated shortfall is never silent: {@link searchByKeywords} reports it to
 * its caller, because nothing here can name the missing package — that is the
 * whole difficulty — so the count is the honest thing to publish.
 */
export const MAX_SEARCH_SHORTFALL = 3

/** One keyword that enumerated fewer names than its own total promised. */
export interface KeywordShortfall {
  keyword: string
  enumerated: number
  required: number
}

/**
 * Refinement keywords the harvest ANDs onto an over-window keyword to split it
 * into reachable cells, most-covering first.
 *
 * `keywords:a,b` is an INTERSECTION on `/-/v1/search`, and it is the ONLY
 * filtering qualifier the API honors. Probed 2026-09-03 against
 * `keywords:deepseek-harness` (total 5,103): `scope:`, `author:`,
 * `maintainer:`, `not:unstable`, `is:unstable`, and the
 * `quality`/`popularity`/`maintenance` weights each left both the total and
 * the first page unchanged — none of them can split or re-slice the window.
 * A bare text term (`keywords:deepseek-harness memory`) leaves the total
 * unchanged too, but re-ranks the page: only 138 of 250 names match at rank
 * 2,500 against the untermed query. It still cannot widen the reachable
 * window — the *tail* is score-stable (`from=5000` returns identical names
 * under three different terms), so a text term re-ranks the head but never
 * moves a name into the reachable window.
 *
 * TWO KINDS OF NUMBER FOLLOW, and they must never be summed together. Printing
 * them as one list, and then adding four of the second kind up, is how a
 * partition fifteen names short came to be documented as covering.
 *
 * (i) Measured CELL TOTALS, `keywords:deepseek-harness,<refinement>` — how big
 * a cell is. Dated per entry, because they were not all measured on one day:
 * an entry marked * was re-measured 2026-09-04 against that keyword's 5,132,
 * and the rest were measured 2026-09-03 against its 5,103.
 * `dsh` 4,255, `dsh-plugin` 3,178, `plugin` 1,604, `cordis`* 1,279,
 * `deepseek` 949, `agent` 498, `mcp` 213, `codex`* 155, `claude-code`* 110,
 * `cli` 72, `desktop-pet`* 50, `harness` 41, `claude` 35, `ai` 31, `tool` 29.
 *
 * (ii) Measured MARGINAL CONTRIBUTIONS to the union, 2026-09-03 — how many
 * names a cell adds that the cells before it did not already have:
 * `cordis` 20, `codex` 10, `claude-code` 10, `desktop-pet` 7. These four are
 * a hundredth of their own cell totals, and the previous round of this
 * comment printed them in the list above as if they were totals, then summed
 * them across four OVERLAPPING sets (20+10+10+7 = 47 against a 44-name gap)
 * and concluded coverage from the sum. A marginal contribution is valid only
 * against one fixed set of preceding cells; four of them add to nothing.
 *
 * WHAT THE CELLS REACHED, paged live 2026-09-04, before the additions below:
 * the fourteen entries this constant shipped with that morning yield thirteen
 * cells against `keywords:deepseek-harness` — fourteen ENTRIES, thirteen
 * cells, because a keyword is never ANDed onto itself (see {@link
 * partitionKeyword}'s self-skip) — and those thirteen enumerated 5,117 of
 * that keyword's 5,132. Fifteen short, not zero.
 *
 * The twelve entries added 2026-09-04 are a greedy minimum cover over exactly
 * those fifteen names, so each line below is a refinement and the uncovered
 * names it brings in — NOT a cell total, and not summable with anything:
 *   hesi -> hesi-dsh-plan, hesi-dsh-roundtable
 *   memory -> @agentscope-ai/reme, @cziyi/dsh-mnemosyne
 *   pi-extension -> @demo-0416/pi-trace, pi-turn-metrics
 *   academic-writing -> dsh-plugin-writing-guard
 *   agent-virtualization -> dsh-llm-agent-virtualization
 *   agents -> openswarm
 *   ai-review -> dsh-spec-collab
 *   approval -> @mangobsh/dsh-approval-notify
 *   client-plugin -> dsh-client-ui-writing
 *   embedding -> dsh-tool-writing
 *   remote -> dsh-writing-remote
 *   statistics -> @chengwd96/dsh-usage-analytics
 *
 * That is today's gap, and a hand-extended list closes a gap once. The
 * STRUCTURAL half is in {@link searchByKeywords}: it also pages
 * `keywords:<keyword>` itself, `from=0` through `from=`{@link
 * MAX_SEARCH_FROM}, and unions those names in. That cell is deliberately
 * NON-COMPLETING — it stops at the window instead of throwing, the one place
 * in this module where a short enumeration is intended — and it costs 21
 * requests, against the ~57 the thirteen cells cost before the twelve entries
 * above widened that. It takes the refinements out of the picture for every
 * name INSIDE the window, whatever that name is tagged with, and the window is
 * the whole keyword bar its lowest-scoring tail: a keyword at
 * `SEARCH_WINDOW + k` puts exactly k names beyond reach, so one on the day it
 * first crosses, growing with the overshoot. That leaves the refinements responsible only for the
 * tail, and the measurement says that is the half they are good at: the
 * fifteen names they missed ranked 90 to 4,530 (median 2,879) of 5,132, and
 * NOT ONE was in the worst 250. Uncovered-ness does not track score. The
 * bottom of the ranking is template copies carrying the generic tags this
 * list already names; a package a refinement misses carries a niche tag and
 * scores too well to fall out of the window in the first place.
 *
 * So the residual is precise, and it is not zero: a name is missed only if it
 * is BOTH outside the reachable window AND carries no refinement keyword.
 * There is no negation qualifier (`keywords:a,-b` returns total 0), so a
 * cell's complement cannot be expressed and this partition is not covering by
 * construction. {@link searchByKeywords} therefore MEASURES its coverage
 * against the keyword's own total and throws on a shortfall: safe by check,
 * not by construction. The window cell shrinks the residual; it does not
 * retire the check.
 *
 * Two entries above are not what a reader expects. `harness` (41) and `ai`
 * (31) were measured and never shipped. `deepseek-harness` cannot appear in a
 * list measured against `keywords:deepseek-harness` at all: it is here for the
 * OTHER harvest keyword, where `keywords:dsh-plugin,deepseek-harness` is a
 * real cell, and it is skipped as self on this one.
 *
 * None of this has run in production yet: partitioning starts above
 * SEARCH_WINDOW, and on 2026-09-04 `keywords:deepseek-harness` measured 5,132
 * and `keywords:dsh-plugin` 3,731. That leaves 118 names of headroom, growing
 * about thirty a day, so the first crossing is days away and it is what will
 * re-derive every number here. Adding a keyword is the documented response to
 * that throw; a cell is always `keywords:<harvest-keyword>,<refinement>`, so a
 * refinement can only narrow the net a listing sees, never widen it — an
 * addition is a coverage decision, not a policy one.
 */
export const PARTITION_KEYWORDS: readonly string[] = [
  'dsh', 'dsh-plugin', 'deepseek-harness', 'plugin', 'deepseek',
  'agent', 'mcp', 'cli', 'claude', 'tool',
  'cordis', 'codex', 'claude-code', 'desktop-pet',
  'hesi', 'memory', 'pi-extension', 'academic-writing', 'agent-virtualization',
  'agents', 'ai-review', 'approval', 'client-plugin', 'embedding',
  'remote', 'statistics',
]

/** One query's `text` value: the keyword, plus any refinements ANDed on. */
export function keywordQuery(keywords: readonly string[]): string {
  return `keywords:${keywords.join(',')}`
}

/**
 * Split one harvest keyword into queries whose totals each fit
 * {@link SEARCH_WINDOW}.
 * @param keyword - the harvest keyword.
 * @param probe - reads one query's `total`; injected so tests need no network.
 * @returns the cells to page, the keyword's own total, and whether a split
 *   happened (an unsplit keyword needs no coverage check: paging to its
 *   answered total already enumerates all of it).
 * @throws when a cell is past the window and no refinement keyword splits it.
 */
export async function partitionKeyword(
  keyword: string,
  probe: (keywords: readonly string[]) => Promise<number>,
): Promise<{ cells: string[][]; total: number; partitioned: boolean }> {
  const total = await probe([keyword])
  if (total <= SEARCH_WINDOW) return { cells: [[keyword]], total, partitioned: false }
  const cells: string[][] = []
  const oversized: string[][] = []
  for (const refinement of PARTITION_KEYWORDS) {
    // `keywords:X,X` is X: a cell that re-states the keyword partitions
    // nothing, and above the window — the only place this runs — it lands in
    // `oversized` and can throw "no refinement keyword splits it" on a
    // keyword every other cell splits fine. It is also why PARTITION_KEYWORDS
    // yields one fewer cell than it has entries whenever it names the harvest
    // keyword itself, which is what the coverage arithmetic in that constant's
    // comment is counted against.
    if (refinement === keyword) continue
    const cell = [keyword, refinement]
    const cellTotal = await probe(cell)
    if (cellTotal === 0) continue
    if (cellTotal <= SEARCH_WINDOW) cells.push(cell)
    else oversized.push(cell)
  }
  // One intersection, however many oversized cells reach it. If `[k,'dsh']`
  // and `[k,'plugin']` are both over the window, each is split by the other's
  // refinement — and `keywords:k,dsh,plugin` and `keywords:k,plugin,dsh` are
  // the same set of names behind two different `text` values. Names dedupe
  // downstream, so the whole cost is requests: one probe and up to 21 pages
  // for names already enumerated. Keyed on the SORTED tuple and consulted
  // BEFORE the probe, so the duplicate costs nothing at all. An intersection
  // already accepted still counts as a split for the second parent: its names
  // are in `cells` either way, so that parent is exactly as covered.
  const deeper = new Map<string, boolean>()
  for (const cell of oversized) {
    let split = false
    for (const refinement of PARTITION_KEYWORDS) {
      if (cell.includes(refinement)) continue
      const deeperCell = [...cell, refinement]
      const intersection = [...deeperCell].sort().join(',')
      const known = deeper.get(intersection)
      if (known !== undefined) {
        split = split || known
        continue
      }
      const deeperTotal = await probe(deeperCell)
      const usable = deeperTotal !== 0 && deeperTotal <= SEARCH_WINDOW
      deeper.set(intersection, usable)
      if (!usable) continue
      cells.push(deeperCell)
      split = true
    }
    if (!split) {
      throw new Error(
        `npm search for ${keywordQuery(cell)} reports more than the ${SEARCH_WINDOW} names one query can reach (from is capped at ${MAX_SEARCH_FROM}) and no refinement keyword splits it; add one to PARTITION_KEYWORDS`,
      )
    }
  }
  if (cells.length === 0) {
    throw new Error(
      `npm search for ${keywordQuery([keyword])} reports more than the ${SEARCH_WINDOW} names one query can reach (from is capped at ${MAX_SEARCH_FROM}) and no refinement keyword splits it; add one to PARTITION_KEYWORDS`,
    )
  }
  return { cells, total, partitioned: true }
}

/** The two fields the harvest reads off a search response. `objects` admits a
 * null element because JSON does: the registry's shape is not a guarantee. */
/**
 * Byte cap on one search page's JSON body. A page carries `size=250` objects
 * of registry metadata — about 500 KB live — so this is sixteen times the
 * observed size and still refuses a body no search page can legitimately
 * produce.
 */
export const MAX_SEARCH_BODY_BYTES = 8 * 1024 * 1024

/**
 * Byte cap on one packument. Half the tarball reader's 32 MB: a dsh plugin's
 * packument is tens of kilobytes, and the largest packuments on npm at all —
 * thousands of versions of a monolith — sit near this figure, so nothing a
 * plugin author can publish reaches it.
 */
export const MAX_PACKUMENT_BYTES = 16 * 1024 * 1024

/**
 * Read a response body as JSON under a hard byte cap.
 *
 * `response.json()` buffers the whole body before parsing, so an origin can
 * spend the build's memory before any of our code sees a byte — and this
 * module's origin is not always npm: {@link fetchWithFailover} serves a
 * NPM_BACKUP_REGISTRY answer, registry.npmmirror.com by default, whenever the
 * primary throws, stalls or 5xxs. The github half has capped every body it
 * reads since its tarball reader was written; this half capped none of them,
 * across one packument per harvested name.
 *
 * `content-length` is an early refusal and never the measurement: a compressed
 * body's header understates what it decodes to, which is why the count that
 * decides is taken off the bytes as they arrive, inside
 * {@link readCappedBody}.
 *
 * A {@link FetchTimeoutError} from a stalled body is deliberately NOT caught
 * here: a deadline is not a malformed body, and both callers already say so in
 * their own words.
 * @returns the parsed value, or which of the two ways it was unusable — the
 *   callers want different consequences from the same fact.
 */
async function readJsonCapped(
  response: Response,
  cap: number,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: 'too-large' | 'not-json' }> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > cap) return { ok: false, reason: 'too-large' }
  const bytes = await readCappedBody(response, cap)
  if (bytes === null) return { ok: false, reason: 'too-large' }
  // Non-fatal decoding: an invalid sequence becomes U+FFFD rather than
  // throwing, and JSON.parse then reports it as the malformed body it is.
  const text = new TextDecoder().decode(bytes)
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    // The only thing JSON.parse throws is a SyntaxError about this text, which
    // is precisely the 'not-json' the caller is being told about.
    return { ok: false, reason: 'not-json' }
  }
}

interface SearchBody {
  objects?: ({ package?: { name?: unknown } | null } | null)[]
  total?: unknown
}

/**
 * Parse one search response, naming the query on a body that is not JSON.
 * Observed live: page 13 of `keywords:dsh-plugin` answered 200 with
 * `<!doctype html>`, and the bare `SyntaxError` named no keyword.
 */
async function readSearchBody(response: Response, query: string, from: number): Promise<SearchBody> {
  // A deadline is not a malformed body — and this module is where the deadline
  // is built, so a wrong reason here is the one an operator is least likely to
  // doubt. readJsonCapped lets a FetchTimeoutError through untouched.
  const read = await readJsonCapped(response, MAX_SEARCH_BODY_BYTES)
  if (!read.ok) {
    // Over-cap THROWS on this path. An unusable search page is the whole
    // candidate set, and reading it as empty is indistinguishable from an
    // empty ecosystem; an unusable packument is one package, and gets a row.
    throw new Error(read.reason === 'too-large'
      ? `npm search for ${query} at from=${from} answered a body larger than ${MAX_SEARCH_BODY_BYTES} bytes, which no search page can legitimately produce`
      : `npm search for ${query} at from=${from} answered 200 with a body that is not JSON`)
  }
  const parsed = read.value
  // `null` parses without throwing and satisfies the `SearchBody` cast
  // structurally, so the try/catch above never fires and `body.total` in the
  // caller throws `Cannot read properties of null` instead — a bare TypeError
  // naming no keyword, which is the very failure this function exists to
  // prevent. Named here, where the query is still in scope.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`npm search for ${query} at from=${from} answered 200 with a body that is not a search response`)
  }
  return parsed as SearchBody
}

/**
 * One search response's `total`, refused unless it is a count of packages.
 *
 * `typeof total === 'number'` was the whole check, and it admits values that
 * silently disable every guard downstream. A NEGATIVE total makes the coverage
 * floor `min(total, after)` negative, so `forKeyword.size < required` is false
 * however little the harvest found: `{"total": -1, "objects": []}` for both
 * keywords returned an EMPTY name list with a green build — the zero-name
 * harvest with no error that the floor exists to refuse, and the same outcome
 * the backup-registry rule at {@link searchByKeywords} is written against.
 * `Infinity` (which is what `1e999` parses to) and a fractional total are the
 * same class: JSON has no integer type, neither value is a count, and
 * Infinity used to partition every keyword and then blame PARTITION_KEYWORDS
 * for not splitting a cell that never existed.
 * @param stake - what cannot be decided without the number. The two callers
 *   read the same field for different reasons, and each says its own.
 */
function readTotal(body: SearchBody, query: string, from: number, stake: string): number {
  const total = body.total
  if (typeof total !== 'number') {
    throw new Error(`npm search for ${query} at from=${from} answered no total; ${stake}`)
  }
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`npm search for ${query} at from=${from} answered total=${total}, which is not a count of packages; ${stake}`)
  }
  return total
}

/**
 * Read one query's `total` with a single-object request.
 * @throws when the request fails, or {@link readTotal} refuses the answer — a
 *   malformed probe must not read as an empty keyword: {@link
 *   partitionKeyword} and the coverage check in {@link searchByKeywords} both
 *   trust this number, and a silent 0 disables both, as does a negative one.
 */
async function searchTotal(
  keywords: readonly string[],
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  backupRegistry: string | undefined,
  timeoutMs: number,
): Promise<number> {
  const query = keywordQuery(keywords)
  const path = `-/v1/search?text=${encodeURIComponent(query)}&size=1&from=0`
  const response = await fetchWithFailover(path, fetchImpl, sleep, token, backupRegistry, timeoutMs)
  if (!response.ok) throw new Error(`npm search for ${query} failed: ${response.status}`)
  const body = await readSearchBody(response, query, 0)
  return readTotal(body, query, 0, "a keyword's size cannot be measured without it")
}

/**
 * Per-attempt bound on a registry request. A stalled connection fails over
 * to the backup registry instead of hanging the build — the hub's
 * stall-detection borrowing, in its read-only form (the install path still
 * runs through the user's own pnpm and registry config).
 */
const REQUEST_TIMEOUT_MS = 30_000

/** A request that outlived its deadline; a failover trigger. Exported so the
 * other three network modules can classify their own stalls the same way. */
export class FetchTimeoutError extends Error {}

/**
 * The primary registry answered with a 5xx. Carries the status so that once
 * a configured backup has ALSO failed and this becomes the thrown
 * `primaryError`, the catch in {@link fetchCandidate} can report the same
 * "npm registry returned NNN fetching x" phrasing a caller with no backup
 * (or a healthy one) would have seen for the identical status, instead of
 * wrapping it as a generic, invented-sounding transport failure.
 */
class PrimaryStatusError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`npm registry returned ${status}`)
    this.status = status
  }
}

function registryUrl(registry: string, path: string): string {
  return `${registry.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * Wrap a fetch so that `ms` after the request starts, the request is over:
 * the timer aborts the request's own signal, which both rejects the returned
 * promise during the header phase AND errors an in-flight body stream after
 * it. The deadline covers the WHOLE exchange, not the part before the headers.
 *
 * That distinction is the whole point. `fetch` resolves as soon as the
 * response headers arrive, so the timer this used to clear at that moment
 * bounded the header phase alone: a counterpart answering `200 OK` and then
 * stalling its body left the read running against a controller that would
 * never abort. Measured against a real localhost socket — the wrapper resolved
 * at 62ms and the body was still hanging at 1564ms — and undici's own
 * `bodyTimeout` is inactivity-based, so a slow trickle never trips it either.
 * The timer is therefore left ARMED and `unref`'d: unref so a deadline still
 * pending on a finished request cannot hold the process open, armed so the
 * abort actually arrives. Aborting a request that already completed is a
 * no-op, and `Promise.race` keeps a handler on the loser, so a late abort
 * raises no unhandled rejection.
 *
 * One consequence of the unref, noted rather than chased: in a TEST an unref'd
 * timer is the only thing keeping a stalled request alive, so those tests lean
 * on vitest holding the process open. Production is unaffected — undici holds
 * a ref'd socket for the request the deadline is racing.
 *
 * The abort REASON is the {@link FetchTimeoutError} itself, so a deadline that
 * lands mid-body surfaces at the reader as that same error instance rather
 * than an anonymous abort — which is how a caller tells "our deadline fired"
 * apart from "this body is malformed", a distinction {@link readManifest}'s
 * counterpart in github-client.ts depends on to avoid publishing a permanent
 * verdict for a transient stall.
 *
 * Lives here and is exported because npm-client was the ONLY module passing an
 * AbortSignal. Against a socket that accepts and never writes, npm-client
 * rejected after 2s while github-client was still pending at 8s: the only
 * bound anywhere else was undici's 300s headers timeout, after which the
 * GitHub client's own retry ladder ran three more times, so a stalled GitHub
 * or gateway ended in the six-hour Actions kill with no report, no state
 * commit and no catalog. One wrapper reused by four modules, rather than four
 * copies of it, is what keeps the fourth network module from being the one
 * that forgets.
 *
 * A body large enough to be slow on purpose needs a deadline sized for it:
 * see `TARBALL_REQUEST_TIMEOUT_MS` in github-client.ts, the one path here that
 * reads up to 32 MB.
 * @param subject - names the stalled counterpart in the error message.
 */
export function withTimeout(fetchImpl: typeof fetch, ms: number, subject = 'registry'): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController()
    const expiry = new FetchTimeoutError(`${subject} request exceeded ${ms}ms`)
    const timer = setTimeout(() => controller.abort(expiry), ms)
    timer.unref()
    return await Promise.race([
      fetchImpl(input, { ...init, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(expiry), { once: true })
      }),
    ])
  }
}

/**
 * Fetch a registry path with a backup registry absorbing ONLY
 * unavailability: a network throw, a stalled connection (the per-attempt
 * timeout), or a 5xx. A 4xx answer from the primary is authoritative and is
 * returned as-is — a 404 is never re-litigated against a mirror, and an
 * exhausted 429 reports the throttle rather than quietly switching source.
 * When the backup also fails, the primary's failure is what propagates: a
 * mirror's opinion must never masquerade as npm's.
 *
 * The token reaches {@link REGISTRY} and nowhere else. It is an npmjs.org
 * credential; `NPM_BACKUP_REGISTRY` may be any URL, so forwarding it would
 * hand a third party a Bearer token it was never issued. The backup is a
 * read-only public mirror and needs none.
 *
 * An EMPTY backup registry is disabled, not a registry at the filesystem
 * root: `registryUrl('', 'x')` is `/x`, and the documented disable value (an
 * empty string, build.ts) used to die with `Failed to parse URL` on the first
 * primary failure instead of reporting that failure.
 */
async function fetchWithFailover(
  path: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  backupRegistry: string | undefined,
  timeoutMs: number,
): Promise<Response> {
  const timed = withTimeout(fetchImpl, timeoutMs)
  const backup = backupRegistry === undefined || backupRegistry.trim() === '' ? undefined : backupRegistry
  let primary: Response | null = null
  let primaryError: unknown = undefined
  try {
    primary = await fetchWithRetry(registryUrl(REGISTRY, path), timed, sleep, token)
    if (primary.ok || primary.status < 500) return primary
    primaryError = new PrimaryStatusError(primary.status)
  } catch (error) {
    primaryError = error
  }
  if (backup === undefined) {
    // No backup configured: behave exactly as before — the 5xx response
    // returns to the caller (whose contextual error names the keyword), a
    // network throw propagates.
    if (primary !== null) return primary
    throw primaryError
  }
  let backupResponse: Response
  try {
    backupResponse = await fetchWithRetry(registryUrl(backup, path), timed, sleep, undefined)
  } catch {
    // The backup itself is unreachable or stalled past its own timeout.
    // Whatever it threw is not what the caller hears: the doc comment above
    // promises the primary's failure is what propagates, so primaryError —
    // never the backup's own error — is what gets thrown.
    throw primaryError
  }
  if (!backupResponse.ok) throw primaryError
  return backupResponse
}

/**
 * Bound on HTTP 429 retries per request. npm rate-limits aggressively by IP,
 * and a CI runner shares its egress IP with every other tenant, so a single
 * 429 must not fail the daily publish. The retry is bounded: after
 * {@link RETRY_LIMIT} total attempts the last response is returned as-is and
 * the caller reports it the way it reports any other failure.
 *
 * The budget is sized for an IP-level throttle, not a blip. It was 4 attempts
 * over 7s, and on 2026-08-26 two catalog builds died anyway: a burst of pushes
 * ran the full harvest repeatedly from the same runner IP pool, npm throttled
 * the search endpoint, and seven seconds of backoff never outlives that. Five
 * delays of 2/4/8/16/32s give the limit ~62s to clear — still bounded, still
 * loud when npm is genuinely unavailable rather than merely annoyed.
 *
 * Note that a token does not exempt the search endpoint: those two builds sent
 * one (see the `token` parameter of {@link fetchWithRetry}) and were throttled
 * regardless, which is consistent with `/-/v1/search` metering by IP. The token
 * still lifts the per-packument limit, which is where most requests go.
 */
const RETRY_LIMIT = 6

const RETRY_BASE_DELAY_MS = 2000
/** Also the clamp on a `Retry-After` the registry sends; npm has answered with
 * values far larger than any build should wait for. */
const RETRY_MAX_DELAY_MS = 60_000

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetch one URL with bounded retries on HTTP 429, honoring a Retry-After
 * header when the registry sends one and backing off exponentially otherwise.
 * @param url - the registry URL.
 * @param fetchImpl - the fetch implementation, injected for testing.
 * @param sleep - the delay implementation, injected so tests do not wait.
 * @param token - an optional npm access token, sent as a Bearer header. npm
 *   rate-limits by IP and a CI runner shares its egress IP, so an
 *   unauthenticated search can be throttled before the first request; a
 *   read-only token lifts the limit onto the token instead of the IP.
 * @returns the first non-429 response, or the final 429 after the retries.
 */
export async function fetchWithRetry(
  url: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<Response> {
  const init = token === undefined ? undefined : { headers: { Authorization: `Bearer ${token}` } }
  let response = await fetchImpl(url, init)
  for (let attempt = 0; response.status === 429 && attempt < RETRY_LIMIT - 1; attempt += 1) {
    const retryAfter = Number(response.headers.get('retry-after'))
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS)
      : Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS)
    await sleep(delay)
    response = await fetchImpl(url, init)
  }
  return response
}

/** Normalize an npm repository field to a plain https URL. */
function normalizeRepository(value: unknown): string | null {
  const url = typeof value === 'string'
    ? value
    : typeof (value as { url?: unknown } | null)?.url === 'string'
      ? (value as { url: string }).url
      : null
  if (url === null) return null
  return url.replace(/^git\+/, '').replace(/\.git$/, '')
}

/**
 * Maximum number of peer names recorded from one package's manifest.
 * `peerDependencies` keys flow from hostile npm input straight to a published
 * artifact, and the object carries no size limit of its own: a manifest
 * declaring thousands of them would bloat every published `plugins.json` and
 * force each reader's host to attempt that many peer resolutions on every
 * catalog load. The excess is dropped, never rejected — an author's oversized
 * manifest costs them the tail of the list, not the listing.
 *
 * These two bounds MULTIPLY, and their product was the largest thing in a
 * published entry. Measured through gate.ts's own serializer: 200 names of
 * 214 characters is 45,239 bytes of `plugins.json`, which is 3.68x
 * `ENTRY_PAYLOAD_MAX_BYTES` — the budget for an ENTIRE entry — so this one
 * field set the per-entry ceiling for every other. Against the published
 * catalog of 2026-09-04, 9,422 entries, the largest peers list any listed
 * package declares is 58 names of at most 50 characters, which serializes to
 * 3,635 bytes. 200 x 214 was bounding nothing that exists.
 *
 * 128 is 2.2x the largest real list and drops no peer any listed package
 * declares today. At 128 x 128 the block is 17,959 bytes — still ABOVE the
 * 12 KiB entry budget, and that is not an oversight: a field bound says what
 * one value may look like, the budget says what a whole entry may cost, and a
 * package maxing out every field at once is refused entirely. The two are
 * deliberately not jointly satisfiable. At real sizes they never meet — the
 * budget admits ~188 peer names of 50 characters, 3.2x the live maximum.
 */
export const PEERS_MAX_COUNT = 128

/**
 * Maximum length of one recorded peer name. Each of the {@link
 * PEERS_MAX_COUNT} names reaches every reader's `plugins.json` verbatim.
 * Dropped rather than rejected, the same policy the count cap states: an
 * oversized manifest costs the author the tail of the list, not the listing.
 *
 * This was 214 — npm's own name limit — and that rationale is retired rather
 * than mislaid. It was never a grammar check: a `peerDependencies` key is an
 * arbitrary JSON key, this filter only ever measured its length, and 214
 * admitted 214 emoji as readily as a package name. What it did do was
 * multiply by {@link PEERS_MAX_COUNT} into the 45,239-byte block described
 * there, and the longest peer name in the live catalog is 50 characters.
 * 128 is 2.56x that.
 *
 * The consequence, stated rather than buried: a peer name of 129 to 214
 * characters is legal on npm and is now DROPPED. None has ever been observed,
 * and the loss is the tail of one list — silent, like every other drop this
 * field makes, because no rejection code and no published `detail` covers a
 * truncated peers list. If one ever shows up, this bound is what to revisit;
 * `length` here counts UTF-16 code units, so a name's cost in the byte budget
 * is up to six times this number and the byte budget is what actually decides.
 */
export const PEER_NAME_MAX_LENGTH = 128

/**
 * Project one npm packument into a candidate.
 * @param packument - the parsed registry document for one package.
 * @returns the candidate, or null when the document names no usable latest version.
 */
/**
 * The npm account behind one package: the account npm recorded for this
 * version when it is one of the package's maintainers, otherwise the first
 * maintainer.
 *
 * `_npmUser` alone is not an identity. Measured on 250 live catalog entries,
 * 30 report it as the literal string "GitHub Actions" — the trusted-publisher
 * path, which the better-run projects use. Naming that would tell a reader
 * nothing, and it would read backwards: the original `@nanmicoder/dsh-agent-
 * teams` publishes from CI while the clone `dsh-agent-squad` was pushed by
 * hand, so the clone would be the side showing a human. Requiring the value
 * to be a maintainer keeps it an account someone owns, and the fallback keeps
 * an answer for the CI case. 246 of those 250 have exactly one maintainer.
 */
function publisherOf(maintainers: unknown, npmUser: unknown): string | undefined {
  const names = Array.isArray(maintainers)
    ? maintainers
      .map(m => (m !== null && typeof m === 'object' ? (m as { name?: unknown }).name : m))
      .filter((n): n is string => typeof n === 'string')
    : []
  if (typeof npmUser === 'string' && names.includes(npmUser)) return npmUser
  return names[0]
}

/**
 * The declared license as a string, from any spelling npm actually serves.
 *
 * The current field is an SPDX string, but the registry still carries the two
 * legacy forms — `license: { type, url }` and `licenses: [{ type, url }]` —
 * which npm publishes with a warning rather than a refusal. Reading only the
 * string form told those authors "Declares no license.", a published reason
 * that was simply false (audit A-7).
 * @param license - the manifest `license` value, unvalidated.
 * @param licenses - the manifest `licenses` value, unvalidated.
 * @returns the license identifier, or null when nothing declares one.
 */
function normalizeLicense(license: unknown, licenses: unknown): string | null {
  if (typeof license === 'string') return license.trim() === '' ? null : license
  if (license !== null && typeof license === 'object' && !Array.isArray(license)) {
    const type = (license as { type?: unknown }).type
    if (typeof type === 'string' && type.trim() !== '') return type
  }
  if (Array.isArray(licenses)) {
    for (const item of licenses) {
      if (typeof item === 'string' && item.trim() !== '') return item
      if (item !== null && typeof item === 'object') {
        const type = (item as { type?: unknown }).type
        if (typeof type === 'string' && type.trim() !== '') return type
      }
    }
  }
  return null
}

/**
 * Whether npm reports this version deprecated.
 *
 * `npm deprecate <pkg> ""` is the documented un-deprecate, and it leaves
 * `deprecated: ""` behind — so the presence of the key says nothing. A
 * non-empty message means deprecated; so does a bare `true`, which some
 * manifests carry and which we must not read as "fine" (audit B-5).
 * @param deprecated - the manifest `deprecated` value, unvalidated.
 */
function isDeprecated(deprecated: unknown): boolean {
  if (deprecated === true) return true
  return typeof deprecated === 'string' && deprecated.trim() !== ''
}

export function toCandidate(packument: unknown): Candidate | null {
  // `null` is legal JSON, so a 200 whose whole body is those four bytes
  // parses cleanly and arrives here — and every property read below the cast
  // throws a TypeError on it. Checked before the cast rather than after it:
  // the cast is a claim about shape that `null` satisfies structurally and
  // not in fact. Anything that is not an object shape can carry no name, so
  // it projects to no candidate, the same as a packument naming no latest
  // version — one author-readable `fetch-failed` row instead of an aborted
  // harvest. github-client's twin projection took this guard on this branch
  // after a real public repository served exactly that body; a throw HERE is
  // worse, because fetchCandidate's catches wrap the transport and the JSON
  // parse but not the projection, so it rejects fetchCandidates' Promise.all
  // and neither build.ts nor classify.ts has an outer catch. The Array clause
  // is belt-and-braces: an array's `.name` is undefined and would be rejected
  // below anyway — it is here so the guard reads as "not an object shape"
  // rather than as a null check that happens to suffice today.
  if (typeof packument !== 'object' || packument === null || Array.isArray(packument)) return null
  const doc = packument as {
    name?: unknown
    'dist-tags'?: { latest?: unknown }
    maintainers?: unknown
    time?: Record<string, unknown>
    versions?: Record<string, {
      dist?: { integrity?: unknown }
      license?: unknown
      licenses?: unknown
      repository?: unknown
      deprecated?: unknown
      description?: unknown
      keywords?: unknown
      _npmUser?: { name?: unknown }
      peerDependencies?: unknown
      dsh?: { bundle?: unknown; catalog?: unknown }
    }>
  }
  const name = doc.name
  const version = doc['dist-tags']?.latest
  if (typeof name !== 'string' || typeof version !== 'string') return null
  const manifest = doc.versions?.[version]
  // The same input class, one level down: `"versions": {"1.2.0": null}` is
  // legal JSON, it passes an `=== undefined` check, and `manifest.dist` then
  // throws. A version entry that is not an object shape carries no manifest,
  // so it names no usable latest version — and a hollow candidate built from
  // one would reach the gate to be rejected for a license and a repository it
  // was never asked for, which is a misattributed reason in a published
  // report.
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return null
  const publishedAt = doc.time?.[version]
  return {
    name,
    version,
    integrity: typeof manifest.dist?.integrity === 'string' ? manifest.dist.integrity : null,
    publishedAt: typeof publishedAt === 'string' ? publishedAt : null,
    repository: normalizeRepository(manifest.repository),
    license: normalizeLicense(manifest.license, manifest.licenses),
    deprecated: isDeprecated(manifest.deprecated),
    hasBundle: manifest.dsh?.bundle !== undefined,
    catalog: manifest.dsh?.catalog ?? null,
    description: typeof manifest.description === 'string' ? manifest.description : null,
    keywords: Array.isArray(manifest.keywords)
      ? manifest.keywords.filter((k): k is string => typeof k === 'string')
      : [],
    // The account name only: npm carries an address beside it and our
    // artifact has no use for republishing that (see Candidate.publisher for
    // why an account and not `author`).
    ...(() => {
      const publisher = publisherOf(doc.maintainers, manifest._npmUser?.name)
      return publisher === undefined ? {} : { publisher }
    })(),
    peers: manifest.peerDependencies !== null && typeof manifest.peerDependencies === 'object' && !Array.isArray(manifest.peerDependencies)
      ? Object.keys(manifest.peerDependencies)
        .filter(peer => peer.length > 0 && peer.length <= PEER_NAME_MAX_LENGTH)
        .slice(0, PEERS_MAX_COUNT)
      : [],
  }
}

/**
 * List every package name carrying one of the harvest keywords: one paged
 * search per keyword, unioned and deduplicated, sorted for determinism.
 *
 * A keyword past {@link SEARCH_WINDOW} is paged as refinement cells (see
 * {@link PARTITION_KEYWORDS}) PLUS the keyword's own reachable window, which
 * stops at the window instead of throwing. The union of the two is then
 * measured against the keyword's own total, re-paged once on a shortfall, and
 * refused if the shortfall survives that.
 *
 * Harvesting by keyword rather than by name pattern is deliberate: a name
 * pattern is trivially spoofed. A keyword search that cannot complete
 * aborts the harvest — harvesting only the keywords that answered would
 * silently shrink the candidate set, which is indistinguishable from an
 * empty ecosystem.
 * @param fetchImpl - the fetch implementation, injected for testing.
 * @param sleep - the delay implementation, injected so tests do not wait.
 * @param token - an optional read-only npm token; see {@link fetchWithRetry}.
 * @param backupRegistry - accepted, and NEVER passed by a production caller.
 *   registry.npmmirror.com does not implement the `keywords:` qualifier this
 *   search depends on: measured 2026-09-03 it answers
 *   `{"objects":[],"total":0}` for both harvest keywords, and a numeric zero
 *   is not an error — the coverage floor becomes `min(0, 0) = 0` and passes,
 *   so a stalled or 5xx npmjs search would publish a zero-name harvest with a
 *   green build. The failover belongs on {@link fetchCandidate}, where the
 *   integrity hash makes a mirror answer interchangeable. npm-client.test.ts
 *   scans both call sites for this.
 * @returns every matching package name, sorted and deduplicated.
 * @throws when the registry answers with a non-OK status after the 429
 *   retries are exhausted; when a search page or a total probe answers no
 *   total, or one that is not a whole count of packages; when a keyword's
 *   total is past {@link SEARCH_WINDOW} and no refinement keyword splits it;
 *   when a PARTITION CELL would need a `from` past {@link MAX_SEARCH_FROM}
 *   (the keyword's own window cell stops there instead — that one is expected
 *   not to fit); or when a keyword still enumerates fewer names than its own
 *   total says to expect after a second full pass.
 */
export async function searchByKeywords(
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  token: string | undefined = undefined,
  backupRegistry: string | undefined = undefined,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  onShortfall: (shortfall: KeywordShortfall) => void = () => {},
): Promise<string[]> {
  const seen = new Set<string>()
  const probe = (keywords: readonly string[]): Promise<number> =>
    searchTotal(keywords, fetchImpl, sleep, token, backupRegistry, timeoutMs)
  /**
   * Page one query to its answered total, into `into` and into the union.
   * @param pastWindow - what a `from` past {@link MAX_SEARCH_FROM} means here.
   *   `throw` for a partition cell: the partition MEASURED that cell as
   *   fitting, so needing another page says the partition is wrong and a
   *   larger `from` would silently re-serve page 0. `stop` for the keyword's
   *   own window cell, which is expected not to fit — sweeping the reachable
   *   window is the entire job, and ending at the window is the answer, not a
   *   truncation.
   */
  const pageCell = async (
    cell: readonly string[],
    into: Set<string>,
    pastWindow: 'throw' | 'stop',
  ): Promise<void> => {
    const query = keywordQuery(cell)
    for (let from = 0; ; from += PAGE_SIZE) {
      if (from > MAX_SEARCH_FROM) {
        if (pastWindow === 'stop') return
        throw new Error(
          `npm search for ${query} needs from=${from}, past the ${MAX_SEARCH_FROM} the registry honors (a larger from silently returns page 0); the partition is wrong`,
        )
      }
      const path = `-/v1/search?text=${encodeURIComponent(query)}&size=${PAGE_SIZE}&from=${from}`
      const response = await fetchWithFailover(path, fetchImpl, sleep, token, backupRegistry, timeoutMs)
      if (!response.ok) throw new Error(`npm search for ${query} failed: ${response.status}`)
      const body = await readSearchBody(response, query, from)
      // Array-checked, not `?? []`: a non-array `objects` is not iterable
      // and `for…of` would throw on it. An unusable `objects` reads as an
      // empty page, which the coverage check below refuses BY NAME rather
      // than by TypeError. Each element is optional-chained for the same
      // reason: `{"objects":[null]}` is legal JSON, and an entry naming no
      // package is not a package.
      const objects = Array.isArray(body.objects) ? body.objects : []
      for (const object of objects) {
        const found = object?.package?.name
        if (typeof found === 'string') {
          seen.add(found)
          into.add(found)
        }
      }
      // Stop on the total the registry answered, NEVER on a short page: npm
      // has served a 249-object page of a 600-name result set, and breaking
      // there dropped every later page of that keyword in silence. A
      // missing total cannot be told apart from a truncated page, so it
      // throws rather than defaulting to 0 and ending the cell on whatever
      // page happened to arrive first — live shape: the registry has
      // served a 200 with `<!doctype html>` and a 429 with a 7 KB HTML
      // body on ordinary search pages. The window cell is bounded by the
      // window, never by a page it cannot judge, so this throw applies to it
      // exactly as it does to a partition cell.
      const cellTotal = readTotal(body, query, from, 'a truncated page cannot be told from a complete one')
      if (objects.length === 0 || from + objects.length >= cellTotal) return
    }
  }
  for (const keyword of HARVEST_KEYWORDS) {
    const { cells, total, partitioned } = await partitionKeyword(keyword, probe)
    const forKeyword = new Set<string>()
    const enumerate = async (): Promise<void> => {
      // The keyword's own reachable window, unioned in beside the refinement
      // cells and deliberately NON-COMPLETING. A refinement partition is not
      // covering by construction — there is no negation qualifier — so
      // PARTITION_KEYWORDS is a list somebody has to extend every time the
      // ecosystem moves, and it was fifteen names short the day after it was
      // documented as complete. This cell needs no list: it takes the
      // refinements out of the picture for every name INSIDE the window,
      // leaving them responsible only for the lowest-scoring tail beyond it,
      // which is the half they measure well on. See PARTITION_KEYWORDS for
      // the ranks. It costs 21 requests and shrinks the residual to names
      // that are BOTH outside the window AND carry no refinement keyword.
      if (partitioned) await pageCell([keyword], forKeyword, 'stop')
      for (const cell of cells) await pageCell(cell, forKeyword, 'throw')
    }
    await enumerate()
    // The API has no complement operator, so a partition's coverage is
    // measured rather than assumed: `min` of the totals before and after
    // absorbs a package published or unpublished during the run, and a
    // genuine partition gap is hundreds of names and still throws. An
    // unpartitioned keyword gets the same floor AND the same re-probe: a
    // stale `total` reused as `after` gives `required = total` exactly, so
    // it could absorb no churn at all — an ordinary unpublish between the
    // probe and the page landing then looked identical to a truncated
    // harvest. The re-probe costs one extra size=1 request per top-level
    // keyword; it also catches a mid-stream empty page: the `||` that ends
    // pageCell above returns on ANY empty page, even one arriving before the
    // cell's own total says the cell is exhausted.
    let required = Math.min(total, await probe([keyword]))
    if (forKeyword.size < required) {
      // ONE re-page before the throw. The floor is exact, and the anomaly
      // that motivated it does not survive it: npm served a 249-object page
      // of a 600-name result set, `from` advances by PAGE_SIZE, so the object
      // npm omitted is never re-requested and that keyword enumerates 599 of
      // 600. Same for a `total` npm overstates by one. One registry hiccup
      // would freeze the shelf for the day with no catalog published. A
      // second full pass separates a transient omission from a genuine
      // partition gap — the distinction both messages below already claim to
      // draw — and it is bounded at one, so a registry really serving short
      // still fails the build rather than looping. It UNIONS into the same
      // set, because pass two may omit a different object than pass one did,
      // and the floor takes the minimum across every total observed, so churn
      // during the retry is tolerated exactly as churn during the first pass.
      await enumerate()
      required = Math.min(required, await probe([keyword]))
    }
    const shortfall = required - forKeyword.size
    if (shortfall > 0 && shortfall <= MAX_SEARCH_SHORTFALL) {
      // Small enough to be the registry answering a total it cannot serve.
      // Reported, never swallowed: the caller puts it in the build report, and
      // a bound this low cannot hide any gap this repo has seen.
      onShortfall({ keyword, enumerated: forKeyword.size, required })
    } else if (shortfall > 0) {
      throw new Error(partitioned
        ? `npm search for ${keywordQuery([keyword])} enumerated ${forKeyword.size} of ${required} names across ${cells.length} partition cell(s) plus the keyword's own reachable window, and a second full pass found no more; the refinement keywords do not cover the keyword, so the harvest would be silently short`
        : `npm search for ${keywordQuery([keyword])} enumerated ${forKeyword.size} of ${required} names, and a second full pass found no more; the search ended before reaching the answered total, so the harvest would be silently short`)
    }
  }
  return [...seen].sort()
}

/**
 * The outcome of fetching one package: either a usable candidate, or the
 * reason none could be produced. Distinguishing the two lets a caller record
 * a transient fetch failure as its own audited rejection rather than
 * conflating it with a package that simply carries no `dsh.catalog`.
 */
export type CandidateResult =
  | { ok: true; candidate: Candidate }
  | { ok: false; detail: string }

/**
 * Fetch one package's full packument and project it into a candidate.
 * @param name - the package name.
 * @param fetchImpl - the fetch implementation, injected for testing.
 * @param sleep - the delay implementation, injected so tests do not wait.
 * @param token - an optional read-only npm token; see {@link fetchWithRetry}.
 * @returns the candidate, or the reason none could be produced. NEVER throws:
 *   a 429 is retried a bounded number of times, a transport failure (network
 *   error, stall, or an exhausted failover) becomes a rejection whose detail
 *   names that cause, and {@link toCandidate} answers `null` for any body it
 *   cannot project rather than dereferencing it — one dead packument out of
 *   thousands must not take the daily catalog down with it. That last clause
 *   is the one this branch had to add twice: the three catches below wrap the
 *   transport and the JSON parse, NOT the projection, so a `null` body (legal
 *   JSON, parsed without complaint) threw straight past all of them.
 */
export async function fetchCandidate(
  name: string,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  token: string | undefined = undefined,
  backupRegistry: string | undefined = undefined,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<CandidateResult> {
  let response: Response
  try {
    response = await fetchWithFailover(encodeURIComponent(name), fetchImpl, sleep, token, backupRegistry, timeoutMs)
  } catch (error) {
    // One unreachable packument must never abort a harvest of thousands.
    // CLAUDE.md: "a package that cannot be fetched becomes a fetch-failed
    // rejection in the build report. Nothing disappears without a reason
    // attached to its name." Before this catch that held only for HTTP-status
    // failures: one ECONNRESET or one 30s stall rejected the whole harvest.
    // The detail names the TRUE cause, because an author reads it to find out
    // why their package is missing.
    //
    // A PrimaryStatusError means the primary DID answer — with a 5xx — and a
    // configured backup then also failed. That is the same fact a caller
    // with no backup (or a healthy one) sees as a non-OK `response` below, so
    // it gets identical phrasing here instead of being wrapped as a second,
    // invented-sounding transport failure.
    const detail = error instanceof FetchTimeoutError
      ? `${name}: the npm registry did not answer within ${timeoutMs}ms`
      : error instanceof PrimaryStatusError
        ? `npm registry returned ${error.status} fetching ${name}`
        : `${name}: could not reach the npm registry (${error instanceof Error ? error.message : String(error)})`
    return { ok: false, detail }
  }
  if (!response.ok) return { ok: false, detail: `npm registry returned ${response.status} fetching ${name}` }
  let body: unknown
  try {
    const read = await readJsonCapped(response, MAX_PACKUMENT_BYTES)
    if (!read.ok) {
      // A row, not a throw: nothing disappears without a reason attached to
      // its name, and one oversized packument is not a broken harvest.
      return {
        ok: false,
        detail: read.reason === 'too-large'
          ? `${name}: the registry answered a packument larger than ${MAX_PACKUMENT_BYTES} bytes, so it was discarded without being parsed`
          : `${name}: response body was unreadable`,
      }
    }
    body = read.value
  } catch (error) {
    // A deadline landing MID-BODY arrives here, not at the header-phase catch
    // above: `fetch` resolves on the headers, and {@link withTimeout} leaves
    // its timer armed past that point precisely so a stalled body still
    // aborts — with the FetchTimeoutError itself as the abort reason, so this
    // catch can tell the two apart. Publishing "response body was unreadable"
    // for our own 30s stall tells the author npm sent something malformed and
    // sends them looking at a package that is fine. The header phase above
    // already reports it correctly, and readSearchBody in this module rethrows
    // it with a comment saying a deadline is not a malformed body; this was
    // the site that missed. Same reason, same sentence — a rejection rather
    // than a rethrow, because this function never throws.
    if (error instanceof FetchTimeoutError) {
      return { ok: false, detail: `${name}: the npm registry did not answer within ${timeoutMs}ms` }
    }
    // response.json() throws on a body that is not valid JSON; recorded as a
    // rejection like any other unusable response, rather than aborting the build.
    return { ok: false, detail: `${name}: response body was unreadable` }
  }
  const candidate = toCandidate(body)
  if (candidate === null) return { ok: false, detail: `${name}: packument names no usable latest version` }
  // The packument has to BE the package we asked for. Nothing compared the
  // two, and {@link fetchWithFailover} serves a NPM_BACKUP_REGISTRY answer
  // whenever the primary throws, stalls, or 5xxs — to any URL an operator
  // sets, registry.npmmirror.com by default. `name`, `version`, `integrity`,
  // `publishedAt` and `publisher` are then taken verbatim into plugins.json,
  // manifest.lock, the committed-and-pushed first-seen.yml and the published
  // report. The integrity hash — the design's stated reason a mirror answer is
  // interchangeable — pins the TARBALL a reader installs; it says nothing
  // about which package that tarball is filed under. One string comparison,
  // at the only boundary where both strings are in scope.
  if (candidate.name !== name) {
    return { ok: false, detail: `${name}: the registry answered with the packument for ${candidate.name}` }
  }
  return { ok: true, candidate }
}

export const HARVEST_CONCURRENCY = 8

/**
 * Fetch every name into a candidate, turning un-fetchable names into
 * `fetch-failed` rejections rather than dropping them (build.ts rationale).
 *
 * A sliding pool of {@link HARVEST_CONCURRENCY} workers, not a batch barrier.
 * Awaiting `Promise.all` over each slice of eight made every batch cost its
 * SLOWEST member: one packument stalling to the full 30s deadline idled the
 * other seven slots for those 30 seconds, and the harvest runs ~5,650 names
 * deep. Each worker claims the next index and starts on it the moment its own
 * name is done, so a stall costs one slot rather than eight.
 *
 * Results are written back at the CLAIMED INDEX and collected in input order
 * afterwards, never pushed as they land. With a pool, completion order is
 * whatever the network did that morning: pushing would reorder `harvest.json`
 * — which classify.ts writes and build.ts reads — on every run, and reorder
 * the `fetch-failed` rows for no reason anyone chose. The index is claimed
 * synchronously, before the first await, so no two workers can read the same
 * one.
 */
export async function fetchCandidates(
  names: string[],
  fetchImpl: typeof fetch = fetch,
  token: string | undefined = undefined,
  backupRegistry: string | undefined = undefined,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ candidates: Candidate[]; rejections: Rejection[] }> {
  const results: (CandidateResult | undefined)[] = names.map(() => undefined)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= names.length) return
      const name = names[index]
      // `noUncheckedIndexedAccess`: an index below `length` can still be a
      // hole in a sparse array. Nothing here produces one — the caller's list
      // is searchByKeywords' sorted union — and a hole is no name to fetch,
      // so it leaves an empty slot the collection below skips rather than a
      // rejection row naming `undefined` in the published report.
      if (name === undefined) continue
      // `fetchCandidate` never throws — transport, parse AND projection — so
      // no worker can reject: every name lands as a candidate or as a
      // rejection carrying its reason. One rejected promise here takes down
      // the `Promise.all` and the whole harvest with it, and there is no outer
      // catch above: build.ts and classify.ts both call this at module scope.
      results[index] = await fetchCandidate(name, fetchImpl, sleep, token, backupRegistry, timeoutMs)
    }
  }
  await Promise.all(Array.from({ length: Math.min(HARVEST_CONCURRENCY, names.length) }, () => worker()))
  const candidates: Candidate[] = []
  const rejections: Rejection[] = []
  names.forEach((name, index) => {
    const result = results[index]
    if (result === undefined) return
    if (result.ok) candidates.push(result.candidate)
    else rejections.push({ name, code: 'fetch-failed', detail: result.detail })
  })
  return { candidates, rejections }
}
