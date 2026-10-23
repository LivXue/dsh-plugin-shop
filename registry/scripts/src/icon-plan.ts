/**
 * Planning the icon step and folding what it brings back (design
 * 2026-10-23-shop-plugin-icons §5.1, §5.3 and §9): the pure heart of the
 * feature, between the declarations the harvest already holds and the network
 * reads of `icon-fetch.ts`, and between those reads and the artifacts the build
 * writes.
 *
 * Three functions, in the order the daily build calls them:
 *
 * 1. {@link iconSubjects} pairs each listed entry with the icon its candidate
 *    declares, and names the artifact the icon would be read from.
 * 2. {@link planIconWork} sets those against the committed record
 *    (`icon-state.ts`) and yesterday's published icons file, and says which keys
 *    to reuse, which to fetch and which the per-run fetch budget turns away.
 * 3. {@link foldIconResults} turns the fetches' answers into the next record, the
 *    icons file, the map from each entry to its icon, and the report's rows and
 *    counts.
 *
 * An icon never stops the catalog (design decision 6), so an icon that is
 * missing, refused or unanswered makes nothing here throw. An entry no candidate
 * matches, a candidate with nowhere to fetch from, a fetch that did not answer
 * and a budget that turned one away are each an icon that is not there yet, and
 * the next build asks again. A transport failure is never a refusal (§5.3): only
 * what a build read and judged is recorded.
 *
 * Pure: no clock, no network, no filesystem, no environment, and no locale.
 * Every ordering is by code unit (`compareStrings`), so that the plan, the file
 * and the report do not depend on the order the entries or the answers came in.
 *
 * @module icon-plan
 */
import { checkIconBytes, iconDataUrl, sha256Hex } from './icon-bytes.ts'
import { iconDetail } from './icon-declaration.ts'
import type { IconDeclaration, IconRead } from './icon-declaration.ts'
import { githubIconKey, npmIconKey, pruneIconState, releaseIconKey } from './icon-state.ts'
import type { IconKey, IconOutcome } from './icon-state.ts'
import { ICONS_FILE_BUDGET_BYTES, assembleIcons } from './icons-assemble.ts'
import type { IconsFile, PublishedIcon } from './icons-assemble.ts'
import { compareStrings, firstSeenKey, installIdentity, repoUnit } from './identity.ts'
import type { Candidate, Entry, RepoCandidate } from './types.ts'

/**
 * Where an icon's bytes are read from (design §5.2), which `icon-fetch.ts` does.
 *
 * - `npm`: the listed version's own tarball. `tarball` and `integrity` are the
 *   candidate's `dist.tarball` and `dist.integrity`, the pair npm wrote for the
 *   version the declaration was read from, and the fetch checks the one against
 *   the other before it inflates anything. `path` is relative to the package root.
 * - `github`: the file at the pinned commit. `path` is the file's path in the
 *   repository, so a subpackage's directory is part of it, as it is of the key.
 * - `release`: the asset a rescued entry installs, which the fetch checks against
 *   `sha256`. `path` is inside the asset's package root: a rescued entry is a
 *   repository root, so there is no subdirectory.
 */
export type IconFetchTarget =
  | { kind: 'npm'; name: string; version: string; tarball: string; integrity: string; path: string }
  | { kind: 'github'; repo: string; commit: string; path: string }
  | { kind: 'release'; repo: string; url: string; sha256: string; path: string }

/**
 * One listed entry, and the icon it may carry.
 *
 * `identity` is the entry's install identity, which keys {@link IconFold.byIdentity},
 * the map the pipeline reads an entry's icon from. `name` is what the report
 * calls the entry: an npm package's name, and for a repository its `owner/slug`
 * (with `#subdir` for a subpackage), as the rejection table names a repository.
 * It is never the bundle name, which two forks can share, in a table that shows
 * no identity beside it. `withheldKey` is what a row of `withheld-icons.yml`
 * names (design §9): the npm name, or the repository's full name lower-cased, as
 * `firstSeenKey` writes it, so one row withholds every entry of a repository.
 *
 * `read` is what the entry's candidate says of its icon: `declared` or
 * `refused`, or `none` for an entry whose candidate declares nothing and for one
 * no candidate matches. `key` names the artifact a declared icon is read from
 * (§5.1) and `target` says where to read it. Only a declared icon has either. It
 * has no target when its candidate lacks what the fetch needs, which an npm
 * package can: the tarball's URL, or the integrity to verify it by.
 */
