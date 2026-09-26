import { describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, statSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { load } from 'js-yaml'
import { collidingEntryId, discoverProfile, ownedEntries, ownedEntryIds, ownsEntryId, setUserLayerRow, setUserLayerRows } from '../../src/host/profile.ts'
import { fileTempRoot } from './temp-root.ts'

const TEMP_ROOT = fileTempRoot('profile')

function fixtureProfile(): string {
  const home = mkdtempSync(join(TEMP_ROOT, 'dsh-profile-'))
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-base'] } } }))
  return dir
}

describe('discoverProfile', () => {
  it('finds the profile directory above the start path', () => {
    const dir = fixtureProfile()
    expect(discoverProfile(join(dir, 'node_modules', 'dsh-plugin-shop', 'lib', 'index.js'))).toEqual({ name: 'web', dir })
  })

  it('resolves symlinks in the start path back to the real profile directory', () => {
    const dir = fixtureProfile()
    const link = join(dirname(dir), 'web-link')
    // A junction on Windows, where a directory SYMLINK needs elevation or
    // Developer Mode and `symlinkSync` answers EPERM without either — which
    // is why this one case failed there while the rest of the file passed. A
    // junction needs no privilege, takes the same absolute target, and
    // `realpathSync` resolves it identically, so the claim under test is
    // unchanged. It is also the shape that actually occurs: pnpm links a
    // workspace dependency as a junction on Windows for the same reason.
    symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : undefined)
    expect(discoverProfile(join(link, 'node_modules', 'dsh-plugin-shop', 'lib', 'index.js'))).toEqual({ name: 'web', dir })
  })

  it('uses the boot-provided base directory when the start path is not under any profile', () => {
    // A `link:` install keeps the package at its source location, so no
    // ancestor of the module path is a profile; the boot's ctx.baseUrl (the
    // profile's cordis.yml directory) is the authoritative fallback.
    const dir = fixtureProfile()
    const linkedSource = mkdtempSync(join(TEMP_ROOT, 'dsh-linked-source-'))
    expect(discoverProfile(join(linkedSource, 'packages', 'dsh-plugin-shop', 'lib', 'index.js'), dir))
      .toEqual({ name: 'web', dir })
  })

  it('ignores a base directory that is not a profile and walks up as before', () => {
    const dir = fixtureProfile()
    const stray = mkdtempSync(join(TEMP_ROOT, 'dsh-stray-'))
    expect(discoverProfile(join(dir, 'node_modules', 'dsh-plugin-shop', 'lib', 'index.js'), stray))
      .toEqual({ name: 'web', dir })
  })

  it('throws when no ancestor is a profile directory and no base directory is given', () => {
    const stray = mkdtempSync(join(TEMP_ROOT, 'dsh-stray-'))
    expect(() => discoverProfile(join(stray, 'x.js'))).toThrow(/no profile directory/)
  })
})

describe('setUserLayerRow', () => {
  it('adds a disabled row and preserves existing rows', () => {
    const dir = fixtureProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: keep-me\n  name: x\n')
    setUserLayerRow({ profileDir: dir, row: { id: 'hello', disabled: true } })
    const raw = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(raw).toContain('keep-me')
    expect(raw).toContain('hello')
    expect(raw).toContain('disabled: true')
  })

  it('writes disabled: false when re-enabling, instead of deleting the row', () => {
    // Deleting the row was the rule until 2026-09-26 ("so the bundle default
    // rules"), and deletion is what loses a row the user wrote or the comment
    // above it; writing the key never removes a node. It is also dsh 0.1.7's
    // own convention for this file, and it enables an entry whose bundle
    // ships it disabled, which removing an override never could (design
    // 2026-09-26-market-borrowings §2.2).
    const dir = fixtureProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: hello\n  disabled: true\n')
    setUserLayerRow({ profileDir: dir, row: { id: 'hello', disabled: false } })
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe('- id: hello\n  disabled: false\n')
  })

  it('replaces an existing row for the same id instead of duplicating', () => {
    const dir = fixtureProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: hello\n  disabled: true\n- id: other\n  disabled: true\n')
    setUserLayerRow({ profileDir: dir, row: { id: 'hello', disabled: true } })
    const raw = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(raw.match(/id: hello/g)).toHaveLength(1)
  })
})

