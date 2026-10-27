import { describe, expect, it } from 'vitest'
import {
  EXPORT_CONDITIONS,
  ICON_MEDIA_TYPES,
  MAX_FILES_MATCH_STEPS,
  MAX_ICON_PATH_LENGTH,
  fileListIncludes,
  iconDetail,
  iconLabel,
  readIconDeclaration,
  resolveExportsSubpath,
  shownPath,
} from '../src/icon-declaration.ts'
import type { IconMediaType, IconRead, ResolvedSubpath } from '../src/icon-declaration.ts'

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

// Everything above is the resolver. What follows reads a whole manifest the way
// dsh 0.2.1's `readPluginMeta` and `iconOf` do (dsh-app-boot,
// lib/types/package-meta.js): which file dsh takes for the manifest, whether it
// reads the `icon` field or the `./icon` export, and whether what it finds is
// a path it would accept.

const ICON_LABEL = 'package.json "icon"'
const EXPORT_LABEL = 'the "./icon" export'

const none: IconRead = { kind: 'none' }
const declared = (source: 'icon' | 'export', path: string, mediaType: IconMediaType): IconRead => ({
  kind: 'declared',
  declaration: { source, path, mediaType },
})
const refused = (detail: string): IconRead => ({ kind: 'refused', detail })
const detailOf = (read: IconRead): string => {
  if (read.kind !== 'refused') throw new Error(`expected a refusal, read ${read.kind}`)
  return read.detail
}

type ReadRow = [what: string, manifest: unknown, expected: IconRead]

describe('readIconDeclaration: the icon field', () => {
  it.each<ReadRow>([
    ['a relative path is declared, normalised', { icon: './assets/icon.svg' }, declared('icon', 'assets/icon.svg', 'image/svg+xml')],
    // dsh lower-cases the extension to choose the type and reads the file by
    // its own name, so the path keeps the case it was written in.
    ['an upper-case extension chooses the type, and the path keeps its case', { icon: 'Icon.SVG' }, declared('icon', 'Icon.SVG', 'image/svg+xml')],
    ['a png', { icon: 'icon.png' }, declared('icon', 'icon.png', 'image/png')],
    ['a jpg', { icon: 'icon.jpg' }, declared('icon', 'icon.jpg', 'image/jpeg')],
    ['a jpeg', { icon: 'img/icon.JPEG' }, declared('icon', 'img/icon.JPEG', 'image/jpeg')],
    ['a webp', { icon: 'icon.WebP' }, declared('icon', 'icon.WebP', 'image/webp')],
    ['a path that climbs out of a directory and back is declared by where it ends', { icon: 'a/../icon.svg' }, declared('icon', 'icon.svg', 'image/svg+xml')],
    ['doubled slashes and inner dots collapse', { icon: './a//b/./c.svg' }, declared('icon', 'a/b/c.svg', 'image/svg+xml')],
    // `path.resolve`, which dsh resolves the field with, drops a trailing
    // slash, so dsh reads the file `logo.svg`; `posix.normalize` alone keeps it.
    ['a trailing slash is dropped, as dsh drops it', { icon: 'logo.svg/' }, declared('icon', 'logo.svg', 'image/svg+xml')],
  ])('declares: %s', (_what, manifest, expected) => {
    expect(readIconDeclaration(manifest)).toEqual(expected)
  })

  it.each<ReadRow>([
    ['an empty string', { icon: '' }, refused(iconDetail.notString())],
    ['a number', { icon: 7 }, refused(iconDetail.notString())],
    // dsh's `textOf` throws on `typeof value !== 'string' || value.trim() === ''`
    // and treats only `undefined` as absent.
    ['a string of whitespace', { icon: '  \t ' }, refused(iconDetail.notString())],
    ['null, which is present and not a string', { icon: null }, refused(iconDetail.notString())],
    ['an array', { icon: ['icon.svg'] }, refused(iconDetail.notString())],
    ['an object', { icon: { path: 'icon.svg' } }, refused(iconDetail.notString())],
    ['a POSIX absolute path', { icon: '/abs/icon.svg' }, refused(iconDetail.notRelative('"/abs/icon.svg"'))],
    ['a Windows drive path', { icon: 'C:\\icon.svg' }, refused(iconDetail.notRelative(shownPath('C:\\icon.svg')))],
    ['a Windows UNC path', { icon: '\\\\server\\share\\icon.svg' }, refused(iconDetail.notRelative(shownPath('\\\\server\\share\\icon.svg')))],
    ['a drive-relative path, which has a scheme-shaped prefix', { icon: 'C:icon.svg' }, refused(iconDetail.notRelative('"C:icon.svg"'))],
    ['a URL', { icon: 'https://example.com/icon.svg' }, refused(iconDetail.notRelative('"https://example.com/icon.svg"'))],
    ['a path that leaves the package', { icon: '../icon.svg' }, refused(iconDetail.leavesPackage('"../icon.svg"'))],
    // The detail quotes what the author wrote when it refuses before there is
    // a path (not relative, leaves the package), and the normalised path from
    // there on (ruling R1).
    ['a path that leaves only once normalised is quoted as written', { icon: 'a/../../icon.svg' }, refused(iconDetail.leavesPackage('"a/../../icon.svg"'))],
    ['the parent directory', { icon: '..' }, refused(iconDetail.leavesPackage('".."'))],
    ['the parent directory with a slash', { icon: '../' }, refused(iconDetail.leavesPackage('"../"'))],
    ['an extension dsh does not know, quoted as normalised', { icon: './logo.icon' }, refused(iconDetail.badType(ICON_LABEL, '"logo.icon"'))],
    ['no extension', { icon: 'logo' }, refused(iconDetail.badType(ICON_LABEL, '"logo"'))],
    ['a gif', { icon: 'img/logo.gif' }, refused(iconDetail.badType(ICON_LABEL, '"img/logo.gif"'))],
    // `extname` takes no extension from a dotfile, in dsh as here.
    ['a dotfile named like an extension', { icon: '.svg' }, refused(iconDetail.badType(ICON_LABEL, '".svg"'))],
    ['the package directory itself', { icon: '.' }, refused(iconDetail.badType(ICON_LABEL, '"."'))],
  ])('refuses: %s', (_what, manifest, expected) => {
    expect(readIconDeclaration(manifest)).toEqual(expected)
  })

  it('refuses a data URL as not a file path', () => {
    const read = readIconDeclaration({ icon: 'data:image/svg+xml;base64,AAAA' })
    expect(detailOf(read).startsWith('package.json "icon" "data:image/svg+xml;base64,AAAA" must be a relative file path')).toBe(true)
  })
})

