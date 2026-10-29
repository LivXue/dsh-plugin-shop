/**
 * The committed record of what became of each icon key (design
 * 2026-10-23-shop-plugin-icons §5.1): the daily build writes one row per key to
 * `registry/icon-state.json`, and the next build reads it before it plans a
 * fetch. A key names exactly one artifact, so a row never goes stale, and the
 * build plans from the rows instead of looking at every icon again.
 *
 * The file is a deterministic build input like `repo-state.json`: sorted,
 * committed daily, and a malformed one throws. Read as empty it would send every
 * icon in the catalog to be fetched again, the refused ones included, and a
 * refusal is meant to be asked once.
 *
 * Pure: no clock, no network, no filesystem, no environment, and no locale.
 *
 * @module icon-state
 */
import { ICON_MEDIA_TYPES } from './icon-declaration.ts'
import type { IconMediaType } from './icon-declaration.ts'
import { compareStrings } from './identity.ts'

/**
 * What names one icon artifact (design §5.1), as one string:
 *
 * - npm: `npm:<name>@<version>:<path>`
 * - a git-installed GitHub entry: `github:<owner>/<slug>@<commit>:<path>`, the
 *   path including the subpackage directory
 * - a release-rescued GitHub entry: `release:<sha256 of the tarball>:<path>`
 *
 * A key never changes meaning: one version, commit or tarball always holds the
 * same bytes, so what was recorded under a key holds for good. That is also why
 * a path is written as it stands, never escaped: escaping it later would give
 * every recorded row a new key.
 *
 * Two artifacts cannot share a key, because everything before the path is free
 * of the delimiters. An npm name and a semver version hold no `:` or `@` (a
 * scope's leading `@` aside), a GitHub owner and repository name hold neither,
 * a commit is 40 hexadecimal digits and a sha256 is 64. The path is the one
 * part that can hold anything, and it comes last, so read from the left a key
 * splits only one way.
 *
 * Nothing here takes a key apart. A key is hostile text, for its path is the
 * package author's: it is only compared, and quoted whenever a message prints
 * it.
 */
export type IconKey = string

/** The key of an icon read from a listed npm package's own tarball. */
export function npmIconKey(name: string, version: string, path: string): IconKey {
  return `npm:${name}@${version}:${path}`
}

/** The key of an icon read from a git-installed repository at its pinned commit; `path` includes the subpackage directory. */
export function githubIconKey(repo: string, commit: string, path: string): IconKey {
  return `github:${repo}@${commit}:${path}`
}

/** The key of an icon read from the release asset a rescued entry installs, which its sha256 names. */
export function releaseIconKey(tarballSha256: string, path: string): IconKey {
  return `release:${tarballSha256}:${path}`
}

/**
 * What became of one key.
 *
 * `published`: the bytes were read and passed, and the row keeps their sha256,
 * media type and size, never the bytes, which are the icons file's.
 * `withheld-for-size`: the same bytes, valid and fetched, that the icons
 * file's own budget kept out of yesterday's file — the row exists so the build
 * does not fetch them again blind and so the record does not claim a file
 * carries an icon it does not. `refused`: the artifact was read and its icon
 * broke a rule, with the sentence its author is told; a fix is a new version,
 * commit or tarball, which is a new key. `not-read`: the artifact could not be
 * read at all and its author did nothing wrong, a package past the download cap
 * for one, or an archive that matched its digest and still does not open, with
 * the cause. A `refused` or `not-read` key is never fetched again.
 *
 * A transport failure is none of these. It is "not yet read" (design §5.3),
 * which this record has no row for, so the next build asks again.
 */
export type IconOutcome =
  | { outcome: 'published'; sha256: string; mediaType: IconMediaType; bytes: number }
  | { outcome: 'withheld-for-size'; sha256: string; mediaType: IconMediaType; bytes: number }
  | { outcome: 'refused'; detail: string }
  | { outcome: 'not-read'; detail: string }

/** A digest as `sha256Hex` writes it: lower case, so one icon has one spelling and an equality test finds it. */
const SHA256_HEX = /^[0-9a-f]{64}$/

/** The fields of a row, in the order they are written. */
const PUBLISHED_FIELDS = ['outcome', 'sha256', 'mediaType', 'bytes'] as const
const DETAIL_FIELDS = ['outcome', 'detail'] as const

/** Whether `value` is a media type an icon can have. Own keys only: `constructor` is not one. */
function isIconMediaType(value: unknown): value is IconMediaType {
  return typeof value === 'string' && Object.hasOwn(ICON_MEDIA_TYPES, value)
}

/** Whether a plain object's own keys are exactly `keys`, in any order. */
function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record)
  return own.length === keys.length && keys.every(key => own.includes(key))
}

