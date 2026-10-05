/**
 * The change feed's committed state and the rule that decides which
 * packages it holds. Pure: no clock, no network, no filesystem, no
 * environment.
 *
 * npm search reaches a package by RANK and ranks a new one at the bottom,
 * past every 5,250-name window; npm's replication change feed lists it by
 * the time it changed. `npm-feed.ts` reads the feed. Every decision it
 * applies lives here, so fixtures can drive all of them.
 * Spec: docs/design/2026-10-04-change-feed-harvest.md.
 * @module feed-state
 */
import { escapeCell } from './emit.ts'
import { compareStrings } from './identity.ts'
import { isMaintainerName } from './publisher-state.ts'

/**
 * The ids whose `/latest` manifest a run reads: a DISCOVERY filter, never
 * a membership rule. A name it matches is admitted only by the exact
 * keyword in its manifest (`classifyManifest`), so the pattern can cause a
 * miss but never a listing -- CLAUDE.md, "Admit by keyword, never by name
 * pattern".
 *
 * Measured 2026-10-04 (spec section 2): it matches 96.1% of the names that
 * carry `dsh-plugin` and 95.5% of those that carry `deepseek-harness`, and
 * 19 of the 22 residue names an owner sweep identified; it selects about
 * 700 ids a day. Most false positives are "spreadsheet", which contains
 * "dsh"; each costs one small read. No `g` flag: `test` on a global regex
 * keeps `lastIndex` between calls, and this one is shared by every call.
 */
export const FEED_NAME_PATTERN = /dsh|deepseek|cordis/i

/**
 * Where a run with no state file starts reading. Seq 117,350,216 dates to
 * 2026-07-01T00:00Z by binary search on the median `modified` of the rows
 * that follow it (spec section 2); rounded down, it is ahead of the first
 * dsh package. A full catch-up from here measured 62 pages and 17,779
 * selected ids.
 */
export const FEED_BOOTSTRAP_SEQ = 117_350_000

/** npm's own bound on the length of a package name. */
export const FEED_PACKAGE_NAME_MAX_LENGTH = 214

/**
 * The modern npm package-name grammar: lowercase, URL-safe, an optional
 * scope. Applied where a name is ADMITTED and again where the file is
 * PARSED, so the parser can never meet a name the writer produced (spec
 * section 4.2). npm still serves some legacy names with capitals; those
 * are refused at selection and stay search's to reach, as they are today.
 */
const FEED_PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/

/**
 * Owners whose `keywords:K maintainer:U` cell one run pages per keyword to
 * verify feed-only names. Today's residue has 12 owners per keyword, so
 * every feed-only name is verified until a crossing grows it past 16.
 */
export const FEED_VERIFY_OWNERS = 16

/**
 * Feed-only names per keyword per run that may disagree with their
 * owner's cell before the build throws. Room for index lag on a name
 * published minutes before the read; a systematic drift exceeds it at once
 * -- crediting deprecated packages would have produced 28 disagreements
 * out of 47 (spec section 2).
 */
export const FEED_MAX_DISAGREEMENTS = 3

/** Whether `value` is a name the feed may store (see FEED_PACKAGE_NAME). */
export function isFeedPackageName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= FEED_PACKAGE_NAME_MAX_LENGTH
    && FEED_PACKAGE_NAME.test(value)
}

/**
 * Whether npm reports this version deprecated.
 *
 * `npm deprecate <pkg> ""` is the documented un-deprecate, and it leaves
 * `deprecated: ""` behind -- so the presence of the key says nothing. A
 * non-empty message means deprecated; so does a bare `true`, which some
 * manifests carry and which we must not read as "fine" (audit B-5). It
 * lives here, not in npm-client.ts, so the feed's membership rule and the
 * packument reader share one definition: npm search excludes deprecated
 * packages from its results AND from `total` (spec section 2), so the two
 * must agree exactly.
 * @param deprecated - the manifest `deprecated` value, unvalidated.
 */
export function isDeprecated(deprecated: unknown): boolean {
  if (deprecated === true) return true
  return typeof deprecated === 'string' && deprecated.trim() !== ''
}

/** One package the feed holds. */
export interface FeedCarrier {
  /**
   * The code-unit-smallest `maintainers[].name` that `isMaintainerName`
   * accepts, or null when none does. Never `_npmUser`: that is the
   * identity that published, and it can be a bot's display name ("GitHub
   * Actions"), which `maintainer:` cannot address.
   */
  readonly owner: string | null
  /** The harvest keywords its latest version lists: sorted, never empty. */
  readonly keywords: readonly string[]
}

