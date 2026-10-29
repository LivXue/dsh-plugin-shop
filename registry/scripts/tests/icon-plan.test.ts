import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import { MAX_CATALOG_ICON_BYTES, checkIconBytes, iconDataUrl, sha256Hex } from '../src/icon-bytes.ts'
import { iconDetail, iconLabel, shownPath } from '../src/icon-declaration.ts'
import type { IconDeclaration, IconMediaType } from '../src/icon-declaration.ts'
import { foldIconResults, iconSubjects, planIconWork, renderIconSection } from '../src/icon-plan.ts'
import type { IconCounts, IconFetchResult, IconFetchTarget, IconFold, IconPlan, IconReportRow, IconSubject } from '../src/icon-plan.ts'
import { githubIconKey, npmIconKey, parseIconState, releaseIconKey, serializeIconState } from '../src/icon-state.ts'
import type { IconKey, IconOutcome } from '../src/icon-state.ts'
import { compareStrings } from '../src/identity.ts'
import { ICONS_FILE_BUDGET_BYTES, parseIconsFile, serializeIcons } from '../src/icons-assemble.ts'
import type { IconsFile } from '../src/icons-assemble.ts'
import type { Candidate, Entry, RepoCandidate, StoredIconRead } from '../src/types.ts'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const SVG_NS = 'http://www.w3.org/2000/svg'

/** A valid SVG for `label`. Two labels never make the same bytes, so never the same sha256. */
const svgOf = (label: string): Uint8Array => utf8(`<svg xmlns="${SVG_NS}"><title>${label}</title></svg>`)

/** A valid SVG of exactly `length` bytes, padded with a comment so that it stays a document a browser draws. */
function svgOfLength(length: number): Uint8Array {
  const head = `<svg xmlns="${SVG_NS}"><!--`
  const tail = '--></svg>'
  const encoded = utf8(head + 'x'.repeat(length - head.length - tail.length) + tail)
  // The fixture's arithmetic: all of it is ASCII, so characters are bytes.
  if (encoded.length !== length) throw new Error(`svgOfLength(${length}) made ${encoded.length} bytes`)
  return encoded
}

/**
 * A valid SVG of exactly the largest size the catalog carries, with `label` in
 * its first bytes so that two labels never make one sha256.
 */
function largeSvg(label: string): Uint8Array {
  const head = `<svg xmlns="${SVG_NS}"><!--${label}-`
  const tail = '--></svg>'
  const encoded = utf8(head + 'x'.repeat(MAX_CATALOG_ICON_BYTES - head.length - tail.length) + tail)
  if (encoded.length !== MAX_CATALOG_ICON_BYTES) throw new Error(`largeSvg(${label}) made ${encoded.length} bytes`)
  return encoded
}

/** The eight bytes every PNG starts with, and padding: a PNG as far as the sniff goes, and no SVG at all. */
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00)

/**
 * Bytes the check refuses under every extension: text that is no image. The
 * refused fixtures below used PNG under `icon.svg` until Firefox was measured
 * drawing a raster under image/svg+xml, which the check now accepts (design
 * §5.4).
 */
const NOT_AN_IMAGE = utf8('<html></html>')

// What a git-pinned entry is pinned to and what a rescued one installs. The
// digests are real ones, made here, so that nothing below is a typed hash.
const COMMIT = sha256Hex(utf8('a commit')).slice(0, 40)
const OTHER_COMMIT = sha256Hex(utf8('another commit')).slice(0, 40)
const TARBALL_SHA = sha256Hex(utf8('a release asset'))
const OTHER_TARBALL_SHA = sha256Hex(utf8('another release asset'))
const RELEASE_URL = 'https://github.com/o/r/releases/download/v1.0.0/plugin.tgz'

const integrityOf = (name: string, version = '1.0.0'): string => `sha512-${Buffer.from(`${name}@${version}`).toString('base64')}`
const tarballOf = (name: string, version = '1.0.0'): string => `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`

function declaration(path = 'icon.svg', mediaType: IconMediaType = 'image/svg+xml', source: IconDeclaration['source'] = 'icon'): IconDeclaration {
  return { source, path, mediaType }
}

/** What a candidate stores for an icon its manifest declares. */
const declared = (path = 'icon.svg', mediaType: IconMediaType = 'image/svg+xml', source: IconDeclaration['source'] = 'icon'): StoredIconRead =>
  ({ kind: 'declared', declaration: declaration(path, mediaType, source) })

/** What a candidate stores for an icon its manifest declares and dsh would not read. */
const refusedRead = (detail: string): StoredIconRead => ({ kind: 'refused', detail })

const CATALOG = { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] } as const

function npmEntry(name: string, version = '1.0.0'): Entry {
  return {
    name, version, integrity: integrityOf(name, version), publishedAt: '2026-08-01T12:00:00.000Z',
    repository: `https://github.com/you/${name}`, license: 'MIT', tier: 'community', metadata: 'declared',
    catalog: { ...CATALOG, capabilities: [] }, source: 'npm', added: '2026-08-01',
  }
}

/** A git-installed entry: its version and integrity are both the commit. */
function gitEntry(repo: string, options: { name?: string; subdir?: string; commit?: string } = {}): Entry {
  const commit = options.commit ?? COMMIT
  return {
    name: options.name ?? `bundle-of-${repo.replace('/', '-')}`, version: commit, integrity: commit,
    publishedAt: '2026-08-01T12:00:00.000Z', repository: `https://github.com/${repo}`, license: 'MIT',
    tier: 'community', metadata: 'declared', catalog: { ...CATALOG, capabilities: [] }, source: 'github', repo,
    ...(options.subdir === undefined ? {} : { subdir: options.subdir }), added: '2026-08-01',
  }
}

/** A release-rescued entry: its version is the tag, its integrity the asset's sha256. */
function rescuedEntry(repo: string, options: { name?: string; tag?: string; url?: string; sha256?: string } = {}): Entry {
  const tarball = { url: options.url ?? RELEASE_URL, sha256: options.sha256 ?? TARBALL_SHA }
  return {
    ...gitEntry(repo, options.name === undefined ? {} : { name: options.name }),
    version: options.tag ?? 'v1.0.0', integrity: tarball.sha256, tarball,
  }
}

/**
 * The candidate an npm entry was built from. An icon, when it declares one,
 * brings its tarball URL. A version in `overrides` moves the integrity and the
 * tarball with it, as npm writes them for each version.
 */
function npmCandidate(name: string, icon?: StoredIconRead, overrides: Partial<Candidate> = {}): Candidate {
  const version = overrides.version ?? '1.0.0'
  return {
    name, version, integrity: integrityOf(name, version), publishedAt: '2026-08-01T12:00:00.000Z',
    repository: `https://github.com/you/${name}`, license: 'MIT', deprecated: false, hasBundle: true,
    catalog: { ...CATALOG, capabilities: [] }, description: 'x', keywords: [], peers: [],
    ...(icon === undefined ? {} : { icon, distTarball: tarballOf(name, version) }),
    ...overrides,
  }
}

function repoCandidate(
  repo: string,
  options: { name?: string; subdir?: string; commit?: string; icon?: StoredIconRead; rescued?: boolean; sha256?: string } = {},
): RepoCandidate {
  const commit = options.commit ?? COMMIT
  return {
    name: options.name ?? `bundle-of-${repo.replace('/', '-')}`, repo, commit, version: commit,
    publishedAt: '2026-08-01T12:00:00.000Z', repository: `https://github.com/${repo}`, license: 'MIT',
    hasBundle: true, requiresBuild: options.rescued === true, hasWorkspaceDeps: false,
    catalog: { ...CATALOG, capabilities: [] }, description: 'x',
    ...(options.subdir === undefined ? {} : { subdir: options.subdir }),
    ...(options.icon === undefined ? {} : { icon: options.icon }),
    ...(options.rescued === true ? { release: { tag: 'v1.0.0', url: RELEASE_URL, sha256: options.sha256 ?? TARBALL_SHA, assetVerified: true as const } } : {}),
  }
}

const only = <T>(items: readonly T[]): T => {
  const [first, ...rest] = items
  if (first === undefined || rest.length > 0) throw new Error(`expected exactly one item, got ${items.length}`)
  return first
}

const keyOf = (subject: IconSubject): IconKey => {
  if (subject.key === undefined) throw new Error(`${subject.identity} has no key`)
  return subject.key
}

const targetOf = (subject: IconSubject): IconFetchTarget => {
  if (subject.target === undefined) throw new Error(`${subject.identity} has no target`)
  return subject.target
}

/** The subject of `name` among `subjects`, found by what the report calls it. */
const subjectNamed = (subjects: readonly IconSubject[], name: string): IconSubject => {
  const found = subjects.find((subject) => subject.name === name)
  if (found === undefined) throw new Error(`no subject is named ${name}`)
  return found
}

/** The subject of an npm package that declares an icon (`null` for one that declares none). */
function npmSubject(name: string, icon: StoredIconRead | null = declared()): IconSubject {
  return only(iconSubjects([npmEntry(name)], [npmCandidate(name, icon ?? undefined)], []))
}

/** The key of `npmSubject(name)`, written out the way the builder does, for the tests that name a key before they have a subject. */
const npmKey = (name: string, path = 'icon.svg'): IconKey => npmIconKey(name, '1.0.0', path)

/** The row a build records for bytes that passed. */
const publishedRow = (bytes: Uint8Array, mediaType: IconMediaType = 'image/svg+xml'): IconOutcome =>
  ({ outcome: 'published', sha256: sha256Hex(bytes), mediaType, bytes: bytes.length })

/** The row of bytes the file's budget turned away: read and valid, and not in the file. */
const withheldRow = (bytes: Uint8Array, mediaType: IconMediaType = 'image/svg+xml'): IconOutcome =>
  ({ outcome: 'withheld-for-size', sha256: sha256Hex(bytes), mediaType, bytes: bytes.length })

/** The file an earlier build published for these icons: each key under the sha256 of its bytes. */
function fileOf(held: readonly (readonly [IconKey, Uint8Array])[], mediaType: IconMediaType = 'image/svg+xml'): IconsFile {
  return {
    icons: Object.fromEntries(held.map(([, bytes]) => [sha256Hex(bytes), iconDataUrl(bytes, mediaType)])),
    sources: Object.fromEntries(held.map(([key, bytes]) => [key, sha256Hex(bytes)])),
  }
}

/** What the budget counts, as `assembleIcons` measures it. */
const sizeOf = (file: IconsFile): number => Buffer.byteLength(serializeIcons(file).json)

const bytesResult = (bytes: Uint8Array): IconFetchResult => ({ kind: 'bytes', bytes })
const resultsOf = (...pairs: [IconKey, IconFetchResult][]): Map<IconKey, IconFetchResult> => new Map(pairs)
const stateOf = (...pairs: [IconKey, IconOutcome][]): Map<IconKey, IconOutcome> => new Map(pairs)
const withheldOf = (...pairs: [string, string][]): Map<string, { reason: string }> =>
  new Map(pairs.map(([name, reason]): [string, { reason: string }] => [name, { reason }]))

const permutations = <T>(items: readonly T[]): T[][] => items.length <= 1
  ? [[...items]]
  : items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]))

const ZERO = { declared: 0, published: 0, withheldByHand: 0, withheldForSize: 0, refused: 0, notRead: 0, notYetRead: 0 }

/** More fetches than any fixture here has keys: a budget that never binds. */
const PLENTY = 1000

const compareRows = (a: IconReportRow, b: IconReportRow): number =>
  compareStrings(a.name, b.name) || compareStrings(a.identity, b.identity) || compareStrings(a.detail, b.detail)

/**
 * What every fold must satisfy, whatever it was folding. Each assertion here is
 * a property of the answer and none is about the case a test builds, so a test
 * that runs a day through `runDay` asserts all of them without saying so.
 *
 * - Every declared subject is in exactly one bucket, so the counts add up, and
 *   each bucket that reports has one row for each subject in it: as many rows
 *   of each kind as its buckets count, and no two rows for one identity.
 * - A subject counts as published only where its icon is in the file: the
 *   identity map, the file's `sources` and its `icons` agree, and nothing is in
 *   the file that no published subject names.
 * - The file is null exactly when it holds no icon, and what it holds reads
 *   back as it is written.
 * - Rows are in the order the report prints them.
 * - The next record holds only keys a declared subject names.
 */