export interface IconSubject {
  identity: string
  name: string
  withheldKey: string
  read: IconRead
  key?: IconKey
  target?: IconFetchTarget
}

/**
 * One fetch to make: the key it settles, where to read the bytes, and the
 * declaration they are checked against.
 *
 * `expectSha256` is there for a key the record holds published whose bytes
 * yesterday's file no longer carries (a first run, an outage, a deploy that
 * failed after the snapshot commit): the fetch reproduces what was recorded. A
 * key whose bytes no longer hash to it is not an error; it is recorded under the
 * sha256 it has now.
 */
export interface IconWork {
  key: IconKey
  target: IconFetchTarget
  declaration: IconDeclaration
  expectSha256?: string
}

/**
 * What the build does about icons today. `reuse` lists the keys whose recorded
 * icon yesterday's file still holds, each with the sha256 it is recorded under.
 * `fetch` lists the keys to read, in code-unit order of their keys and no more
 * than the budget. `deferred` lists the keys the budget turned away, which the
 * next build asks for again.
 */
export interface IconPlan {
  reuse: { key: IconKey; sha256: string }[]
  fetch: IconWork[]
  deferred: IconKey[]
}

/**
 * What one fetch answered. `bytes` is the whole file, still to be checked.
 * `refused` is the artifact read and its icon not there or not usable, and
 * `not-read` the artifact not readable at all through no fault of its author;
 * both carry the sentence an author reads, and both are recorded. `not-yet-read`
 * is anything that says nothing about the artifact (a timeout, a 503, a deadline
 * that ran out): it is recorded nowhere, and `reason` is for the log.
 */
export type IconFetchResult =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'refused'; detail: string }
  | { kind: 'not-read'; detail: string }
  | { kind: 'not-yet-read'; reason: string }

/**
 * One line of the report's icon section: an icon a reader of the catalog does
 * not see, and why. `refused` and `not-read` are what a fetch or a declaration
 * came to; `withheld` is a maintainer's row in `withheld-icons.yml` or the icons
 * file's size budget. None of them is a rejection: the entry is listed.
 */
export interface IconReportRow {
  name: string
  identity: string
  kind: 'refused' | 'not-read' | 'withheld'
  detail: string
}

/**
 * The report's one line of counts. They are counted for listed entries, and each
 * entry that declares an icon is in exactly one bucket, so that
 * `declared === published + withheldByHand + withheldForSize + refused + notRead + notYetRead`.
 *
 * `declared` is every entry whose candidate says anything about an icon, a
 * refused declaration included. `published` is an icon that is in the file the
 * build publishes: a recorded icon whose bytes are nowhere this build is not
 * published, whatever the record says, and counts as `notYetRead`, as does an
 * icon with nothing to fetch it from.
 */
export interface IconCounts {
  declared: number
  published: number
  withheldByHand: number
  withheldForSize: number
  refused: number
  notRead: number
  notYetRead: number
}

/**
 * What the day's icon step comes to.
 *
 * `nextState` is the record to commit: the rows of the keys a declared entry
 * names, with this build's answers laid over them. `file` is the icons file to
 * publish, `null` exactly when it would hold no icon. `byIdentity` maps the
 * identity of each entry whose icon is in that file to the sha256 the entry
 * carries. `rows` are in the order the report prints them.
 */
export interface IconFold {
  nextState: Map<IconKey, IconOutcome>
  file: IconsFile | null
  byIdentity: Map<string, string>
  rows: IconReportRow[]
  counts: IconCounts
}

