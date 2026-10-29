/**
 * Planning the icon step and folding what it brings back (design
 * 2026-10-23-shop-plugin-icons §5.1, §5.3 and §9): the pure heart of the
 * feature, between the declarations the harvest already holds and the network
 * reads of `icon-fetch.ts`, and between those reads and the artifacts the build
 * writes.
 *
 * Four functions, in the order the daily build calls them:
 *
 * 1. {@link iconSubjects} pairs each listed entry with the icon its candidate
 *    declares, and names the artifact the icon would be read from.
 * 2. {@link planIconWork} sets those against the committed record
 *    (`icon-state.ts`) and yesterday's published icons file, and says which keys
 *    to reuse, which to fetch and which the per-run fetch budget turns away.
 * 3. {@link foldIconResults} turns the fetches' answers into the next record, the
 *    icons file, the map from each entry to its icon, and the report's rows and
 *    counts.
 * 4. {@link renderIconSection} writes those rows and counts as the report's
 *    icon section.
 *
 * An icon never stops the catalog (design decision 6), so an icon that is
 * missing, refused or unanswered makes nothing here throw. An entry no candidate
 * matches, a candidate with nowhere to fetch from, a fetch that did not answer
 * and a budget that turned one away are each an icon that is not there yet, and
 * the next build asks again, unless the bytes a recorded key names are already
 * in hand from another key (§5.3). A transport failure is never a refusal (§5.3):
 * only what a build read and judged is recorded.
 *
 * Pure: no clock, no network, no filesystem, no environment, and no locale.
 * Every ordering is by code unit (`compareStrings`), so that the plan, the file
 * and the report do not depend on the order the entries or the answers came in.
 *
 * @module icon-plan
 */
import { escapeCell } from './emit.ts'
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
 * than the budget. `deferred` lists the keys the budget turned away, which a
 * later build asks for again, unless another key's fetch brought in the bytes
 * their record names in the meantime ({@link foldIconResults}).
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
 * One line of the report's icon section: an icon that is refused, withheld or
 * not read, and why (design §10). `refused` and `not-read` are what a fetch or a
 * declaration came to; `withheld` is a maintainer's row in `withheld-icons.yml`
 * or the icons file's size budget. An icon not yet read has no row: it is
 * counted, and the next build asks for it again. None of them is a rejection:
 * the entry is listed.
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
  // A git install is keyed by the commit it is pinned to. The candidate was
  // paired by that commit, and it is read from the candidate because there it is
  // a commit and nothing else: the entry's `version` is a tag on a rescued entry.
  const inRepository = candidate.subdir === undefined ? path : `${candidate.subdir}/${path}`
  return {
    ...base,
    read,
    key: githubIconKey(candidate.repo, candidate.commit, inRepository),
    target: { kind: 'github', repo: candidate.repo, commit: candidate.commit, path: inRepository },
  }
}

/** The candidates of each install identity, in the order they came. */
function groupByIdentity<T>(candidates: readonly T[], identityOf: (candidate: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const candidate of candidates) {
    const identity = identityOf(candidate)
    const group = groups.get(identity)
    if (group === undefined) groups.set(identity, [candidate])
    else group.push(candidate)
  }
  return groups
}

/** Whether `candidate` is the artifact a repository entry lists: the commit a git install is pinned to, or the release asset a rescue installs. */
function isListedRepoCandidate(entry: Entry, candidate: RepoCandidate): boolean {
  const { tarball } = entry
  return tarball === undefined ? candidate.commit === entry.version : candidate.release?.sha256 === tarball.sha256
}

/**
 * One subject for each entry, in the order of `entries`: the entry, the icon its
 * candidate declares, and what it takes to read it.
 *
 * An entry is paired with the candidate of its own install identity and of the
 * artifact it lists: an npm package's version, the commit a git install is
 * pinned to, the asset a rescue installs. A bundle name is no identity, since
 * two forks can claim one and an npm package can share its name with a
 * repository's bundle, and an identity alone is not enough either. The gate can
 * turn a candidate away and list another of the same identity at another
 * version, commit or asset, and an icon read from that one is another
 * artifact's icon under this entry's key. Of two candidates of one artifact the
 * first is read. The entries are selected from these very candidates in the same
 * build, so every entry has its own; one that somehow has none reads no icon,
 * because a missing icon is the safe absence and an icon must never stop the
 * daily catalog (design decision 6).
 * @param entries - the entries the build will publish.
 * @param candidates - the npm candidates they were selected from.
 * @param repoCandidates - the repository candidates they were selected from.
 */
