import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { valid as semverValid } from 'semver'
import { parse } from 'yaml'
import { z } from 'zod'
import type { MarketRow } from './markets.ts'
import { CATEGORIES, type Category, type Review } from './types.ts'

/**
 * An npm package name as the registry can actually serve one: at most 214
 * characters, an optional `@scope/`, no whitespace, no control characters and
 * no leading `.` or `_`. Uppercase is permitted — npm refuses uppercase for
 * NEW packages but still serves the legacy ones, and a denial has to be able
 * to name one.
 */
const NPM_NAME = /^(?:@[A-Za-z0-9-~][A-Za-z0-9-._~]*\/)?[A-Za-z0-9-~][A-Za-z0-9-._~]*$/

/**
 * A GitHub repository full name, `owner/slug`. Never a leading `@` and always
 * exactly one slash — which is what keeps the repo keyspace from colliding
 * with the npm keyspace inside `denied`, `verified` and `first-seen.yml`.
 */
const REPO_FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/

/** A row that must name an npm package. */
const npmName = z.string().min(1).max(214).regex(
  NPM_NAME,
  'must be an npm package name: no spaces, no newlines, no leading dot or underscore, at most 214 characters',
)

/** A row that may name an npm package or a GitHub repository. */
const npmNameOrRepo = z.string().min(1).max(214).refine(
  value => NPM_NAME.test(value) || REPO_FULL_NAME.test(value),
  { message: 'must be an npm package name or a GitHub owner/slug: no spaces, no newlines, exactly one slash for a repo' },
)

/** A row that must name a GitHub repository. */
const repoFullName = z.string().min(1).max(140).regex(REPO_FULL_NAME, 'must be a GitHub owner/slug')

const verifiedSchema = z.array(z.object({
  name: npmName,
  repo: repoFullName.optional(),
  // Canonical semver, checked here so the build fails with the FILE's name
  // rather than dying inside tier.ts with a bare `Invalid Version`. The
  // canonical form is required, not merely a parseable one: `assignTier`
  // compares this string to the published version exactly, so `v1.2.0` would
  // load and then never match anything.
  reviewedVersion: z.string().min(1).refine(
    value => semverValid(value) === value,
    { message: 'must be a canonical semver version — no leading v, no build metadata, e.g. 1.2.0' },
  ).optional(),
  reviewedCommit: z.string().min(1).optional(),
  reviewedSha256: z.string().min(1).optional(),
  reviewer: z.string().min(1),
  reviewCommit: z.string().min(1),
  notes: z.string().default(''),
}).strict().refine(
  row => row.reviewedVersion !== undefined || row.reviewedCommit !== undefined || row.reviewedSha256 !== undefined,
  { message: 'declare reviewedVersion (npm), reviewedCommit (github), or reviewedSha256 (release tarball)' },
).refine(
  // A github review binds (repo, commit): without the repo there is nothing
  // to bind it to, and the review would attach to a bundle name that up to 14
  // repositories claim.
  row => (row.reviewedCommit === undefined && row.reviewedSha256 === undefined) || row.repo !== undefined,
  { message: 'a github review must name the repository it covers: repo: owner/slug' },
).refine(
  // An npm review is pinned by the version alone. A `repo:` beside it would
  // be keyed as a github review and match nothing.
  row => row.reviewedVersion === undefined || row.repo === undefined,
  { message: 'repo: belongs to a github review (reviewedCommit / reviewedSha256), not to an npm review' },
))

const deniedSchema = z.array(z.object({
  name: npmNameOrRepo,
  reason: z.string().min(1),
  replacement: npmNameOrRepo.optional(),
}).strict())

const allowedSimilarSchema = z.array(npmNameOrRepo)

const categoriesSchema = z.array(z.object({
  name: z.string().min(1),
  category: z.enum(CATEGORIES),
}).strict())

/** `markets.yml`: every name the client's shop-like NAME filter catches, and
 * whether it IS a competing plugin market. Both verdicts are recorded, not
 * just the exemptions — that memory is what stops the daily classifier
 * re-asking about a name, and stops an LLM flip-flopping one in and out of
 * the shelf and churning the content hash with it. The verdict decides what
 * happens; `by` records who judged it, and is what lets the build report name
 * the withholdings that rest on a classifier pass alone. `reason` says what
 * the plugin actually is, because the name already misled once. */
