import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { verifyReleaseAsset } from '../src/release-asset.ts'
import { packedTarball, rawTarball } from './packed-tarball.ts'


describe('verifyReleaseAsset', () => {
  it('accepts an asset that IS the package the entry declares', () => {
    const bytes = packedTarball('dsh-foo')
    expect(verifyReleaseAsset(bytes, 'dsh-foo')).toEqual({ ok: true })
  })

  it('refuses an asset packing a DIFFERENT package', () => {
    // Measured on the live catalog: yjh051108/dsh-routing-suite declares
    // @dsh-external/dsh-super-injector at its root and its only release asset
    // is a packed @dsh-external/dsh-graded-mode. The install put graded-mode
    // in the profile, the declared bundle never landed, and the confirm
    // failed — the card could never work.
    const bytes = packedTarball('@dsh-external/dsh-graded-mode', { version: '0.0.1-rc1' })
    const verdict = verifyReleaseAsset(bytes, '@dsh-external/dsh-super-injector')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      // Both names, or the author cannot tell which asset to fix.
      expect(verdict.detail).toContain('@dsh-external/dsh-graded-mode')
      expect(verdict.detail).toContain('@dsh-external/dsh-super-injector')
    }
  })

  it('refuses an asset that merely adds a scope, which is a different manifest key', () => {
    // cc-dsh-notifier's asset packs @baobaolaodie/cc-dsh-notifier. pnpm keys
    // the profile by the packed name, so the bundle lands nowhere the shop
    // looks.
    const bytes = packedTarball('@baobaolaodie/cc-dsh-notifier', { version: '0.1.5' })
    expect(verifyReleaseAsset(bytes, 'cc-dsh-notifier').ok).toBe(false)
  })

  it('refuses a rightly-named asset that declares no dsh.bundle', () => {
    // get-fable: the name matches, so a filename check clears it, and the
    // asset is not a plugin at all. `no-bundle` is checked on the repo's ROOT
    // manifest, so the rescue path walked straight past the rule that exists
    // to kill a silent no-op install.
    const bytes = packedTarball('get-fable', { dsh: undefined })
    const verdict = verifyReleaseAsset(bytes, 'get-fable')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.detail).toContain('dsh.bundle')
  })

  it('refuses an archive carrying no package manifest at all', () => {
    // dhs-multi-agent's asset is a Python sdist
    // (deepseek_multi_agent_plugin-1.0.1.tar.gz).
    const bytes = rawTarball({ 'deepseek_multi_agent_plugin-1.0.1/PKG-INFO': 'Metadata-Version: 2.1\n' })
    expect(verifyReleaseAsset(bytes, 'dhs-multi-agent').ok).toBe(false)
  })

  it('refuses bytes that are not a readable gzipped tar', () => {
    // The probe hands over whatever the release asset was; an author may
    // attach a zip, an installer, or a truncated upload.
    expect(verifyReleaseAsset(Buffer.from('not a tarball'), 'dsh-foo').ok).toBe(false)
  })

  it('refuses an asset whose manifest is not readable JSON', () => {
    const bytes = rawTarball({ 'package/package.json': '{ this is not json' })
    expect(verifyReleaseAsset(bytes, 'dsh-foo').ok).toBe(false)
  })

  it('never throws, whatever the bytes are', () => {
    // The rescue is advisory: its fallback is the unchanged requires-build
    // rejection, so nothing here may take the daily harvest down.
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(512), gzipSync(Buffer.alloc(3))]) {
      expect(() => verifyReleaseAsset(bytes, 'dsh-foo')).not.toThrow()
    }
  })
})
