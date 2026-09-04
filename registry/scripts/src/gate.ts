import { distance } from 'fastest-levenshtein'
import { githubOwnerName, isHarnessRepo } from './github-repo.ts'
import { isOwnPackage } from './own.ts'
import { parseCatalogSection } from './schema.ts'
import type { RegistryConfig } from './config.ts'
import type { Candidate, CatalogSection, Rejection } from './types.ts'

/**
 * Maximum edit distance to a verified name that still trips the typosquatting
 * hold. A starting point tunable against the observed false-positive rate;
 * changing it touches this constant and its tests, not the process.
 */
export const SIMILARITY_THRESHOLD = 2

/**
 * Maximum length of a derived `summary.en`. Mirrors the `max(200)` the
 * author-facing schema already imposes on a declared summary, so a derived
 * one respects the same published limit rather than a different one.
 */
export const DERIVED_SUMMARY_MAX_LENGTH = 200

/**
 * Truncate to `maxLength` UTF-16 code units without splitting a surrogate pair.
 *
 * `String.prototype.slice` counts code units, so cutting at a fixed length can
 * land BETWEEN the two halves of an astral character (an emoji, most CJK
 * extension characters) and leave a lone surrogate in the result. That value
 * reaches `plugins.json`, the file every reader downloads: `JSON.stringify`
 * escapes the orphan as `\ud83d`, so the artifact stays valid JSON and its
 * content hash stays stable — which is exactly why nothing here would notice —
 * but any consumer that parses it and re-encodes UTF-8 fails on it (Python
 * raises `UnicodeEncodeError: surrogates not allowed`). Dropping the orphan
 * costs the author one character of a summary that was being cut anyway.
 *
 * Shared by both derived-summary sites — `gate.ts` and `repo-gate.ts` — rather
 * than written out twice; a bound that exists in two copies is a bound that
 * gets fixed in one.
 * @param value - the text to truncate.
 * @param maxLength - the maximum number of UTF-16 code units to keep.
 * @returns `value`, or its first `maxLength` code units with a trailing
 *   unpaired high surrogate removed.
 */
export function truncateWholeCharacters(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const cut = value.slice(0, maxLength)
  const last = cut.charCodeAt(cut.length - 1)
  // A HIGH surrogate in final position is the first half of a pair whose
  // second half the cut just removed: dropping it reads better than replacing
  // it mid-word. A LOW surrogate there is usually a complete pair ending at
  // the bound and is kept — but it can also be an orphan that was already in
  // the text, which this function deliberately does NOT try to judge. Every
  // orphan the input carried in is handled once, for every field of every
  // entry, at the emit boundary (see `emit.ts`); this function's only job is
  // not to CREATE one, because dropping a half-character reads better than
  // publishing a replacement character in the middle of a word.
  return last >= 0xD800 && last <= 0xDBFF ? cut.slice(0, -1) : cut
}

/**
 * Maximum length of a `license` string. npm takes the field verbatim and it
 * reaches every published entry; a value past this is not an SPDX identifier
 * (the longest expression in use, `Apache-2.0 WITH LLVM-exception`, is 30
 * characters). Bounded HERE and not in `toCandidate`, so the rejection can say
 * what is actually wrong: nulling the field in the shell would publish
 * "Declares no license." for a package that declared a one-megabyte one.
 */
export const LICENSE_MAX_LENGTH = 128

/**
 * Maximum length of a `repository` URL. A GitHub URL is under 100 characters;
 * the headroom covers a self-hosted path. Same reasoning as
 * {@link LICENSE_MAX_LENGTH} for why the bound is a gate rule.
 */
export const REPOSITORY_MAX_LENGTH = 512

/**
 * Maximum length of a package `name` — npm's own limit, so a longer one is not
 * a name npm could have published.
 *
 * This bound comes FIRST in {@link gate}, ahead of every other rule, because
 * the name is also the rejection's own key: `emit` prints it as the first
 * column of `report.md`, so an unbounded name puts its megabyte into the
 * published report by way of the rejection that was meant to stop it. Checked
 * first, every later rejection carries a name already inside the bound.
 */