/** Whether `value` is a string with something in it: `dist.tarball` and `dist.integrity` are kept as npm wrote them, and an empty one names nothing to download or to verify by. */
function isText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value !== ''
}

/** What every subject carries before its icon is looked at. */
type SubjectBase = Pick<IconSubject, 'identity' | 'name' | 'withheldKey'>

/** The subject of an npm entry, from the candidate it was built from. */
function npmSubject(base: SubjectBase, candidate: Candidate | undefined): IconSubject {
  if (candidate === undefined) return { ...base, read: { kind: 'none' } }
  const read: IconRead = candidate.icon ?? { kind: 'none' }
  if (read.kind !== 'declared') return { ...base, read }
  // The key, the tarball and the integrity are all the candidate's: the version
  // whose manifest the declaration was read from, and the `dist` npm wrote for
  // it, so they name one artifact.
  const { path } = read.declaration
  const key = npmIconKey(candidate.name, candidate.version, path)
  const { distTarball, integrity } = candidate
  if (!isText(distTarball) || !isText(integrity)) return { ...base, read, key }
  return {
    ...base,
    read,
    key,
    target: { kind: 'npm', name: candidate.name, version: candidate.version, tarball: distTarball, integrity, path },
  }
}

/** The subject of a repository entry, from the candidate it was built from. */
function githubSubject(base: SubjectBase, entry: Entry, candidate: RepoCandidate | undefined): IconSubject {
  if (candidate === undefined) return { ...base, read: { kind: 'none' } }
  const read: IconRead = candidate.icon ?? { kind: 'none' }
  if (read.kind !== 'declared') return { ...base, read }
  const { path } = read.declaration
  const { tarball } = entry
  // A rescued entry installs the release asset, so its icon is read from there
  // and keyed by the asset's sha256: the entry's `version` is the tag, a mutable
  // ref the key must not rest on.
  if (tarball !== undefined) {
    return {
      ...base,
      read,
      key: releaseIconKey(tarball.sha256, path),
      target: { kind: 'release', repo: candidate.repo, url: tarball.url, sha256: tarball.sha256, path },
    }
  }
  // A git install is keyed by the commit its declaration was read at. That is
  // the entry's version too, but the candidate is where it is a commit and
  // nothing else, so the key never rests on a field that is a tag elsewhere.
  const inRepository = candidate.subdir === undefined ? path : `${candidate.subdir}/${path}`
  return {
    ...base,
    read,
    key: githubIconKey(candidate.repo, candidate.commit, inRepository),
    target: { kind: 'github', repo: candidate.repo, commit: candidate.commit, path: inRepository },
  }
}

/**
 * One subject for each entry, in the order of `entries`: the entry, the icon its
 * candidate declares, and what it takes to read it.
 *
 * An entry is paired with the candidate of its own install identity, which is
 * what a bundle name is not: two forks can claim one, and an npm package can
 * share its name with a repository's bundle. A repeated identity among the
 * candidates keeps the first. The entries are selected from these very
 * candidates in the same build, so every entry has its own; one that somehow
 * has none reads no icon, because a missing icon is the safe absence and an
 * icon must never stop the daily catalog (design decision 6).
 * @param entries - the entries the build will publish.
 * @param candidates - the npm candidates they were selected from.
 * @param repoCandidates - the repository candidates they were selected from.
 */
export function iconSubjects(
  entries: readonly Entry[],
  candidates: readonly Candidate[],
  repoCandidates: readonly RepoCandidate[],
): IconSubject[] {
  const npmByIdentity = new Map<string, Candidate>()
  for (const candidate of candidates) {
    const identity = installIdentity({ source: 'npm', name: candidate.name })
    if (!npmByIdentity.has(identity)) npmByIdentity.set(identity, candidate)
  }
  const repoByIdentity = new Map<string, RepoCandidate>()
  for (const candidate of repoCandidates) {
    const identity = installIdentity({ source: 'github', name: candidate.name, repo: candidate.repo, subdir: candidate.subdir })
    if (!repoByIdentity.has(identity)) repoByIdentity.set(identity, candidate)
  }
  return entries.map((entry) => {
    const identity = installIdentity(entry)
    const base: SubjectBase = {
      identity,
      name: entry.source === 'npm' ? entry.name : repoUnit({ repo: entry.repo ?? entry.name, subdir: entry.subdir }),
      withheldKey: firstSeenKey(entry),
    }
    return entry.source === 'npm'
      ? npmSubject(base, npmByIdentity.get(identity))
      : githubSubject(base, entry, repoByIdentity.get(identity))
  })
}

