/**
 * Fetching the bytes of a declared icon (design 2026-10-23-shop-plugin-icons
 * §5.1 to §5.3): the impure half of the icon step, between the plan of
 * `icon-plan.ts` and the fold that judges what comes back. Three jobs:
 *
 * 1. {@link readPublishedIcons} reads the icons file the last build published,
 *    whose icons the plan reuses instead of fetching them again.
 * 2. {@link fetchIcon} reads one icon from where its entry installs it: the
 *    tarball npm lists, the file at the commit a git install is pinned to, or
 *    the release asset a rescued entry installs.
 * 3. {@link harvestIcons} runs a plan's fetches, a few at a time, until the
 *    plan is done or its time is.
 *
 * What a fetch hands back is read, not judged. Bytes are checked against the
 * declaration (size, and the file type the extension promises) by the fold in
 * `icon-plan.ts`, which holds that policy where fixtures can drive it. The fetch
 * decides only what the transport can know: whether the artifact was read, and
 * whether the icon is in it. A transport failure is never a refusal (design
 * §5.3, and CLAUDE.md on `no-manifest`): a refusal is the author's to fix and a
 * timeout is not, so anything that says nothing about the artifact is "not yet
 * read" and asked for again on a later build.
 *
 * Every body goes through `readCappedBody`, every inflate carries
 * `maxOutputLength`, and every request through `withTimeout`; a guard test in
 * `github-client.test.ts` scans this module for the first two and one in
 * `npm-client.test.ts` for the third. Author-controlled text this module writes
 * into a reason is quoted and bounded (`echo`): a reason is for the log, and
 * GitHub Actions reads a log line that opens with `::` as a workflow command.
 *
 * @module icon-fetch
 */
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { readTar } from '../../../packages/dsh-plugin-shop/src/shared/tar.ts'
import { downloadReleaseAsset, fetchRobust, MAX_TARBALL_BYTES, rawFileUrl, recordedReleaseUrl } from './github-client.ts'
import { readCappedBody } from './http-body.ts'
import { MAX_CATALOG_ICON_BYTES, sha256Hex } from './icon-bytes.ts'
import { iconDetail, iconLabel, shownPath } from './icon-declaration.ts'
import type { IconFetchResult, IconFetchTarget, IconPlan, IconWork } from './icon-plan.ts'
import type { IconKey } from './icon-state.ts'
import { ICONS_FILE_BUDGET_BYTES, parseIconsFile } from './icons-assemble.ts'
import type { IconsFile } from './icons-assemble.ts'
import { withTimeout } from './npm-client.ts'
import { echo, MAX_INFLATED_BYTES, memberName, normalize, singleRoot } from './release-asset.ts'

/**
 * Where the catalog is published, and so where the last build's `index.json`,
 * and the icons file it points at, are read from. The shop's own default
 * (`DEFAULT_CATALOG_URL` in its host code) is the same address; the registry
 * does not import host code.
 */
export const PUBLISHED_CATALOG_URL = 'https://LivXue.github.io/dsh-plugin-shop/v1/'

/**
 * The most keys one run fetches when `ICON_FETCH_BUDGET` is unset (design
 * §5.3): the first run's, since it fetches every key the record does not know,
 * and after it a build fetches only the keys a new version, commit or tarball
 * has added.
 *
 * The design's sample of 2026-10-23 (§1) read every fourth npm line of
 * `manifest.lock` and found 289 declared icons, so the npm half holds about
 * 1,160 keys (289 x 4) for that first run. GitHub's share was not sampled, and
 * 1,500 leaves about 340 for it. What a run does not reach is "not yet read"
 * and fetched on the next.
 *
 * INFERRED, NOT MEASURED: no run has fetched an icon yet. After the first
 * `main` run, re-measure this and {@link ICON_FETCH_TIME_BUDGET_MS_DEFAULT}
 * against the report's counts and the step's own time, and replace the figures
 * here with the measured ones.
 */
export const ICON_FETCH_BUDGET_DEFAULT = 1500

