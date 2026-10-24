/**
 * The icons sidecar (design 2026-10-23-shop-plugin-icons §6): every icon the
 * catalog carries, once, as a data URL, and the map from each icon key to the
 * icon it names. It is content-addressed like the stars sidecar, for the same
 * reason: a hash in the file name lets every cache keep a copy for good, so
 * nothing that changes from one day to the next may enter its bytes, `builtAt`
 * least of all.
 *
 * This module builds the file under a size budget, writes its exact bytes, and
 * reads a published one back, which is how a build reuses an icon it fetched on
 * an earlier day instead of fetching it again (§5.1).
 *
 * Pure: no clock, no network, no filesystem, no environment, and no locale.
 * `node:crypto` hashes the text it writes, as `stars-assemble` does.
 *
 * @module icons-assemble
 */
import { createHash } from 'node:crypto'
import { ICON_MEDIA_TYPES } from './icon-declaration.ts'
import type { IconKey } from './icon-state.ts'
import { compareStrings } from './identity.ts'

/**
 * The most bytes the icons file may have, serialised (design §6.2): a backstop
 * that keeps the catalog package inside the npm transport's caps even with the
 * plugins file doubling, whose arithmetic the design keeps. Icons past it are
 * withheld, the largest first ({@link assembleIcons}).
 *
 * `iconDetail` writes this budget out as "16 MiB" in the sentence an author
 * reads, because it sits below this module and cannot import it. Moving the
 * constant means moving that copy, and the test that holds the one to the other
 * fails until both have moved.
 */
export const ICONS_FILE_BUDGET_BYTES = 16 * 1024 * 1024

/**
 * One icon the file is to carry: the key that names it, the sha256 of its bytes
 * (`sha256Hex`), and the data URL those bytes are carried as (`iconDataUrl`).
 * Many keys may come with one sha256, which is how an icon that plugins share is
 * carried once.
 */
export interface PublishedIcon {
  key: IconKey
  sha256: string
  dataUrl: string
}

/**
 * The icons file as the shop reads it (design §6.1). `icons` holds each distinct
 * icon once, under the sha256 of its bytes. `sources` is the reuse map of §5.1:
 * every key the file carries an icon for, and the sha256 of that icon, which is a
 * key of `icons`.
 */
export interface IconsFile {
  icons: Record<string, string>
  sources: Record<IconKey, string>
}

/** What {@link assembleIcons} makes: the file, and the keys of the icons the budget turned away. */
export interface AssembledIcons {
  file: IconsFile
  /** Every key whose icon was withheld for size, in code-unit order. None is in the file. */
  withheldForSize: IconKey[]
}

/** The file as bytes: what to write, under what name, and its hash. */
export interface SerializedIcons {
  /** Content-addressed file name the index points at. */
  fileName: string
  json: string
  sha256: string
}

/** A digest as `sha256Hex` writes it: lower case, so one icon has one spelling and an equality test finds it. */
const SHA256_HEX = /^[0-9a-f]{64}$/

/** What a data URL of an icon opens with, and the mark that ends its media type. */
const DATA_URL_OPEN = 'data:'
const BASE64_MARK = ';base64,'

/** The payload of one: at least one character of the standard base64 alphabet, then at most two `=` of padding. */
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Whether `value` is a data URL of an icon, the one form the icons file carries
 * an icon in (design §6.1): `data:`, one of the {@link ICON_MEDIA_TYPES},
 * `;base64,`, and a payload of at least one character of the standard base64
 * alphabet followed by at most two `=`. The media types are read from that table
 * and not listed again, so a type added to it is read here the day it is
 * written. Own keys only: `constructor` is not one.
 *
 * It is the one grammar the file is read by ({@link parseIconsFile}), and what
 * `iconDataUrl` writes for an icon is in it: an empty file is no icon, and has
 * no payload to write. Anything else is no icon the shop may set as an image's
 * `src`: `javascript:` and `data:text/html` are the two it must never meet, and
 * a data URL that is not base64, `data:image/svg+xml;utf8,<svg …>` among them,
 * is text its writer chose. The check is of the form and no more: the payload
 * is not decoded.
 */
