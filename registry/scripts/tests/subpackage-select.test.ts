import { describe, expect, it } from 'vitest'
import { hasWorkspaceDeps, MAX_SUBPACKAGES, monorepoSignal, selectSubpackagePaths } from '../src/subpackage-select.ts'

describe('monorepoSignal', () => {
  it('flags a private root and a workspaces declaration', () => {
    expect(monorepoSignal({ private: true })).toBe(true)
    expect(monorepoSignal({ workspaces: ['packages/*'] })).toBe(true)
    expect(monorepoSignal({ name: 'plain-package' })).toBe(false)
    expect(monorepoSignal({})).toBe(false)
  })
})

describe('hasWorkspaceDeps', () => {
  it('sees workspace: specifiers in every dependency section', () => {
    expect(hasWorkspaceDeps({ dependencies: { core: 'workspace:*' } })).toBe(true)
    expect(hasWorkspaceDeps({ devDependencies: { tooling: 'workspace:^1.0.0' } })).toBe(true)
    expect(hasWorkspaceDeps({ peerDependencies: { shared: 'workspace:*' } })).toBe(true)
    expect(hasWorkspaceDeps({ optionalDependencies: { opt: 'workspace:*' } })).toBe(true)
  })

  it('ignores plain semver and non-string values', () => {
    expect(hasWorkspaceDeps({ dependencies: { core: '^1.0.0', meta: 42 } })).toBe(false)
    expect(hasWorkspaceDeps({})).toBe(false)
  })
})

describe('selectSubpackagePaths', () => {
  const tree = [
    'package.json',
    'packages/core/package.json',
    'packages/plugin-one/package.json',
    'packages/plugin-two/package.json',
    'packages/examples/demo/package.json',
    'packages/plugin-one/node_modules/x/package.json',
    'docs/package.json',
    'src/package.json',
  ]

  it('follows the workspaces globs when declared', () => {
    const paths = selectSubpackagePaths({ workspaces: ['packages/*'] }, tree)
    expect(paths).toEqual(['packages/core', 'packages/plugin-one', 'packages/plugin-two'])
  })

  it('falls back to the packages/* convention without a declaration', () => {
    expect(selectSubpackagePaths({}, tree)).toEqual(['packages/core', 'packages/plugin-one', 'packages/plugin-two'])
  })

  it('excludes examples, docs, node_modules, and the root manifest', () => {
    const paths = selectSubpackagePaths({ workspaces: ['packages/*', 'docs/*'] }, tree)
    expect(paths).not.toContain('packages/examples/demo')
    expect(paths).not.toContain('packages/plugin-one/node_modules/x')
    expect(paths).not.toContain('docs')
    expect(paths).not.toContain('')
  })

  it('caps at MAX_SUBPACKAGES, sorted', () => {
    const many = Array.from({ length: 20 }, (_, i) => `packages/pkg-${String(i).padStart(2, '0')}/package.json`)
    const paths = selectSubpackagePaths({}, ['package.json', ...many])
    expect(paths).toHaveLength(MAX_SUBPACKAGES)
    expect(paths[0]).toBe('packages/pkg-00')
  })

  it('does not let one package nested manifests displace its siblings', () => {
    // The regex was anchored only at the start, so `packages/*` matched
    // `packages/a/lib0` too: seven nested manifests filled the cap of 8 and
    // the real siblings never got probed.
    // `packages/a` needs its OWN manifest to be the package whose nested
    // manifests do the displacing. Without it the old code matched nine dirs,
    // not ten, and only `packages/zeta-plugin` fell off the cap — which is not
    // the defect B-7 describes.
    const nested = [
      'package.json',
      'packages/a/package.json',
      ...Array.from({ length: 7 }, (_, i) => `packages/a/lib${i}/package.json`),
      'packages/b/package.json',
      'packages/zeta-plugin/package.json',
    ]
    const paths = selectSubpackagePaths({ workspaces: ['packages/*'] }, nested)
    expect(paths).toEqual(['packages/a', 'packages/b', 'packages/zeta-plugin'])
  })

  it('honours a literal workspaces entry instead of dropping it', () => {
    // `workspaces: ['packages/core', 'tools/*']` is a real declaration. The
    // literal entry was filtered out for containing no `*`, and when every
    // entry was literal the repo fell back to `packages/*` and found nothing.
    const paths = selectSubpackagePaths(
      { workspaces: ['packages/core', 'tools/*'] },
      ['package.json', 'packages/core/package.json', 'packages/other/package.json', 'tools/cli/package.json'],
    )
    expect(paths).toEqual(['packages/core', 'tools/cli'])
  })

  it('supports a ** glob at any depth', () => {
    const paths = selectSubpackagePaths(
      { workspaces: ['packages/**'] },
      ['package.json', 'packages/a/package.json', 'packages/group/b/package.json'],
    )
    expect(paths).toEqual(['packages/a', 'packages/group/b'])
  })

  it('falls back to the convention when no entry yields a matcher', () => {
    const paths = selectSubpackagePaths(
      { workspaces: ['!(vendor)/*'] },
      ['package.json', 'packages/a/package.json'],
    )
    expect(paths).toEqual(['packages/a'])
  })

  it('reads the object form and tolerates a leading ./ and a trailing slash', () => {
    const paths = selectSubpackagePaths(
      { workspaces: { packages: ['./packages/*/'] } },
      ['package.json', 'packages/a/package.json', 'packages/a/nested/package.json'],
    )
    expect(paths).toEqual(['packages/a'])
  })
})

describe('a manifest that is not an object', () => {
  // All three of these take `unknown` and promise a boolean or an array, so
  // each has to be total for its declared input. Each did `manifest as {...}`
  // and then read a property, which throws on `null` — and `null` is legal
  // JSON, so a package.json of exactly those four bytes reaches them. Nothing
  // in the harvest caught it: one public repo could end the daily build.
  for (const manifest of [null, undefined, 123, 'a string', true] as unknown[]) {
    const label = JSON.stringify(manifest) ?? 'undefined'

    it(`monorepoSignal is false for ${label}`, () => {
      expect(monorepoSignal(manifest)).toBe(false)
    })

    it(`hasWorkspaceDeps is false for ${label}`, () => {
      expect(hasWorkspaceDeps(manifest)).toBe(false)
    })

    it(`selectSubpackagePaths returns nothing for ${label}`, () => {
      // An array root has no `workspaces`, so the convention glob applies and
      // a matching tree path would still be selected; a non-object root
      // declares no workspaces at all and selects by convention too. What
      // matters here is that it answers instead of throwing.
      expect(() => selectSubpackagePaths(manifest, ['packages/a/package.json'])).not.toThrow()
    })
  }
})