export const NAME_MAX_LENGTH = 214

/**
 * Maximum length of a `version` string. `dist-tags.latest` reaches
 * `plugins.json` AND `manifest.lock`, which is committed daily. A semver
 * version with a prerelease and build metadata is well under 60 characters;
 * this leaves room for an unusual one and none for a payload.
 */
export const VERSION_MAX_LENGTH = 128

/**
 * Maximum length of a `dist.integrity` string. One `sha512-` SRI hash is 95
 * characters (`sha512-` plus 88 of base64), and SRI permits a space-separated
 * list, so the bound holds a couple of them and nothing more.
 */
export const INTEGRITY_MAX_LENGTH = 256

/**
 * Maximum length of a `publishedAt` timestamp. npm writes an ISO 8601 instant,
 * 24 characters (`2026-09-04T12:00:00.000Z`); the rest is headroom for a
 * different offset form.
 */
export const PUBLISHED_AT_MAX_LENGTH = 64

/**
 * Maximum length of a `publisher` account name. The value is the registry's
 * own statement of who pushed this version — provenance rather than
 * decoration (see `Candidate.publisher` for why it is not `author`) — and it
 * reaches every published entry verbatim.
 */
export const PUBLISHER_MAX_LENGTH = 128

/**
 * Maximum bytes of `plugins.json` one entry's UNTRUSTED payload may occupy:
 * every field the gate resolves from the packument, serialized exactly as
 * `emit` will serialize it.
 *
 * Each field above is bounded on its own, and their PRODUCT was the ceiling.
 * Measured through the real serializer against the peer bounds this budget was
 * written to answer — 200 names of 214 characters — one npm entry cost 49,055
 * bytes, 44.2 KiB of it `peers` alone. Against the live catalog of 2026-09-04
 * — 3,514 npm plus 5,908 github entries, 7.51 MB, 797 B average — that was an
 * aggregate ceiling near 186 MiB, and 100 hostile packages adding 4.7 MB to a
 * 7.2 MB file.
 *
 * Those peer bounds have since been cut to 128 names of 128 characters, taking
 * the peers block to 17,959 bytes and the whole entry to 21,775. The peers
 * block alone is still 1.46x this budget, deliberately: a field bound says what
 * one value may look like, this says what a whole entry may cost, and they are
 * not jointly satisfiable at their limits. So the aggregate is capped by THIS
 * number and not by the peer bounds — at 63 MiB, not 186.
 *
 * 12 KiB is chosen against measurement. The worst entry the live data COULD
 * hold — every maximum observed on 2026-09-04 in one entry, which is a
 * ceiling and not a real package: name 214, repository 108, license 37, both
 * summaries 200 CJK characters (599 UTF-8 bytes each), 20 capabilities of 14,
 * 58 peers of 50 — measures 6,261 bytes. So the budget is 1.96x anything
 * listed today and drops none of it, while taking the per-entry ceiling from
 * 47.9 KiB to 12.1 KiB (the payload plus the 109 bytes of trusted keys below)
 * and the aggregate from ~186 MiB to ~63 MiB.
 *
 * Deliberately NOT jointly satisfiable with the per-field bounds: a field
 * bound says what one value may look like, this says what the whole entry may
 * cost, and a package that maxes out every field at once is refused. That is
 * the point of having both — a per-field bound can only ever cap one part, and
 * the list of parts has now been written short twice: `capabilities` capped
 * its count and not its item length, and the identity fields above were left
 * out of the round that set out to bound every published field.
 *
 * The excluded remainder is the trusted half of an `Entry`: `metadata`,
 * `source`, `added`, `tier` (109 bytes together, measured), the github-only
 * `repo`/`subdir`/`tarball`, and `review`, which comes from `verified.yml` and
 * is human-authored. None of it is third-party text.
 */
export const ENTRY_PAYLOAD_MAX_BYTES = 12 * 1024