function expectSound(result: IconFold, subjects: readonly IconSubject[]): void {
  const { counts, file } = result
  expect(counts.declared).toBe(subjects.filter(({ read }) => read.kind !== 'none').length)
  expect(counts.published + counts.withheldByHand + counts.withheldForSize + counts.refused + counts.notRead + counts.notYetRead).toBe(counts.declared)
  expect(result.rows).toHaveLength(counts.withheldByHand + counts.withheldForSize + counts.refused + counts.notRead)
  const rowsOfKind = (kind: IconReportRow['kind']): number => result.rows.filter((row) => row.kind === kind).length
  expect(rowsOfKind('withheld')).toBe(counts.withheldByHand + counts.withheldForSize)
  expect(rowsOfKind('refused')).toBe(counts.refused)
  expect(rowsOfKind('not-read')).toBe(counts.notRead)
  expect(new Set(result.rows.map(({ identity }) => identity)).size).toBe(result.rows.length)
  expect(result.rows).toEqual([...result.rows].sort(compareRows))
  expect(result.byIdentity.size).toBe(counts.published)
  const published = subjects.filter(({ identity }) => result.byIdentity.has(identity))
  const names = new Set<IconKey>()
  for (const { identity, key } of published) {
    const sha256 = result.byIdentity.get(identity)
    expect(sha256).toBeDefined()
    expect(key).toBeDefined()
    if (key !== undefined) names.add(key)
    expect(key === undefined ? undefined : file?.sources[key]).toBe(sha256)
    expect(sha256 === undefined ? undefined : file?.icons[sha256]).toBeDefined()
  }
  if (file === null) {
    expect(counts.published).toBe(0)
  } else {
    expect(Object.keys(file.icons).length).toBeGreaterThan(0)
    expect(new Set(Object.keys(file.sources))).toEqual(names)
    expect(new Set(Object.values(file.sources))).toEqual(new Set(Object.keys(file.icons)))
    expect(parseIconsFile(serializeIcons(file).json)).toEqual(file)
  }
  const live = new Set(subjects.flatMap(({ read, key }) => (read.kind === 'declared' && key !== undefined ? [key] : [])))
  for (const key of result.nextState.keys()) expect(live.has(key)).toBe(true)
}

interface Day {
  state?: ReadonlyMap<IconKey, IconOutcome>
  published?: IconsFile | null
  withheld?: ReadonlyMap<string, { reason: string }>
  results?: ReadonlyMap<IconKey, IconFetchResult>
  /** The most keys the plan may fetch. */
  fetchBudget?: number
  /** The most bytes the icons file may have. */
  fileBudget?: number
}

/**
 * One build's icon step, as the build runs it: plan from the record and
 * yesterday's file, then fold what the fetches answered. The fold is checked
 * against {@link expectSound} before it is handed back.
 */
function runDay(subjects: readonly IconSubject[], day: Day = {}): { plan: IconPlan; fold: IconFold } {
  const state = day.state ?? new Map<IconKey, IconOutcome>()
  const published = day.published ?? null
  const withheld = day.withheld ?? new Map<string, { reason: string }>()
  const plan = planIconWork(subjects, state, published, withheld, day.fetchBudget ?? PLENTY)
  const fold = foldIconResults(subjects, plan, day.results ?? new Map<IconKey, IconFetchResult>(), state, published, withheld, day.fileBudget)
  expectSound(fold, subjects)
  return { plan, fold }
}

describe('the fixtures', () => {
  it('are the sizes and the identities their names say', () => {
    expect(sha256Hex(svgOf('a'))).not.toBe(sha256Hex(svgOf('b')))
    expect(svgOf('a').length).toBe(svgOf('b').length)
    expect(svgOfLength(MAX_CATALOG_ICON_BYTES / 2).length).toBe(MAX_CATALOG_ICON_BYTES / 2)
    expect(COMMIT).toMatch(/^[0-9a-f]{40}$/)
    expect(OTHER_COMMIT).toMatch(/^[0-9a-f]{40}$/)
    expect(OTHER_COMMIT).not.toBe(COMMIT)
    expect(TARBALL_SHA).toMatch(/^[0-9a-f]{64}$/)
  })

  it('are bytes the check passes and bytes it does not', () => {
    expect(checkIconBytes(svgOf('a'), declaration())).toEqual({ ok: true })
    expect(checkIconBytes(svgOfLength(MAX_CATALOG_ICON_BYTES / 2), declaration())).toEqual({ ok: true })
    expect(checkIconBytes(PNG, declaration('icon.png', 'image/png'))).toEqual({ ok: true })
    expect(checkIconBytes(PNG, declaration())).toEqual({ ok: true })
    expect(checkIconBytes(NOT_AN_IMAGE, declaration())).toMatchObject({ ok: false })
    expect(checkIconBytes(new Uint8Array(MAX_CATALOG_ICON_BYTES + 1), declaration())).toMatchObject({ ok: false })
  })

  it('make entries and candidates of the install identity their names say', () => {
    expect(npmSubject('x').identity).toBe('npm:x')
    expect(only(iconSubjects([gitEntry('o/r')], [], [repoCandidate('o/r')])).identity).toBe('github:o/r#')
    expect(only(iconSubjects([rescuedEntry('o/r')], [], [repoCandidate('o/r', { rescued: true })])).identity).toBe('github:o/r#')
  })
})

describe('iconSubjects: the key and the target', () => {
  it('keys an npm icon by package, version and path, and targets the listed tarball', () => {
    expect(iconSubjects([npmEntry('x')], [npmCandidate('x', declared('icon.svg'))], [])).toStrictEqual([{
      identity: 'npm:x',
      name: 'x',
      withheldKey: 'x',
      read: declared('icon.svg'),
      key: 'npm:x@1.0.0:icon.svg',
      target: { kind: 'npm', name: 'x', version: '1.0.0', tarball: tarballOf('x'), integrity: integrityOf('x'), path: 'icon.svg' },
    }])
  })

  it('keys a subpackage icon by repository, commit and the path from the repository root', () => {
    const entry = gitEntry('o/r', { name: 'bundle-a', subdir: 'packages/a' })
    const candidate = repoCandidate('o/r', { name: 'bundle-a', subdir: 'packages/a', icon: declared('icon.svg') })
    expect(iconSubjects([entry], [], [candidate])).toStrictEqual([{
      identity: 'github:o/r#packages/a',
      name: 'o/r#packages/a',
      withheldKey: 'o/r',
      read: declared('icon.svg'),
      key: `github:o/r@${COMMIT}:packages/a/icon.svg`,
      target: { kind: 'github', repo: 'o/r', commit: COMMIT, path: 'packages/a/icon.svg' },
    }])
  })

  it('leaves the path of a root package as the manifest wrote it', () => {
    const subject = only(iconSubjects([gitEntry('o/r')], [], [repoCandidate('o/r', { icon: declared('assets/icon.png', 'image/png') })]))
    expect(subject.key).toBe(githubIconKey('o/r', COMMIT, 'assets/icon.png'))
    expect(subject.target).toEqual({ kind: 'github', repo: 'o/r', commit: COMMIT, path: 'assets/icon.png' })
  })

  it('keys a release-rescued icon by the asset\'s sha256 and targets the recorded asset, with no subdirectory', () => {
    const subject = only(iconSubjects(
      [rescuedEntry('o/r', { tag: 'v9.9.9' })], [],
      [repoCandidate('o/r', { rescued: true, icon: declared('assets/icon.png', 'image/png') })],
    ))
    expect(subject).toStrictEqual({
      identity: 'github:o/r#',
      name: 'o/r',
      withheldKey: 'o/r',
      read: declared('assets/icon.png', 'image/png'),
      key: releaseIconKey(TARBALL_SHA, 'assets/icon.png'),
      target: { kind: 'release', repo: 'o/r', url: RELEASE_URL, sha256: TARBALL_SHA, path: 'assets/icon.png' },
    })
    // The tag is display only: it is in neither the key nor the target.
    expect(JSON.stringify(subject.key)).not.toContain('v9.9.9')
    expect(JSON.stringify(subject.target)).not.toContain('v9.9.9')
  })

  it('keys a git icon by the commit its entry is pinned to', () => {
    // A rescued entry's version is a tag, which no key rests on (above). A git
    // entry's is its commit, and the candidate it reads is the one at it.
    const entry = gitEntry('o/r', { commit: OTHER_COMMIT })
    const subject = only(iconSubjects([entry], [], [repoCandidate('o/r', { commit: OTHER_COMMIT, icon: declared() })]))
    expect(subject.key).toBe(githubIconKey('o/r', OTHER_COMMIT, 'icon.svg'))
    expect(subject.target).toEqual({ kind: 'github', repo: 'o/r', commit: OTHER_COMMIT, path: 'icon.svg' })
  })

  it('names a repository entry by its repository and subdirectory, as the rejection table does, and not by a bundle name that forks share', () => {
    const subjects = iconSubjects([gitEntry('a/x', { name: 'x' }), gitEntry('b/x', { name: 'x', subdir: 'sub' })], [], [])
    expect(subjects.map(({ name }) => name)).toEqual(['a/x', 'b/x#sub'])
  })

  it('takes the withheld key from the npm name as it is, and from the repository lower-cased', () => {
    const subjects = iconSubjects([npmEntry('Legacy-Name'), gitEntry('Owner/Repo'), gitEntry('Owner/Repo', { subdir: 'sub' })], [], [])
    expect(subjects.map(({ identity, withheldKey }) => [identity, withheldKey])).toEqual([
      ['npm:Legacy-Name', 'Legacy-Name'],
      ['github:Owner/Repo#', 'owner/repo'],
      ['github:Owner/Repo#sub', 'owner/repo'],
    ])
  })
})

describe('iconSubjects: which candidate an entry reads', () => {
  it('pairs an entry with the candidate of its own install identity, not of its name', () => {
    // Two forks claim one bundle name, a root and a subpackage share a
    // repository, and an npm package shares the name with a repository's
    // bundle: each entry reads its own declaration and no other.
    const entries = [
      gitEntry('a/x', { name: 'x' }),
      gitEntry('b/x', { name: 'x' }),
      gitEntry('a/x', { name: 'x-sub', subdir: 'sub' }),
      npmEntry('x'),
    ]
    const repos = [
      repoCandidate('a/x', { name: 'x', icon: declared('a.svg') }),
      repoCandidate('b/x', { name: 'x', icon: declared('b.svg') }),
      repoCandidate('a/x', { name: 'x-sub', subdir: 'sub', icon: declared('sub.svg') }),
    ]
    const subjects = iconSubjects(entries, [npmCandidate('x')], repos)
    expect(subjects.map(({ key }) => key)).toEqual([
      githubIconKey('a/x', COMMIT, 'a.svg'),
      githubIconKey('b/x', COMMIT, 'b.svg'),
      githubIconKey('a/x', COMMIT, 'sub/sub.svg'),
      undefined,
    ])
  })

  it('reads no icon for an entry no candidate matches, and does not throw', () => {
    // An icon never stops the catalog: a missing icon is the safe absence.
    const lost = { ...gitEntry('o/lost'), repo: undefined }
    expect(iconSubjects([npmEntry('x'), gitEntry('o/r'), lost], [], [])).toStrictEqual([
      { identity: 'npm:x', name: 'x', withheldKey: 'x', read: { kind: 'none' } },
      { identity: 'github:o/r#', name: 'o/r', withheldKey: 'o/r', read: { kind: 'none' } },
      { identity: `github:${lost.name}#`, name: lost.name, withheldKey: lost.name, read: { kind: 'none' } },
    ])
  })

  it('reads no icon for a candidate that declares none', () => {
    expect(iconSubjects([npmEntry('x'), gitEntry('o/r')], [npmCandidate('x')], [repoCandidate('o/r')])).toStrictEqual([
      { identity: 'npm:x', name: 'x', withheldKey: 'x', read: { kind: 'none' } },
      { identity: 'github:o/r#', name: 'o/r', withheldKey: 'o/r', read: { kind: 'none' } },
    ])
  })

  it('carries a refused read through, with its sentence, and gives it no key and no target', () => {
    const detail = iconDetail.notString()
    expect(iconSubjects([npmEntry('x'), gitEntry('o/r')], [npmCandidate('x', refusedRead(detail))], [repoCandidate('o/r', { icon: refusedRead(detail) })]))
      .toStrictEqual([
        { identity: 'npm:x', name: 'x', withheldKey: 'x', read: { kind: 'refused', detail } },
        { identity: 'github:o/r#', name: 'o/r', withheldKey: 'o/r', read: { kind: 'refused', detail } },
      ])
  })

  it.each<[what: string, overrides: Partial<Candidate>]>([
    ['no tarball URL', { distTarball: undefined }],
    ['an empty tarball URL', { distTarball: '' }],
    ['no integrity', { integrity: null }],
    ['an empty integrity', { integrity: '' }],
  ])('keeps the key of an npm package with %s and gives it no target', (_what, overrides) => {
    const subject = only(iconSubjects([npmEntry('x')], [npmCandidate('x', declared(), overrides)], []))
    expect(subject.key).toBe('npm:x@1.0.0:icon.svg')
    expect(subject.read).toEqual(declared())
    expect(subject).not.toHaveProperty('target')
  })

  it('keeps the first of two candidates of one artifact', () => {
    // Two records of one version or commit are one artifact, and the first is
    // read. They are given two icons here only to show which.
    const subjects = iconSubjects(
      [npmEntry('x'), gitEntry('o/r', { subdir: 'sub' })],
      [npmCandidate('x', declared('first.svg')), npmCandidate('x', declared('second.svg'))],
      [
        repoCandidate('o/r', { subdir: 'sub', icon: declared('first.svg') }),
        repoCandidate('o/r', { subdir: 'sub', icon: declared('second.svg') }),
      ],
    )
    expect(subjects.map(({ read }) => read)).toEqual([declared('first.svg'), declared('first.svg')])
  })

  // The gate can turn a candidate away and list another of the same identity at
  // another version, commit or asset. An entry reads the candidate of the
  // artifact it lists, whichever comes first, and none when there is none: an
  // icon read from another version's manifest would be another version's icon.
  it('pairs an npm entry with the candidate of its own version, whichever comes first', () => {
    const own = npmCandidate('x', declared('own.svg'))
    const other = npmCandidate('x', declared('other.svg'), { version: '2.0.0' })
    for (const candidates of [[own, other], [other, own]]) {
      const subject = only(iconSubjects([npmEntry('x')], candidates, []))
      expect(subject.key).toBe(npmIconKey('x', '1.0.0', 'own.svg'))
      expect(subject.read).toEqual(declared('own.svg'))
    }
  })

  it('pairs a git entry with the candidate at its own commit, whichever comes first', () => {
    const own = repoCandidate('o/r', { icon: declared('own.svg') })
    const other = repoCandidate('o/r', { commit: OTHER_COMMIT, icon: declared('other.svg') })
    for (const candidates of [[own, other], [other, own]]) {
      const subject = only(iconSubjects([gitEntry('o/r')], [], candidates))
      expect(subject.key).toBe(githubIconKey('o/r', COMMIT, 'own.svg'))
      expect(subject.read).toEqual(declared('own.svg'))
    }
  })

  it('pairs a rescued entry with the candidate of its own asset, whichever comes first', () => {
    const own = repoCandidate('o/r', { rescued: true, icon: declared('own.svg') })
    const other = repoCandidate('o/r', { rescued: true, sha256: OTHER_TARBALL_SHA, icon: declared('other.svg') })
    for (const candidates of [[own, other], [other, own]]) {
      const subject = only(iconSubjects([rescuedEntry('o/r')], [], candidates))
      expect(subject.key).toBe(releaseIconKey(TARBALL_SHA, 'own.svg'))
      expect(subject.read).toEqual(declared('own.svg'))
    }
  })

  it.each<[what: string, entry: Entry, candidates: RepoCandidate[]]>([
    ['a git entry whose only candidate is at another commit', gitEntry('o/r'), [repoCandidate('o/r', { commit: OTHER_COMMIT, icon: declared() })]],
    ['a rescued entry whose only candidate holds another asset', rescuedEntry('o/r'), [repoCandidate('o/r', { rescued: true, sha256: OTHER_TARBALL_SHA, icon: declared() })]],
    ['a rescued entry whose only candidate was never rescued', rescuedEntry('o/r'), [repoCandidate('o/r', { icon: declared() })]],
  ])('reads no icon for %s', (_what, entry, candidates) => {
    expect(only(iconSubjects([entry], [], candidates)).read).toEqual({ kind: 'none' })
  })

  it('reads no icon for an npm entry whose only candidate is of another version', () => {
    const subject = only(iconSubjects([npmEntry('x')], [npmCandidate('x', declared(), { version: '2.0.0' })], []))
    expect(subject).toStrictEqual({ identity: 'npm:x', name: 'x', withheldKey: 'x', read: { kind: 'none' } })
  })

  it('makes one subject for each entry, in the order of the entries', () => {
    const entries = [npmEntry('b'), gitEntry('o/r'), npmEntry('a')]
    expect(iconSubjects(entries, [npmCandidate('a'), npmCandidate('b')], [repoCandidate('o/r')]).map(({ identity }) => identity))
      .toEqual(['npm:b', 'github:o/r#', 'npm:a'])
    expect(iconSubjects([], [npmCandidate('a')], [repoCandidate('o/r')])).toEqual([])
  })

  it('leaves what it is given as it was', () => {
    const entries = [npmEntry('x'), gitEntry('o/r', { subdir: 'sub' })]
    const candidates = [npmCandidate('x', declared())]
    const repos = [repoCandidate('o/r', { subdir: 'sub', icon: declared() })]
    const before = JSON.stringify([entries, candidates, repos])
    iconSubjects(entries, candidates, repos)
    expect(JSON.stringify([entries, candidates, repos])).toBe(before)
  })
})