/**
 * The longest the icon fetches keep STARTING in one run when
 * `ICON_FETCH_TIME_BUDGET_MS` is unset: 15 minutes (design §5.3).
 *
 * What the step can add to the run: its two reads of the published icons file
 * ({@link PUBLISHED_REQUEST_TIMEOUT_MS} each), this budget spent in full, and
 * at most one fetch in flight per worker when it runs out (below). `daily.yml`
 * bounds the job at 180 minutes, and the job already takes over two hours
 * without the step (DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT's comment
 * measures it and does the sum). So the sum is not left to fit by itself: on
 * the daily run build.ts cuts this budget to the time left before the job's
 * own deadline, less a reserve for the fetches' last request and the rest of
 * the build, and a run that reaches the step late starts fewer fetches, or
 * none, and still publishes.
 *
 * A fetch in flight costs at most 5 minutes because each takes the first answer
 * it gets, without a status ladder to wait out: a tarball or an asset is one
 * attempt of at most `tarballTimeoutMs`, which the build sets to
 * `TARBALL_REQUEST_TIMEOUT_MS`, 300 seconds, and a raw file is at most the four
 * attempts of `fetchRobust`'s ladder for a THROW, 134 seconds. A ladder on 429
 * and 5xx as well would hold one fetch through up to six attempts of each and
 * the waits between them. A fetch that is turned away for time, or answered with
 * a status, costs the catalog nothing: its key is "not yet read" and asked for
 * again on the next build.
 *
 * It is a budget on STARTING fetches, not a deadline on them, as
 * `DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT` is for the re-read.
 *
 * INFERRED, NOT MEASURED, like {@link ICON_FETCH_BUDGET_DEFAULT}.
 */
export const ICON_FETCH_TIME_BUDGET_MS_DEFAULT = 15 * 60 * 1000

/**
 * Fetches running at once. The change feed reads packuments from the same
 * registry at this figure (`FEED_READ_CONCURRENCY`), and it bounds what is held
 * in memory at once: each worker holds at most a compressed tarball and what it
 * inflates to, 32 MiB and 64 MiB, so eight hold at most 768 MiB.
 */
export const ICON_FETCH_CONCURRENCY = 8

/**
 * What a fetch reaches the network with.
 *
 * `token` is the job's GitHub token, `''` for none. It goes to
 * raw.githubusercontent.com and nowhere else: not to the npm registry, whose
 * tarballs are public, and not to a release asset's host, since
 * `downloadReleaseAsset` sends no token to any URL by design. `timeoutMs` bounds
 * a request for a raw file, body included, and `tarballTimeoutMs` one for a
 * tarball or an asset.
 *
 * `caps` is for tests, which lower the bounds to values a fixture can reach.
 * `tarballBytes` is the most an npm tarball may be, and defaults to
 * `MAX_TARBALL_BYTES`; a release asset is read by the harvest's own downloader,
 * under that constant. `inflatedBytes` is the most either may inflate to, and
 * defaults to `MAX_INFLATED_BYTES`.
 */
export interface IconTransport {
  fetchImpl: typeof fetch
  sleep: (ms: number) => Promise<void>
  token: string
  timeoutMs: number
  tarballTimeoutMs: number
  caps?: { tarballBytes: number; inflatedBytes: number }
}

/** What `index.json` and its pointer are read under: a few hundred bytes of the catalog's own JSON. */
const PUBLISHED_INDEX_MAX_BYTES = 64 * 1024

/**
 * The most an icons file may be for the build to read it: 1.5 times the budget
 * a file is built under (24 MiB at today's 16). Room above the budget, so a file
 * built under a somewhat larger one than today's is still read, and a bound on
 * what a broken or hostile host can have the build hold.
 */
const PUBLISHED_ICONS_MAX_BYTES = ICONS_FILE_BUDGET_BYTES * 1.5

/**
 * Per-request bound on the two reads of the published catalog, body included.
 * The icons file is under 24 MiB, so this is a floor of some 200 KB/s for the
 * largest file it admits, where a real one is a couple of megabytes. A read that
 * runs out of time is a published file the build could not use, which only costs
 * it a fetch for every icon it would have reused. Exported for build.ts, which
 * counts the two reads in what has to follow the declarations re-read before
 * the job's deadline.
 */
export const PUBLISHED_REQUEST_TIMEOUT_MS = 120_000

/** The registry's host, which an npm tarball is read from and from nowhere else. */
const REGISTRY_HOST = 'registry.npmjs.org'