/** The committed state, `registry/feed-state.json`. */
export interface FeedState {
  /** The feed position up to which every row has been applied. */
  readonly seq: number
  /** Every package the feed has seen whose latest version passes the rule. */
  readonly carriers: ReadonlyMap<string, FeedCarrier>
  /** Names whose read failed or was not reached; read first next run. */
  readonly pending: readonly string[]
}

/** What reading one `/latest` manifest established. */
export type FeedRead =
  | { readonly kind: 'carrier'; readonly name: string; readonly carrier: FeedCarrier }
  // The package's manifest, read and parsed, and not a carrier: no harvest
  // keyword, or deprecated. The `no-manifest` side of the line CLAUDE.md
  // draws, so the name is dropped.
  | { readonly kind: 'not-carrier'; readonly name: string }
  // A 404, or a row the feed marks deleted.
  | { readonly kind: 'gone'; readonly name: string }
  // Anything that is not the package's manifest: a transport failure, a
  // deadline, any non-2xx but a 404 (a 403 from a blocking edge included),
  // a body past the cap or not JSON, a body that is not a manifest, or the
  // manifest of another package. The `fetch-failed` side: the name keeps
  // its previous status and is read again next run.
  | { readonly kind: 'failed'; readonly name: string; readonly reason: string }
  // Not started within the run's read budget. Kept, retried.
  | { readonly kind: 'unreached'; readonly name: string }

/**
 * Apply the membership rule (spec section 4.3) to one parsed `/latest`
 * manifest. A package carries a harvest keyword when the manifest names
 * it, lists the keyword by exact code-unit equality -- as npm search and
 * `isAtRisk` compare -- and is not deprecated.
 */
export function classifyManifest(name: string, manifest: unknown, harvestKeywords: readonly string[]): FeedRead {
  // npm serializes every manifest as an object carrying its name, so a body
  // that is not one is an edge or a cache answering in npm's place. It says
  // nothing about the package, so the name is retried, never dropped.
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { kind: 'failed', name, reason: 'the registry answered a body that is not a manifest' }
  }
  const m = manifest as { name?: unknown; keywords?: unknown; deprecated?: unknown; maintainers?: unknown }
  if (typeof m.name !== 'string') return { kind: 'failed', name, reason: 'the registry answered a manifest that names no package' }
  // The manifest of another package is a statement about the transport (a
  // cache answering the wrong key), not about this package, so it is
  // retried rather than believed -- the packument reader's own rule.
  if (m.name !== name) return { kind: 'failed', name, reason: 'the registry answered with the manifest of another package' }
  if (isDeprecated(m.deprecated)) return { kind: 'not-carrier', name }
  const declared: readonly unknown[] = Array.isArray(m.keywords) ? m.keywords : []
  const keywords = harvestKeywords.filter(keyword => declared.includes(keyword)).sort(compareStrings)
  if (keywords.length === 0) return { kind: 'not-carrier', name }
  const owners = (Array.isArray(m.maintainers) ? m.maintainers : [])
    .map((entry: unknown) => (entry !== null && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined))
    .filter(isMaintainerName)
    .sort(compareStrings)
  return { kind: 'carrier', name, carrier: { owner: owners[0] ?? null, keywords } }
}

/** The state a run starts from when `registry/feed-state.json` is absent. */
export function bootstrapFeedState(): FeedState {
  return { seq: FEED_BOOTSTRAP_SEQ, carriers: new Map(), pending: [] }
}

/**
 * Read `registry/feed-state.json`. Throws on anything malformed (spec
 * section 4.2): a state the build cannot trust is a state it must not
 * credit, and an empty one would look like an ecosystem with no residue.
 * Unknown top-level keys are ignored, as publisher-state.json's are, and
 * the next write drops them.
 */
