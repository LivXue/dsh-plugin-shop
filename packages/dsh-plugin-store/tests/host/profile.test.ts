import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { discoverProfile, setUserLayerRow } from '../../src/host/profile.ts'

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
    expect(discoverProfile(join(dir, 'node_modules', 'dsh-plugin-store', 'lib', 'index.js'))).toEqual({ name: 'web', dir })
  })

  it('resolves symlinks in the start path back to the real profile directory', () => {
    const dir = fixtureProfile()
    const link = join(dirname(dir), 'web-link')
    symlinkSync(dir, link)
    expect(discoverProfile(join(link, 'node_modules', 'dsh-plugin-store', 'lib', 'index.js'))).toEqual({ name: 'web', dir })
  })

  it('throws when no ancestor is a profile directory', () => {
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