export function iconSubjects(
  entries: readonly Entry[],
  candidates: readonly Candidate[],
  repoCandidates: readonly RepoCandidate[],
): IconSubject[] {
  const npmByIdentity = groupByIdentity(candidates, (candidate) => installIdentity({ source: 'npm', name: candidate.name }))
  const repoByIdentity = groupByIdentity(repoCandidates, (candidate) =>
    installIdentity({ source: 'github', name: candidate.name, repo: candidate.repo, subdir: candidate.subdir }))
  return entries.map((entry) => {
    const identity = installIdentity(entry)
    const base: SubjectBase = {
      identity,
      name: entry.source === 'npm' ? entry.name : repoUnit({ repo: entry.repo ?? entry.name, subdir: entry.subdir }),
      withheldKey: firstSeenKey(entry),
    }
    return entry.source === 'npm'
      ? npmSubject(base, npmByIdentity.get(identity)?.find((candidate) => candidate.version === entry.version))
      : githubSubject(base, entry, repoByIdentity.get(identity)?.find((candidate) => isListedRepoCandidate(entry, candidate)))
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
    // A refusal or an unreadable artifact is final for this key; an icon the
    // file's budget turned away is not, and its bytes were never kept, so it is
    // fetched again — the file may have room for it this time.
    if (recorded !== undefined && recorded.outcome !== 'published' && recorded.outcome !== 'withheld-for-size') continue
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

/**
 * Where one entry's icon stands this build, decided once. The set of icons the
 * file is assembled from and the bucket each entry is counted in are both read
 * off it, so an entry cannot be counted published without having been handed to
 * the file. `icon` is an icon in hand, and still waits on the file budget, which
 * may turn it away; `none` is an entry that declares no icon, counted nowhere.
 */
type Standing =
  | { kind: 'none' }
  | { kind: 'withheld-by-hand'; reason: string }
  | { kind: 'refused'; detail: string }
  | { kind: 'not-read'; detail: string }
  | { kind: 'not-yet-read' }
  | { kind: 'icon'; key: IconKey; sha256: string; dataUrl: string }

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
 * A key recorded published has its icon when the bytes of the sha256 its row
 * names are in hand: in yesterday's file, or fetched this build under any key. A
 * sha256 names its bytes whichever key they were read under, and a key names one
 * immutable artifact, so they are that key's own icon, and a key whose fetch was
 * deferred or did not answer publishes with them (design §5.3). A key whose
 * bytes are nowhere has no icon this build, and counts as not yet read, with no
 * row, no identity entry and its record kept: the next build fetches it against
 * that sha256.
 *
 * The file is assembled under `budget` from the icons of the entries that are
 * not withheld, handing `assembleIcons` one record for each key and one data URL
 * for each sha256. It refuses a sha256 with two data URLs and a key with two
 * sha256s, and a throw there would stop the day's build over an icon, so neither
 * may reach it: a key's record is the one this build's answer left, whether or
 * not yesterday's file also held it, and bytes just fetched win over the data URL
 * the published file holds for the same sha256.
 *
 * Each entry's standing is decided once, and what is handed to the file and the
 * bucket the entry is counted in are both read off it. Each entry that declares
 * an icon is counted in exactly one bucket ({@link IconCounts}), and each bucket
 * that reports has one row for it. A withheld entry is counted as withheld,
 * whatever else is true of its icon, because that is what stays true however its
 * author fixes it. The record that goes forward drops the keys no declared entry
 * names, which prunes the row of a package that left and keeps the row of an
 * icon that is withheld, deferred or unreachable today.
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
  const standingOf = (subject: IconSubject): Standing => {
    const { read } = subject
    if (read.kind === 'none') return { kind: 'none' }
    const hold = withheld.get(subject.withheldKey)
    if (hold !== undefined) return { kind: 'withheld-by-hand', reason: hold.reason }
    if (read.kind === 'refused') return { kind: 'refused', detail: read.detail }
    // A refused read has no key, and returned above; a declared one always has
    // one, which the optional field's type does not say.
    const key = subject.key
    if (key === undefined) return { kind: 'not-yet-read' }
    const outcome = record.get(key)
    // Bytes already in the published file are in hand whatever the artifact
    // does now: the key names one immutable artifact, and the file carries a
    // copy. Consulted before `isFetchable`, which decides whether a FETCH is
    // possible, not whether the icon is available.
    if (outcome?.outcome === 'published') {
      const dataUrl = dataUrlOf(outcome.sha256)
      if (dataUrl !== undefined) return { kind: 'icon', key, sha256: outcome.sha256, dataUrl }
    }
    // A declared icon with nothing to fetch it from is no icon this build.
    if (!isFetchable(subject)) return { kind: 'not-yet-read' }
    if (outcome === undefined) return { kind: 'not-yet-read' }
    // Bytes the file's budget kept out are not in hand this build: the row's
    // size says they exist, and the next build fetches them to try again.
    if (outcome.outcome === 'withheld-for-size') return { kind: 'not-yet-read' }
    if (outcome.outcome !== 'published') return { kind: outcome.outcome, detail: outcome.detail }
    return { kind: 'not-yet-read' }
  }
  const standings = subjects.map((subject) => ({ subject, standing: standingOf(subject) }))

  // One record for each key, whoever names it.
  const icons = new Map<IconKey, PublishedIcon>()
  for (const { standing } of standings) {
    if (standing.kind === 'icon') icons.set(standing.key, { key: standing.key, sha256: standing.sha256, dataUrl: standing.dataUrl })
  }
  const assembled = assembleIcons([...icons.values()], budget)
  const turnedAway = new Set(assembled.withheldForSize)
  // A key the file's budget kept out was fetched and is valid, but the file
  // does not carry it; recorded `published`, the committed record claimed an
  // icon the published file did not have, and the next build could not tell the
  // two apart. Its row says what happened, and carries the size the plan needs
  // to decide whether the file has room for it later.
  for (const key of turnedAway) {
    const recorded = record.get(key)
    if (recorded?.outcome === 'published') {
      record.set(key, { outcome: 'withheld-for-size', sha256: recorded.sha256, mediaType: recorded.mediaType, bytes: recorded.bytes })
    }
  }

  const counts: IconCounts = { declared: 0, published: 0, withheldByHand: 0, withheldForSize: 0, refused: 0, notRead: 0, notYetRead: 0 }
  const byIdentity = new Map<string, string>()
  const rows: IconReportRow[] = []
  const report = (subject: IconSubject, kind: IconReportRow['kind'], detail: string): void => {
    rows.push({ name: subject.name, identity: subject.identity, kind, detail })
  }
  for (const { subject, standing } of standings) {
    if (standing.kind === 'none') continue
    counts.declared += 1
    if (standing.kind === 'withheld-by-hand') {
      counts.withheldByHand += 1
      report(subject, 'withheld', iconDetail.withheldByHand(standing.reason))
    } else if (standing.kind === 'refused') {
      counts.refused += 1
      report(subject, 'refused', standing.detail)
    } else if (standing.kind === 'not-read') {
      counts.notRead += 1
      report(subject, 'not-read', standing.detail)
    } else if (standing.kind === 'not-yet-read') {
      counts.notYetRead += 1
    } else if (turnedAway.has(standing.key)) {
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

/**
 * The report's icon section (design 2026-10-23-shop-plugin-icons §10): one line
 * of counts and the size of the icons file, then one row for each icon that is
 * refused, withheld or not read, and why ({@link IconReportRow}); an icon not
 * yet read is counted and has no row. With no row there is no table, so a
 * catalog whose icons all land carries no empty one. The text starts at its
 * `## Icons` heading, with no blank line before it, and ends with one newline.
 *
 * Both cells go through `escapeCell`: a row's name and detail come from what a
 * package or a repository declared, and a `|` or a newline in one would break
 * the row its author reads. The rows are printed in the order the fold gave
 * them, which is the report's order already. Numbers are plain digits, whatever
 * the locale, so the section reads the same on every machine.
 * @param fold - the rows and counts of {@link foldIconResults}.
 * @param fileBytes - the size of the icons file the build publishes, or `null` when it publishes none.
 */
export function renderIconSection(fold: Pick<IconFold, 'rows' | 'counts'>, fileBytes: number | null): string {
  const { counts, rows } = fold
  const summary = `Declared ${counts.declared}: published ${counts.published}, withheld by hand ${counts.withheldByHand}, withheld for size ${counts.withheldForSize}, refused ${counts.refused}, not read ${counts.notRead}, not yet read ${counts.notYetRead}.`
  const file = fileBytes === null ? 'Icons file: none.' : `Icons file: ${fileBytes} bytes.`
  const lines = [
    '## Icons',
    '',
    `${summary} ${file}`,
    ...(rows.length > 0 ? ['', '| Plugin | Icon |', '|---|---|', ...rows.map((row) => `| ${escapeCell(row.name)} | ${escapeCell(row.detail)} |`)] : []),
  ]
  return `${lines.join('\n')}\n`
}