/** Materialize a package inside the profile's node_modules with the bundle
 * patch it declares — the real shape the loader composes from. */
function fixturePackage(profileDir: string, name: string, patch: string | null, patchPath = './cordis.patch.yml'): void {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  const dsh = patch === null ? {} : { bundle: { patch: patchPath } }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dsh }))
  if (patch !== null) writeFileSync(join(dir, patchPath.replace(/^\.\//, '')), patch)
}

describe('ownedEntryIds', () => {
  it('reads the ids a package inserts even when the entry module is another package', () => {
    // @tt-a1i/archify-dsh's real shape: it registers no module of its own, it
    // inserts a configured instance of a harness module. The entry's
    // moduleName is `@deepseek-ai/dsh-skill-filesystem`; only the id
    // `archify-skill-filesystem` identifies it as archify's.
    const dir = fixtureProfile()
    fixturePackage(dir, '@tt-a1i/archify-dsh',
      "- insert:\n    - id: archify-skill-filesystem\n      name: '@deepseek-ai/dsh-skill-filesystem'\n")
    expect(ownedEntryIds({ profileDir: dir, packageName: '@tt-a1i/archify-dsh' })).toEqual(['archify-skill-filesystem'])
  })

  it('collects every inserted id when one package contributes several entries', () => {
    const dir = fixtureProfile()
    fixturePackage(dir, 'dsh-many',
      '- insert:\n    - id: many-host\n      name: dsh-many/host\n    - id: many-web\n      name: dsh-many/web\n')
    expect(ownedEntryIds({ profileDir: dir, packageName: 'dsh-many' })).toEqual(['many-host', 'many-web'])
  })

  it('descends into an inserted group, which owns its children', () => {
    // The loader reads a group's children from the group entry's own `config`
    // array (applyEntryPatches buildMap), not from a nested `insert`.
    const dir = fixtureProfile()
    fixturePackage(dir, 'dsh-grouped',
      '- insert:\n    - id: grouped-root\n      name: cordis/group\n      group: true\n      config:\n        - id: grouped-child\n          name: dsh-grouped/child\n')
    expect(ownedEntryIds({ profileDir: dir, packageName: 'dsh-grouped' })).toEqual(['grouped-root', 'grouped-child'])
  })

  it('ignores ids the package only targets, which it does not own', () => {
    // A bare id-targeted row overrides SOMEONE ELSE'S entry. Treating it as
    // owned would let a package claim — and let the shop disable — a row it
    // merely configures.
    const dir = fixtureProfile()
    fixturePackage(dir, 'dsh-targeter',
      '- id: someone-elses-row\n  config:\n    verbose: true\n- insert:\n    - id: targeter-own\n      name: dsh-targeter\n')
    expect(ownedEntryIds({ profileDir: dir, packageName: 'dsh-targeter' })).toEqual(['targeter-own'])
  })

  it('also reads the module each inserted entry mounts, which a named user row is judged by', () => {
    // An entry without a plain-string name (an `!!js` expression) has none to
    // offer, and a group's children are read like any other entry.
    const dir = fixtureProfile()
    fixturePackage(dir, 'dsh-mixed', [
      '- insert:',
      '    - id: mixed-host',
      '      name: dsh-mixed/host',
      '    - id: mixed-dynamic',
      '      name: !!js process.env.MIXED_MODULE',
      '    - id: mixed-root',
      '      name: cordis/group',
      '      group: true',
      '      config:',
      '        - id: mixed-child',
      '          name: dsh-mixed/child',
      '',
    ].join('\n'))
    expect(ownedEntries({ profileDir: dir, packageName: 'dsh-mixed' })).toEqual([
      { id: 'mixed-host', name: 'dsh-mixed/host' },
      { id: 'mixed-dynamic', name: undefined },
      { id: 'mixed-root', name: 'cordis/group' },
      { id: 'mixed-child', name: 'dsh-mixed/child' },
    ])
    expect(ownedEntryIds({ profileDir: dir, packageName: 'dsh-mixed' })).toEqual(['mixed-host', 'mixed-dynamic', 'mixed-root', 'mixed-child'])
  })

  it('returns no ids for a package that declares no bundle patch', () => {
    const dir = fixtureProfile()
    fixturePackage(dir, 'dsh-libonly', null)
    expect(ownedEntryIds({ profileDir: dir, packageName: 'dsh-libonly' })).toEqual([])
  })

  it('returns no ids for a package that is not in the profile at all', () => {
    const dir = fixtureProfile()
    expect(ownedEntryIds({ profileDir: dir, packageName: 'dsh-absent' })).toEqual([])
  })

  it('refuses a patch path that escapes the package directory', () => {
    const dir = fixtureProfile()
    fixturePackage(dir, 'dsh-escapee', '- insert:\n    - id: x\n      name: y\n', '../../../evil.yml')
    expect(() => ownedEntryIds({ profileDir: dir, packageName: 'dsh-escapee' }))
      .toThrow(/outside its own directory/)
  })
})

describe('setUserLayerRows', () => {
  it('writes every disable row of a multi-entry package in one pass', () => {
    const dir = fixtureProfile()
    setUserLayerRows({ profileDir: dir, rows: [{ id: 'a', disabled: true }, { id: 'b', disabled: true }] })
    const written = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(written).toContain('a')
    expect(written).toContain('b')
  })

  it('enables every row of the package in one pass and touches no other row', () => {
    // It used to DROP the package's rows; see the re-enable case above.
    const dir = fixtureProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: a\n  disabled: true\n- id: b\n  disabled: true\n- id: other\n  disabled: true\n')
    setUserLayerRows({ profileDir: dir, rows: [{ id: 'a', disabled: false }, { id: 'b', disabled: false }] })
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'))
      .toBe('- id: a\n  disabled: false\n- id: b\n  disabled: false\n- id: other\n  disabled: true\n')
  })
})

describe('setUserLayerRows and the !!js spelling (F-9)', () => {
  it('writes an existing !!js scalar back as !!js, not as __jsExpr', () => {
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-jsexpr-'))
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '- id: provider-row',
      '  config:',
      '    apiKey: !!js process.env.DEEPSEEK_API_KEY',
      '',
    ].join('\n'))

    setUserLayerRows({ profileDir, rows: [{ id: 'hello-row', disabled: true }] })

    const written = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(written).toContain('!!js process.env.DEEPSEEK_API_KEY')
    expect(written).not.toContain('__jsExpr')
    expect(written).toContain('hello-row')
    rmSync(profileDir, { recursive: true, force: true })
  })

  it('still writes a plain row plainly', () => {
    // `b` gains a row of its own since 2026-09-26: an enable writes
    // `disabled: false` rather than removing what is not there.
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-jsexpr-plain-'))
    setUserLayerRows({ profileDir, rows: [{ id: 'a', disabled: true }, { id: 'b', disabled: false }] })
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe('- id: a\n  disabled: true\n- id: b\n  disabled: false\n')
    rmSync(profileDir, { recursive: true, force: true })
  })
})