const marketsSchema = z.array(z.object({
  name: z.string().min(1),
  market: z.boolean(),
  by: z.enum(['human', 'llm']),
  reason: z.string().min(1),
}).strict())

const firstSeenSchema = z.array(z.object({
  name: z.string().min(1),
  added: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict())

/** The human-authored inputs to one catalog build. */
export interface RegistryConfig {
  /**
   * Review index, keyed by the identity the review covers: an npm review by
   * its package `name`, a github review by its lowercased `repo`. The two
   * keyspaces cannot collide — `owner/slug` carries a slash and never a
   * leading `@` — so one map holds both, exactly as {@link denied} does.
   */
  verified: Map<string, Review>
  /**
   * Every package or bundle name a review covers. This — and never
   * {@link verified}'s keys — is the typosquatting hold's probe set: a
   * Levenshtein distance from an npm name to `owner/slug` is meaningless,
   * because the owner prefix drowns the distance.
   */
  verifiedNames: Set<string>
  /** Package name to the reason it is excluded, plus the known replacement
   * when a human recorded one. Keyed as written. */
  denied: Map<string, { reason: string; replacement?: string }>
  /** The `owner/slug`-shaped denials, lowercased. Read by both gates: a
   * denial names a project, and a project has two published spellings. */
  deniedRepos: Map<string, { reason: string; replacement?: string }>
  /** Names cleared past the similarity hold, as written. */
  allowedSimilar: Set<string>
  /** The `owner/slug`-shaped clearances, lowercased — the only form the
   * GitHub channel honours. */
  allowedSimilarRepos: Set<string>
  /** Names cleared past the client's shop-like name filter: judged NOT to be
   * competing plugin markets, so the shelf shows them. The verdict decides
   * this, not who recorded it; {@link marketRows} is what tells the build
   * report which withholdings rest on a classifier pass alone. */
  notAShop: Set<string>
  /** Every name `markets.yml` has a verdict for, either way. The classifier
   * asks only about names absent from this set. */
  marketsJudged: Set<string>
  /** The rows as written, so the classify step can merge into them and write
   * the file back without re-reading it. */
  marketRows: MarketRow[]
  /** Package name to its LLM-assigned category (spec 2026-08-26-llm-categorization-design.md). */
  categories: Map<string, Category>
  /** Package name to the date it first entered the catalog (YYYY-MM-DD). */
  firstSeen: Map<string, string>
}

/**
 * Parse one file, failing loudly with the file's name in the message. A
 * malformed registry file must stop the build: silently listing nothing looks
 * identical to an empty ecosystem.
 *
 * The message is the whole product of this function, because its reader is a
 * human with a broken file. Three things it used to get wrong: a row was
 * identified by its zero-based index rather than by the package name sitting
 * in it; an empty or comments-only file was reported as `got object`, since
 * `parse('')` is `null` and `typeof null === 'object'`; and a leading UTF-8
 * BOM failed inside the YAML parser as `Unexpected scalar at node end at line
 * 1, column 4`, naming no file and pointing at a line that looks correct.
 */
function parseFile<T>(label: string, text: string, schema: z.ZodType<T>): T {
  // A BOM is an encoding marker, not content. yaml reads it as part of the
  // first token and fails several characters later.
  const raw: unknown = parse(text.replace(/^\ufeff/, ''))
  if (raw === null || raw === undefined) {
    throw new Error(`${label}: the file has no YAML document (it is empty, or only comments); write [] for an empty list`)
  }
  if (!Array.isArray(raw)) throw new Error(`${label}: expected a YAML list, got ${typeof raw}`)
  const result = schema.safeParse(raw)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  if (issue === undefined) throw new Error(`${label}: invalid`)
  // The first path segment is the row index for every schema here (they are
  // all arrays), so the row can be looked up and named. A refinement failure
  // has ONLY that segment, which is exactly the case where the index alone
  // told the reader least.
  const [first, ...rest] = issue.path
  const row = typeof first === 'number' ? raw[first] : undefined
  const name = typeof row === 'object' && row !== null && typeof (row as { name?: unknown }).name === 'string'
    ? (row as { name: string }).name
    : undefined
  const where = typeof first === 'number'
    ? `row ${first + 1}${name === undefined ? '' : ` (${name})`}`
    : issue.path.join('.')
  const field = typeof first === 'number' ? rest.join('.') : ''
  throw new Error([label + ':', where, field, issue.message].filter(part => part !== '').join(' '))
}

/**
 * Insert into a map, failing loudly on a name already present. `verified.yml`
 * and `denied.yml` are each a human review record for one package; a second
 * entry for the same name would otherwise silently keep whichever one was
 * inserted last, with the outcome depending on file order.
 */
function setUnique<V>(map: Map<string, V>, label: string, name: string, value: V): void {
  if (map.has(name)) throw new Error(`${label}: duplicate entry for ${name}`)
  map.set(name, value)
}

/**
 * Parse the six registry files from their text.
 * @param input - the raw text of each file.
 * @returns the parsed configuration.
 * @throws when any file is malformed, or when `verified.yml`, `denied.yml`,
 *   `markets.yml`, `categories.yml`, or `first-seen.yml` lists the same
 *   package name twice.
 */
export function parseRegistryConfig(
  input: {
    verified: string
    denied: string
    allowedSimilar: string
    /** Optional so the five callers that predate this file stay valid; the
     * loader always passes it. */
    markets?: string
    categories: string
    firstSeen: string
  },
): RegistryConfig {
  const verified = new Map<string, Review>()
  const verifiedNames = new Set<string>()
  for (const row of parseFile('verified.yml', input.verified, verifiedSchema)) {
    // The key is the identity the review covers, so two repositories sharing
    // a bundle name can each hold their own review — and a second review of
    // the SAME repository still throws.
    const key = row.repo === undefined ? row.name : row.repo.toLowerCase()
    setUnique(verified, 'verified.yml', key, {
      reviewedVersion: row.reviewedVersion,
      reviewedCommit: row.reviewedCommit,
      reviewedSha256: row.reviewedSha256,
      repo: row.repo,
      reviewer: row.reviewer,
      reviewCommit: row.reviewCommit,
      notes: row.notes,
    })
    verifiedNames.add(row.name)
  }
  const denied = new Map<string, { reason: string; replacement?: string }>()
  const deniedRepos = new Map<string, { reason: string; replacement?: string }>()
  for (const row of parseFile('denied.yml', input.denied, deniedSchema)) {
    const value = {
      reason: row.reason,
      ...(row.replacement !== undefined ? { replacement: row.replacement } : {}),
    }
    setUnique(denied, 'denied.yml', row.name, value)
    // A denial written as `owner/slug` gets a second, case-folded index. Both
    // gates read it: the repo gate because GitHub resolves repository names
    // case-insensitively (B-8), and the npm gate because the author of a
    // denied repository can publish the same code to npm and win the bundle
    // name (B-6).
    if (REPO_FULL_NAME.test(row.name)) setUnique(deniedRepos, 'denied.yml', row.name.toLowerCase(), value)
  }
  const allowedSimilarRows = parseFile('allowed-similar.yml', input.allowedSimilar, allowedSimilarSchema)
  const allowedSimilar = new Set(allowedSimilarRows)
  // The repo-shaped clearances, case-folded. The GitHub channel honours ONLY
  // this set: a bundle-name clearance cleared every repository using the name
  // (A-4).
  const allowedSimilarRepos = new Set(
    allowedSimilarRows.filter(entry => REPO_FULL_NAME.test(entry)).map(entry => entry.toLowerCase()),
  )
  const marketVerdicts = new Map<string, boolean>()
  const marketRows: MarketRow[] = []
  for (const row of parseFile('markets.yml', input.markets ?? '[]', marketsSchema)) {
    setUnique(marketVerdicts, 'markets.yml', row.name, row.market)
    marketRows.push(row)
  }
  const marketsJudged = new Set(marketVerdicts.keys())
  // The VERDICT decides; `by` only records who said it. One classifier pass
  // is accurate enough for "is this a marketplace FOR dsh plugins" — a narrow
  // question a name and a description usually settle — and `pipeline.ts` puts
  // every LLM-only withholding in the build report so it can be spot-checked.
  //
  // A `by: human` gate was tried on 2026-09-04 (audit D-7) and was wrong in
  // this codebase, in the one direction that matters. This set is the CLEARED
  // list, and the client shows a name that is cleared OR not shop-like
  // (`ShopTab.tsx:920-922`), so routing an LLM `true` into it ADVERTISED 16
  // competing markets the name heuristic had been hiding. The same reading
  // bounds D-7's own severity: a steered `true` on an ordinarily-named plugin
  // withholds nothing, because that name was never shop-like to begin with.
  // What such a row does cost is the re-ask — a recorded verdict is never
  // asked again — which is exactly what the report line exists to surface.
  const notAShop = new Set(marketRows.filter(row => !row.market).map(row => row.name))
  const categories = new Map<string, Category>()
  for (const row of parseFile('categories.yml', input.categories, categoriesSchema)) {
    setUnique(categories, 'categories.yml', row.name, row.category)
  }
  const firstSeen = new Map<string, string>()
  for (const row of parseFile('first-seen.yml', input.firstSeen, firstSeenSchema)) {
    setUnique(firstSeen, 'first-seen.yml', row.name, row.added)
  }
  // A name cannot be reviewed and excluded at once. `gate` checks denial
  // before anything else, so the denial wins and the review becomes dead text
  // nobody notices — including the reviewer who wrote it. Both keyspaces are
  // compared case-folded, because a repository review and a repository denial
  // are both written `owner/slug`.
  const deniedKeys = new Set([...denied.keys()].map(key => key.toLowerCase()))
  for (const key of [...verified.keys(), ...verifiedNames]) {
    if (deniedKeys.has(key.toLowerCase())) {
      throw new Error(
        `verified.yml/denied.yml: ${key} is both reviewed and denied; the denial wins silently, so remove one of the two rows`,
      )
    }
  }
  return {
    verified, verifiedNames, denied, deniedRepos, allowedSimilar, allowedSimilarRepos,
    notAShop, marketsJudged, marketRows, categories, firstSeen,
  }
}

/**
 * Read and parse the registry files from a directory.
 * @param dir - the `registry/` directory.
 * @returns the parsed configuration.
 */
export function loadRegistryConfig(dir: string): RegistryConfig {
  return parseRegistryConfig({
    verified: readFileSync(join(dir, 'verified.yml'), 'utf8'),
    denied: readFileSync(join(dir, 'denied.yml'), 'utf8'),
    allowedSimilar: readFileSync(join(dir, 'allowed-similar.yml'), 'utf8'),
    markets: readOptional(dir, 'markets.yml'),
    categories: readOptional(dir, 'categories.yml'),
    firstSeen: readOptional(dir, 'first-seen.yml'),
  })
}

function readOptional(dir: string, file: string): string {
  const path = join(dir, file)
  return existsSync(path) ? readFileSync(path, 'utf8') : '[]'
}

/**
 * Serialize the first-seen file: header, sorted rows, trailing newline.
 *
 * Names are always JSON-quoted. Quoting at all is because a scoped name starts
 * with `@`, which YAML would otherwise read as a tag; JSON escaping rather
 * than bare double quotes is because this file receives EVERY harvested repo
 * candidate name, gated or not (build.ts), and a GitHub manifest name is
 * unrestricted. An unescaped `"` in one made `loadRegistryConfig` throw on
 * every subsequent build until a human edited the file by hand.
 */
export function serializeFirstSeen(rows: ReadonlyMap<string, string>): string {
  const rowsText = [...rows]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, added]) => `- name: ${JSON.stringify(name)}\n  added: ${added}`)
  const body = rowsText.length === 0 ? ['[]'] : rowsText
  const header = [
    '# First catalog appearance per package name (YYYY-MM-DD). Appended by the daily build;',
    '# a name absent here is simply "first seen today".',
  ].join('\n')
  return `${header}\n${body.join('\n')}\n`
}