/** A subject whose icon is declared and can be fetched: it has a key and a target. */
interface Fetchable extends IconSubject {
  read: Extract<IconRead, { kind: 'declared' }>
  key: IconKey
  target: IconFetchTarget
}

function isFetchable(subject: IconSubject): subject is Fetchable {
  return subject.read.kind === 'declared' && subject.key !== undefined && subject.target !== undefined
}

/**
 * What to do about each icon today (design §5.1 and §5.3), from the committed
 * record and yesterday's published file.
 *
 * Nothing is asked for an entry that declares no icon or a refused one, for one
 * a maintainer withheld, for one with nothing to fetch it from, or for a key the
 * record holds refused or not read: a refusal is the author's to fix and a
 * package past the caps stays past them, and either changes only with a new
 * version, commit or tarball, which is a new key. A key the record holds
 * published is reused when yesterday's file still holds its sha256, and fetched
 * again, expecting that sha256, when the file does not. A key the record does
 * not know is fetched.
 *
 * Keys are asked for once, however many entries name one (two repositories can
 * attach one release asset), unless every entry that names it is withheld. The
 * fetches are cut at `budget` in code-unit order of their keys, so the same keys
 * are served first on every build, and the rest are deferred. Entries are read
 * in the order of their identities, so that two entries sharing a key hand over
 * the same declaration however they were listed.
 * @param subjects - from {@link iconSubjects}.
 * @param state - the committed record, `icon-state.json`.
 * @param published - yesterday's icons file, or `null` when it could not be read.
 * @param withheld - `withheld-icons.yml`, by {@link IconSubject.withheldKey}.
 * @param budget - the most keys to fetch; one below zero fetches none.
 */
export function planIconWork(
  subjects: readonly IconSubject[],
  state: ReadonlyMap<IconKey, IconOutcome>,
  published: IconsFile | null,
  withheld: ReadonlyMap<string, { reason: string }>,
  budget: number,
): IconPlan {
  const reuse: IconPlan['reuse'] = []
  const needed: IconWork[] = []
  const seen = new Set<IconKey>()
  const ordered = subjects.filter(isFetchable).sort((a, b) => compareStrings(a.identity, b.identity))
  for (const { key, target, read, withheldKey } of ordered) {
    if (withheld.has(withheldKey) || seen.has(key)) continue
    seen.add(key)
    const recorded = state.get(key)
    if (recorded !== undefined && recorded.outcome !== 'published') continue
    if (recorded !== undefined && published !== null && Object.hasOwn(published.icons, recorded.sha256)) {
      reuse.push({ key, sha256: recorded.sha256 })
      continue
    }
    needed.push({ key, target, declaration: read.declaration, ...(recorded === undefined ? {} : { expectSha256: recorded.sha256 }) })
  }
  reuse.sort((a, b) => compareStrings(a.key, b.key))
  needed.sort((a, b) => compareStrings(a.key, b.key))
  // `Math.max` is what keeps a budget below zero from counting back from the end of the list.
  const limit = Math.max(0, budget)
  return { reuse, fetch: needed.slice(0, limit), deferred: needed.slice(limit).map(({ key }) => key) }
}

/** What an answered fetch comes to: the row to record, and for bytes that passed, what the file is to carry them as. */
interface Settled {
  outcome: IconOutcome
  held?: { sha256: string; dataUrl: string }
}