/** A sha256 as `sha256Hex` writes it, and as the index names the icons file's. */
const SHA256_HEX = /^[0-9a-f]{64}$/

/** A commit as the harvest records it: forty lower-case hexadecimal digits. */
const COMMIT_SHA = /^[0-9a-f]{40}$/

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The bounds a transport reads under: its own where it names them, which only a test does, else the harvest's. */
function capsOf(transport: IconTransport): { tarballBytes: number; inflatedBytes: number } {
  return transport.caps ?? { tarballBytes: MAX_TARBALL_BYTES, inflatedBytes: MAX_INFLATED_BYTES }
}

const notYetRead = (reason: string): IconFetchResult => ({ kind: 'not-yet-read', reason })
const notRead = (detail: string): IconFetchResult => ({ kind: 'not-read', detail })
const refused = (detail: string): IconFetchResult => ({ kind: 'refused', detail })

/**
 * Read the icons file the last build published, so its icons can be reused
 * (design §5.1). The index is read from `baseUrl`, its `icons` pointer followed,
 * and the file checked against the sha256 the pointer names.
 *
 * An index with no `icons` key at all is what a build that published no icon
 * writes (the day every listed icon was withheld, say), and it is an answer: the
 * empty file, after one request. Read as a failure, it had the next build's
 * report say the file could not be read (`describeLostIconsFile`).
 *
 * Returns `null`, and never throws, for anything else short of a file that
 * checks out: a host that does not answer, answers a status, serves too much
 * (the index is read under 64 KiB, the file under 24 MiB), serves text that is
 * no index or no icons file, serves an `icons` pointer that is not one, or
 * serves a file whose sha256 is not the pointer's. A caller reads that as no
 * published file and fetches what it would have reused, which costs requests
 * and nothing else.
 *
 * The pointer stays under the base. It is read from a file on the published
 * host, and a pointer to another host, or above the base on this one, would have
 * the build trust the file and sha256 of wherever it said. The URL is resolved
 * the way a browser would, so `..`, `%2e%2e` and a backslash climb are
 * resolved before the comparison and not after.
 *
 * A file that checks out is not yet all trusted. Its sha256 proves it is the
 * file that was published and says nothing of what is in it, and reuse carries
 * an icon forward by the sha256 it is filed under. So an icon is kept only if its
 * data URL is exactly what this build writes for bytes that hash to that key:
 * it decodes, re-encodes to the same text, and the bytes hash to the key. One
 * that does not is dropped with every source that names it, which sends those
 * keys back to the plan as keys to fetch again.
 * @param fetchImpl - the fetch to read with; it is given a deadline here.
 * @param baseUrl - the directory the catalog is published in, `index.json` in it.
 */
export async function readPublishedIcons(
  fetchImpl: typeof fetch,
  baseUrl: string = PUBLISHED_CATALOG_URL,
): Promise<IconsFile | null> {
  try {
    return await readPublished(withTimeout(fetchImpl, PUBLISHED_REQUEST_TIMEOUT_MS, 'published catalog'), baseUrl)
  } catch {
    // Swallows every way the read can throw: a request that fails or stalls, a
    // body that breaks mid-read, text that is not JSON, a base that is not a
    // URL. Each is a published file this build cannot use, which is the null a
    // caller already handles, and nothing past this point can throw into it.
    return null
  }
}

