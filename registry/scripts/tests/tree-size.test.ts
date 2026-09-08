import { describe, expect, it } from 'vitest'
import { treeInstallSize } from '../src/tree-size.ts'

/** A git tree response as the API answers it: blobs carry `size`, directories
 * do not, and a submodule is a `commit` entry with no size at all. */
function tree(entries: { path: string; type?: string; size?: unknown }[], truncated = false): unknown {
  return { truncated, tree: entries.map(e => ({ path: e.path, type: e.type ?? 'blob', ...(e.size !== undefined ? { size: e.size } : {}) })) }
}

describe('treeInstallSize', () => {
  it('sums every blob in the tree for a root entry', () => {
    expect(treeInstallSize(tree([
      { path: 'package.json', size: 348 },
      { path: 'client.js', size: 43511 },
      { path: 'README.md', size: 4642 },
    ]))).toBe(48501)
  })

  it('counts only blobs — a directory and a submodule carry no installable bytes', () => {
    expect(treeInstallSize(tree([
      { path: 'src', type: 'tree' },
      { path: 'vendor/dep', type: 'commit' },
      { path: 'src/index.ts', size: 100 },
    ]))).toBe(100)
  })

  it('scopes to the subdirectory when the entry is a monorepo subpackage', () => {
    // Measured on xiaohj233/dsh-compat-shims: the subdir is 9.3% of the repo,
    // so charging the whole tree to it would overstate by more than 10x.
    expect(treeInstallSize(tree([
      { path: 'package.json', size: 500 },
      { path: 'packages/keyboard-guard/package.json', size: 300 },
      { path: 'packages/keyboard-guard/index.js', size: 20060 },
      { path: 'packages/other/index.js', size: 999999 },
    ]), 'packages/keyboard-guard')).toBe(20360)
  })

  it('does not treat a sibling with a shared name prefix as inside the subdirectory', () => {
    expect(treeInstallSize(tree([
      { path: 'packages/foo/index.js', size: 10 },
      { path: 'packages/foo-bar/index.js', size: 7000 },
    ]), 'packages/foo')).toBe(10)
  })

  it('accepts a subdirectory written with a trailing slash', () => {
    expect(treeInstallSize(tree([{ path: 'packages/foo/index.js', size: 10 }]), 'packages/foo/')).toBe(10)
  })

  // A truncated tree hides blobs, and every hidden blob is bytes the reader
  // WILL download. A low figure is worse than none: it renders under a label
  // saying how much installing costs, and understates it silently.
  it('yields no size at all when the tree was truncated', () => {
    expect(treeInstallSize(tree([{ path: 'a.js', size: 10 }], true))).toBeUndefined()
  })

  it('yields no size when a subdirectory matches nothing', () => {
    // Zero would render as "0 B" — a claim that installing costs nothing.
    expect(treeInstallSize(tree([{ path: 'src/index.ts', size: 10 }]), 'packages/gone')).toBeUndefined()
  })

  // GitHub is untrusted input like npm: these reach a published artifact.
  it('yields no size when any blob size is not a safe non-negative integer', () => {
    expect(treeInstallSize(tree([{ path: 'a.js', size: 10 }, { path: 'b.js', size: 'big' }]))).toBeUndefined()
    expect(treeInstallSize(tree([{ path: 'a.js', size: -1 }]))).toBeUndefined()
    expect(treeInstallSize(tree([{ path: 'a.js', size: 1.5 }]))).toBeUndefined()
    expect(treeInstallSize(tree([{ path: 'a.js', size: Number.MAX_SAFE_INTEGER }, { path: 'b.js', size: 1 }]))).toBeUndefined()
  })

  it('yields no size when a blob carries no size field', () => {
    expect(treeInstallSize(tree([{ path: 'a.js', size: 10 }, { path: 'b.js' }]))).toBeUndefined()
  })

  it('yields no size for a malformed or empty body', () => {
    expect(treeInstallSize(undefined)).toBeUndefined()
    expect(treeInstallSize({})).toBeUndefined()
    expect(treeInstallSize({ tree: 'not an array' })).toBeUndefined()
    expect(treeInstallSize(tree([]))).toBeUndefined()
  })

  it('treats an absent truncated flag as not truncated', () => {
    // The pre-`recursive` body shape carries no flag. Refusing on absence
    // would withhold the size of every tree that answers without one.
    expect(treeInstallSize({ tree: [{ path: 'a.js', type: 'blob', size: 10 }] })).toBe(10)
  })

  it('yields no size when the truncated flag itself is malformed', () => {
    // Absent means false, but a non-boolean is a shape we do not understand,
    // and guessing "not truncated" is the guess that publishes an undercount.
    expect(treeInstallSize({ truncated: 'yes', tree: [{ path: 'a.js', type: 'blob', size: 10 }] })).toBeUndefined()
  })
})