/**
 * The bytes one entry adds to `plugins.json`.
 *
 * Serialized in a one-element `plugins` array, which is the nesting the real
 * file has, so the indentation `JSON.stringify(…, null, 2)` adds is counted
 * rather than estimated; the empty envelope is subtracted so the number is the
 * entry's own footprint. Counted in UTF-8 bytes, not code units: a CJK summary
 * costs a reader three bytes per character, and counting code units would let
 * one entry occupy three times the budget.
 * @param payload - the untrusted fields of one entry, in emitted key order.
 * @returns the UTF-8 byte cost of that payload inside `plugins.json`.
 */
export function entryPayloadBytes(payload: unknown): number {
  const encoder = new TextEncoder()
  const filled = JSON.stringify({ plugins: [payload] }, null, 2)
  const empty = JSON.stringify({ plugins: [] }, null, 2)
  return encoder.encode(filled).length - encoder.encode(empty).length
}

/** A candidate that passed every gate rule, with its optional fields resolved. */
export interface Accepted {
  candidate: Candidate
  catalog: CatalogSection
  integrity: string
  publishedAt: string
  repository: string
  license: string
  /** Whether `catalog` is the author's declaration or derived from npm metadata. */
  metadata: 'declared' | 'derived'
}

/** Build one rejection. */
function reject(
  name: string,
  code: Rejection['code'],
  detail: string,
  replacement?: string,
): { ok: false; rejection: Rejection } {
  return {
    ok: false,
    rejection: {
      name, code, detail,
      ...(replacement !== undefined ? { replacement } : {}),
    },
  }
}

/**
 * Apply every admission rule to one candidate.
 *
 * Order matters in one place: denial is checked before similarity, so a
 * lookalike a human already adjudicated reports the adjudication rather than
 * the hold that prompted it.
 * @param candidate - the package as fetched from npm.
 * @param config - the human-authored registry files.
 * @returns the accepted candidate, or a rejection carrying an author-readable reason.
 */