/** The reads of {@link readPublishedIcons}, which may throw: the caller answers null for it. */
async function readPublished(timed: typeof fetch, baseUrl: string): Promise<IconsFile | null> {
  const base = new URL(baseUrl)
  // A base without its closing slash would resolve `index.json` beside its last
  // segment and not inside it.
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`
  const index = await getCapped(timed, new URL('index.json', base).href, PUBLISHED_INDEX_MAX_BYTES)
  if (index === null) return null
  const parsed = JSON.parse(new TextDecoder().decode(index)) as unknown
  if (isIndexWithoutIcons(parsed)) return { icons: {}, sources: {} }
  const pointer = iconsPointer(parsed)
  if (pointer === null) return null
  const target = new URL(pointer.url, base)
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) return null
  const bytes = await getCapped(timed, target.href, PUBLISHED_ICONS_MAX_BYTES)
  if (bytes === null || sha256Hex(bytes) !== pointer.sha256) return null
  const file = parseIconsFile(new TextDecoder().decode(bytes))
  return file === null ? null : keepVerified(file)
}

/** One GET under a byte cap: the body, or null for a status other than ok or a body past the cap. */
async function getCapped(timed: typeof fetch, url: string, cap: number): Promise<Uint8Array | null> {
  const response = await timed(url)
  return response.ok ? await readCappedBody(response, cap) : null
}

/** The `icons` pointer of a parsed `index.json`: a url and the sha256 of the file, or null for anything else. */
function iconsPointer(index: unknown): { url: string; sha256: string } | null {
  if (typeof index !== 'object' || index === null || Array.isArray(index)) return null
  const icons = (index as { icons?: unknown }).icons
  if (typeof icons !== 'object' || icons === null || Array.isArray(icons)) return null
  const { url, sha256 } = icons as { url?: unknown; sha256?: unknown }
  return typeof url === 'string' && url !== '' && typeof sha256 === 'string' && SHA256_HEX.test(sha256) ? { url, sha256 } : null
}

/**
 * Whether the parsed body is a catalog index published before the icons
 * sidecar existed: an object with the catalog's own fields and no `icons` key.
 *
 * The shape is checked, not just the missing key: a 200 that is not an index at
 * all — a rate-limit body, a proxy's error page — would otherwise read as the
 * pre-icons catalog, and the caller would treat an unreadable file as the
 * answer "no icons published" and re-fetch every recorded icon for nothing.
 */
function isIndexWithoutIcons(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const index = value as Record<string, unknown>
  return !Object.hasOwn(index, 'icons') && Object.hasOwn(index, 'schemaVersion') && Object.hasOwn(index, 'plugins')
}

/** The file without the icons whose bytes are not the ones their key names, and without the sources that name those. */
function keepVerified(file: IconsFile): IconsFile {
  const icons = Object.entries(file.icons).filter(([sha256, dataUrl]) => holdsBytesOf(dataUrl, sha256))
  const kept = new Set(icons.map(([sha256]) => sha256))
  return {
    icons: Object.fromEntries(icons),
    sources: Object.fromEntries(Object.entries(file.sources).filter(([, sha256]) => kept.has(sha256))),
  }
}

/**
 * Whether `dataUrl` is the data URL of bytes whose sha256 is `sha256`, in the
 * form `iconDataUrl` writes. `parseIconsFile` has checked the grammar, which is
 * `data:<media type>;base64,<payload>` with no comma in the media type, so the
 * payload starts after the first one. Node's decoder is lenient, reading `YQ=`
 * and `YQ` as it reads `YQ==`, where the decode a browser applies to a data URL
 * refuses the first. So the payload must also be what the bytes encode to: the
 * text this build writes, and not one that only decodes to the same bytes here.
 */
function holdsBytesOf(dataUrl: string, sha256: string): boolean {
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bytes = Buffer.from(payload, 'base64')
  return bytes.toString('base64') === payload && sha256Hex(bytes) === sha256
}

/**
 * Read one icon from where its entry installs it (design §5.2). Never throws.
 *
 * - `bytes`: the whole file, still to be checked by the fold. An icon in a
 *   tarball is handed over as a copy of the member, and only if it is within
 *   `MAX_CATALOG_ICON_BYTES`: the result is held until the fold has run, a
 *   member is a view into an archive inflated to as much as 64 MiB, and a view
 *   would keep that archive alive. A member past the bound is refused here with
 *   its size, the sentence the fold would write, so a hostile package cannot make
 *   a day's results as large as its archives. A raw file is read to one byte
 *   past the bound, so the fold can report the size of a file just over it.
 * - `refused`: the artifact was read and the icon is not usable, with the
 *   sentence its author is told: the member or file is not there, or is past the
 *   bound, with its size where that is known and without it where the read
 *   stopped at the bound.
 * - `not-read`: the artifact could not be read at all, through no fault of its
 *   author, and bytes shown to be the artifact's will not read any better
 *   tomorrow: an npm tarball past 32 MiB or inflating past 64 MiB, and a tarball
 *   or asset, once it has matched its digest or sha256, that cannot be read as a
 *   gzipped tar archive with one top-level directory.
 * - `not-yet-read`: anything that says nothing about the artifact, with a reason
 *   for the log. A transport failure of any kind, a status that is not an
 *   answer about the file, a tarball URL that is not the registry's or a release
 *   URL that is not the repository's, an integrity this build cannot compute (no
 *   request is made) or bytes that do not match the integrity or sha256 (a
 *   release download past the cap is one, since it cannot be the recorded asset),
 *   a release asset that inflates past the cap (no sentence is true of it, and
 *   the rescue that listed it was held to the same cap), a pinned commit that
 *   is not a sha, and a 404 for a raw file the record holds published.
 *
 * Every request takes the first answer it gets: a 429 or a 5xx is "not yet
 * read" at once and is not waited out, so a fetch in flight when the time budget
 * runs out finishes in one attempt (see {@link ICON_FETCH_TIME_BUDGET_MS_DEFAULT}).
 *
 * `work.expectSha256` is read for one thing, that the record holds the key
 * published, which turns a raw 404 into an answer about the host rather than
 * the file ({@link fromGithub}). The sha256 itself is for the fold, which
 * records the bytes under the sha256 they have.
 * @param work - one fetch of a plan.
 * @param transport - how to reach the network.
 */
export async function fetchIcon(work: IconWork, transport: IconTransport): Promise<IconFetchResult> {
  try {
    const label = iconLabel(work.declaration.source)
    const shown = shownPath(work.declaration.path)
    const { target } = work
    switch (target.kind) {
      case 'npm':
        return await fromNpm(target, label, shown, transport)
      case 'github':
        return await fromGithub(target, label, shown, transport, work.expectSha256 !== undefined)
      case 'release':
        return await fromRelease(target, label, shown, transport)
    }
  } catch (error) {
    // Swallows every way a read can throw: a request that fails or stalls, a
    // body that breaks mid-read, a deadline. Each is the transport, and none
    // says anything an author could act on, so the key is "not yet read" with
    // the cause for the log. What a fetch decides about the artifact it returns;
    // nothing it returns is thrown.
    return notYetRead(message(error))
  }
}

type NpmTarget = Extract<IconFetchTarget, { kind: 'npm' }>
type GithubTarget = Extract<IconFetchTarget, { kind: 'github' }>
type ReleaseTarget = Extract<IconFetchTarget, { kind: 'release' }>

/**
 * The tarball's URL as `new URL` writes it, or null where it is not an https URL
 * on the registry's host. `dist.tarball` is hostile input, however it came by:
 * the integrity check proves the bytes, and this keeps the request on the
 * registry. `host` is compared and not `hostname`, so a port fails, and so does a
 * URL with credentials, which would be sent to the host it names.
 */
function registryTarballUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // Swallows the TypeError `new URL` throws for text that is no absolute URL.
    // There is nothing to request, which is the null the caller turns away.
    return null
  }
  if (url.protocol !== 'https:' || url.host !== REGISTRY_HOST || url.username !== '' || url.password !== '') return null
  return url.href
}

/**
 * The digests SRI names that `node:crypto` can compute, strongest first. A
 * list of digests is judged by the strongest algorithm it holds (W3C SRI,
 * "Does response match metadataList"), so a weak digest that matches cannot
 * vouch for a strong one that does not, and a weak one that does not match is
 * outvoted.
 */
const INTEGRITY_ALGORITHMS = ['sha512', 'sha384', 'sha256', 'sha1'] as const

/** The digests of one algorithm, as npm wrote them in base64. */
interface Digests {
  algorithm: (typeof INTEGRITY_ALGORITHMS)[number]
  expected: string[]
}

/**
 * The digests `integrity` holds in the strongest algorithm of
 * {@link INTEGRITY_ALGORITHMS} it holds any in, or null where it holds none.
 * `integrity` is an SRI string: one digest, or several separated by white space,
 * each `<algorithm>-<base64>` as npm writes `dist.integrity`.
 *
 * Read before the request, because null settles it: there is nothing to check
 * the bytes by, bytes that are not checked are not shown to be the listed
 * artifact's, and the gate admits any `[a-z0-9]+` algorithm, so a string this
 * build cannot compute does reach here. Downloading 32 MiB to find that out
 * would be done again every day.
 */
function strongestDigests(integrity: string): Digests | null {
  const digests = integrity.split(/\s+/).flatMap((token) => {
    const dash = token.indexOf('-')
    return dash === -1 ? [] : [{ algorithm: token.slice(0, dash), expected: token.slice(dash + 1) }]
  })
  for (const algorithm of INTEGRITY_ALGORITHMS) {
    const expected = digests.filter((digest) => digest.algorithm === algorithm).map((digest) => digest.expected)
    if (expected.length > 0) return { algorithm, expected }
  }
  return null
}

/** Whether `bytes` hash to one of `digests`. */
function matchesDigests(bytes: Uint8Array, { algorithm, expected }: Digests): boolean {
  return expected.includes(createHash(algorithm).update(bytes).digest('base64'))
}

/** What opening an archive for the icon came to. */
type Opened =
  | { kind: 'member'; member: Buffer }
  | { kind: 'missing' }
  | { kind: 'unpacks-too-large' }
  | { kind: 'unreadable' }

/**
 * Inflate a gzipped tar and take the member at `<root>/<path>`, `<root>` being
 * the archive's one top-level directory, found as the harvest's own reader finds
 * it ({@link singleRoot}): `package` for everything `npm pack` writes, and
 * anything else a tarball may be rooted at, `./` spellings and a stray file at
 * the top aside. Both channels that read an icon from an archive are installed
 * with the first path component stripped, so the file the install carries at
 * `<path>` is the member under that root.
 *
 * The inflate is bounded by `maxOutputLength`, which is `MAX_INFLATED_BYTES`
 * unless the transport lowers it (release-asset.ts keeps the arithmetic): a body
 * cap bounds nothing after the inflate, and an OOM kill is not catchable, so an
 * unbounded one would take the build down with no report. Past the bound is
 * `unpacks-too-large`.
 *
 * `unreadable` is bytes that are not a gzipped tar this pipeline can read: the
 * inflate or the tar reader threw, or the archive has no one top-level
 * directory. The caller has checked the bytes against the digest or the sha256
 * recorded for them, so that is a fixed property of an immutable key, recorded
 * as "not read" and not found out again every day. The reader is a small strict
 * parser, and what it refuses (a `..` member, a base-256 size) is as likely its
 * limit as the archive's fault, so the sentence says what the build could not
 * do and blames no one. Several top-level directories are not what `npm pack`
 * writes, and which of them an install keeps depends on the order of the
 * members.
 *
 * A name is looked up as the reader spells it: one character for each byte, so
 * a declared path is looked up as {@link memberName} writes it and `图标.svg`
 * is found where it is. Decoding names as ASCII, as the reader once did,
 * dropped the high bit of every byte, which made `é.svg` (C3 A9) and
 * `C).svg` one name and took the bytes of one for the other's.
 *
 * A name that does not fit a ustar header — 100 bytes of name and 155 of prefix,
 * which `npm pack` fills by splitting a path at a slash — travels in a pax (`x`)
 * header before the entry (`npm pack`: one file name past 100 bytes, about 33
 * CJK characters, or a member path past 256 bytes, `package/` included), or in
 * a GNU `L` entry. The shared reader reads both and gives the next entry the
 * name they carry, so an icon with a path that long is found where it is.
 */
function openMember(archive: Uint8Array, path: string, inflatedBytes: number): Opened {
  let files: Map<string, Buffer>
  try {
    files = readTar(gunzipSync(archive, { maxOutputLength: inflatedBytes }))
  } catch (error) {
    // Swallows gunzip's own throws (not gzip, cut short, corrupt) and the tar
    // reader's deliberate loudness, whose cause is the archive's or the
    // reader's and is not told apart: either way the build could not read it,
    // which is all the sentence for it says. Past the output bound is its own
    // answer.
    if ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') return { kind: 'unpacks-too-large' }
    return { kind: 'unreadable' }
  }
  // An archive with no member at all is readable, and has no icon.
  if (files.size === 0) return { kind: 'missing' }
  const rooted = singleRoot([...files.keys()].map(normalize))
  if ('detail' in rooted) return { kind: 'unreadable' }
  const wanted = `${rooted.root}/${memberName(path)}`
  let found: Buffer | undefined
  for (const [raw, member] of files) {
    // A name that appears twice, `package/x` and `./package/x` say, is not what
    // `npm pack` writes. The later one the reader returned is taken, which is no
    // claim about which an install would keep.
    if (normalize(raw) === wanted) found = member
  }
  return found === undefined ? { kind: 'missing' } : { kind: 'member', member: found }
}

/**
 * A member as an icon result: a copy of it, so that the result holds the icon
 * and not the archive it is a view into, or a refusal with its size where it is
 * past the bound (see {@link fetchIcon}).
 */
function memberResult(member: Buffer, label: string, shown: string): IconFetchResult {
  if (member.length > MAX_CATALOG_ICON_BYTES) return refused(iconDetail.tooLarge(label, shown, member.length))
  return { kind: 'bytes', bytes: new Uint8Array(member) }
}

async function fromNpm(target: NpmTarget, label: string, shown: string, transport: IconTransport): Promise<IconFetchResult> {
  const { name, version } = target
  const subject = echo(`${name}@${version}`)
  const url = registryTarballUrl(target.tarball)
  if (url === null) {
    return notYetRead(`the tarball URL ${echo(target.tarball)} of ${subject} is not an https://${REGISTRY_HOST} URL, so it was not requested`)
  }
  // Before the request, not after the body: see strongestDigests.
  const digests = strongestDigests(target.integrity)
  if (digests === null) {
    return notYetRead(`the dist.integrity ${echo(target.integrity)} of ${subject} holds no digest in sha512, sha384, sha256 or sha1, so the tarball cannot be checked and was not requested`)
  }
  // The registry's tarballs are public, so no token goes with the request.
  const response = await withTimeout(transport.fetchImpl, transport.tarballTimeoutMs, 'registry')(url)
  if (!response.ok) return notYetRead(`the registry answered ${response.status} for the tarball of ${subject}`)
  const { tarballBytes, inflatedBytes } = capsOf(transport)
  const bytes = await readCappedBody(response, tarballBytes)
  if (bytes === null) return notRead(iconDetail.packageTooLarge(name, version))
  // Before anything is inflated: the icon is the listed artifact's only if the
  // bytes are, and the catalog says "this version" for the icon as for the rest.
  // It is also what lets an archive be called unreadable for good: bytes that
  // are not the version's say nothing of the version.
  if (!matchesDigests(bytes, digests)) return notYetRead(`the tarball of ${subject} does not match its dist.integrity`)
  const opened = openMember(bytes, target.path, inflatedBytes)
  switch (opened.kind) {
    case 'member':
      return memberResult(opened.member, label, shown)
    case 'missing':
      return refused(iconDetail.notInPackage(label, shown, name, version))
    case 'unpacks-too-large':
      return notRead(iconDetail.packageUnpacksTooLarge(name, version))
    case 'unreadable':
      return notRead(iconDetail.packageUnreadable(name, version))
  }
}