/** The header dsh writes into a new profile's user layer, verbatim from a
 * dsh 0.1.5-rc.3 `web` profile, over the empty list it starts as. */
const TEMPLATE_HEADER = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '',
].join('\n')

describe('setUserLayerRows edits one key and keeps everything the user wrote (A4)', () => {
  const layer = (dir: string): string => readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  const rows = (dir: string): unknown => load(layer(dir))

  it('a disable keeps the row\'s own config, and so does the enable after it', () => {
    // The row this file exists for: an id-targeted config override. The old
    // rewrite dropped the whole row on the disable and wrote nothing back on
    // the enable, so the override was gone for good after one round trip.
    const dir = fixtureProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: provider\n  config:\n    endpoint: https://example.test\n')
    setUserLayerRows({ profileDir: dir, rows: [{ id: 'provider', disabled: true }] })
    expect(rows(dir)).toEqual([{ id: 'provider', config: { endpoint: 'https://example.test' }, disabled: true }])
    setUserLayerRows({ profileDir: dir, rows: [{ id: 'provider', disabled: false }] })
    expect(rows(dir)).toEqual([{ id: 'provider', config: { endpoint: 'https://example.test' }, disabled: false }])
  })

  it('keeps the header dsh writes at profile init through a disable and an enable', () => {
    // js-yaml models no comments, so the first toggle used to erase this. The
    // empty flow list under it becomes a block list on the first append, so
    // the file stays one row per line.
    const dir = fixtureProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), `${TEMPLATE_HEADER}[]\n`)
    setUserLayerRows({ profileDir: dir, rows: [{ id: 'a', disabled: true }] })
    expect(layer(dir)).toBe(`${TEMPLATE_HEADER}- id: a\n  disabled: true\n`)
    setUserLayerRows({ profileDir: dir, rows: [{ id: 'a', disabled: false }] })
    expect(layer(dir)).toBe(`${TEMPLATE_HEADER}- id: a\n  disabled: false\n`)
  })

  it('keeps the comments beside a row, the toggled one and its neighbours alike', () => {
    const dir = fixtureProfile()
    const text = [
      '# my own notes',
      '- id: a # the one being toggled',
      '  config:',
      '    apiKey: !!js process.env.KEY # read from the environment',
      '# between the rows',
      '- id: b',
      '  disabled: true # parked for now',
      '',
    ].join('\n')
    writeFileSync(join(dir, 'cordis.patch.yml'), text)
    setUserLayerRows({ profileDir: dir, rows: [{ id: 'a', disabled: true }] })
    expect(layer(dir)).toBe(text.replace(' # read from the environment\n', ' # read from the environment\n  disabled: true\n'))
  })

  it('writes the last row carrying the id, never an earlier one', () => {
    // applyEntryPatches applies rows in order and each key REPLACES the
    // target's value, so the last row that sets `disabled` decides it.
    // Writing the first row here would leave the second's config untouched
    // and the entry exactly as it was.
    const dir = fixtureProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: a\n  disabled: true\n- id: a\n  config:\n    x: 1\n')
    setUserLayerRows({ profileDir: dir, rows: [{ id: 'a', disabled: false }] })
    expect(rows(dir)).toEqual([{ id: 'a', disabled: true }, { id: 'a', config: { x: 1 }, disabled: false }])
  })

  it('writes a named row only when the name is the entry\'s own module', () => {
    // A row naming a different module is one the harness skips, so a write
    // to it changes nothing; the appended row is the one it will apply.
    const dir = fixtureProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: a\n  name: some-other-module\n  config:\n    x: 1\n')
    setUserLayerRows({ profileDir: dir, rows: [{ id: 'a', name: 'mod-a', disabled: true }] })
    expect(rows(dir)).toEqual([
      { id: 'a', name: 'some-other-module', config: { x: 1 } },
      { id: 'a', disabled: true },
    ])
    const matching = fixtureProfile()
    writeFileSync(join(matching, 'cordis.patch.yml'), '- id: a\n  name: mod-a\n')
    setUserLayerRows({ profileDir: matching, rows: [{ id: 'a', name: 'mod-a', disabled: true }] })
    expect(rows(matching)).toEqual([{ id: 'a', name: 'mod-a', disabled: true }])
  })

  it('appends rather than guess when the last named row might be the one the harness applies', () => {
    // Without the entry's module name the last row cannot be judged. Writing
    // the unnamed row above it would be overridden by that named row the
    // moment the harness applies it; an appended row is applied last either
    // way, so appending is the one write that is always right.
    const dir = fixtureProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: a\n  config:\n    x: 1\n- id: a\n  name: mod-a\n  disabled: true\n')
    setUserLayerRows({ profileDir: dir, rows: [{ id: 'a', disabled: false }] })
    expect(rows(dir)).toEqual([
      { id: 'a', config: { x: 1 } },
      { id: 'a', name: 'mod-a', disabled: true },
      { id: 'a', disabled: false },
    ])
  })

  it('never writes into an insert row that shares the id', () => {
    // A row with `insert` inserts into a group; the harness never reads its
    // other keys as overrides of the entry.
    const dir = fixtureProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: a\n  insert:\n    - id: child\n      name: c\n')
    setUserLayerRows({ profileDir: dir, rows: [{ id: 'a', disabled: true }] })
    expect(rows(dir)).toEqual([{ id: 'a', insert: [{ id: 'child', name: 'c' }] }, { id: 'a', disabled: true }])
  })

  it('refuses a layer the harness itself cannot load, and leaves it as it was', () => {
    const dir = fixtureProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), 'this: is not: a patch list\n')
    expect(() => setUserLayerRows({ profileDir: dir, rows: [{ id: 'a', disabled: true }] })).toThrow()
    expect(layer(dir)).toBe('this: is not: a patch list\n')
  })

  it.skipIf(process.platform === 'win32')('keeps the file\'s permission bits, and creates a new one owner-only', () => {
    // A user layer can hold a credential in a config override; a rewrite must
    // not widen who can read it. POSIX only: Windows has no such bits.
    const dir = fixtureProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    chmodSync(join(dir, 'cordis.patch.yml'), 0o640)
    setUserLayerRows({ profileDir: dir, rows: [{ id: 'a', disabled: true }] })
    expect(statSync(join(dir, 'cordis.patch.yml')).mode & 0o777).toBe(0o640)
    const fresh = fixtureProfile()
    setUserLayerRows({ profileDir: fresh, rows: [{ id: 'a', disabled: true }] })
    expect(statSync(join(fresh, 'cordis.patch.yml')).mode & 0o777).toBe(0o600)
  })
})