describe('planIconWork: what is asked for', () => {
  const x = npmSubject('x')

  it('fetches a key the record does not know, with its target and declaration and no expected sha256', () => {
    const plan = planIconWork([x], new Map(), null, new Map(), PLENTY)
    expect(plan).toStrictEqual({
      reuse: [],
      deferred: [],
      fetch: [{ key: keyOf(x), target: x.target, declaration: declaration('icon.svg') }],
    })
  })

  it.each<[what: string, row: IconOutcome]>([
    ['refused', { outcome: 'refused', detail: iconDetail.notString() }],
    ['not read', { outcome: 'not-read', detail: iconDetail.releaseUnreadable() }],
  ])('does not ask again for a key recorded %s', (_what, row) => {
    // Neither a refusal nor a package past the caps changes without a new
    // version, commit or tarball, which is a new key; and yesterday's file may
    // hold an icon under this key all the same.
    const bytes = svgOf('x')
    const plan = planIconWork([x], stateOf([keyOf(x), row]), fileOf([[keyOf(x), bytes]]), new Map(), PLENTY)
    expect(plan).toEqual({ reuse: [], fetch: [], deferred: [] })
  })

  it('reuses a key recorded published whose sha256 is in yesterday\'s file', () => {
    const bytes = svgOf('x')
    const plan = planIconWork([x], stateOf([keyOf(x), publishedRow(bytes)]), fileOf([[keyOf(x), bytes]]), new Map(), PLENTY)
    expect(plan).toEqual({ reuse: [{ key: keyOf(x), sha256: sha256Hex(bytes) }], fetch: [], deferred: [] })
  })

  it('reuses by the record\'s sha256, whatever the file\'s own sources say of the key', () => {
    const bytes = svgOf('x')
    const elsewhere = fileOf([[npmKey('someone-else'), bytes]])
    const plan = planIconWork([x], stateOf([keyOf(x), publishedRow(bytes)]), elsewhere, new Map(), PLENTY)
    expect(plan.reuse).toEqual([{ key: keyOf(x), sha256: sha256Hex(bytes) }])
  })

  it('fetches a key recorded published again, expecting its sha256, when there is no published file', () => {
    const bytes = svgOf('x')
    const plan = planIconWork([x], stateOf([keyOf(x), publishedRow(bytes)]), null, new Map(), PLENTY)
    expect(plan).toStrictEqual({
      reuse: [],
      deferred: [],
      fetch: [{ key: keyOf(x), target: x.target, declaration: declaration('icon.svg'), expectSha256: sha256Hex(bytes) }],
    })
  })

  it('fetches a key recorded published again when the file it has does not hold its icon', () => {
    const bytes = svgOf('x')
    const without = fileOf([[npmKey('other'), svgOf('other')]])
    const plan = planIconWork([x], stateOf([keyOf(x), publishedRow(bytes)]), without, new Map(), PLENTY)
    expect(plan.reuse).toEqual([])
    expect(plan.fetch.map(({ key, expectSha256 }) => [key, expectSha256])).toEqual([[keyOf(x), sha256Hex(bytes)]])
  })

  it('asks nothing for an entry with no icon, a refused one, or none it can fetch', () => {
    const none = npmSubject('none', null)
    const refused = npmSubject('refused', refusedRead(iconDetail.notString()))
    const noTarget = only(iconSubjects([npmEntry('no-target')], [npmCandidate('no-target', declared(), { distTarball: undefined })], []))
    expect(noTarget.key).toBeDefined()
    expect(planIconWork([none, refused, noTarget], new Map(), null, new Map(), PLENTY)).toEqual({ reuse: [], fetch: [], deferred: [] })
    // Not even to reuse an icon the record and yesterday's file hold for the key it has: with nothing to fetch it from, it is no icon this build.
    const bytes = svgOf('no-target')
    const held = planIconWork([noTarget], stateOf([keyOf(noTarget), publishedRow(bytes)]), fileOf([[keyOf(noTarget), bytes]]), new Map(), PLENTY)
    expect(held).toEqual({ reuse: [], fetch: [], deferred: [] })
  })

  it('asks nothing for a subject withheld by hand, whatever the record and the file hold', () => {
    const bytes = svgOf('x')
    const withheld = withheldOf(['x', 'a reason'])
    expect(planIconWork([x], new Map(), null, withheld, PLENTY)).toEqual({ reuse: [], fetch: [], deferred: [] })
    expect(planIconWork([x], stateOf([keyOf(x), publishedRow(bytes)]), fileOf([[keyOf(x), bytes]]), withheld, PLENTY))
      .toEqual({ reuse: [], fetch: [], deferred: [] })
  })

  it('withholds by the repository, however its name is cased, and by the exact npm name', () => {
    const repo = only(iconSubjects([gitEntry('Owner/Repo')], [], [repoCandidate('Owner/Repo', { icon: declared() })]))
    const legacy = npmSubject('Legacy-Name')
    expect(planIconWork([repo], new Map(), null, withheldOf(['owner/repo', 'r']), PLENTY).fetch).toEqual([])
    expect(planIconWork([repo], new Map(), null, withheldOf(['Owner/Repo', 'r']), PLENTY).fetch).toHaveLength(1)
    expect(planIconWork([legacy], new Map(), null, withheldOf(['Legacy-Name', 'r']), PLENTY).fetch).toEqual([])
    expect(planIconWork([legacy], new Map(), null, withheldOf(['legacy-name', 'r']), PLENTY).fetch).toHaveLength(1)
  })
})

describe('planIconWork: the budget', () => {
  it('cuts the fetches at the budget in code-unit order of their keys and defers the rest', () => {
    const subjects = ['c', 'a', 'b'].map((name) => npmSubject(name))
    const plan = planIconWork(subjects, new Map(), null, new Map(), 2)
    expect(plan.fetch.map(({ key }) => key)).toEqual([npmKey('a'), npmKey('b')])
    expect(plan.deferred).toEqual([npmKey('c')])
  })

  it('orders by code unit, never by locale: an upper-case key goes before a lower-case one', () => {
    // A locale-aware order would put `a` first, and the budget would serve it.
    const subjects = ['a', 'B'].map((name) => npmSubject(name))
    const plan = planIconWork(subjects, new Map(), null, new Map(), 1)
    expect(plan.fetch.map(({ key }) => key)).toEqual([npmKey('B')])
    expect(plan.deferred).toEqual([npmKey('a')])
  })

  it('orders by the key, not by the identity the key hangs from', () => {
    // `npm:a` sorts before `npm:a-b`, but their keys are `npm:a@1.0.0:icon.svg`
    // and `npm:a-b@1.0.0:icon.svg`, and `-` is below `@`: the two orders differ,
    // and the budget serves the key that comes first.
    const subjects = ['a', 'a-b'].map((name) => npmSubject(name))
    expect(subjects.map(({ identity }) => identity)).toEqual(['npm:a', 'npm:a-b'].sort(compareStrings))
    expect(npmKey('a-b') < npmKey('a')).toBe(true)
    const plan = planIconWork(subjects, new Map(), null, new Map(), 1)
    expect(plan.fetch.map(({ key }) => key)).toEqual([npmKey('a-b')])
    expect(plan.deferred).toEqual([npmKey('a')])
  })

  it('fetches everything when the budget allows it, and defers everything when it allows none', () => {
    const subjects = ['a', 'b', 'c'].map((name) => npmSubject(name))
    const keys = ['a', 'b', 'c'].map((name) => npmKey(name))
    for (const budget of [3, 4, Number.POSITIVE_INFINITY]) {
      const plan = planIconWork(subjects, new Map(), null, new Map(), budget)
      expect(plan.fetch.map(({ key }) => key)).toEqual(keys)
      expect(plan.deferred).toEqual([])
    }
    // A budget below zero is no fetches, and does not count back from the end.
    for (const budget of [0, -1]) {
      const plan = planIconWork(subjects, new Map(), null, new Map(), budget)
      expect(plan.fetch).toEqual([])
      expect(plan.deferred).toEqual(keys)
    }
  })

  it('spends the budget on the keys that need a fetch, and not on the ones it reuses', () => {
    const subjects = ['a', 'b', 'c'].map((name) => npmSubject(name))
    const bytes = svgOf('a')
    const plan = planIconWork(subjects, stateOf([npmKey('a'), publishedRow(bytes)]), fileOf([[npmKey('a'), bytes]]), new Map(), 1)
    expect(plan.reuse.map(({ key }) => key)).toEqual([npmKey('a')])
    expect(plan.fetch.map(({ key }) => key)).toEqual([npmKey('b')])
    expect(plan.deferred).toEqual([npmKey('c')])
  })

  it('lists what it reuses by key', () => {
    // `a-b` is listed before `a`: its key is the smaller, though its identity is the larger.
    const subjects = ['c', 'a', 'a-b', 'b'].map((name) => npmSubject(name))
    const held = subjects.map((subject) => [keyOf(subject), svgOf(subject.name)] as const)
    const plan = planIconWork(subjects, new Map(held.map(([key, bytes]) => [key, publishedRow(bytes)])), fileOf(held), new Map(), PLENTY)
    expect(plan.reuse.map(({ key }) => key)).toEqual(['a-b', 'a', 'b', 'c'].map((name) => npmKey(name)))
  })
})

