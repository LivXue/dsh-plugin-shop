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