export function isIconDataUrl(value: string): boolean {
  if (!value.startsWith(DATA_URL_OPEN)) return false
  const mark = value.indexOf(BASE64_MARK, DATA_URL_OPEN.length)
  if (mark === -1) return false
  return Object.hasOwn(ICON_MEDIA_TYPES, value.slice(DATA_URL_OPEN.length, mark))
    && BASE64_PAYLOAD.test(value.slice(mark + BASE64_MARK.length))
}

/**
 * The error for an input the file could not state truthfully. The subject is
 * quoted with `JSON.stringify`: a key holds a package author's path, which may
 * hold a newline, and GitHub Actions reads a log line that opens with `::` as a
 * workflow command.
 */
function conflict(subject: string, what: string): Error {
  return new Error(`icons file: ${JSON.stringify(subject)} ${what}`)
}

/**
 * The largest `count` from 0 to `max` for which `fits(count)` holds, found by
 * bisection, so that a set too large for the budget costs a handful of
 * serialisations and not one for each icon. It is sound only where `fits` is
 * monotone, true up to some count and false beyond it, which holds of a prefix
 * of icons: each icon admitted adds its own entry to `icons` and at least one to
 * `sources`, and takes none away, so every longer prefix is a larger file.
 *
 * `max` is asked first, so a set that fits whole costs one call. Zero is never
 * asked about, other than as `max`: it is the answer where nothing fits, since
 * fewer than none cannot be admitted.
 */
function longestFitting(max: number, fits: (count: number) => boolean): number {
  if (fits(max)) return max
  // Invariant: `low` fits (zero is taken to, as it is never asked about) and no
  // count above `high` does. `max` has just failed, so `high` starts below it.
  let low = 0
  let high = max - 1
  while (low < high) {
    // The upper middle, so that `low = middle` always moves on.
    const middle = Math.ceil((low + high) / 2)
    if (fits(middle)) low = middle
    else high = middle - 1
  }
  return low
}

/**
 * Build the file from the icons the catalog is to carry, under a size budget
 * (design §6.2).
 *
 * An icon that many plugins share is one entry of `icons` and one of `sources`
 * for each key (§6.1), however many times and in whatever order it is handed
 * over: the same icons make the same file, which is what keeps the content hash
 * of the published file stable.
 *
 * When the whole set serialises to at most `budget` bytes it is all admitted.
 * Otherwise icons are taken smallest first, by the length of their data URL and,
 * among equal lengths, by sha256 in code-unit order, and the file holds the
 * longest prefix of that order whose actual serialisation is at most `budget`.
 * The size is measured, in UTF-8 bytes, on the text {@link serializeIcons}
 * writes, so the keys, the `sources` and the JSON syntax are counted as they
 * stand; an allowance for them would stop holding as the keys grew. A tie is
 * decided by the sha256 and not by a key, because an icon has one sha256 and
 * any number of keys.
 *
 * The first prefix that does not fit ends the admission, and every icon after it
 * is withheld, though a later one with a shorter key might have fitted beside
 * the others. What an author is told is that "the largest icons give way first"
 * (`iconDetail.withheldForSize`), and a rule that skipped ahead would carry a
 * larger icon while it turned away a smaller one.
 *
 * A withheld icon is in neither map, and every key that names one is in
 * `withheldForSize`. A budget that not even the empty file fits admits nothing,
 * and the file is then the empty one, which is over that budget: there is no
 * smaller.
 *
 * @param icons - every icon the catalog is to carry, in any order.
 * @param budget - the most bytes the serialised file may have.
 * @throws when one sha256 comes with two data URLs, or one key with two
 *   sha256s: the file could state only one of them and would not say which.
 */