describe('planIconWork: a key two entries share', () => {
  // Two repositories that attach the same release asset share a key: one
  // sha256 of the asset, one path inside it. The declarations differ only in
  // the source they name, which is the word an author's report line uses.
  const tarballs = { url: RELEASE_URL, sha256: TARBALL_SHA }
  const subjectsOf = (order: readonly string[]): IconSubject[] => iconSubjects(
    order.map((repo) => rescuedEntry(repo, tarballs)),
    [],
    order.map((repo) => repoCandidate(repo, { rescued: true, icon: declared('icon.svg', 'image/svg+xml', repo === 'a/x' ? 'icon' : 'export') })),
  )

  it('is planned once, with the declaration of the entry whose identity sorts first, whichever order they come in', () => {
    for (const order of permutations(['a/x', 'b/x', 'c/x'])) {
      const plan = planIconWork(subjectsOf(order), new Map(), null, new Map(), PLENTY)
      expect(plan.fetch.map(({ key, declaration: { source } }) => [key, source])).toEqual([[releaseIconKey(TARBALL_SHA, 'icon.svg'), 'icon']])
    }
  })

  it('is still planned while any entry that holds it is not withheld', () => {
    const subjects = subjectsOf(['a/x', 'b/x'])
    expect(planIconWork(subjects, new Map(), null, withheldOf(['a/x', 'r']), PLENTY).fetch).toHaveLength(1)
    expect(planIconWork(subjects, new Map(), null, withheldOf(['b/x', 'r']), PLENTY).fetch).toHaveLength(1)
    expect(planIconWork(subjects, new Map(), null, withheldOf(['a/x', 'r'], ['b/x', 'r']), PLENTY).fetch).toEqual([])
  })
})

describe('planIconWork: what it leaves alone', () => {
  it('plans the same whatever order the subjects come in, and leaves what it is given as it was', () => {
    const subjects = ['d', 'a', 'c', 'b'].map((name) => npmSubject(name))
    const reused = svgOf('a')
    const state = stateOf([npmKey('a'), publishedRow(reused)], [npmKey('b'), publishedRow(svgOf('b'))])
    const published = fileOf([[npmKey('a'), reused]])
    const withheld = withheldOf(['d', 'r'])
    const before = JSON.stringify([subjects, [...state], published, [...withheld]])
    const expected = planIconWork(subjects, state, published, withheld, 1)
    expect(expected.reuse.map(({ key }) => key)).toEqual([npmKey('a')])
    expect(expected.fetch.map(({ key }) => key)).toEqual([npmKey('b')])
    expect(expected.deferred).toEqual([npmKey('c')])
    for (const order of permutations(subjects)) expect(planIconWork(order, state, published, withheld, 1)).toEqual(expected)
    expect(JSON.stringify([subjects, [...state], published, [...withheld]])).toBe(before)
  })
})

describe('foldIconResults: what a fetch brings back', () => {
  const x = npmSubject('x')

  it('publishes bytes that pass the check: a record, an identity entry and an icon in the file', () => {
    const bytes = svgOf('x')
    const sha256 = sha256Hex(bytes)
    const { fold } = runDay([x], { results: resultsOf([keyOf(x), bytesResult(bytes)]) })
    expect(fold.nextState).toEqual(stateOf([keyOf(x), publishedRow(bytes)]))
    expect(fold.byIdentity).toEqual(new Map([['npm:x', sha256]]))
    expect(fold.file).toEqual({ icons: { [sha256]: iconDataUrl(bytes, 'image/svg+xml') }, sources: { [keyOf(x)]: sha256 } })
    expect(fold.rows).toEqual([])
    expect(fold.counts).toEqual({ ...ZERO, declared: 1, published: 1 })
  })

  it('records and carries the media type the declaration named', () => {
    const png = npmSubject('png', declared('icon.png', 'image/png'))
    const { fold } = runDay([png], { results: resultsOf([keyOf(png), bytesResult(PNG)]) })
    expect(fold.nextState).toEqual(stateOf([keyOf(png), { outcome: 'published', sha256: sha256Hex(PNG), mediaType: 'image/png', bytes: PNG.length }]))
    expect(fold.file?.icons[sha256Hex(PNG)]).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
  })

  it('refuses oversize bytes with the check\'s sentence and records the refusal', () => {
    const bytes = new Uint8Array(MAX_CATALOG_ICON_BYTES + 1)
    const detail = iconDetail.tooLarge(iconLabel('icon'), shownPath('icon.svg'), MAX_CATALOG_ICON_BYTES + 1)
    const { fold } = runDay([x], { results: resultsOf([keyOf(x), bytesResult(bytes)]) })
    expect(fold.nextState).toEqual(stateOf([keyOf(x), { outcome: 'refused', detail }]))
    expect(fold.rows).toEqual([{ name: 'x', identity: 'npm:x', kind: 'refused', detail }])
    expect(fold.byIdentity.size).toBe(0)
    expect(fold.file).toBeNull()
    expect(fold.counts).toEqual({ ...ZERO, declared: 1, refused: 1 })
  })

  it('refuses bytes that are not what the extension says, with the check\'s sentence', () => {
    const detail = iconDetail.wrongBytes(iconLabel('icon'), shownPath('icon.svg'), 'SVG')
    const { fold } = runDay([x], { results: resultsOf([keyOf(x), bytesResult(NOT_AN_IMAGE)]) })
    expect(fold.nextState).toEqual(stateOf([keyOf(x), { outcome: 'refused', detail }]))
    expect(fold.rows).toEqual([{ name: 'x', identity: 'npm:x', kind: 'refused', detail }])
  })

  it('names the declaration in the check\'s sentence by the one the work carried, so an export reads as an export', () => {
    const exported = npmSubject('x', declared('assets/logo.svg', 'image/svg+xml', 'export'))
    const detail = iconDetail.wrongBytes(iconLabel('export'), shownPath('assets/logo.svg'), 'SVG')
    const { fold } = runDay([exported], { results: resultsOf([keyOf(exported), bytesResult(NOT_AN_IMAGE)]) })
    expect(fold.rows).toEqual([{ name: 'x', identity: 'npm:x', kind: 'refused', detail }])
  })

  it('records a refusal the fetch reports as it is, and a package it could not read as it is', () => {
    const refusedDetail = iconDetail.notInPackage(iconLabel('icon'), shownPath('icon.svg'), 'x', '1.0.0')
    const notReadDetail = iconDetail.packageTooLarge('y', '1.0.0')
    const y = npmSubject('y')
    const { fold } = runDay([x, y], {
      results: resultsOf([keyOf(x), { kind: 'refused', detail: refusedDetail }], [keyOf(y), { kind: 'not-read', detail: notReadDetail }]),
    })
    expect(fold.nextState).toEqual(stateOf(
      [keyOf(x), { outcome: 'refused', detail: refusedDetail }],
      [keyOf(y), { outcome: 'not-read', detail: notReadDetail }],
    ))
    expect(fold.rows).toEqual([
      { name: 'x', identity: 'npm:x', kind: 'refused', detail: refusedDetail },
      { name: 'y', identity: 'npm:y', kind: 'not-read', detail: notReadDetail },
    ])
    expect(fold.counts).toEqual({ ...ZERO, declared: 2, refused: 1, notRead: 1 })
    expect(fold.file).toBeNull()
  })

  it('turns a recorded icon into the refusal a new fetch of it comes to', () => {
    // The key was read and passed once; the bytes it holds now do not pass.
    const bytes = svgOf('x')
    const { fold } = runDay([x], { state: stateOf([keyOf(x), publishedRow(bytes)]), results: resultsOf([keyOf(x), bytesResult(NOT_AN_IMAGE)]) })
    expect(fold.nextState.get(keyOf(x))).toEqual({ outcome: 'refused', detail: iconDetail.wrongBytes(iconLabel('icon'), shownPath('icon.svg'), 'SVG') })
    expect(fold.counts).toEqual({ ...ZERO, declared: 1, refused: 1 })
  })

  it('reports a recorded refusal or a recorded package it could not read, without a fetch', () => {
    const y = npmSubject('y')
    const refused: IconOutcome = { outcome: 'refused', detail: iconDetail.notInPackage(iconLabel('icon'), shownPath('icon.svg'), 'x', '1.0.0') }
    const notRead: IconOutcome = { outcome: 'not-read', detail: iconDetail.packageUnpacksTooLarge('y', '1.0.0') }
    const state = stateOf([keyOf(x), refused], [keyOf(y), notRead])
    const { plan, fold } = runDay([x, y], { state })
    expect(plan.fetch).toEqual([])
    expect(fold.nextState).toEqual(state)
    expect(fold.rows).toEqual([
      { name: 'x', identity: 'npm:x', kind: 'refused', detail: refused.detail },
      { name: 'y', identity: 'npm:y', kind: 'not-read', detail: notRead.detail },
    ])
    expect(fold.counts).toEqual({ ...ZERO, declared: 2, refused: 1, notRead: 1 })
  })
})

describe('foldIconResults: what did not answer', () => {
  const x = npmSubject('x')

  it('changes nothing for a fetch that did not answer, and counts the key as not yet read', () => {
    const { fold } = runDay([x], { results: resultsOf([keyOf(x), { kind: 'not-yet-read', reason: 'the registry answered 503' }]) })
    expect(fold.nextState.size).toBe(0)
    expect(fold.rows).toEqual([])
    expect(fold.file).toBeNull()
    expect(fold.byIdentity.size).toBe(0)
    expect(fold.counts).toEqual({ ...ZERO, declared: 1, notYetRead: 1 })
  })

  it('counts a key the fetch never answered, and one the budget deferred, as not yet read too', () => {
    const y = npmSubject('y')
    const unanswered = runDay([x], {})
    expect(unanswered.plan.fetch).toHaveLength(1)
    expect(unanswered.fold.nextState.size).toBe(0)
    expect(unanswered.fold.counts).toEqual({ ...ZERO, declared: 1, notYetRead: 1 })
    const deferred = runDay([x, y], { fetchBudget: 0, results: resultsOf([keyOf(x), bytesResult(svgOf('x'))]) })
    // The answer for a deferred key is not one the plan asked for.
    expect(deferred.plan.deferred).toEqual([keyOf(x), keyOf(y)])
    expect(deferred.fold.nextState.size).toBe(0)
    expect(deferred.fold.file).toBeNull()
    expect(deferred.fold.counts).toEqual({ ...ZERO, declared: 2, notYetRead: 2 })
  })

  // A key recorded published whose bytes are in no file today is a declared
  // icon the build cannot carry: it is not published, so it counts as not yet
  // read and has neither a row nor an identity entry, and its record stays for
  // the next build to fetch it against.
  it.each<[what: string, results: Map<IconKey, IconFetchResult>, fetchBudget: number]>([
    ['the fetch did not answer', new Map(), PLENTY],
    ['the fetch could not reach the registry', resultsOf([npmKey('x'), { kind: 'not-yet-read', reason: 'a timeout' }]), PLENTY],
    ['the budget deferred the fetch', new Map(), 0],
  ])('keeps the record, and counts the icon as not yet read, when yesterday\'s file lacks it and %s', (_what, results, fetchBudget) => {
    const state = stateOf([keyOf(x), publishedRow(svgOf('x'))])
    const { fold } = runDay([x], { state, published: null, results, fetchBudget })
    expect(fold.nextState).toEqual(state)
    expect(fold.file).toBeNull()
    expect(fold.byIdentity.size).toBe(0)
    expect(fold.rows).toEqual([])
    expect(fold.counts).toEqual({ ...ZERO, declared: 1, notYetRead: 1 })
  })

  it('keeps an icon whose bytes are in the file even with nothing to fetch it from', () => {
    // The key names one immutable artifact and the file carries its bytes;
    // whether a FETCH is possible today says nothing about whether the icon is
    // available. Consulted after `isFetchable`, this key lost its icon.
    const noTarget = only(iconSubjects([npmEntry('x')], [npmCandidate('x', declared(), { distTarball: undefined })], []))
    const bytes = svgOf('x')
    const state = stateOf([keyOf(noTarget), publishedRow(bytes)])
    const { plan, fold } = runDay([noTarget], { state, published: fileOf([[keyOf(noTarget), bytes]]) })
    expect(plan).toEqual({ reuse: [], fetch: [], deferred: [] })
    expect(fold.nextState).toEqual(state)
    expect(fold.file).toEqual(fileOf([[keyOf(noTarget), bytes]]))
    expect(fold.byIdentity).toEqual(new Map([['npm:x', sha256Hex(bytes)]]))
    expect(fold.rows).toEqual([])
    expect(fold.counts).toEqual({ ...ZERO, declared: 1, published: 1 })
  })

  it('ignores an answer for a key the plan did not ask for', () => {
    const bytes = svgOf('x')
    const stray = npmKey('stray')
    const plan: IconPlan = { reuse: [], fetch: [], deferred: [] }
    const fold = foldIconResults([x], plan, resultsOf([keyOf(x), bytesResult(bytes)], [stray, bytesResult(bytes)]), new Map(), null, new Map())
    expectSound(fold, [x])
    expect(fold.nextState.size).toBe(0)
    expect(fold.file).toBeNull()
    expect(fold.counts).toEqual({ ...ZERO, declared: 1, notYetRead: 1 })
  })
})