/**
 * The file at a pinned commit. `published` says the record holds the key
 * published: the file was read at this commit on an earlier build.
 */
async function fromGithub(target: GithubTarget, label: string, shown: string, transport: IconTransport, published: boolean): Promise<IconFetchResult> {
  const { repo, commit } = target
  // A key names one immutable artifact only if the commit is one: a branch name
  // would name whatever it pointed at the day it was read.
  if (!COMMIT_SHA.test(commit)) {
    return notYetRead(`the pinned commit ${echo(commit)} of ${echo(repo)} is not a 40-character sha, so there is nothing to read`)
  }
  // The path is a file name and not a URL, and `rawFileUrl` writes it as one:
  // each segment encoded, so a literal %2e%2e, a tab between two dots and a
  // backslash stay inside the commit. A path holding a literal `.` or `..`
  // segment names no file in the commit — no encoded spelling can make it one —
  // so `rawFileUrl` builds no URL from it. The path came from the author's
  // `package.json`, so that declaration leaves the package.
  const url = rawFileUrl(repo, commit, target.path)
  if (url === null) return refused(iconDetail.leavesPackage(shown))
  const response = await fetchRobust(
    url,
    transport.fetchImpl,
    transport.sleep,
    transport.token === '' ? undefined : transport.token,
    transport.timeoutMs,
    'first-answer',
  )
  if (response.status === 404) {
    // A 404 is an answer about the file on its first read alone. A file the
    // record holds published was read at this commit before, and a commit does
    // not change, so a 404 on the refetch says the host, or a repository gone
    // or made private, which the other channels' misses already are: recorded
    // as a refusal, it would replace the published row for good.
    if (published) return notYetRead(`github raw answered 404 for ${echo(`${repo}@${commit}`)}, where the file was read before, so the answer is not about the file`)
    return refused(iconDetail.notAtCommit(label, shown, repo, commit))
  }
  // No other status is an answer about the file. A 403 from a blocking edge or
  // a 429 is a statement about this request.
  if (!response.ok) return notYetRead(`github raw answered ${response.status} for ${echo(`${repo}@${commit}`)}`)
  const bytes = await readCappedBody(response, MAX_CATALOG_ICON_BYTES + 1)
  // The read stopped at the bound and never learned the size, which is not a
  // number to print: a truncated buffer's length would be this one.
  return bytes === null ? refused(iconDetail.tooLarge(label, shown, null)) : { kind: 'bytes', bytes }
}