describe('readIconDeclaration: through exports', () => {
  it.each<ReadRow>([
    ['no exports and no icon', {}, none],
    ['no exports: the manifest resolves, so the field is read', { icon: 'a.svg' }, declared('icon', 'a.svg', 'image/svg+xml')],
    ['a "./*" pattern exposes the manifest, so the field is read', { icon: 'a.svg', exports: { './*': './*' } }, declared('icon', 'a.svg', 'image/svg+xml')],
    ['an exports map without "./package.json" hides the field', { icon: './icon.svg', exports: { '.': './i.js' } }, refused(iconDetail.fieldUnreachable())],
    ['a string at the top of exports is sugar for the root, so it hides the field too', { icon: './icon.svg', exports: './index.js' }, refused(iconDetail.fieldUnreachable())],
    // dsh reads whatever file the map hands to "./package.json". If that is
    // not the manifest the shop holds, the shop cannot know what dsh reads, and
    // this manifest's own field is not it.
    ['a map that sends "./package.json" elsewhere hides this manifest\'s field', { icon: './i.svg', exports: { './package.json': './dist/package.json' } }, refused(iconDetail.fieldUnreachable())],
    ['a map that sends "./package.json" to the package directory hides it too', { icon: './i.svg', exports: { './package.json': './' } }, refused(iconDetail.fieldUnreachable())],
    // The field is never read, so nothing is wrong with its value.
    ['an unreachable field is reported as unreachable, whatever it holds', { icon: 7, exports: { '.': './i.js' } }, refused(iconDetail.fieldUnreachable())],
    ['an unreachable field and an export: the export wins', { icon: './old.svg', exports: { '.': './i.js', './icon': './new.svg' } }, declared('export', 'new.svg', 'image/svg+xml')],
    ['an unreachable field holding nonsense does not stand in the export\'s way', { icon: 7, exports: { './icon': './b.svg' } }, declared('export', 'b.svg', 'image/svg+xml')],
    ['a map that sends "./package.json" elsewhere still lets the export win', { icon: './i.svg', exports: { './package.json': './dist/package.json', './icon': './i.png' } }, declared('export', 'i.png', 'image/png')],
    ['an exposed manifest: the field comes first', { icon: './a.svg', exports: { '.': './i.js', './package.json': './package.json', './icon': './b.svg' } }, declared('icon', 'a.svg', 'image/svg+xml')],
    ['an exposed manifest: a bad field is refused, and the export is not tried', { icon: '', exports: { './package.json': './package.json', './icon': './b.svg' } }, refused(iconDetail.notString())],
    ['an exposed manifest: a field with a bad type is refused, and the export is not tried', { icon: 'a.gif', exports: { './package.json': './package.json', './icon': './b.svg' } }, refused(iconDetail.badType(ICON_LABEL, '"a.gif"'))],
    ['an exposed manifest without a field falls to the export', { exports: { './package.json': './package.json', './icon': './b.svg' } }, declared('export', 'b.svg', 'image/svg+xml')],
    ['an exposed manifest with nothing to read', { exports: { './package.json': './package.json' } }, none],
    ['an exports map with neither the manifest nor an icon', { exports: { '.': './i.js' } }, none],
  ])('%s', (_what, manifest, expected) => {
    expect(readIconDeclaration(manifest)).toEqual(expected)
  })

  it.each<ReadRow>([
    // The map is open to every subpath, so `./icon` resolving through one says
    // nothing about an icon unless it lands on a file with an image extension.
    ['a "./*" pattern lands on a file with no extension: not an icon export', { exports: { './*': './*' } }, none],
    ['a pattern that lands on a script is not one either', { exports: { './*': './dist/*.js' } }, none],
    ['a pattern that lands on an image is the export', { exports: { './*': './assets/*.svg' } }, declared('export', 'assets/icon.svg', 'image/svg+xml')],
    // The same target under an exact key is the author's own statement.
    ['an exact "./icon" key with no extension is refused', { exports: { './icon': './icon' } }, refused(iconDetail.badType(EXPORT_LABEL, '"icon"'))],
    ['an exact "./icon" key with an unknown extension is refused', { exports: { './icon': './icon.gif' } }, refused(iconDetail.badType(EXPORT_LABEL, '"icon.gif"'))],
    ['an exact "./icon" key resolved through conditions', { exports: { './icon': { types: './icon.d.ts', default: './assets/Logo.PNG' } } }, declared('export', 'assets/Logo.PNG', 'image/png')],
    ['an exported webp', { exports: { './icon': './x.webp' } }, declared('export', 'x.webp', 'image/webp')],
    ['an exported path is normalised as the field\'s is', { exports: { './icon': './img//a.JPG' } }, declared('export', 'img/a.JPG', 'image/jpeg')],
    ['an exact key mapped to null exports nothing', { exports: { './*': './*.svg', './icon': null } }, none],
    // `resolveExportsSubpath` answers with a file inside the package, and the
    // path rules are applied to its answer too, as defence in depth. One that
    // fails them is no export, rather than a refusal: the refusals quote
    // `package.json "icon"`, a field the author of an export did not write.
    ['a resolved path the path rules refuse is no export', { exports: { './icon': './C:/icon.svg' } }, none],
    ['a resolved path the path rules refuse leaves a declared field unreachable', { icon: 'a.svg', exports: { './icon': './C:/icon.svg' } }, refused(iconDetail.fieldUnreachable())],
  ])('%s', (_what, manifest, expected) => {
    expect(readIconDeclaration(manifest)).toEqual(expected)
  })
})