/**
 * Judge one answer that says something about the artifact. Bytes are checked
 * against the declaration: those that pass are recorded published, under the
 * sha256 they have, which is the recorded one when the key is read again and
 * unchanged. A failed check is recorded refused with the check's sentence, and
 * the fetch's own refusal and not-read sentences are recorded as they came.
 */
function settle(result: Exclude<IconFetchResult, { kind: 'not-yet-read' }>, declaration: IconDeclaration): Settled {
  if (result.kind !== 'bytes') return { outcome: { outcome: result.kind, detail: result.detail } }
  const checked = checkIconBytes(result.bytes, declaration)
  if (!checked.ok) return { outcome: { outcome: 'refused', detail: checked.detail } }
  const sha256 = sha256Hex(result.bytes)
  return {
    outcome: { outcome: 'published', sha256, mediaType: declaration.mediaType, bytes: result.bytes.length },
    held: { sha256, dataUrl: iconDataUrl(result.bytes, declaration.mediaType) },
  }
}

/** What a key stands at this build, from its row and the bytes to be had: an icon in hand, a sentence to report, or nothing yet. */
type Standing =
  | { kind: 'icon'; sha256: string; dataUrl: string }
  | { kind: 'refused'; detail: string }
  | { kind: 'not-read'; detail: string }
  | { kind: 'not-yet-read' }

/** Rows in the order the report prints them: by name, then identity, then detail. */
function compareRows(a: IconReportRow, b: IconReportRow): number {
  return compareStrings(a.name, b.name) || compareStrings(a.identity, b.identity) || compareStrings(a.detail, b.detail)
}

/**
 * Fold the fetches' answers into the day's artifacts (design §5.1, §5.3, §9).
 *
 * A key's row is the answer the plan fetched for it, laid over the committed
 * record: bytes that pass the check are recorded published, a failed check is
 * recorded refused with the check's sentence, and the fetch's own refused and
 * not-read answers are recorded as they came. A `not-yet-read` answer and a key
 * no answer came for change nothing, a deferred key among them. An answer for a
 * key the plan did not ask for is not read. Only the plan's `fetch` is: it
 * carries the declaration each answer is checked against, while what the plan
 * reuses and defers follows from the record and the file, which are in hand here
 * too.
 *
 * A key's bytes are at hand when this build fetched them or yesterday's file
 * holds the sha256 its row names. A key recorded published whose bytes are
 * neither has no icon this build, and counts as not yet read, with no row, no
 * identity entry and its record kept: the next build fetches it against that
 * sha256.
 *
 * The file is assembled under `budget` from the icons of the entries that are
 * not withheld, handing `assembleIcons` one record for each key and one data URL
 * for each sha256. It refuses a sha256 with two data URLs and a key with two
 * sha256s, and a throw there would stop the day's build over an icon, so neither
 * may reach it: a key's record is the one this build's answer left, whether or
 * not yesterday's file also held it, and bytes just fetched win over the data URL
 * the published file holds for the same sha256.
 *
 * Each entry that declares an icon is counted in exactly one bucket
 * ({@link IconCounts}), and each bucket that reports has one row for it. A
 * withheld entry is counted as withheld, whatever else is true of its icon,
 * because that is what stays true however its author fixes it. The record that
 * goes forward drops the keys no declared entry names, which prunes the row of a
 * package that left and keeps the row of an icon that is withheld, deferred or
 * unreachable today.
 * @param subjects - from {@link iconSubjects}.
 * @param plan - from {@link planIconWork} on the same subjects, record, file and withheld rows.
 * @param results - what each fetched key answered.
 * @param state - the committed record, `icon-state.json`.
 * @param published - yesterday's icons file, or `null` when it could not be read.
 * @param withheld - `withheld-icons.yml`, by {@link IconSubject.withheldKey}.
 * @param budget - the most bytes the icons file may have.
 */