export function gate(
  candidate: Candidate,
  config: RegistryConfig,
): { ok: true; accepted: Accepted } | { ok: false; rejection: Rejection } {
  const { name } = candidate

  // First, ahead of every other rule: the name is this rejection's own key and
  // `report.md`'s first column, so an unbounded one is republished by the very
  // rejection meant to stop it. The row names the cut prefix and says so.
  if (name.length > NAME_MAX_LENGTH) {
    return reject(`${truncateWholeCharacters(name, NAME_MAX_LENGTH)}…`, 'no-manifest',
      `Declares a package name longer than ${NAME_MAX_LENGTH} characters, which is past npm's own limit, so it cannot be listed; the name in this row is cut to that length.`)
  }

  if (isOwnPackage(name)) {
    return reject(name, 'self',
      'This is the shop itself, so it is not listed on its own shelf; install it with dsh plugin add.')
  }

  // Denied by npm name, or by the repository this package declares. A denial
  // names a PROJECT, and a project has two published spellings: `evil/dsh-x`
  // on GitHub and `dsh-x` on npm. Checking only the name let the author of a
  // denied repository publish the same code to npm, win the bundle name (npm
  // wins by design), and get the repository reported `shadowed-by-npm` while
  // `denied[]` — the list the Host's install gate consults — stayed empty.
  //
  // Case-folded on the repo side, as everywhere else on that keyspace. The
  // declared repository is attacker-controlled text, so `githubOwnerName`
  // returns null for anything that is not a plain
  // `https://github.com/<owner>/<name>` URL and the lookup is simply skipped
  // — the no-repository and harness-repository checks below still run.
  const declaredRepo = githubOwnerName(candidate.repository)
  const denial = config.denied.get(name)
    ?? (declaredRepo === null
      ? undefined
      : config.deniedRepos.get(`${declaredRepo.owner}/${declaredRepo.name}`.toLowerCase()))
  if (denial !== undefined) {
    const suffix = denial.replacement === undefined ? '' : ` Known replacement: ${denial.replacement}.`
    return reject(name, 'denied', `Denied by the registry: ${denial.reason}${suffix}`, denial.replacement)
  }

  if (!candidate.hasBundle) {
    return reject(name, 'no-bundle',
      'Declares no dsh.bundle, so it is a library rather than an installable plugin.')
  }
  if (candidate.deprecated) return reject(name, 'deprecated', 'Marked deprecated on npm.')
  if (candidate.version.length > VERSION_MAX_LENGTH) {
    return reject(name, 'no-manifest',
      `Declares a version string longer than ${VERSION_MAX_LENGTH} characters, so it is not a version the snapshot can record.`)
  }
  if (candidate.license === null || candidate.license === '') {
    return reject(name, 'no-license', 'Declares no license.')
  }
  if (candidate.license.length > LICENSE_MAX_LENGTH) {
    return reject(name, 'no-license',
      `Declares a license string longer than ${LICENSE_MAX_LENGTH} characters, so it is not an SPDX identifier.`)
  }
  if (candidate.repository === null || candidate.repository === '') {
    return reject(name, 'no-repository',
      'Declares no repository, so the published code cannot be audited.')
  }
  if (candidate.repository.length > REPOSITORY_MAX_LENGTH) {
    return reject(name, 'no-repository',
      `Declares a repository URL longer than ${REPOSITORY_MAX_LENGTH} characters, so it cannot be audited as a source location.`)
  }
  if (isHarnessRepo(candidate.repository)) {
    return reject(name, 'harness-repository',
      "Declares deepseek-ai/deepseek-harness as its repository, which is the host project rather than this plugin's source, so the published code cannot be audited there.")
  }
  if (candidate.integrity === null || candidate.integrity === '') {
    return reject(name, 'no-integrity',
      'The published version carries no dist.integrity, so it cannot be recorded in the snapshot.')
  }
  if (candidate.integrity.length > INTEGRITY_MAX_LENGTH) {
    return reject(name, 'no-integrity',
      `The published version's dist.integrity is longer than ${INTEGRITY_MAX_LENGTH} characters, so it cannot be recorded in the snapshot.`)
  }
  if (candidate.publishedAt === null) {
    return reject(name, 'no-publish-time', 'npm reports no publication time for this version.')
  }
  if (candidate.publishedAt.length > PUBLISHED_AT_MAX_LENGTH) {
    return reject(name, 'no-publish-time',
      `npm reports a publication time longer than ${PUBLISHED_AT_MAX_LENGTH} characters, which is not a timestamp.`)
  }
  // Absent stays absent — the bound judges a value npm actually carried, and
  // an entry with no publisher simply has no field to bound. The gate can only
  // reject it and not drop it: `assignTier` reads `candidate.publisher`
  // directly, so nulling it here would take a change to a module that has no
  // business making a policy decision.
  if (candidate.publisher !== undefined && candidate.publisher.length > PUBLISHER_MAX_LENGTH) {
    return reject(name, 'no-manifest',
      `Names a publishing account longer than ${PUBLISHER_MAX_LENGTH} characters, which is not an npm account name.`)
  }
  let catalog: CatalogSection
  let metadata: 'declared' | 'derived'
  if (candidate.catalog === undefined || candidate.catalog === null) {
    // No dsh.catalog: derive a listing from npm metadata rather than reject,
    // since the field is optional (§6.1). A missing description leaves
    // nothing to show, which is a rejection distinct from a malformed catalog.
    const description = candidate.description?.trim()
    if (description === undefined || description === '') {
      return reject(name, 'no-summary',
        'Declares no dsh.catalog and npm reports no description, so there is nothing to list.')
    }
    catalog = {
      // LLM-assigned when the classifier has a row for this name (spec
      // 2026-08-26-llm-categorization-design.md); `other` until it does.
      category: config.categories.get(name) ?? 'other',
      summary: { en: truncateWholeCharacters(description, DERIVED_SUMMARY_MAX_LENGTH) },
      capabilities: [],
    }
    metadata = 'derived'
  } else {
    // A declared dsh.catalog that fails validation is a rejection, never a
    // silent fallback to derived: the author declared the section and made a
    // mistake worth reporting, not one worth hiding.
    const parsed = parseCatalogSection(candidate.catalog)
    if (!parsed.ok) return reject(name, 'invalid-catalog', parsed.error)
    catalog = parsed.value
    metadata = 'declared'
  }

  // The hold is skipped for exactly one identity: an npm package a human
  // reviewed AS AN NPM PACKAGE. Both halves of that sentence are load-bearing.
  //
  // "reviewed" (B-4): verifying `dsh-tool-a` and `dsh-tool-b` — distance 1,
  // the shape of a same-author suite — used to delist both, each held against
  // the other, because the hold skipped only the candidate's own exact name.
  // A review is already the adjudication the hold asks for.
  //
  // "as an npm package" (A-2): a name verified by `reviewedCommit` or
  // `reviewedSha256` belongs to a GITHUB entry, which is a different
  // identity. Skipping at distance 0 let any npm publisher take that bundle
  // name, shadow the verified repository (`shadowed-by-npm`) and inherit its
  // shelf position and `added` date. `allowed-similar.yml` — the npm-name
  // form — is the human escape when the npm package really is the same
  // project.
  //
  // The `reviewedVersion !== undefined` half is DEFENCE IN DEPTH, not a live
  // branch: since a github review is keyed by its repository, an npm name
  // cannot reach one at all. Measured against the `good/dsh-x` fixture,
  // `verified.get('dsh-x')` is undefined and `verifiedNames` is ['dsh-x'], so
  // what actually holds the npm publisher is the probe set plus the absence
  // of the `edits === 0` skip. Mutating this half alone leaves the suite
  // green, and no contrived fixture is added to make it red — the same
  // reasoning `assignTier` records for the mirror-image case.
  const ownReview = config.verified.get(name)
  const verifiedAsThisPackage = ownReview !== undefined && ownReview.reviewedVersion !== undefined
  if (!verifiedAsThisPackage && !config.allowedSimilar.has(name)) {
    for (const verifiedName of config.verifiedNames) {
      const edits = distance(name, verifiedName)
      if (edits > SIMILARITY_THRESHOLD) continue
      return reject(name, 'name-too-similar', edits === 0
        ? `Exactly matches ${verifiedName}, which is verified as a repository rather than as this npm package, so publishing it here is a different identity claiming a reviewed name; held for human adjudication.`
        : `Within ${edits} edit(s) of the verified package ${verifiedName}; held for human adjudication.`)
    }
  }

  // Last, so that every reason naming a single field is reported ahead of it:
  // "your license is too long" tells an author what to fix and "your entry is
  // too big" does not. Only a COMBINATION can reach here — each field is
  // individually bounded above — which is exactly the case the per-field
  // bounds cannot see. The key order mirrors `assignTier`'s so the measured
  // bytes are the bytes `emit` will write.
  const payloadBytes = entryPayloadBytes({
    name,
    version: candidate.version,
    integrity: candidate.integrity,
    publishedAt: candidate.publishedAt,
    repository: candidate.repository,
    license: candidate.license,
    catalog,
    ...(candidate.publisher !== undefined ? { publisher: candidate.publisher } : {}),
    ...(candidate.peers.length > 0 ? { peers: candidate.peers } : {}),
  })
  if (payloadBytes > ENTRY_PAYLOAD_MAX_BYTES) {
    return reject(name, 'no-manifest',
      `Would publish ${payloadBytes} bytes of catalog entry, past the ${ENTRY_PAYLOAD_MAX_BYTES}-byte budget one entry may occupy in plugins.json.`)
  }

  return {
    ok: true,
    accepted: {
      candidate,
      catalog,
      integrity: candidate.integrity,
      publishedAt: candidate.publishedAt,
      repository: candidate.repository,
      license: candidate.license,
      metadata,
    },
  }
}
