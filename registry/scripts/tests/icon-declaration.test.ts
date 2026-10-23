import { describe, expect, it } from 'vitest'
import { EXPORT_CONDITIONS, resolveExportsSubpath } from '../src/icon-declaration.ts'
import type { ResolvedSubpath } from '../src/icon-declaration.ts'

/** One resolution: what the manifest's `exports` is, which subpath is asked
 * for, and the answer. `exportsField` is `unknown` because it is untrusted
 * JSON from npm or GitHub, whatever shape an author wrote. */
type Row = [
  what: string,
  exportsField: unknown,
  subpath: './package.json' | './icon',
  expected: ResolvedSubpath | null,
]

describe('resolveExportsSubpath', () => {
  it.each<Row>([
    ['a package with no exports field resolves ./package.json to itself', undefined, './package.json', { path: 'package.json', via: 'exact' }],
    ['a package with no exports field exports no ./icon', undefined, './icon', null],
    ['an exports map listing only the root hides ./package.json', { '.': './index.js' }, './package.json', null],
    ['an explicit "./package.json" key exposes the manifest', { '.': './index.js', './package.json': './package.json' }, './package.json', { path: 'package.json', via: 'exact' }],
    ['a "./*" pattern reaches ./package.json, by way of the pattern', { './*': './*' }, './package.json', { path: 'package.json', via: 'pattern' }],
    ['a "./*" pattern reaches ./icon too, as a file with no extension', { './*': './*' }, './icon', { path: 'icon', via: 'pattern' }],
    ['an exact key beats a pattern that also matches', { './*': './dist/*', './icon': './icon.svg' }, './icon', { path: 'icon.svg', via: 'exact' }],
    ['of two matching patterns the longer prefix wins', { './*': './dist/*', './i*': './x/*.svg' }, './icon', { path: 'x/con.svg', via: 'pattern' }],
    ['a condition Node does not match is skipped, and default decides', { './icon': { types: './i.d.ts', default: './icon.svg' } }, './icon', { path: 'icon.svg', via: 'exact' }],
    ['conditions are read in the object\'s own order', { './icon': { import: './a.svg', require: './b.svg' } }, './icon', { path: 'a.svg', via: 'exact' }],
    ['an object matching no condition resolves nothing', { './icon': { require: './b.svg' } }, './icon', null],
    ['an array resolves to its first member', { './icon': ['./a.svg', './b.svg'] }, './icon', { path: 'a.svg', via: 'exact' }],
    ['a target outside the package does not resolve', { './icon': '../out.svg' }, './icon', null],
    ['a target not starting with "./" does not resolve', { './icon': 'icon.svg' }, './icon', null],
    ['a target that climbs out of the package does not resolve', { './icon': './a/../../x.svg' }, './icon', null],
    ['a null target excludes the subpath', { './icon': null }, './icon', null],
    ['a bare string is sugar for the root, so it exposes no subpath', './index.js', './package.json', null],
    ['a condition object at the top level is sugar for the root, so it exposes no subpath', { import: './index.js' }, './package.json', null],
  ])('%s', (_what, exportsField, subpath, expected) => {
    expect(resolveExportsSubpath(exportsField, subpath)).toEqual(expected)
  })
})

// The tables below go past the one above, to the rules of Node's
// PACKAGE_EXPORTS_RESOLVE that the shop's answer depends on and the first
// table does not reach. Every expected value was read off Node 26.6.0's own
// resolver (`import.meta.resolve` over a fixture package holding that
// `exports`), not off the specification's pseudocode: the two differ in small
// ways, and the shop has to agree with the resolver dsh asks. The one table
// that does not agree with it, on purpose, says so where it starts.

describe('resolveExportsSubpath: choosing a key', () => {
  it.each<Row>([
    ['an exact key resolving to null excludes the subpath, though a pattern matches', { './*': './*', './icon': null }, './icon', null],
    ['the exclusion of one subpath leaves the others to the pattern', { './*': './*', './icon': null }, './package.json', { path: 'package.json', via: 'pattern' }],
    ['an exact key whose conditions all miss does not fall back to a pattern', { './icon': { require: './b.svg' }, './*': './dist/*' }, './icon', null],
    ['only the best matching pattern is tried, so a null there excludes', { './*': './dist/*', './i*': null }, './icon', null],
    ['patterns of equal prefix rank by the longer key, whatever their order', { './i*n': './b/*', './i*': './a/*' }, './icon', { path: 'b/co', via: 'pattern' }],
    // `./*.json` is longer than `./icon`, so it could never match it; the
    // suffix has to be short enough for the length not to settle the question.
    ['a pattern needs its suffix to match', { './*x': './dist/*' }, './icon', null],
    ['a pattern with a suffix puts only what the star matched into the target', { './*.json': './meta/*.json' }, './package.json', { path: 'meta/package.json', via: 'pattern' }],
    ['a star matches at least one character', { './icon*': './x/*.svg' }, './icon', null],
    ['a key with two stars is not a pattern', { './i*c*': './x.svg', './*': './dist/*' }, './icon', { path: 'dist/icon', via: 'pattern' }],
    ['every star in the target is replaced', { './*': './*/*.svg' }, './icon', { path: 'icon/icon.svg', via: 'pattern' }],
  ])('%s', (_what, exportsField, subpath, expected) => {
    expect(resolveExportsSubpath(exportsField, subpath)).toEqual(expected)
  })
})