export function foldIconResults(
  subjects: readonly IconSubject[],
  plan: IconPlan,
  results: ReadonlyMap<IconKey, IconFetchResult>,
  state: ReadonlyMap<IconKey, IconOutcome>,
  published: IconsFile | null,
  withheld: ReadonlyMap<string, { reason: string }>,
  budget: number = ICONS_FILE_BUDGET_BYTES,
): IconFold {
  const record = new Map(state)
  // Plan order is code-unit order of the keys, so the first key to hold a
  // sha256 is the same on every build.
  const freshDataUrls = new Map<string, string>()
  for (const work of plan.fetch) {
    const result = results.get(work.key)
    if (result === undefined || result.kind === 'not-yet-read') continue
    const { outcome, held } = settle(result, work.declaration)
    record.set(work.key, outcome)
    if (held !== undefined && !freshDataUrls.has(held.sha256)) freshDataUrls.set(held.sha256, held.dataUrl)
  }
  const dataUrlOf = (sha256: string): string | undefined =>
    freshDataUrls.get(sha256) ?? (published !== null && Object.hasOwn(published.icons, sha256) ? published.icons[sha256] : undefined)
  const standingOf = (outcome: IconOutcome | undefined): Standing => {
    if (outcome === undefined) return { kind: 'not-yet-read' }
    if (outcome.outcome !== 'published') return { kind: outcome.outcome, detail: outcome.detail }
    const dataUrl = dataUrlOf(outcome.sha256)
    return dataUrl === undefined ? { kind: 'not-yet-read' } : { kind: 'icon', sha256: outcome.sha256, dataUrl }
  }

  // One record for each key, whoever names it.
  const icons = new Map<IconKey, PublishedIcon>()
  for (const subject of subjects) {
    if (!isFetchable(subject) || withheld.has(subject.withheldKey)) continue
    const standing = standingOf(record.get(subject.key))
    if (standing.kind === 'icon') icons.set(subject.key, { key: subject.key, sha256: standing.sha256, dataUrl: standing.dataUrl })
  }
  const assembled = assembleIcons([...icons.values()], budget)
  const turnedAway = new Set(assembled.withheldForSize)

  const counts: IconCounts = { declared: 0, published: 0, withheldByHand: 0, withheldForSize: 0, refused: 0, notRead: 0, notYetRead: 0 }
  const byIdentity = new Map<string, string>()
  const rows: IconReportRow[] = []
  const report = (subject: IconSubject, kind: IconReportRow['kind'], detail: string): void => {
    rows.push({ name: subject.name, identity: subject.identity, kind, detail })
  }
  for (const subject of subjects) {
    const { read } = subject
    if (read.kind === 'none') continue
    counts.declared += 1
    const hold = withheld.get(subject.withheldKey)
    if (hold !== undefined) {
      counts.withheldByHand += 1
      report(subject, 'withheld', iconDetail.withheldByHand(hold.reason))
      continue
    }
    if (read.kind === 'refused') {
      counts.refused += 1
      report(subject, 'refused', read.detail)
      continue
    }
    // A declared icon with nothing to fetch it from is no icon this build.
    if (!isFetchable(subject)) {
      counts.notYetRead += 1
      continue
    }
    const standing = standingOf(record.get(subject.key))
    if (standing.kind === 'not-yet-read') {
      counts.notYetRead += 1
    } else if (standing.kind === 'refused') {
      counts.refused += 1
      report(subject, 'refused', standing.detail)
    } else if (standing.kind === 'not-read') {
      counts.notRead += 1
      report(subject, 'not-read', standing.detail)
    } else if (turnedAway.has(subject.key)) {
      counts.withheldForSize += 1
      report(subject, 'withheld', iconDetail.withheldForSize())
    } else {
      counts.published += 1
      byIdentity.set(subject.identity, standing.sha256)
    }
  }

  const live = new Set<IconKey>()
  for (const { read, key } of subjects) {
    if (read.kind === 'declared' && key !== undefined) live.add(key)
  }
  return {
    nextState: pruneIconState(record, live),
    file: Object.keys(assembled.file.icons).length === 0 ? null : assembled.file,
    byIdentity,
    rows: rows.sort(compareRows),
    counts,
  }
}