describe('readIconDeclaration: hostile and malformed input', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['a string', 'package.json'],
    ['a number', 5],
    ['true', true],
    ['an array', [{ icon: './icon.svg' }]],
  ])('reads %s as no icon', (_what, manifest) => {
    expect(readIconDeclaration(manifest)).toEqual(none)
  })

  it('refuses a data URL however long it is, quoting only its head', () => {
    const url = `data:image/svg+xml;base64,${'A'.repeat(100_000)}`
    const detail = detailOf(readIconDeclaration({ icon: url }))
    expect(detail).toBe(iconDetail.notRelative(shownPath(url)))
    expect(detail.length).toBeLessThan(300)
  })

  // The path becomes a key in a committed file and a lookup in an archive, and
  // a manifest may be a megabyte. No file system dsh runs on opens a name past
  // PATH_MAX, so nothing real is lost to a bound.
  it.each<[source: string, manifestWith: (path: string) => unknown]>([
    ['the field', (path) => ({ icon: path })],
    ['the export', (path) => ({ exports: { './icon': `./${path}` } })],
  ])('declares %s up to the longest path a file system opens, and reads nothing past it', (_source, manifestWith) => {
    const named = (length: number): string => `${'a'.repeat(length - '.svg'.length)}.svg`
    expect(readIconDeclaration(manifestWith(named(MAX_ICON_PATH_LENGTH))).kind).toBe('declared')
    expect(readIconDeclaration(manifestWith(named(MAX_ICON_PATH_LENGTH + 1)))).toEqual(none)
  })

  it('reads a field a megabyte long as no icon, without stalling on it', () => {
    expect(readIconDeclaration({ icon: `${'b/'.repeat(500_000)}icon.svg` })).toEqual(none)
  })
})