export function assembleIcons(
  icons: readonly PublishedIcon[],
  budget: number = ICONS_FILE_BUDGET_BYTES,
): AssembledIcons {
  const dataUrlOf = new Map<string, string>()
  const shaOf = new Map<IconKey, string>()
  for (const { key, sha256, dataUrl } of icons) {
    const heldUrl = dataUrlOf.get(sha256)
    if (heldUrl !== undefined && heldUrl !== dataUrl) throw conflict(sha256, 'comes with two different data URLs')
    const heldSha = shaOf.get(key)
    if (heldSha !== undefined && heldSha !== sha256) throw conflict(key, 'names two different icons')
    dataUrlOf.set(sha256, dataUrl)
    shaOf.set(key, sha256)
  }
  // The order icons are admitted in, and the budget gives way from the far end
  // of: the shortest data URL first, and equal lengths by sha256.
  const ascending = [...dataUrlOf].sort(
    ([shaA, urlA], [shaB, urlB]) => urlA.length - urlB.length || compareStrings(shaA, shaB),
  )
  // The file of the first `count` icons of that order, and every key that names one of them.
  const firstIcons = (count: number): IconsFile => {
    const admitted = ascending.slice(0, count)
    const shas = new Set(admitted.map(([sha256]) => sha256))
    return {
      icons: Object.fromEntries(admitted),
      sources: Object.fromEntries([...shaOf].filter(([, sha256]) => shas.has(sha256))),
    }
  }
  const fits = (count: number): boolean => Buffer.byteLength(serializeIcons(firstIcons(count)).json) <= budget
  const file = firstIcons(longestFitting(ascending.length, fits))
  return {
    file,
    withheldForSize: [...shaOf.keys()].filter((key) => !Object.hasOwn(file.sources, key)).sort(compareStrings),
  }
}

/**
 * A copy of the record with its keys in code-unit order, so that the text does
 * not depend on the order they were added in. Built with `Object.fromEntries`,
 * which defines its keys where an assignment would set them: a key named
 * `__proto__`, assigned into a plain object, sets its prototype, and the entry
 * is gone from the text.
 */
function inCodeUnitOrder(record: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => compareStrings(a, b)))
}

/**
 * Serialize the file to the exact bytes that get published: both maps in
 * code-unit order, two-space JSON, and one trailing newline, with nothing in it
 * that changes between two builds of the same icons.
 *
 * The sort is what keeps the content hash stable between two builds that
 * assembled the same icons in a different order, and it is by code unit because
 * a locale-aware one would make the published bytes depend on the machine. (A
 * key that reads as an array index would be listed ahead of the rest whatever
 * the order; a sha256 is sixty-four digits and every key `icon-state` makes
 * opens with its source's name, so none does.)
 * @param file - the file from {@link assembleIcons}, or one read back by {@link parseIconsFile}.
 */
export function serializeIcons(file: IconsFile): SerializedIcons {
  const json = `${JSON.stringify({ icons: inCodeUnitOrder(file.icons), sources: inCodeUnitOrder(file.sources) }, null, 2)}\n`
  const sha256 = createHash('sha256').update(json).digest('hex')
  return { fileName: `icons.${sha256}.json`, json, sha256 }
}

/** Whether `value` is a JSON object: not `null`, and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read an icons file back from its text: the one a build published on an earlier
 * day, whose icons it reuses so that it need not fetch them again (design §5.1).
 *
 * Returns `null`, and never throws, for anything that is not shaped like what
 * {@link serializeIcons} writes: text that is not JSON; anything but an object
 * with the two keys `icons` and `sources` and no other; an `icons` key that is
 * not a sha256 in lower-case hexadecimal; an icon that is not an
 * {@link isIconDataUrl}; or a `sources` value that names an icon `icons` does
 * not hold. A caller reads that as no published file, and fetches again what it
 * would have reused. The keys of `sources` are icon keys, which are opaque, and
 * are not checked.
 *
 * The form is all that is checked. The payloads are not decoded, and their
 * digests are not compared with the keys they sit under.
 * @param text - the file's text; its size is the caller's to bound.
 */
export function parseIconsFile(text: string): IconsFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Whatever `JSON.parse` throws is about this text, and the answer to all of
    // it is the same: it is no icons file.
    return null
  }
  if (!isRecord(parsed)) return null
  const names = Object.keys(parsed)
  if (names.length !== 2 || !names.includes('icons') || !names.includes('sources')) return null
  const { icons, sources } = parsed
  if (!isRecord(icons) || !isRecord(sources)) return null
  const iconEntries: [string, string][] = []
  for (const [sha256, dataUrl] of Object.entries(icons)) {
    if (!SHA256_HEX.test(sha256) || typeof dataUrl !== 'string' || !isIconDataUrl(dataUrl)) return null
    iconEntries.push([sha256, dataUrl])
  }
  const sourceEntries: [IconKey, string][] = []
  for (const [key, sha256] of Object.entries(sources)) {
    if (typeof sha256 !== 'string' || !Object.hasOwn(icons, sha256)) return null
    sourceEntries.push([key, sha256])
  }
  return { icons: Object.fromEntries(iconEntries), sources: Object.fromEntries(sourceEntries) }
}