describe('resolveExportsSubpath: resolving a target', () => {
  it.each<Row>([
    ['conditions nest, each level deciding for the next', { './icon': { node: { import: { default: './n.svg' } } } }, './icon', { path: 'n.svg', via: 'exact' }],
    ['a condition resolving to nothing moves on to the next', { './icon': { import: { require: './x.svg' }, default: './d.svg' } }, './icon', { path: 'd.svg', via: 'exact' }],
    ['a condition holding null stops the search', { './icon': { import: null, default: './d.svg' } }, './icon', null],
    ['a condition holding an invalid target stops the search', { './icon': { import: 'icon.svg', default: './d.svg' } }, './icon', null],
    ['an array moves past a null member', { './icon': [null, './b.svg'] }, './icon', { path: 'b.svg', via: 'exact' }],
    ['an array moves past an invalid member', { './icon': ['icon.svg', './b.svg'] }, './icon', { path: 'b.svg', via: 'exact' }],
    ['an array moves past a member whose conditions all miss', { './icon': [{ require: './x.svg' }, './b.svg'] }, './icon', { path: 'b.svg', via: 'exact' }],
    ['an array whose members all miss lets the enclosing condition object go on', { './icon': { import: [{ require: './x.svg' }], default: './d.svg' } }, './icon', { path: 'd.svg', via: 'exact' }],
    ['an array that held a null and resolved nothing stops the enclosing object', { './icon': { import: [null, { require: './x.svg' }], default: './d.svg' } }, './icon', null],
    ['an array stops at the first member that resolves, whatever follows it', { './icon': ['./b.svg', { 0: './x.svg' }] }, './icon', { path: 'b.svg', via: 'exact' }],
    ['an array does not move past an invalid configuration', { './icon': [{ 0: './x.svg' }, './b.svg'] }, './icon', null],
    ['an empty array excludes the subpath', { './icon': [] }, './icon', null],
    ['an empty array is a null, not a miss: it stops an enclosing condition object', { './icon': { import: [], default: './d.svg' } }, './icon', null],
    ['a number is no target', { './icon': 7 }, './icon', null],
  ])('%s', (_what, exportsField, subpath, expected) => {
    expect(resolveExportsSubpath(exportsField, subpath)).toEqual(expected)
  })

  // The field is untrusted JSON and the resolver recurses over it. Nothing
  // real nests past a handful of levels; a hostile manifest can nest as deep
  // as its size allows, and an unbounded recursion would throw out of this
  // pure function and take the catalog build with it.
  it.each([
    ['conditions', (inner: unknown) => ({ default: inner })],
    ['arrays', (inner: unknown) => [inner]],
  ])('resolves nothing, and does not overflow the stack, for %s nested far deeper than any map', (_kind, wrap) => {
    let target: unknown = './deep.svg'
    for (let level = 0; level < 100_000; level++) target = wrap(target)
    expect(resolveExportsSubpath({ './icon': target }, './icon')).toBeNull()
  })

  it('matches the conditions Node 26 matches by default, and no others', () => {
    expect(EXPORT_CONDITIONS).toEqual(new Set(['node', 'node-addons', 'import', 'module-sync', 'default']))
    for (const condition of ['node', 'node-addons', 'import', 'module-sync']) {
      expect(resolveExportsSubpath({ './icon': { [condition]: './hit.svg', default: './miss.svg' } }, './icon'))
        .toEqual({ path: 'hit.svg', via: 'exact' })
    }
    for (const condition of ['require', 'browser', 'types', 'development']) {
      expect(resolveExportsSubpath({ './icon': { [condition]: './miss.svg', default: './hit.svg' } }, './icon'))
        .toEqual({ path: 'hit.svg', via: 'exact' })
    }
  })
})