async function fromRelease(target: ReleaseTarget, label: string, shown: string, transport: IconTransport): Promise<IconFetchResult> {
  const [owner, slug, ...rest] = target.repo.split('/')
  const asset = owner === undefined || slug === undefined || rest.length > 0 ? null : recordedReleaseUrl(target.url, owner, slug)
  if (asset === null) {
    return notYetRead(`the recorded release URL ${echo(target.url)} is not a download URL of a release of ${echo(target.repo)}, so it was not requested`)
  }
  // The parsed URL's own spelling, so what is requested is what was checked.
  const download = await downloadReleaseAsset(asset.href, transport.fetchImpl, transport.sleep, transport.tarballTimeoutMs, 'first-answer')
  if (download.outcome === 'not-found') return notYetRead(`the release asset of ${echo(target.repo)} answered 404`)
  // The recorded sha256 was taken of an asset read under this same cap, so a
  // download past it cannot be that asset: it has changed, which a sha256 that
  // does not match says as well. Nothing is recorded for it, and no sentence of
  // the table is true of it.
  if (download.outcome === 'over-cap') {
    return notYetRead(`the release asset of ${echo(target.repo)} is past the ${MAX_TARBALL_BYTES}-byte cap its recorded sha256 was taken under, so it is not the recorded asset`)
  }
  if (sha256Hex(download.bytes) !== target.sha256) {
    return notYetRead(`the release asset of ${echo(target.repo)} does not hash to the recorded sha256`)
  }
  const { inflatedBytes } = capsOf(transport)
  const opened = openMember(download.bytes, target.path, inflatedBytes)
  switch (opened.kind) {
    case 'member':
      return memberResult(opened.member, label, shown)
    case 'missing':
      return refused(iconDetail.notInRelease(label, shown))
    case 'unpacks-too-large':
      // No sentence is true of it, and the rescue that listed the entry was held
      // to the same cap, so the harvest does not leave this state behind.
      return notYetRead(`the release asset of ${echo(target.repo)} inflates past the ${inflatedBytes}-byte cap, so it was not read`)
    case 'unreadable':
      return notRead(iconDetail.releaseUnreadable())
  }
}