describe('ownsEntryId', () => {
  const owned = new Set(['archify-skill-filesystem', 'foo'])

  it('matches the bare id the bundle layer composes', () => {
    expect(ownsEntryId(owned, 'archify-skill-filesystem')).toBe(true)
  })

  it('matches the shop\'s own hot spelling of the same row', () => {
    expect(ownsEntryId(owned, 'include:typert-gateway:mkt-archify-skill-filesystem')).toBe(true)
  })

  it('does not claim an unrelated entry', () => {
    expect(ownsEntryId(owned, 'someone-elses-row')).toBe(false)
    expect(ownsEntryId(owned, 'include:typert-gateway:mkt-someone-elses-row')).toBe(false)
  })

  it('matches the spelling a REAL boot composes: every profile entry lives inside the root include', () => {
    // dsh's app-boot mounts the whole profile as one root Include entry
    // (`id: include`), so a bundle patch's `- id: foo` reaches the loader as
    // `include:foo` and the inventory reports that id verbatim. Matching only
    // the bare spelling found nothing for EVERY installed package, and the
    // toggle answered "not in the running plugin tree" for all of them.
    expect(ownsEntryId(owned, 'include:foo')).toBe(true)
    expect(ownsEntryId(owned, 'include:archify-skill-filesystem')).toBe(true)
  })

  it('matches an entry nested deeper than one tree', () => {
    // An include may hold an include; the package's row is still the last
    // segment however many trees compose above it.
    expect(ownsEntryId(owned, 'include:sub:foo')).toBe(true)
  })

  it('does not claim another package\'s row that merely sits in the same tree', () => {
    expect(ownsEntryId(owned, 'include:someone-elses-row')).toBe(false)
  })

  it('does not read a BARE id that merely starts with mkt- as the hot form', () => {
    // The hot spelling only ever exists inside an Include tree, so it always
    // carries the tree namespace. Without requiring that colon, a boot-layer
    // entry literally named `mkt-foo` would be handed to whoever owns `foo` —
    // one package's toggle silently disabling another package's live entry.
    expect(ownsEntryId(owned, 'mkt-foo')).toBe(false)
  })
})