describe('foldIconResults: reusing what an earlier build published', () => {
  const x = npmSubject('x')
  const bytes = svgOf('x')

  it('carries a recorded icon forward from yesterday\'s file with no fetch at all', () => {
    const state = stateOf([keyOf(x), publishedRow(bytes)])
    const published = fileOf([[keyOf(x), bytes]])
    const { plan, fold } = runDay([x], { state, published })
    expect(plan).toEqual({ reuse: [{ key: keyOf(x), sha256: sha256Hex(bytes) }], fetch: [], deferred: [] })
    expect(fold.file).toEqual(published)
    expect(fold.nextState).toEqual(state)
    expect(fold.byIdentity).toEqual(new Map([['npm:x', sha256Hex(bytes)]]))
    expect(fold.rows).toEqual([])
    expect(fold.counts).toEqual({ ...ZERO, declared: 1, published: 1 })
  })

  it('keeps an icon whose bytes are in the file when the artifact has no fetch target', () => {
    // The key names one immutable artifact and the file carries its bytes;
    // whether a FETCH is possible today says nothing about whether the icon is
    // available. Consulted before `isFetchable`, this key lost its icon.
    const subject = only(iconSubjects([npmEntry('x')], [npmCandidate('x', declared(), { distTarball: undefined })], []))
    const state = stateOf([keyOf(subject), publishedRow(bytes)])
    const published = fileOf([[keyOf(subject), bytes]])
    const { plan, fold } = runDay([subject], { state, published })
    expect(plan).toEqual({ reuse: [], fetch: [], deferred: [] })
    expect(fold.byIdentity).toEqual(new Map([['npm:x', sha256Hex(bytes)]]))
    expect(fold.counts).toEqual({ ...ZERO, declared: 1, published: 1 })
  })

  it('drops from the file an icon no listed entry names any more', () => {
    const gone = npmKey('gone')
    const goneBytes = svgOf('gone')
    const state = stateOf([keyOf(x), publishedRow(bytes)], [gone, publishedRow(goneBytes)])
    const { fold } = runDay([x], { state, published: fileOf([[keyOf(x), bytes], [gone, goneBytes]]) })
    expect(fold.file).toEqual(fileOf([[keyOf(x), bytes]]))
    expect(fold.nextState).toEqual(stateOf([keyOf(x), publishedRow(bytes)]))
  })

  it('re-reads a recorded key, and records the sha256 it has now, when its bytes come back different', () => {
    const before = svgOf('before')
    const after = svgOf('after')
    // Yesterday's file lacks the icon, so the key is fetched again, and the
    // bytes it holds now are not the ones the record names.
    const { plan, fold } = runDay([x], { state: stateOf([keyOf(x), publishedRow(before)]), results: resultsOf([keyOf(x), bytesResult(after)]) })
    expect(plan.fetch.map(({ expectSha256 }) => expectSha256)).toEqual([sha256Hex(before)])
    expect(fold.nextState).toEqual(stateOf([keyOf(x), publishedRow(after)]))
    expect(fold.byIdentity).toEqual(new Map([['npm:x', sha256Hex(after)]]))
    expect(fold.file).toEqual(fileOf([[keyOf(x), after]]))
    expect(Object.keys(fold.file?.icons ?? {})).toEqual([sha256Hex(after)])
  })

  it('records the same sha256 again, and carries the same file, when a refetched key holds what it held', () => {
    const state = stateOf([keyOf(x), publishedRow(bytes)])
    const { fold } = runDay([x], { state, results: resultsOf([keyOf(x), bytesResult(bytes)]) })
    expect(fold.nextState).toEqual(state)
    expect(fold.file).toEqual(fileOf([[keyOf(x), bytes]]))
  })
})

describe('foldIconResults: bytes another key brought in', () => {
  // A sha256 names its bytes whichever key they were read under, and a key names
  // one immutable artifact, so the bytes a recorded key's row names are its own
  // icon wherever they came from: yesterday's file, or another key's fetch this
  // build. A key past the budget, or whose own fetch did not answer, therefore
  // publishes when those bytes are in hand (design §5.3). Only those bytes: the
  // sha256 the record names is what counts.
  const x = npmSubject('x')
  const y = npmSubject('y')
  const bytes = svgOf('shared')
  const sha256 = sha256Hex(bytes)

  it('publishes a deferred key whose recorded bytes another key\'s fetch has just brought in', () => {
    // y is recorded published and yesterday's file is lost, so y is asked for again,
    // and the budget lets only x through. x's bytes hash to the sha256 y's row names.
    const { plan, fold } = runDay([x, y], {
      state: stateOf([keyOf(y), publishedRow(bytes)]),
      published: null,
      fetchBudget: 1,
      results: resultsOf([keyOf(x), bytesResult(bytes)]),
    })
    expect(plan.fetch.map(({ key }) => key)).toEqual([keyOf(x)])
    expect(plan.deferred).toEqual([keyOf(y)])
    expect(fold.byIdentity).toEqual(new Map([['npm:x', sha256], ['npm:y', sha256]]))
    expect(fold.file).toEqual({
      icons: { [sha256]: iconDataUrl(bytes, 'image/svg+xml') },
      sources: { [keyOf(x)]: sha256, [keyOf(y)]: sha256 },
    })
    expect(fold.counts).toEqual({ ...ZERO, declared: 2, published: 2 })
    // y itself was not read, so its record is what it was.
    expect(fold.nextState.get(keyOf(y))).toEqual(publishedRow(bytes))
  })

  it('publishes a key whose own fetch did not answer, the same way', () => {
    const { fold } = runDay([x, y], {
      state: stateOf([keyOf(y), publishedRow(bytes)]),
      published: null,
      results: resultsOf([keyOf(x), bytesResult(bytes)], [keyOf(y), { kind: 'not-yet-read', reason: 'a timeout' }]),
    })
    expect(fold.byIdentity).toEqual(new Map([['npm:x', sha256], ['npm:y', sha256]]))
    expect(fold.counts).toEqual({ ...ZERO, declared: 2, published: 2 })
  })

  it('does not publish a deferred key for bytes that are not the ones its record names', () => {
    const { plan, fold } = runDay([x, y], {
      state: stateOf([keyOf(y), publishedRow(svgOf('what y held'))]),
      published: null,
      fetchBudget: 1,
      results: resultsOf([keyOf(x), bytesResult(bytes)]),
    })
    expect(plan.deferred).toEqual([keyOf(y)])
    expect(fold.byIdentity).toEqual(new Map([['npm:x', sha256]]))
    expect(fold.counts).toEqual({ ...ZERO, declared: 2, published: 1, notYetRead: 1 })
    expect(fold.nextState.get(keyOf(y))).toEqual(publishedRow(svgOf('what y held')))
  })
})

describe('foldIconResults: one record for each key and one data URL for each sha256', () => {
  // `assembleIcons` throws on a sha256 with two data URLs and on a key with two
  // sha256s, because the file could state only one. Those throws are tripwires
  // for a bug here, and a throw there would stop the whole day's build over an
  // icon (design decision 6): nothing a day can bring may reach them.
  const x = npmSubject('x')
  const reusedBytes = svgOf('shared')

  it('carries a reused key and a freshly fetched key whose bytes share one sha256 as one icon', () => {
    const reused = npmSubject('reused')
    const fresh = npmSubject('fresh')
    const { fold } = runDay([reused, fresh], {
      state: stateOf([keyOf(reused), publishedRow(reusedBytes)]),
      published: fileOf([[keyOf(reused), reusedBytes]]),
      results: resultsOf([keyOf(fresh), bytesResult(reusedBytes)]),
    })
    const sha256 = sha256Hex(reusedBytes)
    expect(Object.keys(fold.file?.icons ?? {})).toEqual([sha256])
    expect(fold.file?.sources).toEqual({ [keyOf(reused)]: sha256, [keyOf(fresh)]: sha256 })
    expect(fold.byIdentity).toEqual(new Map([['npm:reused', sha256], ['npm:fresh', sha256]]))
    expect(fold.counts).toEqual({ ...ZERO, declared: 2, published: 2 })
  })

  it('lets the data URL of the bytes just fetched win over the one the published file holds for that sha256', () => {
    // A published file that labels the same bytes with another media type. No
    // build writes one, and a file whose digest checks out can still hold it.
    const reused = npmSubject('reused')
    const fresh = npmSubject('fresh')
    const mislabelled = fileOf([[keyOf(reused), reusedBytes]], 'image/png')
    const sha256 = sha256Hex(reusedBytes)
    expect(mislabelled.icons[sha256]).not.toBe(iconDataUrl(reusedBytes, 'image/svg+xml'))
    const { fold } = runDay([reused, fresh], {
      state: stateOf([keyOf(reused), publishedRow(reusedBytes)]),
      published: mislabelled,
      results: resultsOf([keyOf(fresh), bytesResult(reusedBytes)]),
    })
    expect(fold.file?.icons).toEqual({ [sha256]: iconDataUrl(reusedBytes, 'image/svg+xml') })
    expect(Object.keys(fold.file?.sources ?? {}).sort(compareStrings)).toEqual([keyOf(fresh), keyOf(reused)].sort(compareStrings))
  })

  it('labels shared raster bytes with the type the bytes are, not the first declaration', () => {
    // A raster is accepted under any raster extension, and the file is keyed by
    // the bytes alone: two entries shipping the same PNG as `.png` and `.jpg`
    // must write ONE data URL, and it must say PNG — the type of the bytes.
    const png = npmSubject('png', declared('icon.png', 'image/png'))
    const jpeg = npmSubject('jpeg', declared('icon.jpg', 'image/jpeg'))
    const { fold } = runDay([png, jpeg], { results: resultsOf([keyOf(png), bytesResult(PNG)], [keyOf(jpeg), bytesResult(PNG)]) })
    const sha256 = sha256Hex(PNG)
    expect(fold.file?.icons).toEqual({ [sha256]: iconDataUrl(PNG, 'image/png') })
    expect(fold.nextState.get(keyOf(jpeg))).toMatchObject({ mediaType: 'image/png' })
    expect(fold.counts).toEqual({ ...ZERO, declared: 2, published: 2 })
  })

  it('hands a key that is both reused and freshly fetched over once, as the fetch left it', () => {
    // A plan no `planIconWork` makes: the key is in the reuse list and in the
    // fetch list, with two different sha256s.
    const before = svgOf('before')
    const after = svgOf('after')
    const plan: IconPlan = {
      reuse: [{ key: keyOf(x), sha256: sha256Hex(before) }],
      fetch: [{ key: keyOf(x), target: targetOf(x), declaration: declaration() }],
      deferred: [],
    }
    const fold = foldIconResults([x], plan, resultsOf([keyOf(x), bytesResult(after)]), stateOf([keyOf(x), publishedRow(before)]), fileOf([[keyOf(x), before]]), new Map())
    expectSound(fold, [x])
    expect(fold.file).toEqual(fileOf([[keyOf(x), after]]))
    expect(fold.nextState).toEqual(stateOf([keyOf(x), publishedRow(after)]))
  })
})

describe('foldIconResults: an icon the file budget turned away', () => {
  it('records it as withheld for size, not published, and the next build asks for it again', () => {
    const x = npmSubject('x')
    const y = npmSubject('y')
    const bytesX = svgOf('x')
    const bytesY = svgOf('y')
    const one = sizeOf(fileOf([[keyOf(x), bytesX]]))
    expect(sizeOf(fileOf([[keyOf(x), bytesX], [keyOf(y), bytesY]]))).toBeGreaterThan(one)
    const { fold } = runDay([x, y], {
      results: resultsOf([keyOf(x), bytesResult(bytesX)], [keyOf(y), bytesResult(bytesY)]),
      fileBudget: one,
    })
    expect(fold.counts).toEqual({ ...ZERO, declared: 2, published: 1, withheldForSize: 1 })
    const withheld = [...fold.nextState].filter(([, row]) => row.outcome === 'withheld-for-size')
    expect(withheld).toHaveLength(1)
    const [key, row] = withheld[0] ?? []
    // The record no longer says the file carries bytes it turned away.
    expect(Object.hasOwn(fold.file?.sources ?? {}, String(key))).toBe(false)
    expect(row).toMatchObject({ outcome: 'withheld-for-size' })
    // Its bytes were never kept, so the next build fetches it again, pinned to
    // the sha it had — it may fit this time.
    const next = planIconWork([x, y], fold.nextState, fold.file, new Map(), PLENTY)
    expect(next.fetch.find(work => work.key === key)).toMatchObject({ expectSha256: (row as { sha256: string }).sha256 })
  })
})

