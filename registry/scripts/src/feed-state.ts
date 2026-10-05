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
  // Read, and not a carrier: no harvest keyword, deprecated, another 4xx,
  // too large, or not JSON. The manifest was read -- the `no-manifest`
  // side of the line CLAUDE.md draws -- so the name is dropped.
  | { readonly kind: 'not-carrier'; readonly name: string }
  // A 404, or a row the feed marks deleted.
  | { readonly kind: 'gone'; readonly name: string }
  // A transport failure, a deadline, a 5xx or 429 after retries, or the
  // manifest of another package: the `fetch-failed` side. Kept, retried.
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
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return { kind: 'not-carrier', name }
  const m = manifest as { name?: unknown; keywords?: unknown; deprecated?: unknown; maintainers?: unknown }
  if (typeof m.name !== 'string') return { kind: 'not-carrier', name }
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
