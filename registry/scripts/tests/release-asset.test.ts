import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { MAX_INFLATED_BYTES, verifyReleaseAsset } from '../src/release-asset.ts'
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

  it('refuses a decoy root instead of trusting archive order', () => {
    // The bypass this rule exists for. npm and pnpm extract with `strip: 1`,
    // so `aaa/package.json` and `package/package.json` BOTH become
    // `package.json` on disk and the LAST one written wins — reading the first
    // depth-2 manifest verified one package while pnpm installed the other,
    // and the sha256 is over these exact bytes so the host's integrity gate
    // passed by construction.
    const good = JSON.stringify({ name: 'dsh-good', version: '1.0.0', dsh: { bundle: { patch: './p.yml' } } })
    const evil = JSON.stringify({ name: 'evil-pkg', version: '9.9.9' })
    const verdict = verifyReleaseAsset(rawTarball({
      'aaa/package.json': good,
      'package/package.json': evil,
      'package/payload.js': 'globalThis.pwned = true',
    }), 'dsh-good')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.detail).toContain('top-level directories')
  })

  it('accepts the one-root layout npm pack actually emits, whatever the root is called', () => {
    // The rule is "exactly one root", not "a root named package": the
    // component is stripped, so its name never reaches disk.
    const manifest = JSON.stringify({ name: 'dsh-foo', version: '1.0.0', dsh: { bundle: { patch: './p.yml' } } })
    expect(verifyReleaseAsset(rawTarball({ 'dsh-foo-1.0.0/package.json': manifest }), 'dsh-foo')).toEqual({ ok: true })
  })

  it('accepts the ./ prefix that tar czf ./package emits', () => {
    const manifest = JSON.stringify({ name: 'dsh-foo', version: '1.0.0', dsh: { bundle: { patch: './p.yml' } } })
    expect(verifyReleaseAsset(rawTarball({ './package/package.json': manifest }), 'dsh-foo')).toEqual({ ok: true })
  })

  it('refuses a root-level manifest with the reason that is actually true', () => {
    // `{'package.json': …}` IS at the root, so "carries no package.json at
    // its root" was false. Under strip:1 it has no component left and would
    // land nowhere.
    const manifest = JSON.stringify({ name: 'dsh-foo', version: '1.0.0', dsh: { bundle: { patch: './p.yml' } } })
    const verdict = verifyReleaseAsset(rawTarball({ 'package.json': manifest }), 'dsh-foo')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.detail).toContain('no top-level directory')
  })

  it('reads a manifest saved with a UTF-8 BOM, which npm itself tolerates', () => {
    // Refusing it — and calling the archive unreadable — would report our
    // parser's strictness as the author's defect, for an asset pnpm installs
    // without complaint.
    const manifest = `\ufeff${JSON.stringify({ name: 'dsh-foo', version: '1.0.0', dsh: { bundle: { patch: './p.yml' } } })}`
    expect(verifyReleaseAsset(rawTarball({ 'package/package.json': manifest }), 'dsh-foo')).toEqual({ ok: true })
  })

  it.each([false, 0, '', null, [], 'yes'])('refuses dsh.bundle: %o, which registers no plugin', (bundle) => {
    // `!== undefined` admitted every one of these. None registers a plugin,
    // so the rescue would have re-admitted the silent no-op install that
    // `no-bundle` exists to kill — one JSON literal from the get-fable case.
    const bytes = packedTarball('dsh-foo', { dsh: { bundle } })
    const verdict = verifyReleaseAsset(bytes, 'dsh-foo')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.detail).toContain('dsh.bundle object')
  })

  it.each([
    ['a prepare script', { scripts: { prepare: 'tsc' } }, 'prepare script'],
    ['a prepack script', { scripts: { prepack: 'npm run build' } }, 'prepack script'],
    ['unresolved workspace: deps', { dependencies: { a: 'workspace:*' } }, 'workspace:-protocol'],
  ])('refuses an asset that is a source tree, not a prebuilt package — %s', (_label, extra, expected) => {
    // The third claim the rescue carries. The waiver of
    // requires-build/workspace-deps is granted ONLY because a release asset
    // is presumed prebuilt; a plain `tar czf` of a source tree earned it and
    // landed unbuilt, with its dsh.bundle.patch target absent.
    const verdict = verifyReleaseAsset(packedTarball('dsh-foo', extra), 'dsh-foo')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.detail).toContain(expected)
  })

  it('refuses an array manifest with a reason about the manifest, not the packing', () => {
    const verdict = verifyReleaseAsset(rawTarball({ 'package/package.json': '[1,2,3]' }), 'dsh-foo')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.detail).toContain('not a JSON object')
      // "packs (unnamed)" told the author to re-pack when the fix is to
      // repair an invalid package.json.
      expect(verdict.detail).not.toContain('unnamed')
    }
  })

  it('bounds a hostile name instead of echoing a megabyte into a committed file', () => {
    // This detail becomes `releaseRejected`, which the daily workflow commits
    // into repo-state.json verbatim and appends to the published reason.
    const verdict = verifyReleaseAsset(packedTarball('x'.repeat(200_000)), 'dsh-foo')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.detail.length).toBeLessThan(400)
  })

  it('refuses a compressed bomb instead of being OOM-killed by it', () => {
    // The one input class that can take the daily build down: an OOM kill is
    // not catchable, so no `catch` here or in the probe could degrade it to
    // the requires-build fallback, and the build would publish no report at
    // all. `not.toThrow()` can never observe that, which is why this asserts
    // the verdict.
    const verdict = verifyReleaseAsset(gzipSync(Buffer.alloc(MAX_INFLATED_BYTES + 1)), 'dsh-foo')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.detail).toContain('inflates past')
  })

  it('never throws, whatever the bytes are', () => {
    // The rescue is advisory: its fallback is the unchanged requires-build
    // rejection, so nothing here may take the daily harvest down.
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(512), gzipSync(Buffer.alloc(3))]) {
      expect(() => verifyReleaseAsset(bytes, 'dsh-foo')).not.toThrow()
    }
  })
})
