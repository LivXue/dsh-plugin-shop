import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRunningHarness } from '../../src/host/harness.ts'
import { fileTempRoot } from './temp-root.ts'

const TEMP_ROOT = fileTempRoot('harness')

// Every fixture below lives under TEMP_ROOT, and the app-boot lookup walks up
// from the dsh package to the filesystem root — past TEMP_ROOT into whatever
// the machine holds above it (the one this was written on carries a stray
// /tmp/node_modules with harness packages in it). An empty
// `node_modules/@deepseek-ai/dsh-app-boot` here ends every such walk: the
// lookup matches the directory, finds no manifest in it, and reads absent
// without looking further, exactly as the ESM loader stops at it. So "no
// app-boot" in a fixture means none on its whole resolution path, on every
// machine, and a fixture's own copy — always deeper — is found first.
mkdirSync(join(TEMP_ROOT, 'node_modules', '@deepseek-ai', 'dsh-app-boot'), { recursive: true })

/** `PROFILE_TEMPLATES` as dsh-app-boot 0.1.5-rc.3 exports it, verbatim. */
const RC3_EXPORT = {
  acp: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'], patchReload: 'startup' },
  web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' },
  headless: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'], patchReload: 'startup' },
  sdk: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'], patchReload: 'startup' },
  'sdk-minimal': { bundles: ['@deepseek-ai/dsh-sdk-minimal'], patchReload: 'startup' },
}

/** What `profileTemplatesOf` makes of `RC3_EXPORT`. */
const RC3_TABLE = {
  acp: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  sdk: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  'sdk-minimal': ['@deepseek-ai/dsh-sdk-minimal'],
}

/** The older shape — a template IS its bundle list — with a table no real
 * app-boot ships, so an answer carrying it can only have come from the copy
 * that wrote it. */
const MARKED_EXPORT = { 'fixture-only': ['@dsh-harness-fixture/bundle'] }

/**
 * The dsh CLI installed under `<root>/node_modules`, the way npm installs a
 * global package: `@deepseek-ai/dsh/package.json` plus the `lib/bin.js` its
 * `bin` names. Returns the package directory and the script, which is what
 * `process.argv[1]` resolves to when dsh runs. The script is never executed.
 */
function installDsh(root: string, manifest: Record<string, unknown> = { version: '0.1.5-rc.3' }): { dshDir: string; bin: string } {
  const dshDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(dshDir, 'lib'), { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module', bin: { dsh: 'lib/bin.js' }, ...manifest }))
  const bin = join(dshDir, 'lib', 'bin.js')
  writeFileSync(bin, '')
  return { dshDir, bin }
}

/**
 * A dsh-app-boot in `nodeModules` whose entry exports `PROFILE_TEMPLATES` and
 * nothing else — the manifest shaped as 0.1.5-rc.3's is, `main` and `exports`
 * both naming the entry. `entry` replaces the module's source.
 */
function installAppBoot(nodeModules: string, templates: unknown, entry?: string): string {
  const dir = join(nodeModules, '@deepseek-ai', 'dsh-app-boot')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-app-boot',
    version: '0.1.5-rc.3',
    type: 'module',
    main: 'lib/index.js',
    exports: { '.': { default: './lib/index.js' }, './package.json': './package.json' },
  }))
  writeFileSync(join(dir, 'lib', 'index.js'), entry ?? `export const PROFILE_TEMPLATES = ${JSON.stringify(templates)}\n`)
  return dir
}