/**
 * The error for one malformed row. The key is quoted with `JSON.stringify`: it
 * holds the package author's path, which may hold a newline, and GitHub Actions
 * reads a log line that opens with `::` as a workflow command.
 */
function malformed(key: IconKey, what: string): Error {
  return new Error(`icon-state.json: ${JSON.stringify(key)} ${what}`)
}

/**
 * Check one row and return it typed, built afresh with its fields in the order
 * they are written.
 *
 * Types only, as `repo-state.ts` checks a carried record, and not the bounds
 * the build applies where it reads bytes: `MAX_CATALOG_ICON_BYTES` is that
 * read's to enforce, and a bound lowered later must not turn every row written
 * under the old one into a build that cannot start. The fields are exact, an
 * extra one refused, because this build is the only writer: a field it never
 * wrote means the file was edited.
 * @param key - the row's key, for the error.
 * @param value - one row, unvalidated.
 */
function checkRow(key: IconKey, value: unknown): IconOutcome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed(key, 'is not an object')
  const row = value as Record<string, unknown>
  const { outcome } = row
  if (outcome === 'published' || outcome === 'withheld-for-size') {
    if (!hasExactKeys(row, PUBLISHED_FIELDS)) {
      throw malformed(key, `has a ${outcome} row whose fields are not exactly ${PUBLISHED_FIELDS.join(', ')}`)
    }
    const { sha256, mediaType, bytes } = row
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      throw malformed(key, `has a ${outcome} row whose sha256 is not 64 lowercase hexadecimal digits`)
    }
    if (!isIconMediaType(mediaType)) throw malformed(key, `has a ${outcome} row whose mediaType is not an icon media type`)
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw malformed(key, `has a ${outcome} row whose bytes is not a non-negative safe integer`)
    }
    return { outcome, sha256, mediaType, bytes }
  }
  if (outcome === 'refused' || outcome === 'not-read') {
    if (!hasExactKeys(row, DETAIL_FIELDS)) {
      throw malformed(key, `has a ${outcome} row whose fields are not exactly ${DETAIL_FIELDS.join(', ')}`)
    }
    const { detail } = row
    if (typeof detail !== 'string') throw malformed(key, `has a ${outcome} row whose detail is not a string`)
    return { outcome, detail }
  }
  throw malformed(key, 'has an outcome that is none of published, withheld-for-size, refused or not-read')
}

/**
 * Parse the committed file. A malformed file throws, like every build input
 * (CLAUDE.md, "Failing loudly"): it holds every outcome the build has already
 * paid for, and an empty record would schedule all of them again. A missing
 * file is the caller's to read as an empty record, since this takes text.
 * @throws when the text is not JSON, is not an object, or holds a row that is
 *   not one of the outcomes above in exactly the fields it is written with. The
 *   message names the file and quotes the row's key.
 */
export function parseIconState(text: string): Map<IconKey, IconOutcome> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // JSON.parse throws only a SyntaxError about this text, which is what the
    // message reports.
    throw new Error(`icon-state.json: not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('icon-state.json: expected an object')
  }
  const state = new Map<IconKey, IconOutcome>()
  for (const [key, value] of Object.entries(parsed)) state.set(key, checkRow(key, value))
  return state
}

/**
 * Serialize the record: two-space JSON, keys in code-unit order, one trailing
 * newline. Two builds that hold the same rows write the same bytes whatever
 * order they met them in, and the empty record is `{}` and a newline. (A
 * JavaScript object lists a key that reads as an array index ahead of the rest,
 * whatever the order; every key the constructors above make opens with its
 * source's name, so none does.)
 *
 * Each row passes the check a parse applies, so what is written is always
 * readable back: a row the next build would refuse fails in the build that made
 * it. The object is built with `Object.fromEntries`, which defines its keys
 * where assignment would set them: a key named `__proto__` assigned into a
 * plain object sets its prototype, and the row is gone from the text.
 * @throws when a row is not one of the outcomes above in exactly its fields.
 */
export function serializeIconState(state: ReadonlyMap<IconKey, IconOutcome>): string {
  const rows = [...state]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([key, outcome]) => [key, checkRow(key, outcome)] as const)
  return `${JSON.stringify(Object.fromEntries(rows), null, 2)}\n`
}

/**
 * The record without the rows of keys no listing names any more (design §5.1).
 * A key in `live` that holds no row stays out: pruning never invents an
 * outcome.
 * @returns a new map; `state` is left as it was.
 */
export function pruneIconState(state: ReadonlyMap<IconKey, IconOutcome>, live: ReadonlySet<IconKey>): Map<IconKey, IconOutcome> {
  return new Map([...state].filter(([key]) => live.has(key)))
}
