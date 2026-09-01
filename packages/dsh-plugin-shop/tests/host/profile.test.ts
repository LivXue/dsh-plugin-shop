import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { discoverProfile, ownedEntryIds, ownsEntryId, setUserLayerRow, setUserLayerRows } from '../../src/host/profile.ts'

function fixtureProfile(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
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
    symlinkSync(dir, link)
    expect(discoverProfile(join(link, 'node_modules', 'dsh-plugin-shop', 'lib', 'index.js'))).toEqual({ name: 'web', dir })
  })

  it('uses the boot-provided base directory when the start path is not under any profile', () => {
    // A `link:` install keeps the package at its source location, so no
    // ancestor of the module path is a profile; the boot's ctx.baseUrl (the
    // profile's cordis.yml directory) is the authoritative fallback.
    const dir = fixtureProfile()
    const linkedSource = mkdtempSync(join(tmpdir(), 'dsh-linked-source-'))
    expect(discoverProfile(join(linkedSource, 'packages', 'dsh-plugin-shop', 'lib', 'index.js'), dir))
      .toEqual({ name: 'web', dir })
  })

  it('ignores a base directory that is not a profile and walks up as before', () => {
    const dir = fixtureProfile()
    const stray = mkdtempSync(join(tmpdir(), 'dsh-stray-'))
    expect(discoverProfile(join(dir, 'node_modules', 'dsh-plugin-shop', 'lib', 'index.js'), stray))
      .toEqual({ name: 'web', dir })
  })

  it('throws when no ancestor is a profile directory and no base directory is given', () => {
    const stray = mkdtempSync(join(tmpdir(), 'dsh-stray-'))
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

  it('removes the row when re-enabling, so the bundle default rules', () => {
    const dir = fixtureProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: hello\n  disabled: true\n')
    setUserLayerRow({ profileDir: dir, row: { id: 'hello', disabled: false } })
    const raw = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(raw).not.toContain('hello')
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

  it('drops every row of the package on enable while keeping unrelated rows', () => {
    const dir = fixtureProfile()
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: a\n  disabled: true\n- id: b\n  disabled: true\n- id: other\n  disabled: true\n')
    setUserLayerRows({ profileDir: dir, rows: [{ id: 'a', disabled: false }, { id: 'b', disabled: false }] })
    const written = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(written).not.toMatch(/id: a\b/)
    expect(written).not.toMatch(/id: b\b/)
    expect(written).toContain('other')
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

  it('does not read a BARE id that merely starts with mkt- as the hot form', () => {
    // The hot spelling only ever exists inside an Include tree, so it always
    // carries the tree namespace. Without requiring that colon, a boot-layer
    // entry literally named `mkt-foo` would be handed to whoever owns `foo` —
    // one package's toggle silently disabling another package's live entry.
    expect(ownsEntryId(owned, 'mkt-foo')).toBe(false)
  })
})