describe('shownPath', () => {
  it.each([
    ['a plain value', 'assets/icon.svg', '"assets/icon.svg"'],
    ['quotes, backslashes and newlines, escaped as JSON escapes them', 'a"b\\c\nd', '"a\\"b\\\\c\\nd"'],
    ['the empty string', '', '""'],
  ])('quotes %s', (_what, value, expected) => {
    expect(shownPath(value)).toBe(expected)
  })

  it('cuts 120 characters to a quoted string of 80 ending in an ellipsis', () => {
    const shown = shownPath('a'.repeat(120))
    expect(shown).toBe(`"${'a'.repeat(78)}…`)
    expect([...shown]).toHaveLength(80)
  })

  it('leaves alone a value whose quoted form is exactly 80 characters, and cuts the next longer', () => {
    expect(shownPath('a'.repeat(78))).toBe(`"${'a'.repeat(78)}"`)
    expect(shownPath('a'.repeat(79))).toBe(`"${'a'.repeat(78)}…`)
  })

  it('counts what the escapes made of the value, not the value', () => {
    // 40 quotation marks quote to 80 characters of `\"` pairs plus two of the
    // string's own: past 80, so cut.
    const shown = shownPath('"'.repeat(40))
    expect(shown.endsWith('…')).toBe(true)
    expect([...shown]).toHaveLength(80)
  })

  // The odd lead-in puts a pair across unit 79, where a cut by UTF-16 unit
  // would halve it and leave an ill-formed string in a published detail.
  it('cuts by character, so a surrogate pair is never halved', () => {
    const shown = shownPath(`a${'😀'.repeat(100)}`)
    expect(shown.isWellFormed()).toBe(true)
    expect(shown).toBe(`"a${'😀'.repeat(77)}…`)
  })

  it('does not cut a value that is short in characters but long in UTF-16 units', () => {
    // 40 emoji and the two quotes: 42 characters, 82 units.
    expect(shownPath('😀'.repeat(40))).toBe(`"${'😀'.repeat(40)}"`)
  })

  it('reads only the head of a value, however long', () => {
    expect(shownPath('a'.repeat(5_000_000))).toBe(shownPath('a'.repeat(120)))
  })
})

type FilesRow = [what: string, files: unknown, path: string, expected: boolean]

