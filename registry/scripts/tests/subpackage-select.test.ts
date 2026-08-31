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