describe('foldIconResults: withholding by hand', () => {
  const x = npmSubject('x')

  it('names a withheld subject once, with the reason, and gives it no icon and no identity entry', () => {
    const reason = 'the logo is not the author\'s to give'
    const { plan, fold } = runDay([x], { withheld: withheldOf(['x', reason]), results: resultsOf([keyOf(x), bytesResult(svgOf('x'))]) })
    expect(plan.fetch).toEqual([])
    expect(fold.rows).toEqual([{ name: 'x', identity: 'npm:x', kind: 'withheld', detail: iconDetail.withheldByHand(reason) }])
    expect(fold.byIdentity.size).toBe(0)
    expect(fold.file).toBeNull()
    expect(fold.nextState.size).toBe(0)
    expect(fold.counts).toEqual({ ...ZERO, declared: 1, withheldByHand: 1 })
  })

  it('takes a withheld subject\'s icon out of the file it was in, and keeps its record for the day it is let back', () => {
    const bytes = svgOf('x')
    const state = stateOf([keyOf(x), publishedRow(bytes)])
    const { fold } = runDay([x], { state, published: fileOf([[keyOf(x), bytes]]), withheld: withheldOf(['x', 'r']) })
    expect(fold.file).toBeNull()
    expect(fold.nextState).toEqual(state)
    expect(fold.counts).toEqual({ ...ZERO, declared: 1, withheldByHand: 1 })
  })

  it('withholds the repository\'s every entry, a subpackage\'s included', () => {
    const subjects = iconSubjects(
      [gitEntry('Owner/Repo'), gitEntry('Owner/Repo', { subdir: 'sub' }), gitEntry('Owner/Other')],
      [],
      [
        repoCandidate('Owner/Repo', { icon: declared('a.svg') }),
        repoCandidate('Owner/Repo', { subdir: 'sub', icon: declared('b.svg') }),
        repoCandidate('Owner/Other', { icon: declared('c.svg') }),
      ],
    )
    const { fold } = runDay(subjects, { withheld: withheldOf(['owner/repo', 'r']) })
    expect(fold.rows.map(({ name, kind }) => [name, kind])).toEqual([['Owner/Repo', 'withheld'], ['Owner/Repo#sub', 'withheld']])
    expect(fold.counts).toEqual({ ...ZERO, declared: 3, withheldByHand: 2, notYetRead: 1 })
  })

  it('leaves an entry that declares no icon out of the report, withheld or not', () => {
    const none = npmSubject('none', null)
    const { fold } = runDay([none], { withheld: withheldOf(['none', 'r']) })
    expect(fold.rows).toEqual([])
    expect(fold.counts).toEqual(ZERO)
  })

  it('reports a withheld entry whose own read is refused as withheld, which stays true however its author fixes it', () => {
    const refused = npmSubject('refused', refusedRead(iconDetail.notString()))
    const { fold } = runDay([refused], { withheld: withheldOf(['refused', 'r']) })
    expect(fold.rows).toEqual([{ name: 'refused', identity: 'npm:refused', kind: 'withheld', detail: iconDetail.withheldByHand('r') }])
    expect(fold.counts).toEqual({ ...ZERO, declared: 1, withheldByHand: 1 })
  })
})

describe('foldIconResults: the entry\'s own refused read', () => {
  it('is a row and a count, and leaves no record, because there is no key', () => {
    const detail = iconDetail.leavesPackage(shownPath('../icon.svg'))
    const refused = npmSubject('x', refusedRead(detail))
    const { fold } = runDay([refused])
    expect(fold.rows).toEqual([{ name: 'x', identity: 'npm:x', kind: 'refused', detail }])
    expect(fold.nextState.size).toBe(0)
    expect(fold.byIdentity.size).toBe(0)
    expect(fold.file).toBeNull()
    expect(fold.counts).toEqual({ ...ZERO, declared: 1, refused: 1 })
  })

  it('counts an entry that declares no icon in nothing at all', () => {
    const { fold } = runDay([npmSubject('x', null)])
    expect(fold.rows).toEqual([])
    expect(fold.counts).toEqual(ZERO)
    expect(fold.file).toBeNull()
  })
})

describe('foldIconResults: the record that goes forward', () => {
  it('holds only the keys a declared entry names, and drops a row no listing names any more', () => {
    const live = npmSubject('live')
    const gone = npmKey('gone')
    const stale: IconOutcome = { outcome: 'refused', detail: iconDetail.notString() }
    const state = stateOf([keyOf(live), { outcome: 'not-read', detail: iconDetail.releaseUnreadable() }], [gone, stale])
    const { fold } = runDay([live], { state })
    expect(fold.nextState).toEqual(stateOf([keyOf(live), { outcome: 'not-read', detail: iconDetail.releaseUnreadable() }]))
  })

  it('keeps the rows of keys it did not read this build: withheld, deferred and unreachable ones among them', () => {
    const withheld = npmSubject('held')
    const deferred = npmSubject('later')
    const noTarget = only(iconSubjects([npmEntry('far')], [npmCandidate('far', declared(), { integrity: null })], []))
    const bytes = svgOf('any')
    const state = stateOf(
      [keyOf(withheld), publishedRow(bytes)],
      [keyOf(deferred), publishedRow(bytes)],
      [keyOf(noTarget), publishedRow(bytes)],
    )
    const { plan, fold } = runDay([withheld, deferred, noTarget], { state, withheld: withheldOf(['held', 'r']), fetchBudget: 0 })
    expect(plan.deferred).toEqual([keyOf(deferred)])
    expect(fold.nextState).toEqual(state)
  })

  it('writes a record the next build can read back', () => {
    const subjects = ['a', 'b', 'c'].map((name) => npmSubject(name))
    const { fold } = runDay(subjects, {
      results: resultsOf(
        [npmKey('a'), bytesResult(svgOf('a'))],
        [npmKey('b'), bytesResult(NOT_AN_IMAGE)],
        [npmKey('c'), { kind: 'not-read', detail: iconDetail.releaseUnreadable() }],
      ),
    })
    expect(fold.nextState.size).toBe(3)
    expect(parseIconState(serializeIconState(fold.nextState))).toEqual(fold.nextState)
  })
})

describe('foldIconResults: the report', () => {
  it('lists its rows by name, then identity, then detail, whatever order the subjects come in', () => {
    // Three rows share a name and two of them an identity. The entries of a real
    // catalog never share an identity; these are hand-made, so that the
    // comparator's last key has something to decide.
    const notRelative = iconDetail.notRelative(shownPath('/abs.svg'))
    const notString = iconDetail.notString()
    // Fixture arithmetic: by code unit the first of the two sentences is the smaller.
    expect(notRelative < notString).toBe(true)
    const subjects = [
      npmSubject('b', refusedRead(notString)),
      npmSubject('a', refusedRead(notString)),
      npmSubject('a', refusedRead(notRelative)),
      { ...npmSubject('a', refusedRead(notString)), identity: 'npm:a-other' },
    ]
    const expected: IconReportRow[] = [
      { name: 'a', identity: 'npm:a', kind: 'refused', detail: notRelative },
      { name: 'a', identity: 'npm:a', kind: 'refused', detail: notString },
      { name: 'a', identity: 'npm:a-other', kind: 'refused', detail: notString },
      { name: 'b', identity: 'npm:b', kind: 'refused', detail: notString },
    ]
    for (const order of permutations(subjects)) {
      const { rows } = foldIconResults(order, { reuse: [], fetch: [], deferred: [] }, new Map(), new Map(), null, new Map())
      expect(rows).toEqual(expected)
    }
  })

  it('orders rows by code unit, never by locale', () => {
    // A locale-aware order would put `a` before `B`.
    const rows = runDay([npmSubject('a', refusedRead('x')), npmSubject('B', refusedRead('x'))]).fold.rows
    expect(rows.map(({ name }) => name)).toEqual(['B', 'a'])
  })
})

describe('foldIconResults: the file budget', () => {
  const small = npmSubject('small')
  const large = npmSubject('large')
  const smallBytes = svgOf('small')
  const largeBytes = svgOfLength(MAX_CATALOG_ICON_BYTES / 2)
  const results = resultsOf([keyOf(small), bytesResult(smallBytes)], [keyOf(large), bytesResult(largeBytes)])

  it('withholds for size the icons the budget turns away, with a row each and no identity entry', () => {
    const budget = sizeOf(fileOf([[keyOf(small), smallBytes]]))
    const { fold } = runDay([small, large], { results, fileBudget: budget })
    expect(fold.file).toEqual(fileOf([[keyOf(small), smallBytes]]))
    expect(fold.byIdentity).toEqual(new Map([['npm:small', sha256Hex(smallBytes)]]))
    expect(fold.rows).toEqual([{ name: 'large', identity: 'npm:large', kind: 'withheld', detail: iconDetail.withheldForSize() }])
    expect(fold.counts).toEqual({ ...ZERO, declared: 2, published: 1, withheldForSize: 1 })
  })

  it('records a withheld icon as withheld for size, not published, because the file does not carry it', () => {
    // `published` said the bytes were read and passed, which was true, and that
    // the icons file holds them, which was not: the next build saw a published
    // sha absent from the file, and the committed record disagreed with the
    // published one. The row now says which of the two happened, and keeps the
    // size so the plan can tell whether the file has room for it later.
    const budget = sizeOf(fileOf([[keyOf(small), smallBytes]]))
    const { fold } = runDay([small, large], { results, fileBudget: budget })
    expect(fold.nextState.get(keyOf(large))).toEqual({
      outcome: 'withheld-for-size',
      sha256: sha256Hex(largeBytes),
      mediaType: 'image/svg+xml',
      bytes: largeBytes.length,
    })
  })

  it('withholds every entry that holds a withheld icon', () => {
    const twin = npmSubject('large-twin')
    const budget = sizeOf(fileOf([[keyOf(small), smallBytes]]))
    const { fold } = runDay([small, large, twin], { results: resultsOf(...results, [keyOf(twin), bytesResult(largeBytes)]), fileBudget: budget })
    expect(fold.rows.map(({ name }) => name)).toEqual(['large', 'large-twin'])
    expect(fold.counts).toEqual({ ...ZERO, declared: 3, published: 1, withheldForSize: 2 })
  })

  it('withholds nothing when the icons fit the default budget', () => {
    const { fold } = runDay([small, large], { results })
    expect(fold.counts).toEqual({ ...ZERO, declared: 2, published: 2 })
  })

  it('holds the file to the design\'s budget when it is given none', () => {
    // The build passes no budget, so the default is the one that binds: more
    // icons of the largest size than fit in 16 MiB, and the fold stops at the
    // longest set that does. Counts come from the constants, never typed.
    const dataUrlLength = iconDataUrl(largeSvg('0'), 'image/svg+xml').length
    const count = Math.ceil(ICONS_FILE_BUDGET_BYTES / dataUrlLength) + 4
    const subjects = Array.from({ length: count }, (_, index) => npmSubject(`large-${index}`))
    const answers = resultsOf(...subjects.map((subject, index): [IconKey, IconFetchResult] => [keyOf(subject), bytesResult(largeSvg(String(index)))]))
    const { fold } = runDay(subjects, { results: answers })
    expect(fold.file).not.toBeNull()
    const size = fold.file === null ? 0 : sizeOf(fold.file)
    expect(size).toBeLessThanOrEqual(ICONS_FILE_BUDGET_BYTES)
    // One more icon would not have fitted: the budget is what stopped it.
    expect(size + dataUrlLength).toBeGreaterThan(ICONS_FILE_BUDGET_BYTES)
    expect(fold.counts.withheldForSize).toBeGreaterThan(0)
    expect(fold.counts.published + fold.counts.withheldForSize).toBe(count)
  })

  it('withholds everything, and carries no file, when not even one icon fits', () => {
    const { fold } = runDay([small, large], { results, fileBudget: 0 })
    expect(fold.file).toBeNull()
    expect(fold.byIdentity.size).toBe(0)
    expect(fold.counts).toEqual({ ...ZERO, declared: 2, withheldForSize: 2 })
    expect(fold.rows.map(({ kind }) => kind)).toEqual(['withheld', 'withheld'])
  })
})

describe('foldIconResults: entries that share a key', () => {
  // Two repositories that attach one release asset: one key, so one fetch and
  // one icon, but two entries, each counted and each named by its own identity.
  const subjects = iconSubjects(
    ['a/x', 'b/x'].map((repo) => rescuedEntry(repo)),
    [],
    ['a/x', 'b/x'].map((repo) => repoCandidate(repo, { rescued: true, icon: declared() })),
  )
  const shared = releaseIconKey(TARBALL_SHA, 'icon.svg')
  const bytes = svgOf('asset')

  it('names one key for both entries', () => {
    expect(subjects.map(keyOf)).toEqual([shared, shared])
  })

  it('publishes it to both, fetched once', () => {
    const { plan, fold } = runDay(subjects, { results: resultsOf([shared, bytesResult(bytes)]) })
    expect(plan.fetch).toHaveLength(1)
    expect(fold.byIdentity).toEqual(new Map([['github:a/x#', sha256Hex(bytes)], ['github:b/x#', sha256Hex(bytes)]]))
    expect(Object.keys(fold.file?.icons ?? {})).toEqual([sha256Hex(bytes)])
    expect(fold.counts).toEqual({ ...ZERO, declared: 2, published: 2 })
  })

  it('reports its refusal for each of them', () => {
    const detail = iconDetail.notInRelease(iconLabel('icon'), shownPath('icon.svg'))
    const { fold } = runDay(subjects, { results: resultsOf([shared, { kind: 'refused', detail }]) })
    expect(fold.rows).toEqual([
      { name: 'a/x', identity: 'github:a/x#', kind: 'refused', detail },
      { name: 'b/x', identity: 'github:b/x#', kind: 'refused', detail },
    ])
    expect(fold.counts).toEqual({ ...ZERO, declared: 2, refused: 2 })
  })

  it('gives the icon only to the entry that is not withheld', () => {
    const { fold } = runDay(subjects, { withheld: withheldOf(['a/x', 'r']), results: resultsOf([shared, bytesResult(bytes)]) })
    expect(fold.byIdentity).toEqual(new Map([['github:b/x#', sha256Hex(bytes)]]))
    expect(fold.rows).toEqual([{ name: 'a/x', identity: 'github:a/x#', kind: 'withheld', detail: iconDetail.withheldByHand('r') }])
    expect(fold.counts).toEqual({ ...ZERO, declared: 2, published: 1, withheldByHand: 1 })
  })
})

