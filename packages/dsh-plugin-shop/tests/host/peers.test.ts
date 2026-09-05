import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createPeerVersionCheck,
  incompatibilityMap,
  nodeResolver,
  nodeVersionResolver,
  peerVersionMismatches,
  peerVersionWarning,
  type PeerVersionResolver,
} from '../../src/host/peers.ts'
import { ownPeerRanges } from '../../src/own-version.ts'

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
    const dir = mkdtempSync(join(tmpdir(), 'noderesolver-'))
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

      // The directory was found; an exports restriction only hides the
      // package.json subpath and does not mean the peer is absent.
      expect(resolveHere('restricted-pkg')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps a genuinely missing sibling's verdict beside a restricted package", () => {
    const dir = mkdtempSync(join(tmpdir(), 'noderesolver-pair-'))
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

  it('still throws for a resolution failure that is neither of those', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noderesolver-invalid-'))
    try {
      const pkgDir = join(dir, 'node_modules', 'invalid-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), '{not valid json')
      const throwing = nodeResolver(pathToFileURL(join(dir, 'anchor.js')).href)
      // A malformed package manifest is neither absent nor an exports
      // restriction, so the resolver must keep surfacing the unknown failure.
      expect(() => throwing('invalid-pkg')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still returns false for genuinely missing packages in the same directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noderesolver-'))
    try {
      const resolveHere = nodeResolver(pathToFileURL(join(dir, 'anchor.js')).href)

      // Must return false because package does not exist at all — only
      // MODULE_NOT_FOUND is silently converted to false; other errors throw.
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

/** A resolver over a fixed table: a name the table does not carry yields no
 * version, which is the no-verdict signal (absence is not a violation). */
const versions = (table: Record<string, string>): PeerVersionResolver =>
  spec => table[spec] ?? null

describe('peerVersionMismatches', () => {
  it('is silent for the versions installed today: 0.1.2-rc.1 against ^0.1.1-rc.2', () => {
    // The real shape. The harness ships nothing but -rc versions, so strict
    // semver calls every one of these a violation and this test is what fails
    // if the comparison ever regresses to strict mode.
    expect(peerVersionMismatches(DECLARED, versions({
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/cordis-plugin-include': '1.0.6',
      '@deepseek-ai/dsh-app-boot': '0.1.2-rc.1',
      '@deepseek-ai/dsh-home-paths': '0.1.2-rc.1',
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
      resolve: versions({
        '@deepseek-ai/cordis': '4.0.1',
        '@deepseek-ai/cordis-plugin-include': '1.0.6',
        '@deepseek-ai/dsh-app-boot': '0.1.2-rc.1',
        '@deepseek-ai/dsh-home-paths': '0.1.2-rc.1',
        '@deepseek-ai/dsh-typert-protocol': '0.1.2-rc.1',
      }),
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
    const dir = mkdtempSync(join(tmpdir(), 'peerversion-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'peerversion-'))
    try {
      const resolveHere = nodeVersionResolver(pathToFileURL(join(dir, 'anchor.js')).href)
      expect(resolveHere('genuinely-missing-pkg')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers null for a package that restricts ./package.json in its exports', () => {
    // nodeResolver rethrows here because `false` would be an accusation of
    // absence; there is no version to read either way, and null already means
    // no verdict, so this resolver simply answers null.
    const dir = mkdtempSync(join(tmpdir(), 'peerversion-'))
    try {
      const pkgDir = join(dir, 'node_modules', 'restricted-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'restricted-pkg', version: '1.0.0', main: 'index.js', exports: { '.': './index.js' } }),
      )
      writeFileSync(join(pkgDir, 'index.js'), '')
      const resolveHere = nodeVersionResolver(pathToFileURL(join(dir, 'anchor.js')).href)
      expect(resolveHere('restricted-pkg')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers null for a manifest that declares no version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'peerversion-'))
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
})

describe('ownPeerRanges', () => {
  it('reads the peer ranges this build actually declares', () => {
    // Keeps the DECLARED fixture above honest: a peer range that moves in
    // package.json fails here, which is the prompt to re-examine whether the
    // silent case above is still the shape that ships.
    expect(ownPeerRanges()).toEqual(DECLARED)
  })
})