describe('collidingEntryId', () => {
  // The real shape, measured from the live catalog: two repositories under
  // DIFFERENT bundle names that both declare `id: plugin-manager`. The name
  // gate passes them — they share no manifest key — and dsh then refuses to
  // load the tree at all, so the profile does not boot.
  const insert = (id: string): string => `- insert:\n    - id: ${id}\n      name: dsh-x/host\n`

  it('finds the id a differently-named package already declares', () => {
    const dir = fixtureProfile()
    fixturePackage(dir, '@2768651338/dsh-plugin-manager', insert('plugin-manager'))
    fixturePackage(dir, '@dsh-plugin/plugin-manager', insert('plugin-manager'))
    expect(collidingEntryId({
      profileDir: dir,
      packageName: '@dsh-plugin/plugin-manager',
      dependencies: ['@2768651338/dsh-plugin-manager', '@dsh-plugin/plugin-manager'],
    })).toEqual({ id: 'plugin-manager', holder: '@2768651338/dsh-plugin-manager' })
  })

  it('finds nothing when two same-named forks declare different ids', () => {
    // The converse, also measured: Anyway-one/dsh-balance declares
    // `id: balance` and ZHIZHU4410/deepseek-balance declares `id: dsh-balance`,
    // both bundle-named dsh-balance. The loader would hold them both happily —
    // which is why the name gate's reason is the manifest key, not this.
    const dir = fixtureProfile()
    fixturePackage(dir, 'dsh-balance', insert('balance'))
    fixturePackage(dir, 'dsh-balance-fork', insert('dsh-balance'))
    expect(collidingEntryId({
      profileDir: dir, packageName: 'dsh-balance-fork',
      dependencies: ['dsh-balance', 'dsh-balance-fork'],
    })).toBeNull()
  })

  it('never collides a package with itself', () => {
    const dir = fixtureProfile()
    fixturePackage(dir, 'dsh-solo', insert('solo'))
    expect(collidingEntryId({
      profileDir: dir, packageName: 'dsh-solo', dependencies: ['dsh-solo'],
    })).toBeNull()
  })

  it('is null for a package that declares no ids at all', () => {
    // A package with no bundle patch inserts nothing and can collide with
    // nothing; it must not be reported against an installed package's ids.
    const dir = fixtureProfile()
    fixturePackage(dir, 'dsh-plain', null)
    fixturePackage(dir, 'dsh-other', insert('other'))
    expect(collidingEntryId({
      profileDir: dir, packageName: 'dsh-plain', dependencies: ['dsh-plain', 'dsh-other'],
    })).toBeNull()
  })

  it('treats an unreadable patch in ANOTHER package as owning nothing', () => {
    // Best-effort, the same rule the installed list uses: one malformed
    // package must not fail the install of an unrelated one.
    const dir = fixtureProfile()
    fixturePackage(dir, 'dsh-broken', ': not: yaml: [')
    fixturePackage(dir, 'dsh-new', insert('new-id'))
    expect(collidingEntryId({
      profileDir: dir, packageName: 'dsh-new', dependencies: ['dsh-broken', 'dsh-new'],
    })).toBeNull()
  })

  it('finds a collision inside an inserted group, which owns its children', () => {
    const dir = fixtureProfile()
    fixturePackage(dir, 'dsh-grouper',
      '- insert:\n    - id: g-root\n      name: cordis/group\n      group: true\n      config:\n        - id: g-child\n          name: dsh-grouper/child\n')
    fixturePackage(dir, 'dsh-child-clash', insert('g-child'))
    expect(collidingEntryId({
      profileDir: dir, packageName: 'dsh-child-clash',
      dependencies: ['dsh-grouper', 'dsh-child-clash'],
    })).toEqual({ id: 'g-child', holder: 'dsh-grouper' })
  })
})