/**
 * Run a plan's fetches with `concurrency` workers (design §5.3), and answer
 * what each key came to. Never throws for one key's failure: {@link fetchIcon}
 * answers for it.
 *
 * A worker claims the next key in the plan's order and asks, before every claim,
 * whether `deadlineMs` has passed since the call, by the monotonic clock: an
 * NTP step must not expire it. Once it has, no fetch is started. A fetch in
 * flight is let finish, so the run overruns the deadline by at most one fetch;
 * the keys never started have no entry, which the fold reads as "not yet read".
 * A deadline of zero starts nothing.
 * @param plan - from `planIconWork`; only its `fetch` is run.
 * @param transport - how to reach the network.
 * @param options - the workers to run, and how long after the call they may start a fetch.
 */
export async function harvestIcons(
  plan: IconPlan,
  transport: IconTransport,
  options: { concurrency: number; deadlineMs: number },
): Promise<Map<IconKey, IconFetchResult>> {
  const results = new Map<IconKey, IconFetchResult>()
  const started = performance.now()
  let claimed = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (performance.now() - started >= options.deadlineMs) return
      const work = plan.fetch[claimed]
      claimed += 1
      if (work === undefined) return
      results.set(work.key, await fetchIcon(work, transport))
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, plan.fetch.length) }, worker))
  return results
}