export function parseFeedState(raw: string, harvestKeywords: readonly string[]): FeedState {
  const fail = (what: string): never => {
    throw new Error(`registry/feed-state.json: ${what}; restore it from git, or delete it to re-read the feed from FEED_BOOTSTRAP_SEQ`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    // JSON.parse throws only a SyntaxError about this text, which is what
    // the message reports.
    return fail(`not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('expected an object')
  const p = parsed as { seq?: unknown; carriers?: unknown; pending?: unknown }
  const seq = p.seq
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return fail('`seq` must be a non-negative integer')
  const rawCarriers = p.carriers
  if (rawCarriers === null || typeof rawCarriers !== 'object' || Array.isArray(rawCarriers)) {
    return fail('`carriers` must be an object')
  }
  const carriers = new Map<string, FeedCarrier>()
  for (const [name, value] of Object.entries(rawCarriers)) {
    const shown = JSON.stringify(name.slice(0, 80))
    if (!isFeedPackageName(name)) return fail(`carrier ${shown} is not a package name the feed admits`)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(`carrier ${shown} must be an object`)
    const entry = value as { owner?: unknown; keywords?: unknown }
    const owner = entry.owner === null
      ? null
      : isMaintainerName(entry.owner) ? entry.owner : fail(`carrier ${shown} has an owner that is neither null nor a maintainer username`)
    if (!Array.isArray(entry.keywords) || entry.keywords.length === 0) {
      return fail(`carrier ${shown} must list at least one harvest keyword`)
    }
    const keywords: string[] = []
    for (const keyword of entry.keywords as unknown[]) {
      if (typeof keyword !== 'string' || !harvestKeywords.includes(keyword)) {
        return fail(`carrier ${shown} lists a keyword that is not a harvest keyword`)
      }
      const previous = keywords[keywords.length - 1]
      if (previous !== undefined && compareStrings(previous, keyword) >= 0) {
        return fail(`carrier ${shown} lists its keywords out of order or twice`)
      }
      keywords.push(keyword)
    }
    carriers.set(name, { owner, keywords })
  }
  const rawPending = p.pending
  if (!Array.isArray(rawPending)) return fail('`pending` must be an array')
  const pending: string[] = []
  for (const name of rawPending as unknown[]) {
    if (!isFeedPackageName(name)) return fail('`pending` holds a name the feed does not admit')
    pending.push(name)
  }
  if (new Set(pending).size !== pending.length) return fail('`pending` lists a name twice')
  return { seq, carriers, pending: pending.sort(compareStrings) }
}

/**
 * Write `registry/feed-state.json`: one carrier per line, everything
 * sorted by code unit, one trailing newline, so a day's churn is a few
 * hundred lines rather than a reformatted file (spec section 4.2).
 */
export function serializeFeedState(state: FeedState): string {
  const carriers = [...state.carriers]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([name, carrier]) =>
      `    ${JSON.stringify(name)}: ${JSON.stringify({ owner: carrier.owner, keywords: [...carrier.keywords].sort(compareStrings) })}`)
  const pending = [...new Set(state.pending)].sort(compareStrings).map(name => `    ${JSON.stringify(name)}`)
  const block = (lines: readonly string[]): string => (lines.length === 0 ? '' : `\n${lines.join(',\n')}\n  `)
  return `{\n  "seq": ${state.seq},\n  "carriers": {${block(carriers)}},\n  "pending": [${block(pending)}]\n}\n`
}

/** One row of the change feed: a package at its latest change in the range read. */
export interface FeedRow {
  readonly seq: number
  readonly id: string
  readonly deleted: boolean
}

const isSeq = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * Read one `_changes` page, or null when its shape is not the one
 * measured on 2026-10-04 (spec section 2). All or nothing: rows are
 * applied in order, so a page with one unreadable row would advance the
 * cursor past a change nobody read.
 */
export function parseFeedPage(value: unknown): { readonly rows: readonly FeedRow[]; readonly lastSeq: number } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const page = value as { results?: unknown; last_seq?: unknown }
  const lastSeq = page.last_seq
  if (!Array.isArray(page.results) || !isSeq(lastSeq)) return null
  const rows: FeedRow[] = []
  for (const raw of page.results as unknown[]) {
    if (raw === null || typeof raw !== 'object') return null
    const row = raw as { seq?: unknown; id?: unknown; deleted?: unknown }
    const seq = row.seq
    const id = row.id
    if (!isSeq(seq) || typeof id !== 'string') return null
    rows.push({ seq, id, deleted: row.deleted === true })
  }
  return { rows, lastSeq }
}

/** Which names one run reads, and which it drops without a read. */
export interface FeedSelection {
  /** Names to read this run: every pending name first, then each changed id once. */
  readonly read: readonly string[]
  /** Held or pending names the feed marks deleted: gone without a read. */
  readonly gone: readonly string[]
  /** Ids the name filter matched that the package-name rule refuses. */
  readonly refused: number
}

/**
 * Choose what to read (spec section 4.4, step 3): an id the name filter
 * matches, or one the state already holds or has pending -- so a held
 * carrier is re-read whenever it changes, even if the pattern is ever
 * narrowed -- plus every pending name, changed or not.
 */
export function selectFeedIds(rows: readonly FeedRow[], prior: FeedState): FeedSelection {
  // The feed is live, so one id can appear on two pages of one run when
  // its package changed again mid-read: only its last row counts.
  const last = new Map<string, FeedRow>()
  for (const row of rows) {
    const held = last.get(row.id)
    if (held === undefined || row.seq >= held.seq) last.set(row.id, row)
  }
  const pending = new Set(prior.pending)
  const gone: string[] = []
  const changed: string[] = []
  let refused = 0
  for (const [id, row] of last) {
    if (id.startsWith('_')) continue
    const known = prior.carriers.has(id) || pending.has(id)
    if (!known && !FEED_NAME_PATTERN.test(id)) continue
    if (!isFeedPackageName(id)) {
      refused += 1
      continue
    }
    if (row.deleted) {
      if (known) gone.push(id)
      continue
    }
    if (!pending.has(id)) changed.push(id)
  }
  const goneSet = new Set(gone)
  return {
    read: [...[...pending].filter(name => !goneSet.has(name)).sort(compareStrings), ...changed.sort(compareStrings)],
    gone: gone.sort(compareStrings),
    refused,
  }
}

/**
 * Merge one run's reads into the state (spec section 4.4, step 5). Pure:
 * the prior state is not modified. Pending names hold what the cursor has
 * passed, which is what makes advancing it safe.
 */
export function applyFeedReads(prior: FeedState, reads: readonly FeedRead[], nextSeq: number): FeedState {
  if (!Number.isSafeInteger(nextSeq) || nextSeq < prior.seq) {
    throw new Error(`the change-feed cursor cannot move from ${prior.seq} to ${nextSeq}`)
  }
  const carriers = new Map(prior.carriers)
  const pending = new Set(prior.pending)
  for (const read of reads) {
    // The writer applies the parser's own rule, so nothing written here can
    // make the next run's parse throw (spec section 4.2).
    if (!isFeedPackageName(read.name)) continue
    switch (read.kind) {
      case 'carrier':
        carriers.set(read.name, read.carrier)
        pending.delete(read.name)
        break
      case 'not-carrier':
      case 'gone':
        carriers.delete(read.name)
        pending.delete(read.name)
        break
      case 'failed':
      case 'unreached':
        pending.add(read.name)
        break
    }
  }
  return { seq: nextSeq, carriers, pending: [...pending].sort(compareStrings) }
}

/** Carriers per harvest keyword, for the report. */
export function carrierCounts(state: FeedState, harvestKeywords: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const keyword of harvestKeywords) counts[keyword] = 0
  for (const carrier of state.carriers.values()) {
    for (const keyword of carrier.keywords) counts[keyword] = (counts[keyword] ?? 0) + 1
  }
  return counts
}

/**
 * The carriers `searchByKeywords` may credit: per harvest keyword, each
 * carrier's owner, in code-unit order of name.
 */
export function feedCarriersByKeyword(
  state: FeedState,
  harvestKeywords: readonly string[],
): Map<string, Map<string, string | null>> {
  const byKeyword = new Map<string, Map<string, string | null>>()
  for (const keyword of harvestKeywords) byKeyword.set(keyword, new Map())
  for (const [name, carrier] of [...state.carriers].sort(([a], [b]) => compareStrings(a, b))) {
    for (const keyword of carrier.keywords) byKeyword.get(keyword)?.set(name, carrier.owner)
  }
  return byKeyword
}

/** Which owners' cells one keyword pages to verify its feed-only names. */
export interface FeedVerificationPlan {
  /** Owners whose `keywords:K maintainer:U` cell is paged, in order. */
  readonly owners: readonly string[]
  /** Each chosen owner's feed-only names, sorted. */
  readonly namesOf: ReadonlyMap<string, readonly string[]>
  /** Feed-only names not checked this run: no owner, or an owner past the budget. */
  readonly unverified: readonly string[]
  /** Distinct owners holding feed-only names. */
  readonly ownersTotal: number
}

/**
 * Choose up to `budget` owners in code-unit order, rotated by `seed` (the
 * next state's `seq`), so successive runs check different owners when
 * there are more than the budget (spec section 4.5).
 */
export function planFeedVerification(
  feedOnly: readonly string[],
  ownerOf: ReadonlyMap<string, string | null>,
  budget: number,
  seed: number,
): FeedVerificationPlan {
  const byOwner = new Map<string, string[]>()
  const unverified: string[] = []
  for (const name of [...feedOnly].sort(compareStrings)) {
    const owner = ownerOf.get(name) ?? null
    if (owner === null) {
      unverified.push(name)
      continue
    }
    const names = byOwner.get(owner)
    if (names === undefined) byOwner.set(owner, [name])
    else names.push(name)
  }
  const all = [...byOwner.keys()].sort(compareStrings)
  const take = Math.min(Math.max(0, budget), all.length)
  const offset = all.length === 0 ? 0 : seed % all.length
  const owners: string[] = []
  for (let i = 0; i < take; i += 1) {
    const owner = all[(offset + i) % all.length]
    if (owner !== undefined) owners.push(owner)
  }
  const chosen = new Set(owners)
  for (const owner of all) {
    if (!chosen.has(owner)) unverified.push(...(byOwner.get(owner) ?? []))
  }
  return {
    owners,
    namesOf: new Map(owners.map((owner): [string, string[]] => [owner, byOwner.get(owner) ?? []])),
    unverified: unverified.sort(compareStrings),
    ownersTotal: all.length,
  }
}

/** What the feed step did for one keyword in one run (spec section 4.7). */
export interface FeedCoverage {
  readonly keyword: string
  /** Carriers of the keyword no search cell had served when the step ran. */
  readonly feedOnly: number
  /** The step's own delta on the keyword's union: credited names plus any
   * other name a verification cell served. */
  readonly supplied: number
  readonly ownersVerified: number
  readonly ownersTotal: number
  readonly verified: number
  readonly unverified: number
  /** Feed-only names their owner's cell did not serve: neither listed nor
   * credited. Sorted. */
  readonly disagreed: readonly string[]
}

/** What one run's feed read did (spec section 4.7). */
export interface FeedRunReport {
  /** False when the head or the first page could not be read, or the
   * stored cursor is past the head: nothing from the feed is listed or
   * credited, and the run is today's search-only harvest. */
  readonly available: boolean
  /** Why the feed is unavailable, or where paging stopped early; empty when
   * it read to the head. */
  readonly note: string
  readonly fromSeq: number
  readonly toSeq: number
  readonly pages: number
  /** Names chosen to read, pending first. */
  readonly selected: number
  /** Of those, the reads that were started: `selected - unreached`. */
  readonly read: number
  readonly failed: number
  readonly unreached: number
  /** Matching ids the package-name rule refused. */
  readonly refused: number
  /** Pending names after the merge. */
  readonly pending: number
  /** Carriers per harvest keyword after the merge. */
  readonly carriers: Readonly<Record<string, number>>
}

/** What `searchByKeywords` takes from the feed. */
export interface FeedInput {
  /** Per harvest keyword, each carrier's owner. Empty when the feed is unavailable. */
  readonly carriers: ReadonlyMap<string, ReadonlyMap<string, string | null>>
  /** Rotation seed for `planFeedVerification`: the next state's `seq`. */
  readonly seed: number
  /** Called once per harvest keyword with what the feed step did, BEFORE
   * any throw, so the line reaches the log on the run that needs it. */
  readonly onCoverage?: (coverage: FeedCoverage) => void
}

/** No feed: `searchByKeywords` behaves exactly as it did before the feed existed. */
export const NO_FEED: FeedInput = { carriers: new Map(), seed: 0 }

/** One skimmable line for the build report and the CI log (spec section 4.7). */
export function describeFeedRun(report: FeedRunReport): string {
  if (!report.available) {
    return `change feed unavailable: ${escapeCell(report.note)}; no feed name was listed or credited`
  }
  const carriers = Object.keys(report.carriers).sort(compareStrings)
    .map(keyword => `${escapeCell(keyword)} ${report.carriers[keyword] ?? 0}`)
    .join(', ')
  const stopped = report.note === '' ? '' : `, ${escapeCell(report.note)}`
  return `change feed: seq ${report.fromSeq} -> ${report.toSeq} (${report.pages} page(s)${stopped}); `
    + `read ${report.read} of ${report.selected} selected (${report.failed} failed, ${report.unreached} not reached, `
    + `${report.refused} refused); ${report.pending} pending; carriers: ${carriers}`
}

/** One line per keyword, beside the publisher-axis line (spec section 4.7). */
export function describeFeedCoverage(coverage: FeedCoverage): string {
  const parts = [`owners verified ${coverage.ownersVerified} of ${coverage.ownersTotal}`]
  if (coverage.unverified > 0) parts.push(`${coverage.unverified} unverified`)
  if (coverage.disagreed.length > 0) {
    parts.push(`${coverage.disagreed.length} disagreed: ${coverage.disagreed.map(escapeCell).join(', ')}`)
  }
  return `keywords:${escapeCell(coverage.keyword)} feed supplied ${coverage.supplied} (${parts.join('; ')})`
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * Read a run report back off a `--harvest-from` handoff. Every field is
 * interpolated into a PUBLISHED build report, so a record that does not
 * carry it -- or carries a contradiction -- throws, as
 * `parseKeywordShortfall` does.
 */
export function parseFeedRunReport(value: unknown, where: string, harvestKeywords: readonly string[]): FeedRunReport {
  const fail = (what: string): never => {
    throw new Error(`${where}: change-feed report ${what}; re-run the harvest that wrote it`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('is not an object')
  const r = value as Record<string, unknown>
  const count = (field: string): number => {
    const n = r[field]
    return isCount(n) ? n : fail(`has no integer \`${field}\``)
  }
  const available = r.available
  if (typeof available !== 'boolean') return fail('has no boolean `available`')
  const note = r.note
  if (typeof note !== 'string') return fail('has no string `note`')
  const rawCarriers = r.carriers
  if (rawCarriers === null || typeof rawCarriers !== 'object' || Array.isArray(rawCarriers)) return fail('has no `carriers` object')
  const carriers: Record<string, number> = {}
  for (const keyword of harvestKeywords) {
    const n = (rawCarriers as Record<string, unknown>)[keyword]
    carriers[keyword] = isCount(n) ? n : fail(`has no carrier count for \`${keyword}\``)
  }
  const report: FeedRunReport = {
    available, note,
    fromSeq: count('fromSeq'), toSeq: count('toSeq'), pages: count('pages'),
    selected: count('selected'), read: count('read'), failed: count('failed'),
    unreached: count('unreached'), refused: count('refused'), pending: count('pending'),
    carriers,
  }
  if (report.toSeq < report.fromSeq) return fail(`moves the cursor backwards (${report.fromSeq} -> ${report.toSeq})`)
  if (report.read + report.unreached !== report.selected) return fail('counts reads that do not add up to what it selected')
  if (report.failed > report.read) return fail('reports more failed reads than reads')
  if (!report.available && (report.pages > 0 || report.selected > 0 || report.toSeq !== report.fromSeq)) {
    return fail('reports reading a feed it calls unavailable')
  }
  return report
}

/** Read one coverage record back off a `--harvest-from` handoff; see `parseFeedRunReport`. */
export function parseFeedCoverage(value: unknown, where: string, harvestKeywords: readonly string[]): FeedCoverage {
  const fail = (what: string): never => {
    throw new Error(`${where}: change-feed coverage record ${what}; re-run the harvest that wrote it`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('is not an object')
  const c = value as Record<string, unknown>
  const count = (field: string): number => {
    const n = c[field]
    return isCount(n) ? n : fail(`has no integer \`${field}\``)
  }
  const keyword = c.keyword
  if (typeof keyword !== 'string' || !harvestKeywords.includes(keyword)) return fail('has no harvest `keyword`')
  const rawDisagreed = c.disagreed
  if (!Array.isArray(rawDisagreed)) return fail('has no `disagreed` array')
  const disagreed: string[] = []
  for (const name of rawDisagreed as unknown[]) {
    if (!isFeedPackageName(name)) return fail('names a disagreeing package outside the package-name rule')
    disagreed.push(name)
  }
  const coverage: FeedCoverage = {
    keyword,
    feedOnly: count('feedOnly'), supplied: count('supplied'),
    ownersVerified: count('ownersVerified'), ownersTotal: count('ownersTotal'),
    verified: count('verified'), unverified: count('unverified'),
    disagreed,
  }
  if (coverage.verified + coverage.unverified + coverage.disagreed.length !== coverage.feedOnly) {
    return fail('splits its feed-only names into parts that do not add up')
  }
  if (coverage.ownersVerified > coverage.ownersTotal) return fail('verified more owners than it holds')
  if (coverage.supplied < coverage.verified + coverage.unverified) return fail('supplied fewer names than it credited')
  return coverage
}