describe('fileListIncludes', () => {
  it.each<FilesRow>([
    ['no files list restricts nothing', undefined, 'icon.svg', true],
    ['a directory entry includes what lies under it', ['assets'], 'assets/icon.svg', true],
    ['a trailing slash on a directory entry is optional', ['assets/'], 'assets/icon.svg', true],
    ['a star stays within a segment: it reaches a root file', ['*.svg'], 'icon.svg', true],
    ['a star stays within a segment: it does not reach into a directory', ['*.svg'], 'assets/icon.svg', false],
    ['a double star crosses segments', ['**/*.svg'], 'assets/icon.svg', true],
    ['a later "!" entry excludes what an earlier one included', ['dist', '!dist/icon.svg'], 'dist/icon.svg', false],
    ['a list that names another directory leaves the file out', ['lib'], 'icon.svg', false],
    ['a list that is not an array restricts nothing', 'lib', 'icon.svg', true],
  ])('%s', (_what, files, path, expected) => {
    expect(fileListIncludes(files, path)).toBe(expected)
  })

  // The rows below go past the table above, to the forms authors write and
  // that `npm pack` (and so a git install) reads a particular way. Every
  // expected value was read off npm-packlist 10.0.4, the one bundled with
  // Node 26.6.0's npm, over a fixture tree, not off a reading of its docs.
  it.each<FilesRow>([
    ['a file entry includes that file', ['icon.svg'], 'icon.svg', true],
    ['a file entry does not include a file of that name in a directory', ['icon.svg'], 'assets/icon.svg', false],
    ['an entry is anchored at the package root', ['sub'], 'assets/sub/icon.svg', false],
    ['an entry naming a nested directory includes what lies under it', ['assets/sub'], 'assets/sub/icon.svg', true],
    ['a glob is matched without regard to case', ['*.SVG'], 'icon.svg', true],
    ['and so is the path it is matched against', ['*.svg'], 'Icon.SVG', true],
    ['an entry with directories in it is too', ['DIST/**'], 'dist/icon.svg', true],
    ['and one that names a file', ['dist/ICON.svg'], 'dist/icon.svg', true],
    ['a leading "./" is the package root', ['./dist'], 'dist/icon.svg', true],
    ['a leading "/" is the package root', ['/dist'], 'dist/icon.svg', true],
    ['doubled slashes in an entry collapse', ['dist//icon.svg'], 'dist/icon.svg', true],
    // `dist/*` means `dist/**` to npm, and a star does not otherwise leave its segment.
    ['an entry ending in "/*" includes everything below, not only the children', ['dist/*'], 'dist/sub/icon.svg', true],
    ['a lone "*" includes everything', ['*'], 'assets/sub/icon.svg', true],
    ['a lone "*" as a "!" entry excludes everything', ['dist', '!*'], 'dist/icon.svg', false],
    ['a star before an extension reaches the children only', ['dist/*.svg'], 'dist/icon.svg', true],
    ['a star before an extension stays out of subdirectories', ['dist/*.svg'], 'dist/sub/icon.svg', false],
    ['a double star between directories reaches a child directory', ['assets/**/*.svg'], 'assets/icon.svg', true],
    ['a double star between directories reaches a deeper one', ['assets/**/*.svg'], 'assets/a/b/icon.svg', true],
    ['a double star between directories stays inside its directory', ['assets/**/*.svg'], 'dist/icon.svg', false],
    ['a leading double star may match no directory at all', ['**/icon.svg'], 'icon.svg', true],
    ['a lone double star includes everything', ['**'], 'a/b/icon.svg', true],
    ['a trailing double star includes everything below', ['assets/**'], 'assets/a/icon.svg', true],
    ['a glob matches only the path it names: not a directory that holds it', ['as*'], 'assets/icon.svg', false],
    ['an empty list packs nothing the list could name', [], 'icon.svg', false],
    ['a later entry includes again what an earlier "!" excluded', ['dist', '!dist/icon.svg', 'dist/icon.svg'], 'dist/icon.svg', true],
    ['the last entry that matches decides, so a "!" glob has no say over a later include', ['!dist/*.svg', 'dist'], 'dist/icon.svg', true],
    ['a "!" entry excludes a directory and what lies under it', ['dist', '!dist/sub'], 'dist/sub/icon.svg', false],
    ['a "!" entry leaves the rest of the directory', ['dist', '!dist/sub'], 'dist/icon.svg', true],
    ['a "!" entry may be a glob', ['dist', '!dist/*.svg'], 'dist/icon.svg', false],
    ['a "!" entry that matches nothing excludes nothing', ['dist', '!lib'], 'dist/icon.svg', true],
  ])('%s', (_what, files, path, expected) => {
    expect(fileListIncludes(files, path)).toBe(expected)
  })

  // Glob syntax beyond `*` and `**` (braces, `?`, classes, extglobs, escapes)
  // is npm's minimatch's, and the shop does not evaluate it. A refusal is
  // published to the author, so a pattern this cannot read must not refuse:
  // it includes, and as a "!" entry it excludes nothing.
  it.each<FilesRow>([
    ['braces', ['assets/*.{svg,png}'], 'assets/icon.svg', true],
    ['a single-character wildcard', ['assets/icon.?vg'], 'assets/icon.svg', true],
    ['a character class', ['assets/icon.[sp]*'], 'assets/icon.svg', true],
    ['an extglob', ['assets/+(icon|logo).svg'], 'assets/icon.svg', true],
    ['an escape', ['assets/icon\\.svg'], 'assets/icon.svg', true],
    ['a pattern it cannot read includes every path, since it cannot tell which', ['assets/*.{svg,png}'], 'lib/icon.svg', true],
    ['as a "!" entry it excludes nothing', ['dist', '!dist/*.{svg,png}'], 'dist/icon.svg', true],
    ['an entry that is only slashes and dots', ['./'], 'icon.svg', true],
    ['an empty entry', [''], 'icon.svg', true],
  ])('reads a pattern it does not understand as including: %s', (_what, files, path, expected) => {
    expect(fileListIncludes(files, path)).toBe(expected)
  })

  it.each<FilesRow>([
    ['an array holding a number', ['dist', 7], 'icon.svg', true],
    ['an array holding null', [null], 'icon.svg', true],
    ['an array holding an array', [['dist']], 'icon.svg', true],
    ['null', null, 'icon.svg', true],
    ['an object', { 0: 'dist' }, 'icon.svg', true],
    ['a number', 42, 'icon.svg', true],
  ])('restricts nothing for something that is not an array of strings: %s', (_what, files, path, expected) => {
    expect(fileListIncludes(files, path)).toBe(expected)
  })

  // `files` is untrusted and matching costs the product of the pattern's size
  // and the path's. These shapes make a backtracking matcher run for as long as
  // it likes; here they either answer at once or are past a bound and read as
  // a list that restricts nothing.
  it('answers at once for a pattern built to make a backtracking matcher blow up', () => {
    expect(fileListIncludes([`${'*a'.repeat(100)}b`], `${'a'.repeat(3_000)}.svg`)).toBe(false)
    expect(fileListIncludes([`${'**/'.repeat(50)}x.svg`], `${'a/'.repeat(1_000)}y.svg`)).toBe(false)
  })

  it('reads a list far past any real one as restricting nothing', () => {
    const entries = Array.from({ length: 100_000 }, (_, index) => `dir${index}`)
    expect(fileListIncludes(entries, 'icon.svg')).toBe(true)
  })

  it('reads an entry far past any real one as one it cannot read', () => {
    expect(fileListIncludes([`${'a/'.repeat(50_000)}x`], 'icon.svg')).toBe(true)
  })

  // Inside the bounds a walk still costs the product of its lengths, and a list
  // built to reach it pays that once per entry: the first shape below kept one
  // call busy for 1.2 s of blocking CPU before a call had a budget of steps.
  // Past the budget the list is not read, which includes the file, as a list
  // past the bounds above does.
  describe('a budget of matching steps', () => {
    /** The most entries, each a star that slides along the path and reads 254 more characters after every slide. */
    const slidingStars = (count: number) => Array.from({ length: count }, () => `*${'a'.repeat(254)}b`)
    /** The longest path the reader keeps, all of it one name the stars slide along. */
    const longName = `${'a'.repeat(MAX_ICON_PATH_LENGTH - '.svg'.length)}.svg`

    it('reads a list that would spend more than the budget as including the file', () => {
      const steps = { left: MAX_FILES_MATCH_STEPS }
      expect(fileListIncludes(slidingStars(256), longName, steps)).toBe(true)
      // Stopped at the budget: the one turn past it is the one that found it spent.
      expect(steps.left).toBe(-1)
    })

    it('is what decides that list: read whole, two of its entries alone answer otherwise, past the budget', () => {
      const steps = { left: Number.MAX_SAFE_INTEGER }
      expect(fileListIncludes(slidingStars(2), longName, steps)).toBe(false)
      expect(Number.MAX_SAFE_INTEGER - steps.left).toBeGreaterThan(MAX_FILES_MATCH_STEPS)
    })

    it('spends the budget in a pattern\'s trailing stars, so a list of them cannot run past it', () => {
      // The shape a review measured at the call site: a long path, and 256
      // entries whose trailing stars are read after every counted turn. That
      // tail used to be free, so the call answered after the budget and went on
      // spending, 300 ms of blocking CPU for this one input. With the tail
      // counted it stops at the budget like any other list. Timed against the
      // same shape with one star, which reaches the same budget either way, so
      // the comparison is this machine's own rather than an absolute bound.
      const path = `${'a/'.repeat(2_045)}z.svg`
      const tail = (stars: number) => Array.from({ length: 256 }, () => `**/a${'*'.repeat(stars)}`)
      const spend = (stars: number): number => {
        const steps = { left: MAX_FILES_MATCH_STEPS }
        const started = performance.now()
        expect(fileListIncludes(tail(stars), path, steps)).toBe(true)
        // Spent: the walk that found the budget gone is the one past it, and
        // the caller answers "included" without reading the rest (the exact
        // value may be -1 or -2, whichever walk is holding the last turn).
        expect(steps.left).toBeLessThan(0)
        return performance.now() - started
      }
      spend(1) // Warm the JIT for both readings below.
      const short = spend(1)
      const long = spend(252)
      expect(long).toBeLessThan(Math.max(short * 8, 60))
    })

    it('stops a list of double stars that backtracks over a thousand directories the same way', () => {
      const deepPath = `${Array.from({ length: 1_000 }, () => 'a').join('/')}/${'a'.repeat(2_000)}.svg`
      const steps = { left: MAX_FILES_MATCH_STEPS }
      expect(fileListIncludes(Array.from({ length: 256 }, () => `**/*${'a'.repeat(100)}/**/b*`), deepPath, steps)).toBe(true)
      expect(steps.left).toBe(-1)
    })

    it('reads an ordinary list exactly, and in a small part of the budget', () => {
      // A list as long as the bound allows, of globs that reach into the path's
      // directories, whose last entry decides: the answer is the list's own, not
      // the budget's.
      const forms = ['dist/**/*.js', '**/*.d.ts', 'src/**', '!**/*.test.js', 'icons/*.png', 'README*', 'assets/**/*.svg', '!assets/**/dark/**']
      const files = Array.from({ length: 256 }, (_, index) => forms[index % forms.length])
      const path = 'assets/icons/dark/mode/icon.svg'
      const excluding = { left: MAX_FILES_MATCH_STEPS }
      expect(fileListIncludes(files, path, excluding)).toBe(false)
      const including = { left: MAX_FILES_MATCH_STEPS }
      expect(fileListIncludes(files.slice(0, -1), path, including)).toBe(true)
      for (const steps of [excluding, including]) expect(MAX_FILES_MATCH_STEPS - steps.left).toBeLessThan(MAX_FILES_MATCH_STEPS / 100)
    })
  })
})