describe('resolveExportsSubpath: paths Node refuses', () => {
  it.each<Row>([
    // Node reads the segments of the target as written, before anything is
    // collapsed: `a/../x.svg` stays inside the package and is refused anyway.
    ['a ".." segment refuses the target even when it stays inside the package', { './icon': './a/../x.svg' }, './icon', null],
    ['a "." segment refuses the target', { './icon': './a/./x.svg' }, './icon', null],
    ['a node_modules segment refuses the target, in any case', { './icon': './Node_Modules/x.svg' }, './icon', null],
    ['a segment spelled with percent escapes is refused like the plain one', { './icon': './%2e%2e/x.svg' }, './icon', null],
    ['an escaped node_modules is refused too', { './icon': './%4eode_modules/x.svg' }, './icon', null],
    ['escapes are read whichever case their hex digits are in', { './icon': './%2E%2e/x.svg' }, './icon', null],
    ['node_modules and dots inside a longer segment are not refused', { './icon': './node_modules_x/..x/.y/icon.svg' }, './icon', { path: 'node_modules_x/..x/.y/icon.svg', via: 'exact' }],
    ['a backslash separates segments, so it cannot hide a ".." either', { './icon': './a\\..\\x.svg' }, './icon', null],
    ['a backslash comes out as a slash', { './icon': './a\\x.svg' }, './icon', { path: 'a/x.svg', via: 'exact' }],
    ['empty segments collapse into one separator, and never leave a leading slash', { './icon': './/a//x.svg' }, './icon', { path: 'a/x.svg', via: 'exact' }],
    ['a target naming the package directory resolves to the empty path', { './icon': './' }, './icon', { path: '', via: 'exact' }],
    ['a "." segment in what a star matched refuses the target', { './package*json': './x/*' }, './package.json', null],
    // Node refuses an escaped slash or backslash after it has chosen the
    // member, so an array does not move on to the next one.
    ['an escaped slash ends the array: the member Node chose was refused, so no later one stands in', { './icon': ['./a%2Fb.svg', './b.svg'] }, './icon', null],
  ])('%s', (_what, exportsField, subpath, expected) => {
    expect(resolveExportsSubpath(exportsField, subpath)).toEqual(expected)
  })

  it.each(['%2F', '%2f', '%5C', '%5c'])('refuses a target holding the escaped separator %s', (escape) => {
    expect(resolveExportsSubpath({ './icon': `./a${escape}b.svg` }, './icon')).toBeNull()
  })
})

// The rows above are Node's answers. Most of the ones below are not, and are
// meant not to be. Node checks the segments of a target and of what its star
// matched, separately, and then substitutes without looking again. With a key
// such as `.*` the star's match starts with a slash, so a target segment like
// `..*` is clean as written and becomes `..` once filled in: Node resolves
// `{ '.*': './..*' }` to a file outside the package. `exports` is hostile
// input and `path` drives reads and keys further on, so the shop holds the
// path that comes out to the rule it holds the target to, and refuses where
// Node resolves. The one row that is Node's answer too is marked as the
// contrast.

describe('resolveExportsSubpath: the path that comes out', () => {
  it.each<Row>([
    ['a star can compose a ".." that climbs out of the package, and the path is refused', { '.*': './..*' }, './icon', null],
    ['the composed ".." is refused wherever the target goes on from it', { '.*': './..*/x.svg' }, './icon', null],
    ['a star can compose a node_modules segment, which is refused', { './ic*n': './n*de_modules/x.svg' }, './icon', null],
    ['a star can compose a percent-escaped ".." too', { '.*': './%2e%2e*' }, './icon', null],
    ['and an escaped node_modules', { './ic*n': './%4e*de_modules/x.svg' }, './icon', null],
    ['a star can compose an escaped separator out of two clean halves', { './i*on': './..%5*' }, './icon', null],
    ['a member refused after its star was filled in ends the array: no later member stands in', { '.*': ['./..*', './x*'] }, './icon', null],
    // The contrast: a composed `..` that is cancelled by a directory before it
    // leaves nothing to refuse, and Node resolves it to the same file.
    ['a composed ".." that stays inside the package normalises away and is not refused', { '.*': './a/..*' }, './icon', { path: 'icon', via: 'pattern' }],
    ['a composed escaped ".." is refused though it would stay inside: it is spelled as a segment to refuse', { '.*': './a/%2e%2e*' }, './icon', null],
  ])('%s', (_what, exportsField, subpath, expected) => {
    expect(resolveExportsSubpath(exportsField, subpath)).toEqual(expected)
  })
})

describe('resolveExportsSubpath: the field itself', () => {
  it.each<Row>([
    ['an array at the top level is sugar for the root, so it exposes no subpath', ['./index.js'], './package.json', null],
    ['an empty exports object exposes nothing', {}, './package.json', null],
    ['a map mixing subpath keys and condition keys is invalid, so nothing resolves', { './package.json': './package.json', import: './x.js' }, './package.json', null],
    ['a condition object with an array-index key is invalid', { './icon': { 0: './x.svg', default: './d.svg' } }, './icon', null],
    ['a null exports field is no field', null, './package.json', { path: 'package.json', via: 'exact' }],
    ['an exports field that is not a string, array or object is no field either', false, './package.json', { path: 'package.json', via: 'exact' }],
    ['a field Node ignores exports no ./icon either', 5, './icon', null],
  ])('%s', (_what, exportsField, subpath, expected) => {
    expect(resolveExportsSubpath(exportsField, subpath)).toEqual(expected)
  })
})