describe('foldIconResults: every bucket at once', () => {
  it('puts each declared entry in exactly one, and the counts add up', () => {
    const names = ['a-published', 'b-reused', 'c-held', 'd-big', 'e-badread', 'f-badbytes', 'g-gone', 'h-later', 'i-deferred', 'j-notarget', 'k-plain']
    const subjectOf = (name: string): IconSubject => {
      if (name === 'e-badread') return npmSubject(name, refusedRead(iconDetail.notString()))
      if (name === 'k-plain') return npmSubject(name, null)
      if (name === 'j-notarget') return only(iconSubjects([npmEntry(name)], [npmCandidate(name, declared(), { distTarball: undefined })], []))
      return npmSubject(name)
    }
    const subjects = names.map(subjectOf)
    const subject = (name: string): IconSubject => subjectNamed(subjects, name)
    const published = svgOf('a')
    const reused = svgOf('b')
    const big = svgOfLength(MAX_CATALOG_ICON_BYTES / 2)
    const gone = iconDetail.packageTooLarge('g-gone', '1.0.0')
    const budget = sizeOf(fileOf([[keyOf(subject('a-published')), published], [keyOf(subject('b-reused')), reused]]))
    const { plan, fold } = runDay(subjects, {
      state: stateOf([keyOf(subject('b-reused')), publishedRow(reused)]),
      published: fileOf([[keyOf(subject('b-reused')), reused]]),
      withheld: withheldOf(['c-held', 'a reason']),
      results: resultsOf(
        [keyOf(subject('a-published')), bytesResult(published)],
        [keyOf(subject('d-big')), bytesResult(big)],
        [keyOf(subject('f-badbytes')), bytesResult(NOT_AN_IMAGE)],
        [keyOf(subject('g-gone')), { kind: 'not-read', detail: gone }],
        [keyOf(subject('h-later')), { kind: 'not-yet-read', reason: 'a timeout' }],
        [keyOf(subject('i-deferred')), bytesResult(svgOf('i'))],
      ),
      fetchBudget: 5,
      fileBudget: budget,
    })
    expect(plan.deferred).toEqual([keyOf(subject('i-deferred'))])
    expect(fold.counts).toEqual({ declared: 10, published: 2, withheldByHand: 1, withheldForSize: 1, refused: 2, notRead: 1, notYetRead: 3 })
    expect(fold.rows).toEqual([
      { name: 'c-held', identity: 'npm:c-held', kind: 'withheld', detail: iconDetail.withheldByHand('a reason') },
      { name: 'd-big', identity: 'npm:d-big', kind: 'withheld', detail: iconDetail.withheldForSize() },
      { name: 'e-badread', identity: 'npm:e-badread', kind: 'refused', detail: iconDetail.notString() },
      { name: 'f-badbytes', identity: 'npm:f-badbytes', kind: 'refused', detail: iconDetail.wrongBytes(iconLabel('icon'), shownPath('icon.svg'), 'SVG') },
      { name: 'g-gone', identity: 'npm:g-gone', kind: 'not-read', detail: gone },
    ])
    expect([...fold.byIdentity.keys()].sort(compareStrings)).toEqual(['npm:a-published', 'npm:b-reused'])
    // Every key a declared entry names, bar the ones nothing was read for.
    expect([...fold.nextState.keys()].sort(compareStrings)).toEqual(
      ['a-published', 'b-reused', 'd-big', 'f-badbytes', 'g-gone'].map((name) => keyOf(subject(name))).sort(compareStrings),
    )
  })
})

describe('foldIconResults: every day for one entry', () => {
  // One entry through every combination of what its candidate says, whether a
  // maintainer withheld it, whether it has anything to fetch it from, what the
  // record holds, what the plan did with its key, what the fetch answered and
  // whether the file budget turns every icon away: each day is checked against
  // the rules of the design, written out afresh below and not read off the fold.
  // The sweep at the end holds every fold sound; this holds each bucket right,
  // which a bucket that is wrong but consistent would escape.
  const AXES = {
    /** What the candidate says of the icon. */
    read: ['declared', 'refused'],
    /** Whether `withheld-icons.yml` names the entry. */
    withheld: [false, true],
    /** Whether the candidate has what a fetch needs. */
    target: [true, false],
    /** What the committed record holds for the key, and whether yesterday's file holds the bytes. */
    record: ['none', 'published-in-file', 'published-lost', 'published-elsewhere', 'refused', 'not-read'],
    /** What the plan did with the key: asked for it, deferred it, or left it out of what the fold is handed. */
    placement: ['fetched', 'deferred', 'unasked'],
    /** What the fetch answered, if it did. */
    answer: ['same-bytes', 'new-bytes', 'wrong-bytes', 'refused', 'not-read', 'not-yet-read', 'none'],
    /** Whether the file budget turns every icon away. */
    sized: [false, true],
  } as const

  type Scenario = { [Axis in keyof typeof AXES]: (typeof AXES)[Axis][number] }

  /** Every combination of one value from each axis. */
  function combinations<Axes extends Record<string, readonly unknown[]>>(axes: Axes): { [Axis in keyof Axes]: Axes[Axis][number] }[] {
    const rows = Object.entries(axes).reduce<Record<string, unknown>[]>(
      (partial, [axis, values]) => partial.flatMap((row) => values.map((value) => ({ ...row, [axis]: value }))),
      [{}],
    )
    // Each row now holds one value of every axis.
    return rows as { [Axis in keyof Axes]: Axes[Axis][number] }[]
  }

  const scenarios = combinations(AXES)
  const A = svgOf('A')
  const B = svgOf('B')
  const ELSEWHERE = svgOf('elsewhere')
  const REASON = 'a reason'
  const READ_REFUSED = iconDetail.notString()
  const WRONG = iconDetail.wrongBytes(iconLabel('icon'), shownPath('icon.svg'), 'SVG')
  const FETCH_REFUSED = 'a refusal the fetch reported'
  const FETCH_NOT_READ = 'a package the fetch could not read'
  const RECORD_REFUSED = { outcome: 'refused', detail: 'a refusal recorded earlier' } satisfies IconOutcome
  const RECORD_NOT_READ = { outcome: 'not-read', detail: 'a package recorded as not read' } satisfies IconOutcome

  /** The row the record holds for the key, by the axis that says so. */
  const RECORDS: Record<Scenario['record'], IconOutcome | undefined> = {
    none: undefined,
    'published-in-file': publishedRow(A),
    'published-lost': publishedRow(A),
    'published-elsewhere': publishedRow(A),
    refused: RECORD_REFUSED,
    'not-read': RECORD_NOT_READ,
  }

  /** What the fetch answered, by the axis that says so. */
  const ANSWERS: Record<Scenario['answer'], IconFetchResult | undefined> = {
    'same-bytes': bytesResult(A),
    'new-bytes': bytesResult(B),
    'wrong-bytes': bytesResult(NOT_AN_IMAGE),
    refused: { kind: 'refused', detail: FETCH_REFUSED },
    'not-read': { kind: 'not-read', detail: FETCH_NOT_READ },
    'not-yet-read': { kind: 'not-yet-read', reason: 'a timeout' },
    none: undefined,
  }

  /** Where the one entry ends up: its bucket, its row if any, the icon it carries, and the record of its key. */
  interface Verdict {
    bucket: Exclude<keyof typeof ZERO, 'declared'>
    row: [kind: IconReportRow['kind'], detail: string] | null
    /** The bytes of the icon, for an entry that is published. */
    bytes?: Uint8Array
    state: IconOutcome | undefined
  }

  function verdictOf(scenario: Scenario): Verdict {
    const recorded = RECORDS[scenario.record]
    const withheldByHand = (state: IconOutcome | undefined): Verdict =>
      ({ bucket: 'withheldByHand', row: ['withheld', iconDetail.withheldByHand(REASON)], state })
    // A refused read has no key, so no record: it is refused, or withheld when a maintainer said so.
    if (scenario.read === 'refused') {
      return scenario.withheld ? withheldByHand(undefined) : { bucket: 'refused', row: ['refused', READ_REFUSED], state: undefined }
    }
    // A withheld entry is withheld whatever else is true of it, and its record stays.
    if (scenario.withheld) return withheldByHand(recorded)
    // With nothing to fetch it from it is no icon this build, unless the bytes
    // are already in yesterday's file — those are in hand, and the record stays.
    if (!scenario.target) {
      if (scenario.record !== 'published-in-file') return { bucket: 'notYetRead', row: null, state: recorded }
      return scenario.sized
        ? { bucket: 'withheldForSize', row: ['withheld', iconDetail.withheldForSize()], state: withheldRow(A) }
        : { bucket: 'published', row: null, bytes: A, state: recorded }
    }
    // A refusal and a package past the caps are recorded once, and reported from the record.
    if (scenario.record === 'refused') return { bucket: 'refused', row: ['refused', RECORD_REFUSED.detail], state: recorded }
    if (scenario.record === 'not-read') return { bucket: 'notRead', row: ['not-read', RECORD_NOT_READ.detail], state: recorded }
    // An icon in hand is published, unless the file budget turns it away.
    const icon = (bytes: Uint8Array, state: IconOutcome): Verdict => scenario.sized
      ? { bucket: 'withheldForSize', row: ['withheld', iconDetail.withheldForSize()], state: withheldRow(bytes) }
      : { bucket: 'published', row: null, bytes, state }
    // Yesterday's file holds the bytes the record names: no fetch is made, whatever was answered.
    if (scenario.record === 'published-in-file') return icon(A, publishedRow(A))
    // Otherwise the key is unknown, or its bytes are gone, and the plan asks for it:
    // an answer decides it, and no answer leaves it for the next build.
    const answered = scenario.placement === 'fetched' && scenario.answer !== 'none' && scenario.answer !== 'not-yet-read'
    if (!answered) return { bucket: 'notYetRead', row: null, state: recorded }
    switch (scenario.answer) {
      case 'same-bytes': return icon(A, publishedRow(A))
      case 'new-bytes': return icon(B, publishedRow(B))
      case 'wrong-bytes': return { bucket: 'refused', row: ['refused', WRONG], state: { outcome: 'refused', detail: WRONG } }
      case 'refused': return { bucket: 'refused', row: ['refused', FETCH_REFUSED], state: { outcome: 'refused', detail: FETCH_REFUSED } }
      case 'not-read': return { bucket: 'notRead', row: ['not-read', FETCH_NOT_READ], state: { outcome: 'not-read', detail: FETCH_NOT_READ } }
      default: throw new Error(`the answer ${scenario.answer} was taken for no answer above`)
    }
  }

  /** What differs between the fold of one day and the verdict on it, in words. */
  function problemsOf(scenario: Scenario): string[] {
    const candidate = scenario.read === 'declared' ? declared() : refusedRead(READ_REFUSED)
    const subject = only(iconSubjects([npmEntry('x')], [npmCandidate('x', candidate, scenario.target ? {} : { distTarball: undefined })], []))
    const { key } = subject
    const recorded = RECORDS[scenario.record]
    const answer = ANSWERS[scenario.answer]
    const state = new Map<IconKey, IconOutcome>(key !== undefined && recorded !== undefined ? [[key, recorded]] : [])
    const results = new Map<IconKey, IconFetchResult>(key !== undefined && answer !== undefined ? [[key, answer]] : [])
    const published = key === undefined ? null
      : scenario.record === 'published-in-file' ? fileOf([[key, A]])
        : scenario.record === 'published-elsewhere' ? fileOf([[npmKey('elsewhere'), ELSEWHERE]])
          : null
    const withheld = scenario.withheld ? withheldOf(['x', REASON]) : new Map<string, { reason: string }>()
    const planned = planIconWork([subject], state, published, withheld, scenario.placement === 'deferred' ? 0 : PLENTY)
    const handed = scenario.placement === 'unasked' ? { ...planned, fetch: planned.fetch.filter((work) => work.key !== key) } : planned
    const fold = foldIconResults([subject], handed, results, state, published, withheld, scenario.sized ? 0 : undefined)

    const want = verdictOf(scenario)
    const problems: string[] = []
    const expectEqual = (what: string, got: unknown, wanted: unknown): void => {
      if (!isDeepStrictEqual(got, wanted)) problems.push(`${what} is ${JSON.stringify(got)}, not ${JSON.stringify(wanted)}`)
    }
    expectEqual('the counts', fold.counts, { ...ZERO, declared: 1, [want.bucket]: 1 })
    expectEqual('the rows', fold.rows.map(({ kind, detail }) => [kind, detail]), want.row === null ? [] : [want.row])
    expectEqual('the row identities', fold.rows.map(({ identity }) => identity), want.row === null ? [] : ['npm:x'])
    expectEqual('the identity map', [...fold.byIdentity], want.bytes === undefined ? [] : [['npm:x', sha256Hex(want.bytes)]])
    expectEqual('the file', fold.file, want.bytes === undefined || key === undefined ? null : fileOf([[key, want.bytes]]))
    expectEqual('the record', [...fold.nextState], key === undefined || want.state === undefined ? [] : [[key, want.state]])
    if (fold.file !== null) expectEqual('the file read back', parseIconsFile(serializeIcons(fold.file).json), fold.file)
    return problems
  }

  it('is as many distinct days as the axes hold, reaching every bucket and kind of row', () => {
    expect(scenarios).toHaveLength(Object.values(AXES).reduce((days, values) => days * values.length, 1))
    expect(new Set(scenarios.map((scenario) => JSON.stringify(scenario))).size).toBe(scenarios.length)
    const verdicts = scenarios.map(verdictOf)
    expect(new Set(verdicts.map(({ bucket }) => bucket))).toEqual(new Set(Object.keys(ZERO).filter((bucket) => bucket !== 'declared')))
    expect(new Set(verdicts.flatMap(({ row }) => (row === null ? [] : [row[0]])))).toEqual(new Set(['refused', 'not-read', 'withheld']))
  })

  it('puts the entry in the right bucket, with the right row, icon and record, on every day', () => {
    const failures = scenarios.flatMap((scenario) => {
      const problems = problemsOf(scenario)
      return problems.length === 0 ? [] : [{ scenario, problems }]
    })
    expect(failures).toEqual([])
  })
})