describe('iconLabel', () => {
  it('names the field and the export the way the details quote them', () => {
    expect(iconLabel('icon')).toBe('package.json "icon"')
    expect(iconLabel('export')).toBe('the "./icon" export')
  })
})

describe('ICON_MEDIA_TYPES', () => {
  it('holds exactly the four media types, and every one the reader writes for an extension it knows', () => {
    expect(Object.keys(ICON_MEDIA_TYPES).sort()).toEqual(['image/jpeg', 'image/png', 'image/svg+xml', 'image/webp'])
    // The reader's own output, so a type it learned to write that the table
    // lacks would fail here, where a record guarding stored rows would refuse
    // it on the build after the one that wrote it.
    const written = ['icon.svg', 'icon.png', 'icon.jpg', 'icon.jpeg', 'icon.webp'].map((path) => {
      const read = readIconDeclaration({ icon: path })
      if (read.kind !== 'declared') throw new Error(`expected ${path} to be declared, read ${read.kind}`)
      return read.declaration.mediaType
    })
    expect([...new Set(written)].sort()).toEqual(Object.keys(ICON_MEDIA_TYPES).sort())
  })
})

// Every one of these strings is published to the author it is about (design
// 2026-10-23 §10; CLAUDE.md, "Every rejection carries an author-readable
// detail"). They are pinned here character for character, as the plan states
// them, so a typo in the copy cannot pass by agreeing with itself.
describe('iconDetail', () => {
  const shown = '"icons/logo.svg"'

  it.each<[name: string, actual: string, expected: string]>([
    ['notString', iconDetail.notString(), 'package.json "icon" must be a non-empty string; dsh shows no icon for this package.'],
    ['notRelative', iconDetail.notRelative(shown), 'package.json "icon" "icons/logo.svg" must be a relative file path inside the package; dsh shows no icon for this package.'],
    ['leavesPackage', iconDetail.leavesPackage(shown), 'package.json "icon" "icons/logo.svg" leaves the package directory; dsh shows no icon for this package.'],
    ['badType, of the field', iconDetail.badType(ICON_LABEL, shown), 'package.json "icon" "icons/logo.svg" is not an SVG, PNG, JPEG or WebP file name; dsh chooses an icon\'s type by its extension.'],
    ['badType, of the export', iconDetail.badType(EXPORT_LABEL, shown), 'the "./icon" export "icons/logo.svg" is not an SVG, PNG, JPEG or WebP file name; dsh chooses an icon\'s type by its extension.'],
    ['fieldUnreachable', iconDetail.fieldUnreachable(), 'package.json "icon" is never read: the package\'s "exports" does not expose "./package.json", so dsh cannot see the field. Add "./package.json": "./package.json" to "exports", or export "./icon".'],
    ['notInFiles', iconDetail.notInFiles(ICON_LABEL, shown), 'package.json "icon" "icons/logo.svg" is not in package.json "files", so a git install leaves it out and dsh never sees it.'],
    ['notInPackage', iconDetail.notInPackage(EXPORT_LABEL, shown, '@x/y', '1.2.3'), 'the "./icon" export "icons/logo.svg" is not in the published package @x/y@1.2.3.'],
    ['notAtCommit', iconDetail.notAtCommit(ICON_LABEL, shown, 'owner/repo', '0123456789abcdef0123456789abcdef01234567'), 'package.json "icon" "icons/logo.svg" is not in owner/repo at commit 0123456.'],
    ['notInRelease', iconDetail.notInRelease(ICON_LABEL, shown), 'package.json "icon" "icons/logo.svg" is not in the release asset this entry installs.'],
    ['tooLarge', iconDetail.tooLarge(ICON_LABEL, shown, 32 * 1024 + 1), 'package.json "icon" "icons/logo.svg" is 32.1 KiB; the shop shows icons of at most 32 KiB.'],
    ['tooLarge, of exactly 40 KiB', iconDetail.tooLarge(EXPORT_LABEL, shown, 40 * 1024), 'the "./icon" export "icons/logo.svg" is 40.0 KiB; the shop shows icons of at most 32 KiB.'],
    ['tooLarge, of a size not read', iconDetail.tooLarge(ICON_LABEL, shown, null), 'package.json "icon" "icons/logo.svg" is larger than 32 KiB; the shop shows icons of at most 32 KiB.'],
    ['wrongBytes, SVG', iconDetail.wrongBytes(ICON_LABEL, shown, 'SVG'), 'package.json "icon" "icons/logo.svg" does not hold SVG data, although its extension says it does.'],
    ['wrongBytes, WebP', iconDetail.wrongBytes(EXPORT_LABEL, shown, 'WebP'), 'the "./icon" export "icons/logo.svg" does not hold WebP data, although its extension says it does.'],
    ['packageTooLarge', iconDetail.packageTooLarge('@x/y', '1.2.3'), 'the published package @x/y@1.2.3 is larger than the 32 MiB the catalog build downloads, so its icon was not read.'],
    ['packageUnpacksTooLarge', iconDetail.packageUnpacksTooLarge('@x/y', '1.2.3'), 'the published package @x/y@1.2.3 unpacks to more than the 64 MiB the catalog build reads, so its icon was not read.'],
    ['packageUnreadable', iconDetail.packageUnreadable('@x/y', '1.2.3'), 'the published package @x/y@1.2.3 could not be read by the catalog build as a gzipped tar archive with one top-level directory, so its icon was not read.'],
    ['releaseUnreadable', iconDetail.releaseUnreadable(), 'the release asset could not be read by the catalog build as a gzipped tar archive with one top-level directory, so its icon was not read.'],
    ['withheldByHand', iconDetail.withheldByHand('it shows a logo we may not use'), 'withheld by registry/withheld-icons.yml: it shows a logo we may not use'],
    ['withheldForSize', iconDetail.withheldForSize(), 'withheld: the icons file reached its 16 MiB budget, and the largest icons give way first.'],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toBe(expected)
  })

  it.each([
    [1, '0.1'],
    [1024, '1.0'],
    [1025, '1.1'],
    [32 * 1024 + 1, '32.1'],
    [256 * 1024, '256.0'],
  ])('rounds %i bytes up to the tenth of a KiB: %s', (bytes, kib) => {
    expect(iconDetail.tooLarge(ICON_LABEL, shown, bytes)).toBe(`package.json "icon" "icons/logo.svg" is ${kib} KiB; the shop shows icons of at most 32 KiB.`)
  })
})
