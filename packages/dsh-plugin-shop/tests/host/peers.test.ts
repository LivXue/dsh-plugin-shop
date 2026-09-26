import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createPeerVersionCheck,
  harnessPackageResolver,
  harnessPackageVersionResolver,
  incompatibilityMap,
  nodeResolver,
  nodeVersionResolver,
  packageDirectory,
  packageResolver,
  packageVersionResolver,
  peerVersionMismatches,
  peerVersionWarning,
  type HarnessPackageLookup,
  type PackageLookupFs,
  type PeerVersionResolver,
} from '../../src/host/peers.ts'
import { ownPeerRanges } from '../../src/own-version.ts'
import { fileTempRoot } from './temp-root.ts'

const TEMP_ROOT = fileTempRoot('peers')

// The real division on the machine where this broke: everything the harness
// ships resolves from the profile anchor; dsh-client-store, which exists only
// on the 0.1.2-alpha line, does not.
const present = new Set(['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-locale', 'react'])
const resolve = (spec: string): boolean => present.has(spec)

describe('incompatibilityMap', () => {
  it('names the peers that did not resolve', () => {
    const map = incompatibilityMap(
      [{ source: 'npm', name: 'dsh-timeline', peers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', 'react'] }],
      resolve,
    )
    expect(map).toEqual({ 'npm:dsh-timeline': ['@deepseek-ai/dsh-client-store'] })
  })

  it('omits an entry whose peers all resolve', () => {
    expect(incompatibilityMap([{ source: 'npm', name: 'ok', peers: ['react'] }], resolve)).toEqual({})
  })

  it('omits an entry that declares no peers', () => {
    expect(incompatibilityMap([{ source: 'npm', name: 'bare' }], resolve)).toEqual({})
  })

  it('reports a missing peer that is not a harness package', () => {
    // No name pattern: the check is uniform, so a missing `temml` is reported
    // exactly like a missing @deepseek-ai module.
    expect(incompatibilityMap([{ source: 'npm', name: 'x', peers: ['temml'] }], resolve)).toEqual({ 'npm:x': ['temml'] })
  })

  it('resolves each distinct name once however many entries share it', () => {
    let calls = 0
    const counting = (spec: string): boolean => { calls += 1; return present.has(spec) }
    incompatibilityMap(
      [
        { source: 'npm', name: 'a', peers: ['@deepseek-ai/cordis', 'react'] },
        { source: 'npm', name: 'b', peers: ['@deepseek-ai/cordis', 'react'] },
        { source: 'npm', name: 'c', peers: ['@deepseek-ai/cordis'] },
      ],
      counting,
    )
    expect(calls).toBe(2)
  })

  it('treats a throwing resolver as no verdict rather than as missing', () => {
    // Silence, never a false alarm: an unavailable fact must not read as an
    // accusation against a plugin that may be perfectly fine.
    const throwing = (): boolean => { throw new Error('anchor unavailable') }
    expect(incompatibilityMap([{ source: 'npm', name: 'x', peers: ['whatever'] }], throwing)).toEqual({})
  })

  it('discards a partial missing list when a later peer throws', () => {
    const flaky = (spec: string): boolean => {
      if (spec === 'react') return false
      throw new Error('anchor unavailable')
    }
    expect(incompatibilityMap([{ source: 'npm', name: 'x', peers: ['react', 'whatever'] }], flaky)).toEqual({})
  })

  it('when a shared peer throws, both entries get no verdict and it is resolved once', () => {
    let calls = 0
    const mockResolve = (spec: string): boolean => {
      calls++
      if (spec === 'react') return true
      throw new Error('resolution failed')
    }

    const map = incompatibilityMap(
      [
        { source: 'npm', name: 'a', peers: ['react', 'throwing-peer'] },
        { source: 'npm', name: 'b', peers: ['throwing-peer', 'react'] },
      ],
      mockResolve,
    )

    expect(map).toEqual({}) // both entries get no verdict
    expect(calls).toBe(2) // 'react' once, 'throwing-peer' once
  })
})

describe('incompatibilityMap identity (G-1)', () => {
  it('keys each verdict by the entry identity, so same-named entries do not merge', () => {
    const map = incompatibilityMap(
      [
        { source: 'github', name: 'dsh-foo', repo: 'alice/dsh-foo', peers: ['@deepseek-ai/dsh-client-store'] },
        { source: 'github', name: 'dsh-foo', repo: 'bob/dsh-foo', peers: ['react'] },
        { source: 'npm', name: 'dsh-foo', peers: ['temml'] },
      ],
      resolve,
    )
    expect(map).toEqual({
      'github:alice/dsh-foo#': ['@deepseek-ai/dsh-client-store'],
      'npm:dsh-foo': ['temml'],
    })
  })

  it('keys a subpackage entry by its subdir', () => {
    const map = incompatibilityMap(
      [{ source: 'github', name: 'sub', repo: 'someone/mono', subdir: 'packages/a', peers: ['temml'] }],
      resolve,
    )
    expect(map).toEqual({ 'github:someone/mono#packages/a': ['temml'] })
  })
})

describe('nodeResolver', () => {
  it('resolves a package that exists and refuses one that does not', () => {
    const resolveHere = nodeResolver(import.meta.url)
    expect(resolveHere('vitest')).toBe(true)
    expect(resolveHere('@deepseek-ai/dsh-client-store-that-does-not-exist')).toBe(false)
  })

  it('treats a package that restricts ./package.json as present', () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'noderesolver-'))
    try {
      // Create a package with exports that do not list "./package.json"
      const pkgDir = join(dir, 'node_modules', 'restricted-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: 'restricted-pkg',
          version: '1.0.0',
          main: 'index.js',
          exports: { '.': './index.js' },
        }),
      )
      writeFileSync(join(pkgDir, 'index.js'), '')

      const resolveHere = nodeResolver(pathToFileURL(join(dir, 'anchor.js')).href)

      // The directory is the match; an exports map governs what may be
      // imported FROM a package, and is never evidence that it is absent.
      expect(resolveHere('restricted-pkg')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps a genuinely missing sibling's verdict beside a restricted package", () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'noderesolver-pair-'))
    try {
      const pkgDir = join(dir, 'node_modules', 'restricted-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'restricted-pkg', version: '1.0.0', main: 'index.js', exports: { '.': './index.js' },
      }))
      writeFileSync(join(pkgDir, 'index.js'), '')

      const resolveHere = nodeResolver(pathToFileURL(join(dir, 'anchor.js')).href)
      expect(incompatibilityMap(
        [{ source: 'npm', name: 'x', peers: ['restricted-pkg', 'definitely-missing-peer'] }],
        resolveHere,
      )).toEqual({ 'npm:x': ['definitely-missing-peer'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('counts a package whose manifest is malformed as present', () => {
    // Presence never parses the manifest: it asks only that the matched
    // directory hold a `package.json` FILE, and whether an import from it
    // then works is a different question. require.resolve DID parse it, to
    // consult `exports`, and threw here — which withdrew the whole verdict of
    // every entry that also declared this peer, a genuinely missing sibling
    // included. Nothing on the filesystem makes the lookup throw now; the stat
    // cases below are where that rule is pinned.
    const dir = mkdtempSync(join(TEMP_ROOT, 'noderesolver-invalid-'))
    try {
      const pkgDir = join(dir, 'node_modules', 'invalid-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), '{not valid json')
      const anchor = pathToFileURL(join(dir, 'anchor.js')).href
      expect(nodeResolver(anchor)('invalid-pkg')).toBe(true)
      expect(nodeVersionResolver(anchor)('invalid-pkg')).toBeNull()
      expect(incompatibilityMap(
        [{ source: 'npm', name: 'x', peers: ['invalid-pkg', 'definitely-missing-peer'] }],
        nodeResolver(anchor),
      )).toEqual({ 'npm:x': ['definitely-missing-peer'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still returns false for genuinely missing packages in the same directory', () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'noderesolver-'))
    try {
      const resolveHere = nodeResolver(pathToFileURL(join(dir, 'anchor.js')).href)

      // Must return false because the package exists nowhere: the walk met
      // no directory at any ancestor's `node_modules/<name>`, and a walk that
      // matches nothing is the one answer "absent" always had.
      expect(resolveHere('genuinely-missing-pkg')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── The load-time harness peer-version self-check ──────────────────────────

/** The harness peer ranges this build declares, verbatim from package.json.
 * `ownPeerRanges` is asserted against this table below, so the fixture cannot
 * drift into describing a shape the shop no longer ships. */
const DECLARED: Record<string, string> = {
  '@deepseek-ai/cordis': '^4.0.1',
  '@deepseek-ai/cordis-plugin-include': '^1.0.6',
  '@deepseek-ai/dsh-app-boot': '^0.1.1-rc.2',
  '@deepseek-ai/dsh-home-paths': '^0.1.1-rc.2',
  '@deepseek-ai/dsh-typert-protocol': '^0.1.1-rc.2',
}

/** The versions those peers actually resolve at, re-measured 2026-09-10 by a
 * bare `require` of each package out of the tree the harness npm calls
 * `latest` — NOT a reading of this repo's lockfile, which pins the harness dev
 * deps a line behind on purpose (`.github/workflows/plugin.yml` owns why).
 *
 * One table, used by every case that means "the real install". There were two
 * the first time this moved, and only one of them was re-measured. */
const INSTALLED: Record<string, string> = {
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/cordis-plugin-include': '1.0.7',
  '@deepseek-ai/dsh-app-boot': '0.1.5-rc.1',
  '@deepseek-ai/dsh-home-paths': '0.1.5-rc.1',
  '@deepseek-ai/dsh-typert-protocol': '0.1.5-rc.1',
}

/** A resolver over a fixed table: a name the table does not carry yields no
 * version, which is the no-verdict signal (absence is not a violation). */
const versions = (table: Record<string, string>): PeerVersionResolver =>
  spec => table[spec] ?? null

describe('peerVersionMismatches', () => {
  it('is silent for the versions installed today', () => {
    // The three harness rows are the discriminating ones: the harness ships
    // nothing but -rc versions, so strict semver rejects all three against
    // `^0.1.1-rc.2`, and this test is what fails if the comparison ever
    // regresses to strict mode. The two cordis peers are plain releases that
    // satisfy it either way — they are here because INSTALLED is the real
    // shape, not because they carry a case of their own.
    //
    // Every version here exists, which is what makes it a measurement and
    // also what makes it perishable: the two cases below carry the boundary
    // and the moving-harness properties, so neither depends on what npm
    // happens to be serving on the day someone re-measures this one.
    expect(peerVersionMismatches(DECLARED, versions(INSTALLED))).toEqual([])
  })

  it('accepts a peer resolving at exactly its declared floor', () => {
    // `^4.0.1` and `^1.0.6` are the only non-prerelease ranges DECLARED
    // carries, and INSTALLED now sits one patch above both — so nothing else
    // in this file covers a found version EQUAL to its floor, the boundary a
    // comparator regressed to an exclusive lower bound would break.
    expect(peerVersionMismatches(DECLARED, versions({
      ...INSTALLED,
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/cordis-plugin-include': '1.0.6',
    }))).toEqual([])
  })

  it('accepts an rc ahead of the installed one on the same minor line', () => {
    // Deliberately hypothetical: `0.1.9-rc.3` is published nowhere and stands
    // for whatever the next rc is. The harness moving forward underneath a
    // fixed range is the event §7 of the harness-compatibility design doc
    // (docs/design/2026-09-01-harness-compatibility.md) was written after, and
    // it must not stop being covered every time INSTALLED is re-measured onto
    // a single version.
    expect(peerVersionMismatches(DECLARED, versions({
      ...INSTALLED,
      '@deepseek-ai/dsh-typert-protocol': '0.1.9-rc.3',
    }))).toEqual([])
  })

  it('reports a minor-line move — the real breaking change', () => {
    expect(peerVersionMismatches(
      { '@deepseek-ai/dsh-app-boot': '^0.1.1-rc.2' },
      versions({ '@deepseek-ai/dsh-app-boot': '0.2.0-rc.1' }),
    )).toEqual([{ spec: '@deepseek-ai/dsh-app-boot', range: '^0.1.1-rc.2', found: '0.2.0-rc.1' }])
  })

  it('reports a version older than the pinned prerelease', () => {
    // 0.1.1-rc.1 precedes 0.1.1-rc.2, so ^0.1.1-rc.2 excludes it in both modes.
    expect(peerVersionMismatches(
      { '@deepseek-ai/dsh-home-paths': '^0.1.1-rc.2' },
      versions({ '@deepseek-ai/dsh-home-paths': '0.1.1-rc.1' }),
    )).toEqual([{ spec: '@deepseek-ai/dsh-home-paths', range: '^0.1.1-rc.2', found: '0.1.1-rc.1' }])
  })

  it('reports a major-line move', () => {
    expect(peerVersionMismatches(
      { '@deepseek-ai/cordis': '^4.0.1' },
      versions({ '@deepseek-ai/cordis': '5.0.0' }),
    )).toEqual([{ spec: '@deepseek-ai/cordis', range: '^4.0.1', found: '5.0.0' }])
  })

  it('gives no verdict for a peer it cannot resolve, and still judges the rest', () => {
    // Only home-paths is installed here. The four absent peers must produce
    // nothing at all: absence is not a version violation, and the presence
    // machinery (incompatibilityMap) is what covers it.
    expect(peerVersionMismatches(DECLARED, versions({
      '@deepseek-ai/dsh-home-paths': '0.2.0-rc.1',
    }))).toEqual([{ spec: '@deepseek-ai/dsh-home-paths', range: '^0.1.1-rc.2', found: '0.2.0-rc.1' }])
  })

  it('treats a throwing resolver as no verdict rather than as a violation', () => {
    // The same rule incompatibilityMap documents, for the same reason: one
    // false warning teaches a reader to ignore every warning.
    const throwing = (): string | null => { throw new Error('anchor unavailable') }
    expect(peerVersionMismatches(DECLARED, throwing)).toEqual([])
  })

  it('gives no verdict when the found version is not semver', () => {
    // `satisfies` answers false for an unparseable version, which would read
    // as an accusation; an unreadable fact must stay unspoken.
    expect(peerVersionMismatches(
      { '@deepseek-ai/dsh-app-boot': '^0.1.1-rc.2' },
      versions({ '@deepseek-ai/dsh-app-boot': 'nightly' }),
    )).toEqual([])
  })

  it('gives no verdict when the declared range is not a range', () => {
    // e.g. a `workspace:^0.1.1-rc.2` spec, which semver cannot parse.
    expect(peerVersionMismatches(
      { '@deepseek-ai/dsh-typert-protocol': 'workspace:^0.1.1-rc.2' },
      versions({ '@deepseek-ai/dsh-typert-protocol': '0.1.2-rc.1' }),
    )).toEqual([])
  })

  it('orders mismatches by peer name, whatever order the manifest declares', () => {
    const out = peerVersionMismatches(
      { 'z-peer': '^1.0.0', 'a-peer': '^1.0.0' },
      versions({ 'z-peer': '2.0.0', 'a-peer': '2.0.0' }),
    )
    expect(out.map(m => m.spec)).toEqual(['a-peer', 'z-peer'])
  })

  it('resolves each declared peer once', () => {
    let calls = 0
    const counting = (spec: string): string | null => { calls += 1; return spec === '@deepseek-ai/cordis' ? '4.0.1' : null }
    peerVersionMismatches(DECLARED, counting)
    expect(calls).toBe(Object.keys(DECLARED).length)
  })
})

describe('peerVersionWarning', () => {
  it('says nothing when nothing is wrong', () => {
    expect(peerVersionWarning([])).toBeNull()
  })

  it('names the peer, its declared range and the version found', () => {
    expect(peerVersionWarning([
      { spec: '@deepseek-ai/dsh-app-boot', range: '^0.1.1-rc.2', found: '0.2.0-rc.1' },
    ])).toBe(
      'dsh-plugin-shop: the harness does not provide the peer versions this shop declares'
      + ' — @deepseek-ai/dsh-app-boot ^0.1.1-rc.2, found 0.2.0-rc.1.'
      + ' The shop still loads; if a path misbehaves, check this first.',
    )
  })

  it('names every mismatch in one message', () => {
    const message = peerVersionWarning([
      { spec: '@deepseek-ai/dsh-app-boot', range: '^0.1.1-rc.2', found: '0.2.0-rc.1' },
      { spec: '@deepseek-ai/dsh-home-paths', range: '^0.1.1-rc.2', found: '0.1.1-rc.1' },
    ])
    expect(message).toContain('@deepseek-ai/dsh-app-boot ^0.1.1-rc.2, found 0.2.0-rc.1')
    expect(message).toContain('@deepseek-ai/dsh-home-paths ^0.1.1-rc.2, found 0.1.1-rc.1')
  })
})

describe('createPeerVersionCheck', () => {
  it('warns once, however many times it is called', () => {
    const warnings: string[] = []
    const check = createPeerVersionCheck({
      ranges: { '@deepseek-ai/dsh-app-boot': '^0.1.1-rc.2' },
      resolve: versions({ '@deepseek-ai/dsh-app-boot': '0.2.0-rc.1' }),
      warn: message => warnings.push(message),
    })
    check()
    check()
    check()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('@deepseek-ai/dsh-app-boot ^0.1.1-rc.2, found 0.2.0-rc.1')
  })

  it('stays silent when every declared peer satisfies its range', () => {
    const warnings: string[] = []
    createPeerVersionCheck({
      ranges: DECLARED,
      resolve: versions(INSTALLED),
      warn: message => warnings.push(message),
    })()
    expect(warnings).toEqual([])
  })

  it('never throws when the resolver does', () => {
    const warnings: string[] = []
    const check = createPeerVersionCheck({
      ranges: DECLARED,
      resolve: () => { throw new Error('anchor unavailable') },
      warn: message => warnings.push(message),
    })
    expect(() => check()).not.toThrow()
    expect(warnings).toEqual([])
  })
})

describe('nodeVersionResolver', () => {
  it('reads the version out of a resolvable package manifest', () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'peerversion-'))
    try {
      const pkgDir = join(dir, 'node_modules', 'versioned-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'versioned-pkg', version: '0.1.2-rc.1' }))
      const resolveHere = nodeVersionResolver(pathToFileURL(join(dir, 'anchor.js')).href)
      expect(resolveHere('versioned-pkg')).toBe('0.1.2-rc.1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers null for a package that is not installed', () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'peerversion-'))
    try {
      const resolveHere = nodeVersionResolver(pathToFileURL(join(dir, 'anchor.js')).href)
      expect(resolveHere('genuinely-missing-pkg')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the version of a package that restricts ./package.json in its exports', () => {
    // This answered null while the lookup went through
    // require.resolve('<spec>/package.json'), which an exports map without a
    // "./package.json" key refuses with ERR_PACKAGE_PATH_NOT_EXPORTED. The
    // manifest is read directly now, so the version is there to read — and
    // a packaged dsh's module proxy (below) has exactly this shape.
    const dir = mkdtempSync(join(TEMP_ROOT, 'peerversion-'))
    try {
      const pkgDir = join(dir, 'node_modules', 'restricted-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'restricted-pkg', version: '1.0.0', main: 'index.js', exports: { '.': './index.js' } }),
      )
      writeFileSync(join(pkgDir, 'index.js'), '')
      const resolveHere = nodeVersionResolver(pathToFileURL(join(dir, 'anchor.js')).href)
      expect(resolveHere('restricted-pkg')).toBe('1.0.0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers null for a manifest that declares no version', () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'peerversion-'))
    try {
      const pkgDir = join(dir, 'node_modules', 'unversioned-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'unversioned-pkg' }))
      const resolveHere = nodeVersionResolver(pathToFileURL(join(dir, 'anchor.js')).href)
      expect(resolveHere('unversioned-pkg')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers null for a version that is not a non-empty string', () => {
    // `''` is the case a bare typeof check lets through: it is not semver,
    // so peerVersionMismatches would drop it anyway, but a resolver that
    // answers it is claiming a version nobody declared.
    const root = mkdtempSync(join(TEMP_ROOT, 'peerversion-shape-'))
    const resolveHere = nodeVersionResolver(pathToFileURL(join(root, 'anchor.js')).href)
    for (const [spec, version] of [['empty-version', ''], ['numeric-version', 7], ['null-version', null], ['array-version', ['1.0.0']]] as const) {
      installAt(root, spec, { name: spec, version })
      expect(resolveHere(spec), spec).toBeNull()
    }
    // A manifest that is JSON but not an object carries no version either.
    mkdirSync(join(root, 'node_modules', 'scalar-manifest'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'scalar-manifest', 'package.json'), 'null')
    expect(resolveHere('scalar-manifest')).toBeNull()
  })
})

// ── The node_modules lookup behind both resolvers, on a real filesystem ────
//
// This lookup is the one real-filesystem seam behind both peer verdicts, and
// the defects it replaced were all real-filesystem behaviour — a cache that
// outlived the disk, an exports map, links — so these cases run on real
// temporary directories rather than on a fake of one.
//
// Absence is asserted only for names chosen to be installed nowhere, because
// the walk climbs to the filesystem root and a temp directory's ancestors are
// not ours: the machine this was written on has a stray /tmp/node_modules
// holding @deepseek-ai/cordis and @deepseek-ai/dsh, which is why no case
// asserts a real harness name absent.

/** Writes `<root>/node_modules/<spec>/package.json`; returns the package directory. */
function installAt(root: string, spec: string, manifest: Record<string, unknown>): string {
  const dir = join(root, 'node_modules', ...spec.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  return dir
}

/** A directory link that needs no privilege on any runner: a junction on
 * Windows, where a directory symlink needs elevation or Developer Mode
 * (profile.test.ts measured the EPERM). Both follow the same way under stat. */
function linkDir(target: string, link: string): void {
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : undefined)
}

/** A DSH_HOME laid out the way dsh lays one out: the anchor is
 * `<home>/profiles/web/cordis.yml` as a file URL (what the gateway builds), and
 * `<home>/profiles/node_modules` is the link farm dsh-app-boot maintains. The
 * anchor file is never read, so it is not written. */
function dshHome(): { home: string; profiles: string; profile: string; anchor: string } {
  const home = mkdtempSync(join(TEMP_ROOT, 'home-'))
  const profiles = join(home, 'profiles')
  const profile = join(profiles, 'web')
  mkdirSync(profile, { recursive: true })
  return { home, profiles, profile, anchor: pathToFileURL(join(profile, 'cordis.yml')).href }
}

/** Like `installAt`, but a package Node can actually import: an ES module
 * whose `version` export repeats its manifest's, so an import names the copy
 * it loaded. */
function installModuleAt(root: string, spec: string, version: string): string {
  const dir = installAt(root, spec, { name: spec, version, type: 'module', main: 'index.js' })
  writeFileSync(join(dir, 'index.js'), `export const version = ${JSON.stringify(version)}\n`)
  return dir
}

/**
 * What Node's own ESM loader does with `import(spec)` from a module in `dir`:
 * the loaded copy's `version` export, or the import's error code. This is the
 * control every "the walk mirrors the ESM resolver" case measures itself
 * against, so the rule is read off the loader each run rather than trusted
 * from a comment. A child process, because vitest's own module runner stands
 * between a test and the loader this lookup copies.
 */
function esmImports(dir: string, spec: string): string {
  mkdirSync(dir, { recursive: true })
  const probe = join(dir, 'esm-probe.mjs')
  writeFileSync(probe, `import(${JSON.stringify(spec)}).then(m => console.log(m.version), e => console.log(e.code))\n`)
  const child = spawnSync(process.execPath, [probe], { encoding: 'utf8' })
  expect(child.status, child.stderr).toBe(0)
  return child.stdout.trim()
}

describe('peer lookup on a real filesystem', () => {
  it('reads the version out of a packaged dsh module proxy, whose exports hide ./package.json', () => {
    // Under a packaged dsh executable (`process.pkg`) dsh-app-boot fills the
    // link farm with ESM proxy packages instead of symlinks. This manifest is
    // the shape its ensureModuleProxy writes, field for field: `exports` maps
    // each proxied subpath to an entry file and filters "./package.json" out.
    // require.resolve('<spec>/package.json') therefore threw
    // ERR_PACKAGE_PATH_NOT_EXPORTED for every proxied peer — presence true,
    // version null, mismatches [] — so the load-time self-check could never
    // fire under a packaged dsh, whatever version the proxy carried.
    const { profiles, anchor } = dshHome()
    const target = 'file:///snapshot/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'
    const proxy = installAt(profiles, '@deepseek-ai/dsh-app-boot', {
      name: '@deepseek-ai/dsh-app-boot',
      version: '0.2.0-rc.1',
      private: true,
      type: 'module',
      exports: { '.': './entry-0.js' },
      dsh: { moduleFallback: { targets: { '.': target } } },
    })
    writeFileSync(
      join(proxy, 'entry-0.js'),
      `export * from ${JSON.stringify(target)}\nimport * as target from ${JSON.stringify(target)}\nexport default target.default\n`,
    )

    expect(nodeResolver(anchor)('@deepseek-ai/dsh-app-boot')).toBe(true)
    expect(nodeVersionResolver(anchor)('@deepseek-ai/dsh-app-boot')).toBe('0.2.0-rc.1')
    expect(peerVersionMismatches({ '@deepseek-ai/dsh-app-boot': '^0.1.1-rc.2' }, nodeVersionResolver(anchor)))
      .toEqual([{ spec: '@deepseek-ai/dsh-app-boot', range: '^0.1.1-rc.2', found: '0.2.0-rc.1' }])
  })

  it('reads the disk on every call, so an uninstalled peer stops resolving without a restart', () => {
    // Node caches a SUCCESSFUL CJS resolution for the life of the process
    // (`Module._pathCache`, keyed on request + lookup paths) and hands the
    // cached filename back without looking at the disk again; a failure is
    // not cached. Through require.resolve this read absent → false,
    // installed → true, uninstalled → STILL true (measured, Node 26.6.0), so
    // the plugins declaring a peer the reader had just removed stayed
    // unflagged until dsh restarted.
    const { profiles, anchor } = dshHome()
    const spec = 'dsh-peers-fixture-cycled'
    const presence = nodeResolver(anchor)
    expect(presence(spec)).toBe(false)

    const dir = installAt(profiles, spec, { name: spec, version: '1.0.0' })
    expect(presence(spec)).toBe(true)
    expect(nodeVersionResolver(anchor)(spec)).toBe('1.0.0')

    rmSync(dir, { recursive: true, force: true })
    expect(presence(spec)).toBe(false)
    // A resolver built after the uninstall, the way catalog() builds one, has
    // to agree: the cache was the process's, not the resolver's.
    expect(nodeResolver(anchor)(spec)).toBe(false)
    expect(nodeVersionResolver(anchor)(spec)).toBeNull()
  })

  it('treats a dangling link as absent', () => {
    // The link farm gains links and never loses them: an upgrade that drops
    // a package leaves its link behind, and 29 of 511 dangled on the machine
    // this was measured on. stat follows a link, so a link to nothing is
    // nothing. The live link beside it is the control: same helper, same
    // farm, and it resolves.
    const { home, profiles, anchor } = dshHome()
    const live = installAt(join(home, 'install'), 'dsh-peers-fixture-linked', { name: 'dsh-peers-fixture-linked', version: '1.0.0' })
    const gone = installAt(join(home, 'install'), 'dsh-peers-fixture-dangling', { name: 'dsh-peers-fixture-dangling', version: '1.0.0' })
    linkDir(live, join(profiles, 'node_modules', 'dsh-peers-fixture-linked'))
    linkDir(gone, join(profiles, 'node_modules', 'dsh-peers-fixture-dangling'))
    rmSync(gone, { recursive: true, force: true })

    expect(nodeResolver(anchor)('dsh-peers-fixture-linked')).toBe(true)
    expect(nodeResolver(anchor)('dsh-peers-fixture-dangling')).toBe(false)
    expect(nodeVersionResolver(anchor)('dsh-peers-fixture-dangling')).toBeNull()
  })

  it("finds a peer in an ancestor's node_modules — the link farm under $DSH_HOME/profiles", () => {
    // The production path for every harness package: the profile's own
    // node_modules holds only what pnpm installed there, and the rest comes
    // from one level up, through a link into the global dsh install.
    const { home, profiles, anchor } = dshHome()
    const spec = 'dsh-peers-fixture-farmed'
    linkDir(installAt(join(home, 'install'), spec, { name: spec, version: '3.1.4' }), join(profiles, 'node_modules', spec))

    expect(nodeResolver(anchor)(spec)).toBe(true)
    expect(nodeVersionResolver(anchor)(spec)).toBe('3.1.4')
  })

  it('looks a scoped name up under its scope directory', () => {
    const { profiles, anchor } = dshHome()
    installAt(profiles, '@dsh-peers-fixture/present', { name: '@dsh-peers-fixture/present', version: '2.0.0' })

    expect(nodeResolver(anchor)('@dsh-peers-fixture/present')).toBe(true)
    expect(nodeVersionResolver(anchor)('@dsh-peers-fixture/present')).toBe('2.0.0')
    // The scope directory exists; this package in it does not.
    expect(nodeResolver(anchor)('@dsh-peers-fixture/absent')).toBe(false)
    // Nor does this scope.
    expect(nodeResolver(anchor)('@dsh-peers-fixture-absent/present')).toBe(false)
    expect(nodeVersionResolver(anchor)('@dsh-peers-fixture/absent')).toBeNull()
  })

  it('gives no verdict for a name that is not a bare package name', () => {
    // Peer names are catalog input, and hostile. require.resolve resolved
    // '../x/package.json' RELATIVE to the profile and an absolute one as
    // itself, so a peer name could point the lookup at any path on the
    // reader's disk. Most probes below aim at something that EXISTS, for a
    // directory walk without the name check — a directory with a versioned
    // manifest outside every node_modules, the profile, the node_modules
    // directory itself, a scope directory, a nested directory, pnpm's own
    // store — so an answer of "present", or any version, would be the probe
    // working. None may be answered present OR missing.
    const { home, profile, anchor } = dshHome()
    mkdirSync(join(home, 'x'), { recursive: true })
    writeFileSync(join(home, 'x', 'package.json'), JSON.stringify({ name: 'x', version: '6.6.6' }))
    installAt(profile, '@scope/name', { name: '@scope/name', version: '1.0.0' })
    installAt(profile, '@/x', { name: '@/x', version: '1.0.0' })
    mkdirSync(join(profile, 'node_modules', 'a', 'b', 'c'), { recursive: true })
    writeFileSync(join(profile, 'node_modules', 'a', 'b', 'c', 'package.json'), JSON.stringify({ version: '1.0.0' }))
    mkdirSync(join(profile, 'node_modules', '.pnpm'), { recursive: true })

    const presence = nodeResolver(anchor)
    const version = nodeVersionResolver(anchor)
    const hostile = [
      '../x', '../../x', join(home, 'x'), '/abs', 'node:fs', 'a/b/c', 'a/b', '@scope', '@/x', '',
      'a\\b', '..', '.', '@scope/..', '.pnpm', '%2e%2e', 'a\0b',
    ]
    for (const spec of hostile) {
      expect(() => presence(spec), JSON.stringify(spec)).toThrow()
      expect(version(spec), JSON.stringify(spec)).toBeNull()
    }
    // And through the map: no verdict for the entry at all, so the peer that
    // really is missing beside it is not reported either.
    expect(incompatibilityMap(
      [{ source: 'npm', name: 'x', peers: ['dsh-peers-fixture-absent', '../x'] }],
      presence,
    )).toEqual({})
  })

  it('answers `constructor` and `__proto__` from the disk like any other name', () => {
    // The two names a lookup keyed on a plain object would answer from
    // Object.prototype instead of from the filesystem.
    const { profiles, anchor } = dshHome()
    expect(nodeResolver(anchor)('constructor')).toBe(false)
    expect(nodeResolver(anchor)('__proto__')).toBe(false)
    expect(nodeVersionResolver(anchor)('constructor')).toBeNull()
    expect(nodeVersionResolver(anchor)('__proto__')).toBeNull()

    installAt(profiles, 'constructor', { name: 'constructor', version: '1.0.0' })
    installAt(profiles, '__proto__', { name: '__proto__', version: '2.0.0' })
    expect(nodeResolver(anchor)('constructor')).toBe(true)
    expect(nodeResolver(anchor)('__proto__')).toBe(true)
    expect(nodeVersionResolver(anchor)('constructor')).toBe('1.0.0')
    expect(nodeVersionResolver(anchor)('__proto__')).toBe('2.0.0')
    expect(incompatibilityMap(
      [{ source: 'npm', name: 'x', peers: ['constructor', '__proto__', 'dsh-peers-fixture-absent'] }],
      nodeResolver(anchor),
    )).toEqual({ 'npm:x': ['dsh-peers-fixture-absent'] })
  })

  it('keeps walking past a node_modules that is a file and a candidate that is not a directory', () => {
    // ENOTDIR (a path component is a file) and a non-directory at the
    // candidate itself are both "no package here" to the ESM resolver, which
    // moves on to the next ancestor. Only a directory is a match.
    const root = mkdtempSync(join(TEMP_ROOT, 'walk-'))
    const spec = 'dsh-peers-fixture-walked'
    const deepest = join(root, 'a', 'b', 'c')
    mkdirSync(deepest, { recursive: true })
    writeFileSync(join(deepest, 'node_modules'), '')
    mkdirSync(join(root, 'a', 'b', 'node_modules'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'node_modules', spec), '')
    installAt(join(root, 'a'), spec, { name: spec, version: '4.0.0' })
    const anchor = pathToFileURL(join(deepest, 'cordis.yml')).href

    expect(nodeResolver(anchor)(spec)).toBe(true)
    expect(nodeVersionResolver(anchor)(spec)).toBe('4.0.0')
  })

  it('answers for the nearest copy — the one the loader imports — and never falls through past it', () => {
    // The profile's own copy shadows the link farm's, as it does for the
    // ESM resolver: the first ancestor holding the directory is the match.
    const { profiles, profile, anchor } = dshHome()
    const spec = 'dsh-peers-fixture-shadowed'
    installModuleAt(profiles, spec, '1.0.0')
    const local = installAt(profile, spec, { name: spec, version: '2.0.0' })
    expect(nodeVersionResolver(anchor)(spec)).toBe('2.0.0')

    // With its manifest gone the nearer directory is still the MATCH — the
    // loader stops there, so the farm's 1.0.0 is not the version it provides —
    // and the match is ABSENT: the import fails there with
    // ERR_MODULE_NOT_FOUND rather than falling through to the farm's
    // importable copy, which the control reads off Node itself. This read
    // `true` until 2026-09-25, when the walk counted any directory as a
    // package, manifest or not; the lookup before it
    // (require.resolve('<spec>/package.json')) had required the manifest, so a
    // plugin whose peer was left in this state lost its badge and still failed
    // to import.
    rmSync(join(local, 'package.json'))
    expect(esmImports(profile, spec)).toBe('ERR_MODULE_NOT_FOUND')
    expect(nodeResolver(anchor)(spec)).toBe(false)
    expect(nodeVersionResolver(anchor)(spec)).toBeNull()
    expect(packageDirectory(profile, spec)).toBeNull()

    // Removing the directory uncovers the farm's copy.
    rmSync(local, { recursive: true, force: true })
    expect(esmImports(profile, spec)).toBe('1.0.0')
    expect(nodeResolver(anchor)(spec)).toBe(true)
    expect(nodeVersionResolver(anchor)(spec)).toBe('1.0.0')
    expect(packageDirectory(profile, spec)).toBe(join(profiles, 'node_modules', spec))
  })

  it('reads a leftover directory holding only a nested node_modules as a missing peer', () => {
    // What an uninstall that stops part-way can leave behind (on Windows a
    // locked file is enough): `<profile>/node_modules/L/` with nothing in it
    // but its own nested `node_modules/`. The loader matches the directory and
    // fails there, so a plugin declaring L does not load — and until
    // 2026-09-25 this walk called L present, because any directory was a match
    // AND a package. The lookup before it asked for the manifest, and showed
    // "missing L"; so does this one again.
    const { profile, anchor } = dshHome()
    const spec = 'dsh-peers-fixture-leftover'
    mkdirSync(join(profile, 'node_modules', spec, 'node_modules', 'some-dependency'), { recursive: true })

    expect(esmImports(profile, spec)).toBe('ERR_MODULE_NOT_FOUND')
    expect(nodeResolver(anchor)(spec)).toBe(false)
    expect(nodeVersionResolver(anchor)(spec)).toBeNull()
    expect(incompatibilityMap([{ source: 'npm', name: 'B', peers: [spec] }], nodeResolver(anchor)))
      .toEqual({ 'npm:B': [spec] })
  })

  it('reads a match whose package.json is not a file as absent', () => {
    // Present means the match holds a manifest FILE, and a directory spelled
    // `package.json` is not one: nothing can read a version out of it.
    const { profile, anchor } = dshHome()
    const spec = 'dsh-peers-fixture-manifest-dir'
    mkdirSync(join(profile, 'node_modules', spec, 'package.json'), { recursive: true })

    expect(nodeResolver(anchor)(spec)).toBe(false)
    expect(nodeVersionResolver(anchor)(spec)).toBeNull()
  })

  // ELOOP, from a link to itself — a failure `stat` reports for a path that
  // may well name something, which is why this walk used to throw on it and
  // answer nothing. Node's reader does not care why a stat failed: anything
  // but "directory" is "not here, keep walking" (see `findPackageDir`), and
  // the control reads that off the loader. POSIX only: a Windows directory
  // symlink needs elevation, and what a junction cycle reports there is
  // unmeasured — the injected-fs cases below carry the same rule, ELOOP and
  // EACCES both, on every platform.
  it.skipIf(process.platform === 'win32')('keeps walking past a candidate that loops, to a real copy further up', () => {
    // Until 2026-09-25 this threw ELOOP, and `incompatibilityMap` turned the
    // throw into no verdict for every entry declaring the peer.
    const root = mkdtempSync(join(TEMP_ROOT, 'eloop-outer-'))
    const spec = 'dsh-peers-fixture-cycle-outer'
    installModuleAt(root, spec, '5.0.0')
    const inner = join(root, 'inner')
    const link = join(inner, 'node_modules', spec)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(link, link)
    const anchor = pathToFileURL(join(inner, 'cordis.yml')).href

    expect(esmImports(inner, spec)).toBe('5.0.0')
    expect(nodeResolver(anchor)(spec)).toBe(true)
    expect(nodeVersionResolver(anchor)(spec)).toBe('5.0.0')
  })

  it.skipIf(process.platform === 'win32')('reads a peer as missing when only a looping candidate stands in its way', () => {
    // The same loop with nothing further up: the peer is not installed, the
    // plugin fails to import, and the badge is the one true thing to say.
    // This used to be no verdict at all — one looping or unsearchable
    // `node_modules` on the path to the root silenced every missing-peer badge
    // in the catalog.
    const root = mkdtempSync(join(TEMP_ROOT, 'eloop-'))
    const spec = 'dsh-peers-fixture-cycle'
    const link = join(root, 'node_modules', spec)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(link, link)
    const anchor = pathToFileURL(join(root, 'cordis.yml')).href

    expect(esmImports(root, spec)).toBe('ERR_MODULE_NOT_FOUND')
    expect(nodeResolver(anchor)(spec)).toBe(false)
    expect(nodeVersionResolver(anchor)(spec)).toBeNull()
    expect(incompatibilityMap([{ source: 'npm', name: 'x', peers: [spec] }], nodeResolver(anchor)))
      .toEqual({ 'npm:x': [spec] })
  })

  it('does not search NODE_PATH, which the ESM loader never consults', () => {
    // The CJS lookup this replaced did, and pnpm's bin shims export one — this
    // suite's own vitest shim points it into the virtual store. CJS reads
    // NODE_PATH once, at process start, so the case runs in a child that
    // starts with it: CJS there finds the package through NODE_PATH (the
    // control), and the peer lookup must not.
    const root = mkdtempSync(join(TEMP_ROOT, 'node-path-'))
    const spec = 'dsh-peers-fixture-global'
    const global = join(root, 'global')
    mkdirSync(join(global, spec), { recursive: true })
    writeFileSync(join(global, spec, 'package.json'), JSON.stringify({ name: spec, version: '1.0.0' }))
    const anchor = pathToFileURL(join(root, 'profile', 'cordis.yml')).href
    const peers = new URL('../../src/host/peers.ts', import.meta.url).href
    const script = [
      `import { createRequire } from 'node:module'`,
      `const { nodeResolver, nodeVersionResolver } = await import(${JSON.stringify(peers)})`,
      `const cjs = createRequire(${JSON.stringify(anchor)}).resolve(${JSON.stringify(`${spec}/package.json`)})`,
      `console.log(JSON.stringify({ cjs: cjs.length > 0, present: nodeResolver(${JSON.stringify(anchor)})(${JSON.stringify(spec)}), version: nodeVersionResolver(${JSON.stringify(anchor)})(${JSON.stringify(spec)}) }))`,
    ].join('\n')
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, NODE_PATH: global },
      encoding: 'utf8',
    })

    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({ cjs: true, present: false, version: null })
  })

  it('takes its anchor the way createRequire did: a file URL or an absolute path', () => {
    const root = mkdtempSync(join(TEMP_ROOT, 'anchor-'))
    const spec = 'dsh-peers-fixture-anchored'
    installAt(root, spec, { name: spec, version: '1.2.3' })
    const file = join(root, 'cordis.yml')

    expect(nodeVersionResolver(pathToFileURL(file).href)(spec)).toBe('1.2.3')
    expect(nodeVersionResolver(file)(spec)).toBe('1.2.3')
    // A trailing separator names the directory itself, not a file in its
    // parent — so the walk starts inside it.
    expect(nodeVersionResolver(`${pathToFileURL(root).href}/`)(spec)).toBe('1.2.3')
    expect(nodeVersionResolver(`${root}${sep}`)(spec)).toBe('1.2.3')
    // Anything else throws at construction, which the gateway's call sites
    // already treat as "no anchor, no verdict".
    expect(() => nodeResolver('cordis.yml')).toThrow()
    expect(() => nodeVersionResolver('https://example.test/cordis.yml')).toThrow()
  })
})

describe('packageResolver and packageVersionResolver over an injected filesystem', () => {
  /** An errno error the way node:fs builds one. */
  const errno = (code: string, syscall: string, path: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, syscall, path })

  /** One entry of a fake filesystem: a directory, a file with contents, or a
   * path whose stat fails with `code`. */
  type FakeNode = 'dir' | { file: string } | { fails: string }

  /** A filesystem that holds exactly `nodes`; any other path is ENOENT. Stat
   * follows no links — a fake has none — and a read of a path that is not a
   * file fails the way node:fs fails it. `reads` records every read. */
  function fakeFs(nodes: Record<string, FakeNode>): PackageLookupFs & { reads: string[] } {
    const reads: string[] = []
    const at = (path: string): FakeNode | undefined => Object.hasOwn(nodes, path) ? nodes[path] : undefined
    return {
      reads,
      stat: path => {
        const node = at(path)
        if (node === undefined) throw errno('ENOENT', 'stat', path)
        if (typeof node === 'object' && 'fails' in node) throw errno(node.fails, 'stat', path)
        return { isDirectory: () => node === 'dir', isFile: () => node !== 'dir' }
      },
      readFile: path => {
        reads.push(path)
        const node = at(path)
        if (node === undefined) throw errno('ENOENT', 'open', path)
        if (typeof node === 'object' && 'fails' in node) throw errno(node.fails, 'open', path)
        if (node === 'dir') throw errno('EISDIR', 'read', path)
        return node.file
      },
    }
  }

  // The layout the defect was described with: a profile under the user's
  // home, a `~/node_modules` nobody can search (`sudo npm i` under umask 027
  // can make one) or one that loops, and — in half the cases — a real copy of
  // the peer further up, where the ESM loader, walking on past the failure,
  // finds and loads it (the real-filesystem ELOOP case above measures that).
  const profile = join(sep, 'home', 'u', '.dsh', 'profiles', 'web')
  const spec = 'dsh-peers-fixture'
  const unsearchable = join(sep, 'home', 'u', 'node_modules', spec)
  const outer = join(sep, 'node_modules', spec)

  it.each(['EACCES', 'ELOOP'])('keeps walking past a candidate whose stat fails with %s, to the copy further up', code => {
    // Until 2026-09-25 either code threw out of the walk, and the entry
    // declaring the peer got no verdict — a present peer with a readable
    // version the self-check could never read.
    const fs = fakeFs({
      [unsearchable]: { fails: code },
      [outer]: 'dir',
      [join(outer, 'package.json')]: { file: JSON.stringify({ name: spec, version: '9.9.9' }) },
    })
    expect(packageResolver(profile, fs)(spec)).toBe(true)
    expect(packageVersionResolver(profile, fs)(spec)).toBe('9.9.9')
    expect(packageDirectory(profile, spec, fs)).toBe(outer)
  })

  it.each(['EACCES', 'ELOOP'])('reads a peer as missing when a %s candidate is all the walk meets', code => {
    // The permission case cannot be staged on a real directory when the suite
    // runs as root, which reads through any mode bits. It used to throw here,
    // and `incompatibilityMap` turned the throw into no verdict — so one such
    // directory on the path to the root silenced every missing-peer badge,
    // while the plugins declaring those peers still failed to import.
    const fs = fakeFs({ [unsearchable]: { fails: code } })
    expect(packageResolver(profile, fs)(spec)).toBe(false)
    expect(packageVersionResolver(profile, fs)(spec)).toBeNull()
    expect(incompatibilityMap([{ source: 'npm', name: 'p', peers: [spec] }], packageResolver(profile, fs)))
      .toEqual({ 'npm:p': [spec] })
  })

  it('reads every candidate failing to stat as absent, never as a throw', () => {
    // Flipped on 2026-09-25: this asserted `toThrow(/EACCES/)` for the
    // resolver, and "no verdict" for the entry declaring the peer. It asserts
    // `false` now because the walk treats any stat failure as "not here, keep
    // walking", as Node's ESM resolver does (design
    // 2026-09-01-harness-compatibility section 9.5): the loader never asks
    // what a candidate it cannot stat holds, so neither may the lookup.
    // The same rule taken to its end: nothing on the filesystem can make the
    // lookup throw. Only a name that is not a bare package name still does
    // (the hostile-name case above).
    const denied: PackageLookupFs = {
      stat: path => { throw errno('EACCES', 'stat', path) },
      readFile: path => { throw errno('EACCES', 'open', path) },
    }
    expect(packageResolver(profile, denied)(spec)).toBe(false)
    expect(packageVersionResolver(profile, denied)(spec)).toBeNull()
  })

  it('keeps walking past a candidate that is a file', () => {
    // A FILE at `node_modules/<name>` is "not here" to the ESM resolver, which
    // moves on; only a directory is a match. (The real-filesystem twin above
    // covers the same shape on disk.)
    const fs = fakeFs({
      [join(profile, 'node_modules', spec)]: { file: '' },
      [outer]: 'dir',
      [join(outer, 'package.json')]: { file: JSON.stringify({ name: spec, version: '1.0.0' }) },
    })
    expect(packageVersionResolver(profile, fs)(spec)).toBe('1.0.0')
  })

  it('stops at the first match, and reads a match whose manifest cannot be stat-ed as absent', () => {
    // The manifest's own stat failing is absence too — present means a
    // `package.json` that stats as a FILE — and the copy further up stays
    // shadowed: the loader never falls through past a matched directory.
    const near = join(profile, 'node_modules', spec)
    const fs = fakeFs({
      [near]: 'dir',
      [join(near, 'package.json')]: { fails: 'EACCES' },
      [outer]: 'dir',
      [join(outer, 'package.json')]: { file: JSON.stringify({ name: spec, version: '1.0.0' }) },
    })
    expect(packageResolver(profile, fs)(spec)).toBe(false)
    expect(packageVersionResolver(profile, fs)(spec)).toBeNull()
    expect(packageDirectory(profile, spec, fs)).toBeNull()
  })

  it('never reads the manifest for presence, and answers null for one it cannot read', () => {
    // Presence stats the manifest and never opens it; only the version
    // resolver reads it. A manifest that stats as a file but cannot be read
    // is still a present package — whether the loader can use it is the
    // import's question — with no version anyone can read.
    const near = join(profile, 'node_modules', spec)
    const fs = fakeFs({ [near]: 'dir', [join(near, 'package.json')]: { file: '{}' } })
    const unreadable: PackageLookupFs & { reads: string[] } = {
      ...fs,
      readFile: path => { fs.reads.push(path); throw errno('EACCES', 'open', path) },
    }
    expect(packageResolver(profile, unreadable)(spec)).toBe(true)
    expect(fs.reads).toEqual([])
    expect(packageVersionResolver(profile, unreadable)(spec)).toBeNull()
    expect(fs.reads).toEqual([join(near, 'package.json')])
  })

  it('throws for a name that is not a bare package name, and for nothing else', () => {
    // `packageDirectory` is the lookup under both resolvers and the running
    // harness's app-boot read, so it carries the one throw the presence
    // resolver documents.
    const fs = fakeFs({})
    expect(() => packageDirectory(profile, '../x', fs)).toThrow(TypeError)
    expect(packageDirectory(profile, spec, fs)).toBeNull()
  })
})

describe('harnessPackageResolver and harnessPackageVersionResolver (dsh 0.1.7 pluginPackages)', () => {
  // dsh 0.1.7 keeps no link farm: it serves the installation's packages to a
  // profile through Node's module hooks, so a package it serves exists
  // nowhere the walk from the profile looks. Each case lays that out on a
  // real disk — the served copy under a separate "installation" directory,
  // the profile beside it with no link farm — and answers `packageOf` the way
  // the service does: the served package's manifest path, or undefined.
  // Every name is one installed nowhere else (see the note above
  // `installAt`), so the walk's false is this layout's, not the machine's.
  const served = '@dsh-peers-fixture/harness-only'

  function harnessServing(spec: string, version: string): { anchor: string; profile: string; manifestPath: string; lookup: HarnessPackageLookup & { asked: string[] } } {
    const { profile, anchor } = dshHome()
    const installation = mkdtempSync(join(TEMP_ROOT, 'installation-'))
    const manifestPath = join(installAt(installation, spec, { name: spec, version }), 'package.json')
    const asked: string[] = []
    const lookup = {
      asked,
      packageOf: (specifier: string, parentURL: string) => {
        asked.push(specifier)
        expect(parentURL).toBe(anchor)
        return specifier === spec ? { manifestPath } : undefined
      },
    }
    return { anchor, profile, manifestPath, lookup }
  }

  it('reads a package the harness serves as present where the walk finds nothing, and clears its badge', () => {
    // The defect as measured on 0.1.7-rc.2: the walk alone badged every
    // plugin declaring a harness package — 2,214 entries against 570 on
    // 0.1.5-rc.3 (design 2026-09-01-harness-compatibility §11).
    const { anchor, lookup } = harnessServing(served, '0.1.7-rc.2')
    const entries = [{ source: 'npm' as const, name: 'p', peers: [served] }]
    expect(nodeResolver(anchor)(served)).toBe(false)
    expect(incompatibilityMap(entries, nodeResolver(anchor))).toEqual({ 'npm:p': [served] })

    const resolve = harnessPackageResolver(nodeResolver(anchor), lookup, anchor)
    expect(resolve(served)).toBe(true)
    expect(incompatibilityMap(entries, resolve)).toEqual({})
  })

  it('still names a peer neither the harness nor the walk finds', () => {
    // The badge the change must keep: 0.1.7 removed packages 0.1.5 shipped
    // (`@deepseek-ai/dsh-agent-presets`, measured), and a plugin declaring one
    // is as broken as the badge says.
    const { anchor, lookup } = harnessServing(served, '0.1.7-rc.2')
    const missing = '@dsh-peers-fixture/served-by-nothing'
    const resolve = harnessPackageResolver(nodeResolver(anchor), lookup, anchor)
    expect(resolve(missing)).toBe(false)
    expect(incompatibilityMap([{ source: 'npm', name: 'p', peers: [served, missing] }], resolve))
      .toEqual({ 'npm:p': [missing] })
  })

  it('reads a peer the harness still names, but whose manifest is gone, as missing', () => {
    // The service remembers a package it found; the resolver stats the
    // manifest itself on every call, so an uninstall clears presence without
    // a restart (§9.4, the same rule the walk keeps).
    const { anchor, manifestPath, lookup } = harnessServing(served, '0.1.7-rc.2')
    const resolve = harnessPackageResolver(nodeResolver(anchor), lookup, anchor)
    expect(resolve(served)).toBe(true)
    rmSync(manifestPath)
    expect(resolve(served)).toBe(false)
  })

  it('falls back to the walk for a package the harness does not reach', () => {
    const { anchor, profile, lookup } = harnessServing(served, '0.1.7-rc.2')
    const local = '@dsh-peers-fixture/profile-local'
    installAt(profile, local, { name: local, version: '1.0.0' })
    expect(harnessPackageResolver(nodeResolver(anchor), lookup, anchor)(local)).toBe(true)
    expect(harnessPackageVersionResolver(nodeVersionResolver(anchor), lookup, anchor)(local)).toBe('1.0.0')
  })

  it('gives no verdict for a name that is not a bare package name, and never hands it to the harness', () => {
    const { anchor, lookup } = harnessServing(served, '0.1.7-rc.2')
    const resolve = harnessPackageResolver(nodeResolver(anchor), lookup, anchor)
    expect(() => resolve('../x')).toThrow(TypeError)
    expect(harnessPackageVersionResolver(nodeVersionResolver(anchor), lookup, anchor)('../x')).toBeNull()
    expect(incompatibilityMap([{ source: 'npm', name: 'p', peers: ['../x'] }], resolve)).toEqual({})
    expect(lookup.asked).toEqual([])
  })

  it('gives no verdict when the harness throws, rather than falling back to the walk', () => {
    // The walk alone is exactly what reads every served package as missing,
    // so a harness that cannot answer is silence, never the walk's accusation.
    const { anchor } = harnessServing(served, '0.1.7-rc.2')
    const broken: HarnessPackageLookup = { packageOf: () => { throw new Error('profile resolution: disposed') } }
    const resolve = harnessPackageResolver(nodeResolver(anchor), broken, anchor)
    expect(() => resolve(served)).toThrow('disposed')
    expect(incompatibilityMap([{ source: 'npm', name: 'p', peers: [served] }], resolve)).toEqual({})
    expect(harnessPackageVersionResolver(nodeVersionResolver(anchor), broken, anchor)(served)).toBeNull()
  })

  it('ignores an answer that carries no manifest path, and asks the walk', () => {
    const { anchor, profile } = harnessServing(served, '0.1.7-rc.2')
    const odd: HarnessPackageLookup = { packageOf: () => ({ manifestPath: 42 }) }
    expect(harnessPackageResolver(nodeResolver(anchor), odd, anchor)(served)).toBe(false)
    installAt(profile, served, { name: served, version: '2.0.0' })
    expect(harnessPackageResolver(nodeResolver(anchor), odd, anchor)(served)).toBe(true)
  })

  it('reads the version from the copy the harness reaches, never from another copy the walk finds', () => {
    // The self-check's input on 0.1.7: without the harness, the walk read no
    // version for any of the shop's own peers, and the check went silent.
    const { anchor, profile, manifestPath, lookup } = harnessServing(served, '0.1.7-rc.2')
    installAt(profile, served, { name: served, version: '9.9.9' })
    const version = harnessPackageVersionResolver(nodeVersionResolver(anchor), lookup, anchor)
    expect(version(served)).toBe('0.1.7-rc.2')

    // A manifest the harness names but nobody can parse is no version, not
    // the walk's 9.9.9.
    writeFileSync(manifestPath, '{ not json')
    expect(version(served)).toBeNull()
  })

  it("answers the walk's version when the harness reaches nothing", () => {
    const { anchor, profile } = harnessServing(served, '0.1.7-rc.2')
    const other = '@dsh-peers-fixture/walk-only'
    installAt(profile, other, { name: other, version: '3.1.0' })
    const none: HarnessPackageLookup = { packageOf: () => undefined }
    expect(harnessPackageVersionResolver(nodeVersionResolver(anchor), none, anchor)(other)).toBe('3.1.0')
    expect(harnessPackageVersionResolver(nodeVersionResolver(anchor), none, anchor)(served)).toBeNull()
  })
})

describe('ownPeerRanges', () => {
  it('reads the peer ranges this build actually declares', () => {
    // Keeps the DECLARED fixture above honest: a peer range that moves in
    // package.json fails here, which is the prompt to re-examine whether the
    // silent case above is still the shape that ships.
    expect(ownPeerRanges()).toEqual(DECLARED)
  })
})