describe('foldIconResults: the same answer from the same day', () => {
  /** Everything a fold answers, as bytes where the build writes bytes, so that a difference in any of it shows. */
  const written = (fold: IconFold) => ({
    state: serializeIconState(fold.nextState),
    file: fold.file === null ? null : serializeIcons(fold.file).json,
    identities: [...fold.byIdentity].sort(([a], [b]) => compareStrings(a, b)),
    rows: fold.rows,
    counts: fold.counts,
  })

  it('whatever order the subjects come in', () => {
    const subjects = ['ok', 'twin', 'reused', 'bad', 'held'].map((name) => npmSubject(name))
    const key = (name: string): IconKey => npmKey(name)
    const shared = svgOf('shared')
    const day: Day = {
      state: stateOf([key('reused'), publishedRow(svgOf('reused'))]),
      published: fileOf([[key('reused'), svgOf('reused')]]),
      withheld: withheldOf(['held', 'r']),
      results: resultsOf([key('ok'), bytesResult(shared)], [key('twin'), bytesResult(shared)], [key('bad'), bytesResult(NOT_AN_IMAGE)]),
    }
    const expected = written(runDay(subjects, day).fold)
    expect(expected.counts).toEqual({ ...ZERO, declared: 5, published: 3, withheldByHand: 1, refused: 1 })
    for (const order of permutations(subjects)) expect(written(runDay(order, day).fold)).toEqual(expected)
  })

  it('and leaves what it is given as it was', () => {
    const x = npmSubject('x')
    const state = stateOf([keyOf(x), publishedRow(svgOf('before'))])
    const published = fileOf([[keyOf(x), svgOf('before')]])
    const results = resultsOf([keyOf(x), bytesResult(svgOf('after'))])
    const withheld = withheldOf(['other', 'r'])
    const plan = planIconWork([x], state, null, withheld, PLENTY)
    const snapshot = (): string => JSON.stringify([
      [x],
      plan,
      [...results].map(([key, result]) => [key, result.kind === 'bytes' ? sha256Hex(result.bytes) : result]),
      [...state],
      published,
      [...withheld],
    ])
    const before = snapshot()
    expect(foldIconResults([x], plan, results, state, published, withheld).counts.published).toBe(1)
    expect(snapshot()).toBe(before)
  })
})

describe('the three together, over days', () => {
  const subjects = [npmSubject('a'), npmSubject('b'), npmSubject('c', declared('icon.png', 'image/png'))]
  const answers = resultsOf(
    [npmKey('a'), bytesResult(svgOf('a'))],
    [npmKey('b'), bytesResult(svgOf('b'))],
    [npmKey('c', 'icon.png'), bytesResult(PNG)],
  )

  it('fetches everything on the first day and nothing on the second, and publishes the same bytes both days', () => {
    const first = runDay(subjects, { results: answers })
    expect(first.plan.fetch).toHaveLength(3)
    expect(first.fold.counts).toEqual({ ...ZERO, declared: 3, published: 3 })
    const file = first.fold.file
    expect(file).not.toBeNull()
    // The build publishes the file's text, and the next build reads that text back.
    const published = file === null ? null : parseIconsFile(serializeIcons(file).json)
    const second = runDay(subjects, { state: first.fold.nextState, published })
    expect(second.plan.fetch).toEqual([])
    expect(second.plan.reuse).toHaveLength(3)
    expect(second.fold.nextState).toEqual(first.fold.nextState)
    expect(second.fold.byIdentity).toEqual(first.fold.byIdentity)
    expect(second.fold.file === null ? null : serializeIcons(second.fold.file)).toEqual(file === null ? null : serializeIcons(file))
  })

  it('fetches again, against the recorded sha256s, when the published file is lost, and ends where it was', () => {
    const first = runDay(subjects, { results: answers })
    const lost = runDay(subjects, { state: first.fold.nextState, published: null, results: answers })
    expect(lost.plan.fetch.map(({ key, expectSha256 }) => [key, expectSha256])).toEqual([
      [npmKey('a'), sha256Hex(svgOf('a'))],
      [npmKey('b'), sha256Hex(svgOf('b'))],
      [npmKey('c', 'icon.png'), sha256Hex(PNG)],
    ])
    expect(lost.fold.nextState).toEqual(first.fold.nextState)
    expect(lost.fold.file).toEqual(first.fold.file)
  })

  it('asks once for a refusal, not every day', () => {
    const refusal = iconDetail.notInPackage(iconLabel('icon'), shownPath('icon.svg'), 'a', '1.0.0')
    const first = runDay(subjects, { results: resultsOf([npmKey('a'), { kind: 'refused', detail: refusal }]) })
    const second = runDay(subjects, { state: first.fold.nextState, published: null })
    expect(second.plan.fetch.map(({ key }) => key)).toEqual([npmKey('b'), npmKey('c', 'icon.png')])
    expect(second.fold.rows).toEqual([{ name: 'a', identity: 'npm:a', kind: 'refused', detail: refusal }])
  })
})

describe('whatever a day brings', () => {
  // A seeded sweep over scenarios no hand-written case thinks of: any mix of
  // reads, records, answers, withholds and budgets, with bytes that several
  // keys share and a published file that labels one of them wrong. Nothing
  // may throw, and every fold must be sound (`expectSound`): the counts add up
  // on all of them, which is the property the report's one line stands on.
  function lcg(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 2 ** 32
    }
  }

  // Three icons that several keys can share: two small ones, and one big enough
  // that a file budget turns it away first.
  const POOL = [svgOf('one'), svgOf('two'), svgOfLength(MAX_CATALOG_ICON_BYTES / 2)]
  const READS = ['none', 'refused', 'refused-withheld', 'no-target', 'withheld', 'declared', 'declared'] as const
  const RECORDS = ['none', 'published', 'published-lost', 'refused', 'not-read'] as const
  const ANSWERS = ['none', 'bytes', 'wrong-bytes', 'refused', 'not-read', 'not-yet-read'] as const

  /** Draws from the generator: a pick of some choices, a count below a bound, and a coin that lands with a probability. */
  const drawer = (next: () => number) => ({
    from: <T>(choices: readonly T[]): T => {
      const chosen = choices[Math.floor(next() * choices.length)]
      if (chosen === undefined) throw new Error('nothing to choose from')
      return chosen
    },
    below: (count: number): number => Math.floor(next() * count),
    chance: (probability: number): boolean => next() < probability,
  })

  it('never throws and never counts a declared entry twice', () => {
    for (let seed = 1; seed <= 250; seed += 1) {
      const draw = drawer(lcg(seed))
      const count = 1 + draw.below(7)
      const subjects: IconSubject[] = []
      const state = new Map<IconKey, IconOutcome>()
      const held: [IconKey, Uint8Array][] = []
      const results = new Map<IconKey, IconFetchResult>()
      const withheld = new Map<string, { reason: string }>()
      for (let slot = 0; slot < count; slot += 1) {
        const name = `p${slot}`
        const read = draw.from(READS)
        const subject = read === 'none' ? npmSubject(name, null)
          : read === 'refused' || read === 'refused-withheld' ? npmSubject(name, refusedRead(iconDetail.notString()))
            : read === 'no-target' ? only(iconSubjects([npmEntry(name)], [npmCandidate(name, declared(), { integrity: null })], []))
              : npmSubject(name)
        subjects.push(subject)
        if (read === 'withheld' || read === 'refused-withheld') withheld.set(name, { reason: 'r' })
        if (subject.key === undefined) continue
        const bytes = draw.from(POOL)
        const record = draw.from(RECORDS)
        if (record === 'published' || record === 'published-lost') state.set(subject.key, publishedRow(bytes))
        if (record === 'published') held.push([subject.key, bytes])
        if (record === 'refused') state.set(subject.key, { outcome: 'refused', detail: iconDetail.notString() })
        if (record === 'not-read') state.set(subject.key, { outcome: 'not-read', detail: iconDetail.releaseUnreadable() })
        const answer = draw.from(ANSWERS)
        if (answer === 'bytes') results.set(subject.key, bytesResult(draw.from(POOL)))
        if (answer === 'wrong-bytes') results.set(subject.key, bytesResult(NOT_AN_IMAGE))
        if (answer === 'refused') results.set(subject.key, { kind: 'refused', detail: iconDetail.notString() })
        if (answer === 'not-read') results.set(subject.key, { kind: 'not-read', detail: iconDetail.releaseUnreadable() })
        if (answer === 'not-yet-read') results.set(subject.key, { kind: 'not-yet-read', reason: 'a timeout' })
      }
      // Yesterday's file may be gone, and may label the bytes it holds as another type.
      const published = draw.chance(0.1) ? null : fileOf(held, draw.chance(0.5) ? 'image/svg+xml' : 'image/png')
      const day: Day = { state, published, withheld, results, fetchBudget: draw.below(count + 1) }
      const whole = runDay(subjects, day).fold
      if (whole.file === null) continue
      // The same day under a file budget that turns the largest icon away, and one that turns away about half.
      const size = sizeOf(whole.file)
      runDay(subjects, { ...day, fileBudget: size - 1 })
      runDay(subjects, { ...day, fileBudget: Math.floor(size / 2) })
    }
  })
})

describe('renderIconSection: the icon section', () => {
  const counts: IconCounts = { declared: 3, published: 1, withheldByHand: 0, withheldForSize: 0, refused: 1, notRead: 0, notYetRead: 1 }
  const refusedRow = (name: string, detail: string): IconReportRow => ({ name, identity: `npm:${name}`, kind: 'refused', detail })

  it('renders the counts, the icons file size and a table row for each icon left out', () => {
    const rows = [refusedRow('x|y', iconDetail.notString())]
    expect(renderIconSection({ counts, rows }, 1234)).toBe(
      '## Icons\n' +
      '\n' +
      'Declared 3: published 1, withheld by hand 0, withheld for size 0, refused 1, not read 0, not yet read 1. Icons file: 1234 bytes.\n' +
      '\n' +
      '| Plugin | Icon |\n' +
      '|---|---|\n' +
      `| x\\|y | ${iconDetail.notString()} |\n`,
    )
  })

  it('says the icons file is none when the build publishes none', () => {
    const rows = [refusedRow('x|y', iconDetail.notString())]
    expect(renderIconSection({ counts, rows }, null)).toBe(
      '## Icons\n' +
      '\n' +
      'Declared 3: published 1, withheld by hand 0, withheld for size 0, refused 1, not read 0, not yet read 1. Icons file: none.\n' +
      '\n' +
      '| Plugin | Icon |\n' +
      '|---|---|\n' +
      `| x\\|y | ${iconDetail.notString()} |\n`,
    )
  })

  it('has no table when no icon is left out', () => {
    expect(renderIconSection({ counts: { ...ZERO, declared: 2, published: 2 }, rows: [] }, 1234)).toBe(
      '## Icons\n' +
      '\n' +
      'Declared 2: published 2, withheld by hand 0, withheld for size 0, refused 0, not read 0, not yet read 0. Icons file: 1234 bytes.\n',
    )
  })

  it('escapes a newline and a pipe in a row\'s detail, so the row stays on one line', () => {
    const rows = [refusedRow('p', 'icon is\nbroken | badly')]
    expect(renderIconSection({ counts: { ...ZERO, declared: 1, refused: 1 }, rows }, null)).toBe(
      '## Icons\n' +
      '\n' +
      'Declared 1: published 0, withheld by hand 0, withheld for size 0, refused 1, not read 0, not yet read 0. Icons file: none.\n' +
      '\n' +
      '| Plugin | Icon |\n' +
      '|---|---|\n' +
      '| p | icon is broken \\| badly |\n',
    )
  })
})
