import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { MAX_INFLATED_BYTES, verifyReleaseAsset } from '../src/release-asset.ts'
import { packedTarball, rawTarball } from './packed-tarball.ts'


describe('verifyReleaseAsset', () => {
  // The acceptance cases below assert `toMatchObject({ ok: true })` rather than
  // an exact verdict: an accepted verdict also carries `installSize`, measured
  // from the members it just inflated, and every one of these cases is about
  // ACCEPTANCE and not about the figure. The two tests that are about the
  // figure assert it directly.
  it('accepts an asset that IS the package the entry declares', () => {
    const bytes = packedTarball('dsh-foo')
    // `installSize` rides the verdict: the archive is already inflated here to
    // verify it, so the figure costs nothing and is the ONLY honest one for a
    // release-pinned entry — the tarball is what installs, not the repository
    // tree at that commit.
    const verdict = verifyReleaseAsset(bytes, 'dsh-foo')
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.installSize).toBeGreaterThan(0)
  })

  it('measures the archive members, not the compressed asset', () => {
    // Differential, so the assertion cannot drift with whatever the fixture
    // happens to pack: one added member of known length must move the figure
    // by exactly its length. Asserting a total here would restate
    // `packedTarball`'s internals and break whenever it gains a member.
    //
    // It also pins UNPACKED rather than compressed. The two differ by the
    // compression ratio — measured across 16 npm packages at a median 2.88x
    // but ranging 1.01x to 5.91x — so a compressed figure under this label
    // would be wrong by up to 6x, and differently wrong per package.
    const base = verifyReleaseAsset(packedTarball('dsh-foo'), 'dsh-foo')
    const padded = verifyReleaseAsset(
      packedTarball('dsh-foo', {}, { 'package/extra.txt': 'x'.repeat(5000) }), 'dsh-foo',
    )
    expect(base.ok && padded.ok).toBe(true)
    if (base.ok && padded.ok) expect(padded.installSize - base.installSize).toBe(5000)
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
    expect(verifyReleaseAsset(rawTarball({
      'dsh-foo-1.0.0/package.json': manifest,
      'dsh-foo-1.0.0/p.yml': '- insert: []\n',
    }), 'dsh-foo')).toMatchObject({ ok: true })
  })

  it('accepts the ./ prefix that tar czf ./package emits', () => {
    const manifest = JSON.stringify({ name: 'dsh-foo', version: '1.0.0', dsh: { bundle: { patch: './p.yml' } } })
    expect(verifyReleaseAsset(rawTarball({
      './package/package.json': manifest,
      './package/p.yml': '- insert: []\n',
    }), 'dsh-foo')).toMatchObject({ ok: true })
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
    expect(verifyReleaseAsset(rawTarball({
      'package/package.json': manifest,
      'package/p.yml': '- insert: []\n',
    }), 'dsh-foo')).toMatchObject({ ok: true })
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

  it('refuses an asset whose declared dsh.bundle.patch is not in the archive', () => {
    // The third claim, tested by the only thing that can answer it: the
    // waiver is granted because the asset is presumed PREBUILT, so what has
    // to hold is that the file dsh is pointed at actually ships.
    const verdict = verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({ name: 'dsh-foo', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    }), 'dsh-foo')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.detail).toContain('does not contain it')
  })

  it('accepts an asset that ships the patch it declares', () => {
    expect(verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({ name: 'dsh-foo', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      'package/cordis.patch.yml': '- insert:\n    - id: foo\n      name: dsh-foo/host\n',
    }), 'dsh-foo')).toMatchObject({ ok: true })
  })

  // ── what the patch NAMES, not just the patch file ────────────────────────
  // The patch file shipping and the modules it inserts shipping are two
  // different claims, and the first does not imply the second.
  // `@open-design/dsh-runtime` committed cordis.patch.yml and gitignored
  // `dist/` (root .gitignore:2), so both entries it inserted resolved,
  // through `exports`, onto files no install could ever contain. It declared
  // no prepare/prepack either, so nothing would build them: the archive is
  // complete by every other rule here and still loads nothing.

  it('refuses an asset whose patch names a module the archive does not ship', () => {
    const verdict = verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0',
        exports: { '.': { types: './dist/types/index.d.ts', default: './dist/index.js' } },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert:\n    - id: foo\n      name: dsh-foo\n',
    }), 'dsh-foo')
    expect(verdict.ok).toBe(false)
    // Names the file, or the author cannot tell which build step never ran.
    if (!verdict.ok) expect(verdict.detail).toContain('dist/index.js')
  })

  it('accepts the same asset once it ships the module it names', () => {
    expect(verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0',
        exports: { '.': { types: './dist/types/index.d.ts', default: './dist/index.js' } },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert:\n    - id: foo\n      name: dsh-foo\n',
      'package/dist/index.js': 'export const x = 1',
    }), 'dsh-foo')).toMatchObject({ ok: true })
  })

  it('reads insert rows the hot-mount parser deliberately rejects', () => {
    // The real @open-design/dsh-runtime patch, reduced. `parseSimplePatch`
    // returns null for it twice over — a leading `config` row is not an
    // `insert` key, and `inject` is a key beyond the id/name pair it allows —
    // because it answers "can a hot tree replicate this?". That is a
    // different question from "which modules does this name?", so this rule
    // may not borrow that parser's answer.
    const verdict = verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0',
        exports: {
          '.': { default: './dist/index.js' },
          './startup': { default: './dist/startup.js' },
        },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': [
        '# a comment',
        '- id: system-prompt',
        '  config:',
        '    persona: >-',
        '      multi line scalar',
        '- id: hmr',
        '  disabled: true',
        '- insert:',
        '    - id: foo-startup',
        "      name: 'dsh-foo/startup'",
        '    - id: foo-runtime',
        "      name: 'dsh-foo'",
        '      inject: [fooStartup]',
        '',
      ].join('\n'),
      'package/dist/index.js': 'export const x = 1',
    }), 'dsh-foo')
    expect(verdict.ok).toBe(false)
    // dist/index.js ships; dist/startup.js does not.
    if (!verdict.ok) expect(verdict.detail).toContain('dist/startup.js')
  })

  it('does not refuse over a module belonging to another package', () => {
    // A patch legitimately inserts entries from its peers — the harness's own
    // agent, llm and session modules. Those are never in this archive and
    // requiring them here would refuse every real plugin.
    expect(verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        // An unshipped `main`, so mistaking a foreign name for ours REFUSES.
        // Without it this asserted nothing: nothing resolved either way.
        name: 'dsh-foo', version: '1.0.0', main: './dist/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert:\n    - id: a\n      name: "@deepseek-ai/dsh-agent"\n    - id: b\n      name: dsh-foo-other/x\n',
    }), 'dsh-foo')).toMatchObject({ ok: true })
  })

  it('falls back to main for the bare bundle name', () => {
    const verdict = verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0', main: 'lib/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert:\n    - id: foo\n      name: dsh-foo\n',
    }), 'dsh-foo')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.detail).toContain('lib/index.js')
  })

  it('ignores the types condition, whose absence breaks no install', () => {
    // A pack that omits its .d.ts still loads. Refusing on it would be the
    // prepare/prepack mistake again: a true statement about the archive that
    // is not a reason the plugin cannot run.
    expect(verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert:\n    - id: foo\n      name: dsh-foo\n',
      'package/dist/index.js': 'export const x = 1',
    }), 'dsh-foo')).toMatchObject({ ok: true })
  })

  it('does not refuse what it cannot resolve', () => {
    // Every arm here is a shape this rule does not model: a wildcard target,
    // a subpath with no exports map to resolve it, a subpath the map does not
    // list, and an unparseable patch. Refusing on any of them would be a
    // guess, and a guess in the confident direction is what delisted 90
    // working entries once already.
    for (const [manifest, patch] of [
      [{ exports: { './*': './dist/*.js' } }, '- insert:\n    - id: a\n      name: dsh-foo/x\n'],
      // Through `main`, not `exports`: the guards are shared, and the arm
      // above never reaches them — an unlisted subpath returns null first.
      [{ main: './dist/*.js' }, '- insert:\n    - id: a\n      name: dsh-foo\n'],
      [{ main: './../outside.js' }, '- insert:\n    - id: a\n      name: dsh-foo\n'],
      [{}, '- insert:\n    - id: a\n      name: dsh-foo/deep/x\n'],
      // Neither exports nor main: Node would try `index.js`, but the author
      // declared nothing, and this rule refuses only a declaration the pack
      // does not honour.
      [{}, '- insert:\n    - id: a\n      name: dsh-foo\n'],
      [{ exports: { '.': './dist/index.js' } }, '- insert:\n    - id: a\n      name: dsh-foo/unlisted\n'],
      [{ main: './dist/index.js' }, '- insert:\n  - id: a\n   name: broken indent\n'],
      [{ main: './dist/index.js' }, 'insert: not-a-list\n'],
      // A `..` segment is invalid in an exports target, so the package is
      // broken either way — but "the archive does not contain it" would be
      // the wrong reason, and a wrong reason is a defect here, not a nit.
      [{ exports: { '.': './../outside.js' } }, '- insert:\n    - id: a\n      name: dsh-foo\n'],
      // Past MAX_PATCH_BYTES the patch is not read. An unread patch is an
      // unanswered question, not a proven defect.
      [{ main: './dist/index.js' }, `- insert:\n    - id: a\n      name: dsh-foo\n${'#'.repeat(1024 * 1024)}\n`],
    ] as const) {
      expect(verifyReleaseAsset(rawTarball({
        'package/package.json': JSON.stringify({
          name: 'dsh-foo', version: '1.0.0', ...manifest,
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'package/cordis.patch.yml': patch,
      }), 'dsh-foo')).toMatchObject({ ok: true })
    }
  })

  // ── what the LOADER would select, not what we scan first ─────────────────
  // Review findings on PR #22, all three reproduced by importing the same
  // package contents in real Node: this rule refused four assets that load.
  // The correction is one idea — refuse only when NOTHING the loader could
  // possibly select is in the archive — rather than three special cases.

  it('accepts a conditions object whose selected arm ships, whatever the scan order', () => {
    // Node matches conditions in the object's DECLARATION order, so `node`
    // wins here and dist/node.js is what loads. A fixed default-first scan
    // read dist/browser.js, found it absent, and refused a working package.
    expect(verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0',
        exports: { node: './dist/node.js', default: './dist/browser.js' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert:\n    - id: a\n      name: dsh-foo\n',
      'package/dist/node.js': 'exports.ok=true',
    }), 'dsh-foo')).toMatchObject({ ok: true })
  })

  it('still refuses a conditions object when no arm at all ships', () => {
    // The other side of the same rule: "any reachable arm present" must not
    // become "any conditions object is excused".
    const verdict = verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0',
        exports: { node: './dist/node.js', default: './dist/browser.js' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert:\n    - id: a\n      name: dsh-foo\n',
    }), 'dsh-foo')
    expect(verdict.ok).toBe(false)
  })

  it('accepts a legacy main that resolves by extension or directory index', () => {
    // `main` is not an exact path: Node tries `<main>`, `<main>.js`, and
    // `<main>/index.js`. Both layouts import successfully in real Node, and
    // comparing the literal string refused both.
    for (const main of ['./dist/index', './dist']) {
      expect(verifyReleaseAsset(rawTarball({
        'package/package.json': JSON.stringify({
          name: 'dsh-foo', version: '1.0.0', main,
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'package/cordis.patch.yml': '- insert:\n    - id: a\n      name: dsh-foo\n',
        'package/dist/index.js': 'exports.ok=true',
      }), 'dsh-foo')).toMatchObject({ ok: true })
    }
  })

  it('still refuses a legacy main when no lookup candidate ships', () => {
    const verdict = verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0', main: './dist/index',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert:\n    - id: a\n      name: dsh-foo\n',
    }), 'dsh-foo')
    expect(verdict.ok).toBe(false)
  })

  it('resolves percent-escapes in an exports target before comparing members', () => {
    // An `exports` target is a relative URL, so `%20` is a space on disk.
    // Stripping only the leading `./` searched for a member that cannot
    // exist and called a shipped file missing build output.
    expect(verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0', exports: './dist/my%20plugin.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert:\n    - id: a\n      name: dsh-foo\n',
      'package/dist/my plugin.js': 'exports.ok=true',
    }), 'dsh-foo')).toMatchObject({ ok: true })
  })

  it('refuses a pack that ships only its type declarations', () => {
    // What skipping `types` is FOR, now that "any reachable arm present"
    // would otherwise let a .d.ts excuse a missing runtime module. A types
    // arm is not something the loader can run.
    const verdict = verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert:\n    - id: a\n      name: dsh-foo\n',
      'package/dist/index.d.ts': 'export const ok: boolean',
    }), 'dsh-foo')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.detail).toContain('dist/index.js')
  })

  it('does not refuse a target whose percent-escape cannot be decoded', () => {
    // `decodeURIComponent('%zz')` throws. An undecodable target is a shape
    // this rule cannot resolve, which is never a refusal.
    expect(verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0', exports: './dist/%zz.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert:\n    - id: a\n      name: dsh-foo\n',
    }), 'dsh-foo')).toMatchObject({ ok: true })
  })

  it('still refuses an escape that only appears after decoding', () => {
    // `%2e%2e` decodes to `..`, so the containment check has to run on the
    // DECODED path or the decode step reopens what it guarded.
    expect(verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0', exports: './%2e%2e/outside.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert:\n    - id: a\n      name: dsh-foo\n',
    }), 'dsh-foo')).toMatchObject({ ok: true })
  })

  it('does not treat a non-string insert name as a module name', () => {
    // A YAML list coerces to exactly the bundle name (`String(['dsh-foo'])`
    // is `'dsh-foo'`), so a rule that coerced instead of shape-checking would
    // resolve it and refuse. The loader takes only a string `name`, so this
    // row registers nothing and the archive's contents are not the defect.
    expect(verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0', main: './dist/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert:\n    - id: a\n      name: [dsh-foo]\n',
    }), 'dsh-foo')).toMatchObject({ ok: true })
  })

  it('survives a patch whose aliases make a cyclic structure', () => {
    // `- insert: &a [*a]` parses into an array containing itself. Anything
    // that walked the parsed tree looking for a `name` would not return.
    expect(() => verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0', main: './dist/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert: &a [*a]\n',
    }), 'dsh-foo')).not.toThrow()
  })

  it('does NOT refuse an asset merely for declaring a prepare or prepack script', () => {
    // The correction that matters most in this file. `npm pack` RUNS those
    // scripts, ships the built output, and leaves the scripts in the
    // manifest — so nearly every correctly packed package still declares
    // one, and pnpm does not run them for a tarball install. Refusing on
    // their presence delisted 90 working entries in a dry run against the
    // live catalog, every one of which ships compiled output beside the
    // script. Do not reintroduce it.
    for (const scripts of [{ prepare: 'tsc' }, { prepack: 'npm run build' }]) {
      expect(verifyReleaseAsset(rawTarball({
        'package/package.json': JSON.stringify({
          name: 'dsh-foo', version: '1.0.0', scripts,
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'package/cordis.patch.yml': '- insert: []\n',
        'package/lib/index.js': 'export const x = 1',
      }), 'dsh-foo')).toMatchObject({ ok: true })
    }
  })

  it('refuses unresolved workspace: specifiers, which pnpm pack would have rewritten', () => {
    // Unlike the script field, this one IS evidence: `pnpm pack` rewrites
    // `workspace:` into resolved ranges, so a tarball still carrying them was
    // not packed that way and cannot resolve outside its own workspace.
    // Re-measured 2026-09-07 against the 176 rescued assets of the
    // 2026.906.18 catalog: it fires on ONE, dsh-yizi-themes. The comment here
    // said "none" — true when written, false now, and a stale measurement in
    // a committed comment is the drift CLAUDE.md warns about.
    const verdict = verifyReleaseAsset(rawTarball({
      'package/package.json': JSON.stringify({
        name: 'dsh-foo', version: '1.0.0', dependencies: { a: 'workspace:*' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
      'package/cordis.patch.yml': '- insert: []\n',
    }), 'dsh-foo')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.detail).toContain('workspace:-protocol')
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
