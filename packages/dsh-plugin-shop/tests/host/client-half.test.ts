import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { hasClientHalf } from '../../src/host/client-half.ts'
import { memHotFs } from './mem-fs.ts'

const PROFILE = '/profile'

function withManifest(packageName: string, manifest: unknown): ReturnType<typeof memHotFs> {
  const fs = memHotFs()
  fs.write(join(PROFILE, 'node_modules', packageName, 'package.json'), JSON.stringify(manifest))
  return fs
}

describe('hasClientHalf', () => {
  it('is true when the package declares dsh.client', () => {
    const fs = withManifest('dsh-themer', { name: 'dsh-themer', dsh: { client: { inject: [], platform: 'web' } } })
    expect(hasClientHalf(fs, PROFILE, 'dsh-themer')).toBe(true)
  })

  it('is true for an EMPTY dsh.client object — the declaration is the fact, not its contents', () => {
    const fs = withManifest('dsh-themer', { name: 'dsh-themer', dsh: { client: {} } })
    expect(hasClientHalf(fs, PROFILE, 'dsh-themer')).toBe(true)
  })

  it('is false for a host-only package', () => {
    const fs = withManifest('dsh-tooler', { name: 'dsh-tooler', dsh: { bundle: { patch: './cordis.patch.yml' } } })
    expect(hasClientHalf(fs, PROFILE, 'dsh-tooler')).toBe(false)
  })

  it('is false when the package declares no dsh section at all', () => {
    const fs = withManifest('dsh-tooler', { name: 'dsh-tooler' })
    expect(hasClientHalf(fs, PROFILE, 'dsh-tooler')).toBe(false)
  })

  it('is false when dsh.client is present but not an object — a non-declaration', () => {
    for (const value of [null, 'web', 42, ['web']]) {
      const fs = withManifest('dsh-odd', { name: 'dsh-odd', dsh: { client: value } })
      expect(hasClientHalf(fs, PROFILE, 'dsh-odd')).toBe(false)
    }
  })

  it('assumes a client half when the manifest cannot be read', () => {
    // Offering a reload nobody needed costs one keystroke; withholding one
    // that was needed is the defect this module exists to fix. The
    // asymmetry decides the fallback — it is not a judgement call.
    expect(hasClientHalf(memHotFs(), PROFILE, 'dsh-absent')).toBe(true)
  })

  it('assumes a client half when the manifest is not JSON', () => {
    const fs = memHotFs()
    fs.write(join(PROFILE, 'node_modules', 'dsh-broken', 'package.json'), '{ not json')
    expect(hasClientHalf(fs, PROFILE, 'dsh-broken')).toBe(true)
  })
})