describe('readRunningHarness', () => {
  it('reads the version and the template table of the dsh that owns the script', async () => {
    // npm's global layout: app-boot nested under the dsh package itself.
    const { dshDir, bin } = installDsh(mkdtempSync(join(TEMP_ROOT, 'nested-')))
    installAppBoot(join(dshDir, 'node_modules'), RC3_EXPORT)

    expect(await readRunningHarness(bin)).toEqual({ dshVersion: '0.1.5-rc.3', templates: RC3_TABLE })
  })

  it('finds app-boot as a sibling of the dsh package, where pnpm and a hoisting install put it', async () => {
    const root = mkdtempSync(join(TEMP_ROOT, 'sibling-'))
    const { bin } = installDsh(root)
    installAppBoot(join(root, 'node_modules'), MARKED_EXPORT)

    expect(await readRunningHarness(bin)).toEqual({ dshVersion: '0.1.5-rc.3', templates: MARKED_EXPORT })
  })

  it('reads the copy dsh itself imports when there are two: the nested one', async () => {
    // Walking up from the dsh package meets its own node_modules first, as
    // dsh's own `import '@deepseek-ai/dsh-app-boot'` does; a copy hoisted
    // beside it from some other package's dependencies is not the one running.
    const root = mkdtempSync(join(TEMP_ROOT, 'shadowed-'))
    const { dshDir, bin } = installDsh(root)
    installAppBoot(join(dshDir, 'node_modules'), RC3_EXPORT)
    installAppBoot(join(root, 'node_modules'), MARKED_EXPORT)

    expect((await readRunningHarness(bin)).templates).toEqual(RC3_TABLE)
  })

  it.skipIf(process.platform === 'win32')('resolves a symlinked bin through realpath to the package that owns it', async () => {
    // `process.argv[1]` is the path the shell ran, and a global npm install
    // runs `<prefix>/bin/dsh`, a link into `<prefix>/lib/node_modules`. The
    // link's own directory is owned by no package; only its target is dsh's.
    // POSIX only: a Windows file symlink needs elevation or Developer Mode,
    // and npm installs `.cmd` shims there, which pass the real path anyway.
    const prefix = mkdtempSync(join(TEMP_ROOT, 'prefix-'))
    const { dshDir, bin } = installDsh(join(prefix, 'lib'))
    installAppBoot(join(dshDir, 'node_modules'), RC3_EXPORT)
    const shim = join(prefix, 'bin', 'dsh')
    mkdirSync(dirname(shim), { recursive: true })
    symlinkSync(bin, shim)

    expect(await readRunningHarness(shim)).toEqual({ dshVersion: '0.1.5-rc.3', templates: RC3_TABLE })
  })

  it('knows nothing when there is no script, or none it can resolve', async () => {
    const missing = join(mkdtempSync(join(TEMP_ROOT, 'missing-')), 'lib', 'bin.js')
    for (const script of [undefined, missing, 'bad\0path']) {
      expect(await readRunningHarness(script), JSON.stringify(script)).toEqual({ dshVersion: null, templates: {} })
    }
  })

  it('reads an empty script as none, not as the working directory', async () => {
    // `realpathSync('')` answers the working directory, so an empty path
    // would name whatever package dsh happened to be started inside. Run from
    // inside a real dsh fixture, which is what that would read.
    const { dshDir } = installDsh(mkdtempSync(join(TEMP_ROOT, 'empty-')))
    installAppBoot(join(dshDir, 'node_modules'), RC3_EXPORT)
    const cwd = process.cwd()
    process.chdir(join(dshDir, 'lib'))
    try {
      expect(await readRunningHarness('')).toEqual({ dshVersion: null, templates: {} })
    } finally {
      process.chdir(cwd)
    }
  })

  it('knows nothing when the script belongs to some other package', async () => {
    // A test runner, another host embedding the shop: nothing then says which
    // harness runs, and both halves of the verdict go silent. The owner here
    // sits beside a real dsh install with an app-boot, so neither half could
    // be read by accident from the directory around it.
    const root = mkdtempSync(join(TEMP_ROOT, 'other-'))
    const { dshDir } = installDsh(root)
    installAppBoot(join(dshDir, 'node_modules'), RC3_EXPORT)
    const runner = join(root, 'node_modules', 'tinypool')
    mkdirSync(join(runner, 'dist', 'entry'), { recursive: true })
    writeFileSync(join(runner, 'package.json'), JSON.stringify({ name: 'tinypool', version: '1.1.1' }))
    writeFileSync(join(runner, 'dist', 'entry', 'process.js'), '')

    expect(await readRunningHarness(join(runner, 'dist', 'entry', 'process.js'))).toEqual({ dshVersion: null, templates: {} })
  })

  it('stops at the first manifest above the script, and never climbs past it to a dsh', async () => {
    // The package that OWNS the script is the nearest package.json at or above
    // it, and only that one — `owningEntry` in dsh-cli.ts follows the same
    // rule. A package vendored inside dsh's own tree owns its own scripts.
    const { dshDir } = installDsh(mkdtempSync(join(TEMP_ROOT, 'vendored-')))
    installAppBoot(join(dshDir, 'node_modules'), RC3_EXPORT)
    const vendored = join(dshDir, 'lib', 'vendor')
    mkdirSync(vendored, { recursive: true })
    writeFileSync(join(vendored, 'package.json'), JSON.stringify({ name: 'bundled-helper', version: '1.0.0' }))
    writeFileSync(join(vendored, 'entry.js'), '')

    expect(await readRunningHarness(join(vendored, 'entry.js'))).toEqual({ dshVersion: null, templates: {} })
  })

  it('walks past a package.json that is not a file, and stops at one it cannot parse', async () => {
    // A manifest is a `package.json` FILE; a directory spelled that way owns
    // nothing, so the walk goes on up to dsh's. But a manifest file that
    // cannot be read or parsed is still the owner — an owner nobody can name,
    // which is no harness, never a licence to climb into an ancestor.
    const walked = installDsh(mkdtempSync(join(TEMP_ROOT, 'manifest-dir-')))
    mkdirSync(join(walked.dshDir, 'lib', 'package.json'))
    expect((await readRunningHarness(walked.bin)).dshVersion).toBe('0.1.5-rc.3')

    const stopped = installDsh(mkdtempSync(join(TEMP_ROOT, 'manifest-bad-')))
    writeFileSync(join(stopped.dshDir, 'lib', 'package.json'), '{not json')
    expect(await readRunningHarness(stopped.bin)).toEqual({ dshVersion: null, templates: {} })
  })

  it('reads a version only when the manifest carries a non-empty string, and keeps the templates either way', async () => {
    // The version and the table are separate facts: a manifest without a
    // usable version costs the range half its verdict, not the profile half.
    // Whether a string is semver is `compatibilityMap`'s question, so
    // `nightly` passes through here and forms no verdict there.
    for (const [version, expected] of [[undefined, null], ['', null], [7, null], [null, null], ['nightly', 'nightly']] as const) {
      const { dshDir, bin } = installDsh(mkdtempSync(join(TEMP_ROOT, 'version-')), { version })
      installAppBoot(join(dshDir, 'node_modules'), MARKED_EXPORT)
      expect(await readRunningHarness(bin), JSON.stringify(version)).toEqual({ dshVersion: expected, templates: MARKED_EXPORT })
    }
  })

  it('keeps the version when the template table cannot be read', async () => {
    // Every way app-boot can fail to supply a table — none installed, an entry
    // that throws on import, an export of the wrong name — costs the profile
    // half and nothing else.
    const cases: Array<[string, (dshDir: string) => void]> = [
      ['no app-boot', () => {}],
      ['an entry that throws', dshDir => { installAppBoot(join(dshDir, 'node_modules'), null, 'throw new Error("app-boot fixture")\n') }],
      ['no PROFILE_TEMPLATES export', dshDir => { installAppBoot(join(dshDir, 'node_modules'), null, 'export const SOMETHING_ELSE = {}\n') }],
    ]
    for (const [label, stage] of cases) {
      const { dshDir, bin } = installDsh(mkdtempSync(join(TEMP_ROOT, 'no-table-')))
      stage(dshDir)
      expect(await readRunningHarness(bin), label).toEqual({ dshVersion: '0.1.5-rc.3', templates: {} })
    }
  })

  it('never looks app-boot up through NODE_PATH', () => {
    // pnpm's bin shims export NODE_PATH — this suite's own vitest shim points
    // it into the repository's virtual store, which holds a dsh-app-boot — and
    // a CJS lookup of the bare name finds a package there from ANY directory.
    // So the lookup is the ESM-style walk from the dsh package, and only the
    // resolved directory ever reaches the CJS resolver. CJS reads NODE_PATH
    // once, at process start, so this runs in a child that starts with one
    // pointing at an app-boot of its own: CJS finds that copy (the control),
    // the reader does not — while a fixture that DOES carry app-boot is read
    // in the same child, so the empty answer is not a reader that reads
    // nothing.
    const root = mkdtempSync(join(TEMP_ROOT, 'node-path-'))
    const global = join(root, 'global')
    installAppBoot(global, MARKED_EXPORT)
    const without = installDsh(join(root, 'without'))
    const withAppBoot = installDsh(join(root, 'with'))
    installAppBoot(join(withAppBoot.dshDir, 'node_modules'), RC3_EXPORT)
    const harness = new URL('../../src/host/harness.ts', import.meta.url).href
    // Matched on its tail: a resolved path may spell the temp root differently
    // from the one `mkdtemp` returned (a Windows runner's short 8.3 names).
    const globalEntry = join('global', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
    const script = [
      `import { createRequire } from 'node:module'`,
      `const { readRunningHarness } = await import(${JSON.stringify(harness)})`,
      `const cjs = createRequire(${JSON.stringify(without.bin)}).resolve('@deepseek-ai/dsh-app-boot')`,
      `console.log(JSON.stringify({`,
      `  cjs: cjs.endsWith(${JSON.stringify(globalEntry)}),`,
      `  without: await readRunningHarness(${JSON.stringify(without.bin)}),`,
      `  with: await readRunningHarness(${JSON.stringify(withAppBoot.bin)}),`,
      `}))`,
    ].join('\n')
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, NODE_PATH: global },
      encoding: 'utf8',
    })

    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({
      cjs: true,
      without: { dshVersion: '0.1.5-rc.3', templates: {} },
      with: { dshVersion: '0.1.5-rc.3', templates: RC3_TABLE },
    })
  })
})
