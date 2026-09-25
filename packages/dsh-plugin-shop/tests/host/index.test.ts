import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ShopGateway, { verifyTarballSha256 } from '../../src/host/index.ts'
import { nodeVersionResolver } from '../../src/host/peers.ts'
import { ownPeerRanges } from '../../src/own-version.ts'
import type { InventoryEntry, LoaderEntryLike, RestartBlockedReason, ShopGatewayOptions, ShopInstallStatusResult } from '../../src/host/index.ts'
import type { HotMountResult } from '../../src/host/hot.ts'
import type { CatalogResult, CatalogSnapshot, LoadCatalogOptions } from '../../src/host/catalog.ts'
import type { CatalogEntry } from '../../src/host/types.ts'
import { startInstall } from '../../src/host/executor.ts'
import { createPrefetcher, type Prefetcher } from '../../src/host/prefetch.ts'
import { isTerminalInstallState } from '../../src/shared/install-state.ts'
import { fakeDsh, fakeDshRecording, fakeDshRemovingManifest } from '../fixtures/fake-dsh.ts'
import { fakePnpm } from '../fixtures/fake-pnpm.ts'
import { fileTempRoot } from './temp-root.ts'
import { memHotFs } from './mem-fs.ts'

const TEMP_ROOT = fileTempRoot('index')

/**
 * The gateway's own download phase, pinned to a fixture `pnpm` for this whole
 * file — the same substitution the `dshBin` option already makes for the CLI.
 *
 * A gateway left with the production pump (whose `pnpmBin` is the bare name
 * `pnpm`) runs a real `pnpm store add <name>@<version>` for every install that
 * finds a command already queued for its profile: a live request to
 * registry.npmjs.org, measured at 1.4s for a fixture name that resolves to
 * nothing, and a real download of `dsh-plugin-shop@<version>` in the
 * self-update cases. The profile those batches run in exists — the file pins
 * DSH_HOME to a fixture home — so nothing about this is inert.
 *
 * One fresh pump AND one fresh fixture binary per gateway, not one of either
 * per file: the pump batches per profile inside itself, so sharing one
 * instance across cases would let one case's batch serve another's install —
 * and a shared binary would append every case's batch to one `pnpm.log`.
 */
function fixturePnpmBin(): string {
  return fakePnpm(mkdtempSync(join(TEMP_ROOT, 'dsh-gateway-pnpm-')))
}

function fixturePrefetcher(): Prefetcher {
  return createPrefetcher({ pnpmBin: fixturePnpmBin() })
}

// The install tests drive the full §7.2 path including the post-install
// confirm, which re-reads the profile manifest through app-boot's
// resolveProfileDir honoring DSH_HOME. Pin it to a fixture home whose `web`
// profile manifest already looks like the installs succeeded, so the exit-0
// fixture dsh passes the confirm without any dsh reconcile. Each test file
// runs in its own vitest worker, so the pin never leaves this file.
//
// BOTH halves are required, because the confirm now establishes change and
// not just membership: a real `dsh plugin add X` writes `dependencies[X]` AND
// appends to `dsh.profile.bundles`, so a fixture carrying only the bundle row
// models an install that never happened. It used to pass anyway, which is
// how a stricter confirm could not be told from a broken one.
const INSTALLED_BY_FIXTURE = ['dsh-hello-plugin', 'dsh-repo-plugin', 'sub-plugin', 'dsh-rescued', 'dsh-plugin-shop']
const shopHome = mkdtempSync(join(TEMP_ROOT, 'dsh-gateway-home-'))
process.env.DSH_HOME = shopHome
mkdirSync(join(shopHome, 'profiles', 'web'), { recursive: true })
writeFileSync(join(shopHome, 'profiles', 'web', 'package.json'), JSON.stringify({
  dependencies: Object.fromEntries(INSTALLED_BY_FIXTURE.map(name => [name, '1.0.0'])),
  dsh: { profile: { bundles: INSTALLED_BY_FIXTURE } },
}))

afterAll(() => {
  delete process.env.DSH_HOME
  rmSync(shopHome, { recursive: true, force: true })
})

describe('two catalog entries share one name (G-1)', () => {
  const aliceCommit = 'a'.repeat(40)
  const bobCommit = 'b'.repeat(40)
  const alice: CatalogEntry = {
    name: 'dsh-foo', version: aliceCommit, integrity: aliceCommit, publishedAt: null,
    repository: 'https://github.com/alice/dsh-foo', license: 'MIT',
    tier: 'community', metadata: 'derived', source: 'github', repo: 'alice/dsh-foo',
    added: '2026-08-25',
  }
  const bob: CatalogEntry = { ...alice, version: bobCommit, integrity: bobCommit, repo: 'bob/dsh-foo' }

  function gatewayWithBoth(dir: string, dependencies: Record<string, string>): ShopGateway {
    const bin = fakeDshRecording(dir, 0, { silent: true })
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-dup-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies }))
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 6, builtAt: '', entries: [alice, bob], denied: [], stars: {} }, stale: false }) as CatalogResult,
      dshBin: bin,
      prefetcher: fixturePrefetcher(),
    })
  }

  it('spawns the identity that was asked for, not the first entry with the name', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-dup-install-'))
    const gateway = gatewayWithBoth(dir, {})
    const result = await gateway.install({
      name: 'dsh-foo', version: bobCommit, acknowledged: true,
      source: 'github', repo: 'bob/dsh-foo',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const deadline = Date.now() + 5000
    let terminal = gateway.installStatus({ installId: result.installId })
    while (!isTerminalInstallState(terminal.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      terminal = gateway.installStatus({ installId: result.installId })
    }
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8')
    expect(calls).toContain(`add github:bob/dsh-foo#${bobCommit}`)
    expect(calls).not.toContain('alice/dsh-foo')
    expect(JSON.parse(readFileSync(join(dir, 'cache/github-pins.json'), 'utf8')))
      .toEqual({ 'github:bob/dsh-foo#': bobCommit })
  })

  it('refuses a name-only install request while two entries share the name', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-dup-ambiguous-'))
    const gateway = gatewayWithBoth(dir, {})
    const result = await gateway.install({ name: 'dsh-foo', version: bobCommit, acknowledged: true })
    expect(result).toMatchObject({ ok: false, code: 'ambiguous-identity' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(join(dir, 'calls.log'))).toBe(false)
  })

  it('reports one row for the repository that is actually installed', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-dup-installed-'))
    mkdirSync(join(dir, 'cache'), { recursive: true })
    writeFileSync(join(dir, 'cache/github-pins.json'), JSON.stringify({ 'github:bob/dsh-foo#': bobCommit }))
    const gateway = gatewayWithBoth(dir, { 'dsh-foo': 'github:bob/dsh-foo' })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{
      name: 'dsh-foo', source: 'github', repo: 'bob/dsh-foo',
      installed: bobCommit, latest: bobCommit, outdated: false, enabled: true,
    }])
  })

  it('does not let an npm namesake claim a repo entry\'s installed row', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-dup-npm-'))
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-dup-npm-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', dsh: { profile: { bundles: [] } },
      dependencies: { 'dsh-foo': 'github:bob/dsh-foo' },
    }))
    const npmTwin: CatalogEntry = {
      ...alice, version: '2.0.0', integrity: 'sha512-x', source: 'npm', repo: undefined,
    }
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 6, builtAt: '', entries: [npmTwin, bob], denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{
      name: 'dsh-foo', source: 'github', repo: 'bob/dsh-foo',
      installed: 'github:bob/dsh-foo', latest: bobCommit, outdated: false, enabled: true,
    }])
  })

  it('forgets the identity pin on uninstall', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-dup-uninstall-'))
    mkdirSync(join(dir, 'cache'), { recursive: true })
    writeFileSync(join(dir, 'cache/github-pins.json'), JSON.stringify({
      'github:bob/dsh-foo#': bobCommit, 'github:alice/dsh-foo#': aliceCommit,
    }))
    const gateway = gatewayWithBoth(dir, { 'dsh-foo': 'github:bob/dsh-foo' })
    await gateway.catalog({})
    const result = await gateway.uninstall({ name: 'dsh-foo' })
    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'cache/github-pins.json'), 'utf8')))
      .toEqual({ 'github:alice/dsh-foo#': aliceCommit })
  })
})

function stubCtx(): never {
  return { get: () => undefined, reflect: { provide: () => {} } } as never
}

/** Materialize an installed package with the bundle patch it declares, the
 * shape the loader actually composes: the shop resolves a package's rows
 * through its patch's inserted ids, never through the entry's module name. */
/**
 * @param client the package's `dsh.client` declaration, merged into the same
 *   `dsh` object as the bundle patch. A parameter rather than a hand-written
 *   manifest per site: overwriting the manifest this function already wrote
 *   silently drops the bundle patch with it, which leaves `ownedEntryIds`
 *   empty and the live-disable arm of whatever test did it inert — passing
 *   for a reason unrelated to what it asserts.
 */
function fixturePackage(profileDir: string, name: string, patch: string | null, client?: object): void {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  const dsh = {
    ...(patch === null ? {} : { bundle: { patch: './cordis.patch.yml' } }),
    ...(client === undefined ? {} : { client }),
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dsh }))
  if (patch !== null) writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  // An install writes the dependency too, and installed-ness is read from it.
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
  manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
  writeFileSync(manifestPath, JSON.stringify(manifest))
}

function toggleProfile(): string {
  const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-shop-'))
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
  return profileDir
}

describe('ShopGateway', () => {
  it('registers the shop namespace as a Typert remote service', () => {
    // The constructor discovers the production profile from the module's own
    // location; a bare test instance lives outside any profile, so the test
    // supplies one, like every other test in this file.
    const gateway = new ShopGateway(stubCtx(), { profile: 'web' })
    expect(gateway.name).toBe('shop')
    expect(gateway.typertRemote.serviceKey).toBe('shop')
    expect(gateway.typertRemote.namespace).toBe('shop')
  })

  it('discovers the profile from the boot baseUrl when the module is not under a profile', async () => {
    // Regression for `link:` installs: pnpm keeps the package at its source,
    // so the walk-up from import.meta.url finds the repo, not a profile. The
    // boot's ctx.baseUrl — the profile's cordis.yml directory — is the
    // authoritative source, and the constructor must use it.
    const home = mkdtempSync(join(TEMP_ROOT, 'dsh-linked-'))
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-plugin-shop'] } } }))
    fixturePackage(profileDir, 'dsh-third-party', "- insert:\n    - id: third-party-row\n      name: 'dsh-third-party'\n")
    const ctx = {
      get: () => undefined,
      reflect: { provide: () => {} },
      baseUrl: pathToFileURL(profileDir).href + '/',
    } as never
    // The constructor must not throw (the link-install regression: no profile
    // above the module path), and setEnabled resolves the baseUrl directory
    // end to end — the observable proof of the discovery.
    const gateway = new ShopGateway(ctx)
    expect(gateway.name).toBe('shop')
    const inventory = [{ entryId: 'third-party-row', moduleName: 'dsh-third-party', enabled: true }]
    const withInventory = new ShopGateway(ctx, { inventory: { list: async () => ({ entries: inventory }) } })
    const result = await withInventory.setEnabled({ name: 'dsh-third-party', enabled: false })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('third-party-row')
  })

  it('toggles with the REAL snapshot-shaped inventory ({ entries: [...] })', async () => {
    // The real pluginInventory service returns a snapshot object, not a bare
    // array — hub-borrowings B assumed the array, and the toggle crashed on
    // the real wire shape (0.5.1 regression fix). Pin the real shape here.
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-toggle-snapshot-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    fixturePackage(profileDir, 'dsh-hello-fixture', "- insert:\n    - id: snapshot-row\n      name: 'dsh-hello-fixture'\n")
    const gateway = new ShopGateway(stubCtx(), {
      profile: 'web', profileDir,
      inventory: { list: async () => ({ entries: [{ entryId: 'snapshot-row', moduleName: 'dsh-hello-fixture', enabled: true }] }) },
    })
    const result = await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: false })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('snapshot-row')
  })

  it('drops malformed inventory rows instead of crashing', async () => {
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-toggle-malformed-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    fixturePackage(profileDir, 'dsh-hello-fixture', "- insert:\n    - id: good-row\n      name: 'dsh-hello-fixture'\n")
    const gateway = new ShopGateway(stubCtx(), {
      profile: 'web', profileDir,
      // The malformed row is deliberately off-shape: the cast is the point of
      // the test, which is that listInventory drops it instead of crashing.
      inventory: { list: async () => ({ entries: [{ entryId: 'good-row', moduleName: 'dsh-hello-fixture', enabled: true }, { nope: true } as unknown as InventoryEntry] }) },
    })
    const result = await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: false })
    expect(result.ok).toBe(true)
  })

  it('warns at load when the harness provides a peer outside the declared range', async () => {
    // The whole point of the check: the mismatch is said once, at load, in the
    // shop's own words — not diagnosed for hours from a path that silently
    // changed behaviour.
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-peerversion-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    const warnings: string[] = []
    const ctx = { get: () => undefined, reflect: { provide: () => {} }, logger: { warn: (m: string) => warnings.push(m) } } as never
    new ShopGateway(ctx, {
      profile: 'web', profileDir,
      peerRanges: { '@deepseek-ai/dsh-app-boot': '^0.1.1-rc.2' },
      resolvePeerVersion: () => '0.2.0-rc.1',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('@deepseek-ai/dsh-app-boot ^0.1.1-rc.2, found 0.2.0-rc.1')
  })

  it('loads silently when the harness satisfies every declared peer range', async () => {
    // 0.1.5-rc.1 against ^0.1.1-rc.2 is what is installed today: silence.
    // peers.test.ts's INSTALLED table is where that shape is measured and
    // kept; this case only needs one row of it to reach the load path.
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-peerversion-ok-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    const warnings: string[] = []
    const ctx = { get: () => undefined, reflect: { provide: () => {} }, logger: { warn: (m: string) => warnings.push(m) } } as never
    new ShopGateway(ctx, {
      profile: 'web', profileDir,
      peerRanges: { '@deepseek-ai/dsh-app-boot': '^0.1.1-rc.2' },
      resolvePeerVersion: () => '0.1.5-rc.1',
    })
    expect(warnings).toEqual([])
  })

  it('gives no verdict for a declared peer that is installed nowhere', async () => {
    // Absence is not a version violation — the presence check (peers.ts's
    // incompatibilityMap) is what covers a missing peer. The resolver here is
    // the real one; only the range table is injected, and it names a package
    // that exists in no store.
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-peerversion-absent-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    const warnings: string[] = []
    const ctx = { get: () => undefined, reflect: { provide: () => {} }, logger: { warn: (m: string) => warnings.push(m) } } as never
    new ShopGateway(ctx, {
      profile: 'web', profileDir,
      peerRanges: { '@deepseek-ai/dsh-peer-installed-nowhere': '^1.0.0' },
    })
    expect(warnings).toEqual([])
  })

  it('loads silently against the harness this repo actually installs', async () => {
    // The real declared ranges, read from the shipped package.json, against
    // the versions this repository installs, through the production resolver
    // anchored at the package root, where pnpm links the harness packages
    // this build is developed against. If that harness ever moves off the
    // declared line, this test failing IS the warning firing — read the
    // message and decide whether the ranges or the install is wrong.
    //
    // Until 2026-09-24 this was anchored at a bare temp profile, and it
    // passed only because the vitest launcher's NODE_PATH reached pnpm's
    // store: `require.resolve` searched it. The direct lookup that replaced
    // it does not search NODE_PATH, because the ESM loader that runs plugin
    // host code does not either, so that anchor found nothing, formed no
    // verdict and asserted nothing. Every version is therefore asserted READ
    // before the silence below is believed.
    const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
    const resolvePeerVersion = nodeVersionResolver(pathToFileURL(join(packageRoot, 'package.json')).href)
    for (const spec of Object.keys(ownPeerRanges())) expect(resolvePeerVersion(spec), spec).not.toBeNull()
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-peerversion-live-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    const warnings: string[] = []
    const ctx = { get: () => undefined, reflect: { provide: () => {} }, logger: { warn: (m: string) => warnings.push(m) } } as never
    new ShopGateway(ctx, { profile: 'web', profileDir, resolvePeerVersion })
    expect(warnings).toEqual([])
  })

})

describe('ShopGateway.catalog', () => {
  const snapshot = {
    schemaVersion: 2,
    builtAt: '2026-08-25T00:00:00Z',
    entries: [{ name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' }],
    denied: [{ name: 'dsh-blocked', detail: 'matched the denylist' }],
    stars: {},
  }

  it('forwards the refresh flag to the catalog loader and maps the snapshot', async () => {
    const calls: Array<{ refresh?: boolean }> = []
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/',
      cacheDir: '/cache',
      profile: 'web',
      loadCatalog: async options => { calls.push(options); return { snapshot, stale: false } as CatalogResult },
    })

    const result = await gateway.catalog({ refresh: true })
    expect(calls).toEqual([expect.objectContaining({ origins: [expect.objectContaining({ id: 'http:https://shop.test/v1/' })], cacheDir: '/cache', refresh: true })])
    expect(result).toEqual(expect.objectContaining({ schemaVersion: 2, stale: false }))
    expect(result.plugins[0]?.name).toBe('dsh-hello-plugin')
    expect(result.denied[0]?.detail).toBe('matched the denylist')
  })

  it('reports the stale flag through to the client', async () => {
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/',
      cacheDir: '/cache',
      profile: 'web',
      loadCatalog: async () => ({ snapshot, stale: true }) as CatalogResult,
    })

    const result = await gateway.catalog({})
    expect(result.stale).toBe(true)
  })

  it('rejects loudly when the shop row is missing its config', async () => {
    const gateway = new ShopGateway({
      get: () => undefined,
      reflect: { provide: () => {} },
      loader: { entries: () => [] },
    } as never, { profile: 'web' })

    await expect(gateway.catalog({})).rejects.toThrow(
      'dsh-plugin-shop: the shop row is missing catalogUrl or cacheDir config',
    )
  })

  it('reads the row config through the Loader when no options are given', async () => {
    const calls: LoadCatalogOptions[] = []
    const gateway = new ShopGateway(
      {
        get: () => undefined,
        reflect: { provide: () => {} },
        loader: {
          entries: () => [{
            options: {
              name: 'dsh-plugin-shop',
              config: { catalogUrl: 'https://row.test/v1/', cacheDir: '/row-cache' },
            },
          }],
        },
      } as never,
      {
        profile: 'web',
        loadCatalog: async options => { calls.push(options); return { snapshot, stale: false } as CatalogResult },
      },
    )

    await gateway.catalog({})
    expect(calls).toEqual([expect.objectContaining({ origins: [expect.objectContaining({ id: 'http:https://row.test/v1/' })], cacheDir: '/row-cache' })])
  })
})

// A fixture `dsh` that records its argv and exits 0; the calls log path lets
// a rejection's no-spawn property be proven by the file's absence.
function gatewayWithSnapshot(snapshot: CatalogSnapshot, options: Partial<ShopGatewayOptions> = {}): { gateway: ShopGateway; callsLog: string } {
  const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-gateway-fixture-'))
  const bin = fakeDshRecording(dir, 0, { silent: true })
  // The install flow reads the running profile manifest before spawning (to
  // tell an update from a fresh install); the fixture supplies one.
  const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-gateway-profile-'))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }, dependencies: {} }))
  const gateway = new ShopGateway(stubCtx(), {
    catalogUrl: 'https://shop.test/v1/',
    cacheDir: '/cache',
    profile: 'web',
    profileDir,
    loadCatalog: async () => ({ snapshot, stale: false }) as CatalogResult,
    dshBin: bin,
    prefetcher: fixturePrefetcher(),
    ...options,
  })
  return { gateway, callsLog: join(dir, 'calls.log') }
}

describe('ShopGateway.install — the four rejection paths, through the executor', () => {
  // Annotated so the literal's tier/metadata do not widen to `string`, which
  // would not be assignable to the CatalogEntry union members.
  const listed: CatalogEntry = { name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' }

  it('rejects not-in-catalog without spawning', async () => {
    const { gateway, callsLog } = gatewayWithSnapshot({ schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} })
    const result = await gateway.install({ name: 'dsh-unknown', version: '1.0.0' })
    expect(result).toMatchObject({ ok: false, code: 'not-in-catalog' })
    // A spawned fixture would have created the calls log within this settle window.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(callsLog)).toBe(false)
  })

  it('rejects denied without spawning', async () => {
    const { gateway, callsLog } = gatewayWithSnapshot({ schemaVersion: 2, builtAt: '', entries: [], denied: [{ name: 'dsh-blocked', detail: 'matched the denylist' }], stars: {} })
    const result = await gateway.install({ name: 'dsh-blocked', version: '1.0.0' })
    expect(result).toMatchObject({ ok: false, code: 'denied' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(callsLog)).toBe(false)
  })

  it('rejects version-mismatch without spawning', async () => {
    const { gateway, callsLog } = gatewayWithSnapshot({ schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} })
    const result = await gateway.install({ name: 'dsh-hello-plugin', version: '9.9.9' })
    expect(result).toMatchObject({ ok: false, code: 'version-mismatch' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(callsLog)).toBe(false)
  })

  it('rejects needs-acknowledgement without spawning', async () => {
    const { gateway, callsLog } = gatewayWithSnapshot({ schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} })
    const result = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0' })
    expect(result).toMatchObject({ ok: false, code: 'needs-acknowledgement' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(callsLog)).toBe(false)
  })

  it('rejects name-taken through the executor, without spawning', async () => {
    // The gate's one impure input — the profile manifest's dependency for this
    // name — is wired in `install()`, and every other test of it drives the
    // pure `validateInstall` with a hand-written spec. Without this, a wrong
    // manifest key or a wrong profile dir leaves `installedSpec` permanently
    // undefined, the branch becomes a no-op, and the suite stays green.
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-name-taken-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', dsh: { profile: { bundles: [] } },
      dependencies: { 'dsh-hello-plugin': 'github:someone-else/dsh-hello-plugin' },
    }))
    const { gateway, callsLog } = gatewayWithSnapshot(
      { schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} },
      { profileDir },
    )
    const result = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(result).toMatchObject({ ok: false, code: 'name-taken' })
    if (!result.ok) expect(result.detail).toContain('someone-else/dsh-hello-plugin')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(callsLog)).toBe(false)
  })

  it('still installs when the manifest names this very plugin', async () => {
    // The boundary the wiring must not cross: an update of the same install
    // shares the manifest key by design.
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-name-taken-same-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', dsh: { profile: { bundles: [] } },
      dependencies: { 'dsh-hello-plugin': '^1.0.0' },
    }))
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} },
      { profileDir },
    )
    const result = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(result.ok).toBe(true)
  })

  it('keeps a published rejection detail when the profile manifest is unreadable', async () => {
    // The manifest read runs ahead of every gate rejection. It throws on a
    // malformed file, and an escaped exception crosses the RPC as a bare
    // transport failure — so a profile caught mid-write would replace every
    // author-readable reason on this path with "please retry".
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-broken-manifest-'))
    writeFileSync(join(profileDir, 'package.json'), '{ this is not json')
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 2, builtAt: '', entries: [], denied: [{ name: 'dsh-blocked', detail: 'matched the denylist' }], stars: {} },
      { profileDir },
    )
    const result = await gateway.install({ name: 'dsh-blocked', version: '1.0.0' })
    expect(result).toMatchObject({ ok: false, code: 'denied' })
    if (!result.ok) expect(result.detail).toContain('matched the denylist')
  })

  it('spawns only for an acknowledged install and reports progress', async () => {
    const { gateway, callsLog } = gatewayWithSnapshot({ schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} })
    const result = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const status = gateway.installStatus({ installId: result.installId })
    expect(status.found).toBe(true)
    // The fixture dsh exits 0 immediately, so the status may already be done;
    // a previous case's install may still be draining, so this one may be
    // QUEUED behind it and report 'downloading'. What the case is about is
    // that it is live and not a failure — stated as terminality rather than as
    // an allowlist that has to grow with every state the union gains.
    expect(status.state).not.toBe('failed')
    // Poll installStatus until the fixture's subprocess is done (finished
    // records are retained), then prove the exact argv was recorded — the
    // profile and the pinned spec pass through to the subprocess.
    const deadline = Date.now() + 5000
    let terminal = status
    while (!isTerminalInstallState(terminal.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      terminal = gateway.installStatus({ installId: result.installId })
    }
    expect(terminal.state).toBe('done')
    expect(readFileSync(callsLog, 'utf8')).toContain('plugin --profile web add dsh-hello-plugin@1.2.0')
  })

  it('returns the true terminal state for a finished install', async () => {
    const { gateway } = gatewayWithSnapshot({ schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} })
    const result = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The fixture exits 0 immediately; poll installStatus until terminal.
    // Polling the gateway's own remote method is the honest seam — the map
    // is private, and this exercises the exact contract a client sees: a
    // finished install keeps reporting its true state, found: true.
    const deadline = Date.now() + 5000
    let status = gateway.installStatus({ installId: result.installId })
    while (!isTerminalInstallState(status.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      status = gateway.installStatus({ installId: result.installId })
    }
    expect(status.found).toBe(true)
    expect(status.state).toBe('done')
    expect(status.activation).toBe('restart')
  })

  it('retains at most 32 finished installs, evicting the oldest on the next add', async () => {
    const { gateway } = gatewayWithSnapshot({ schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} })
    const ids: string[] = []
    for (let i = 0; i < 33; i += 1) {
      const result = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
      if (!result.ok) throw new Error('fixture install was rejected')
      ids.push(result.installId)
    }
    const firstId = ids[0]
    const lastId = ids[ids.length - 1]
    if (firstId === undefined || lastId === undefined) throw new Error('no install ids collected')
    // The per-profile mutex serializes the fixtures; when the last one is
    // terminal, all 33 are finished. TERMINAL, not "not running": the last
    // install is QUEUED behind the other 32 and reports 'downloading' for as
    // long as they run, so `!== 'running'` would end this drain immediately
    // and the eviction below would then be asserting against 33 installs that
    // are still in flight — none of which is a finished record to evict.
    const deadline = Date.now() + 15000
    let last = gateway.installStatus({ installId: lastId })
    while (!isTerminalInstallState(last.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      last = gateway.installStatus({ installId: lastId })
    }
    expect(isTerminalInstallState(last.state)).toBe(true)
    // Adding one more install with 33 finished records evicts the oldest.
    const extra = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(extra.ok).toBe(true)
    if (!extra.ok) return
    expect(gateway.installStatus({ installId: firstId }).found).toBe(false)
    expect(gateway.installStatus({ installId: lastId }).found).toBe(true)
  })

  it('retains every finished install below the 32-record cap (no eviction under the cap)', async () => {
    const { gateway } = gatewayWithSnapshot({ schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} })
    const ids: string[] = []
    for (let i = 0; i < 20; i += 1) {
      const result = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
      if (!result.ok) throw new Error('fixture install was rejected')
      ids.push(result.installId)
      // Await this install's completion before the next add, so the next add's
      // eviction pass sees the prior records as finished. The per-profile mutex
      // serializes the fixtures; poll installStatus — the honest client seam.
      const deadline = Date.now() + 5000
      let status = gateway.installStatus({ installId: result.installId })
      while (!isTerminalInstallState(status.state) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
        status = gateway.installStatus({ installId: result.installId })
      }
    }
    // Below the cap nothing may be evicted: all 20 records must still report
    // their true terminal state. The unclamped eviction math slices from the
    // front once the finished count clears ~16, so earlier ids report
    // found: false here and the test fails.
    for (const id of ids) {
      const status = gateway.installStatus({ installId: id })
      expect(status.found).toBe(true)
      expect(status.state).toBe('done')
    }
  })

  it('reports an unknown installId as not found', () => {
    const { gateway } = gatewayWithSnapshot({ schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} })
    const status = gateway.installStatus({ installId: 'nope' })
    expect(status.found).toBe(false)
    expect(status.detail).toContain('nope')
  })
})

describe('ShopGateway.setEnabled', () => {
  it('setEnabled writes a disable row for an installed plugin', async () => {
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-hello-fixture', "- insert:\n    - id: hello-row\n      name: 'dsh-hello-fixture'\n")
    const gateway = new ShopGateway(stubCtx(), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [{ entryId: 'hello-row', moduleName: 'dsh-hello-fixture', enabled: true }] }) } })
    const result = await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: false })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('hello-row')
  })

  it('setEnabled on an enabled plugin removes the disable row', async () => {
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-hello-fixture', "- insert:\n    - id: hello-row\n      name: 'dsh-hello-fixture'\n")
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: hello-row\n  disabled: true\n')
    const gateway = new ShopGateway(stubCtx(), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [{ entryId: 'hello-row', moduleName: 'dsh-hello-fixture', enabled: false }] }) } })
    const result = await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: true })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).not.toContain('hello-row')
  })

  it('refuses to toggle the shop itself or a framework bundle', async () => {
    const profileDir = toggleProfile()
    const gateway = new ShopGateway(stubCtx(), {
      profile: 'web', profileDir,
      inventory: { list: async () => ({ entries: [
        { entryId: 'shop-row', moduleName: 'dsh-plugin-shop', enabled: true },
        { entryId: 'frame-row', moduleName: '@deepseek-ai/dsh-app-boot', enabled: true },
      ] }) },
    })
    const own = await gateway.setEnabled({ name: 'dsh-plugin-shop', enabled: false })
    expect(own).toEqual({ ok: false, detail: 'dsh-plugin-shop: dsh-plugin-shop is part of the harness chain and cannot be toggled from the shop' })
    const framework = await gateway.setEnabled({ name: '@deepseek-ai/dsh-app-boot', enabled: false })
    expect(framework.ok).toBe(false)
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
  })

  it('reports not installed for an unknown name without writing', async () => {
    const profileDir = toggleProfile()
    const gateway = new ShopGateway(stubCtx(), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [] }) } })
    const result = await gateway.setEnabled({ name: 'dsh-not-here', enabled: false })
    expect(result).toEqual({ ok: false, detail: 'dsh-plugin-shop: dsh-not-here is not installed' })
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
  })

  it('reports activation reload from setEnabled when the toggled package has a browser half', async () => {
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-themer', "- insert:\n    - id: themer-row\n      name: 'dsh-themer/host'\n", { inject: [], platform: 'web' })
    const gateway = new ShopGateway(stubCtx(), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [{ entryId: 'themer-row', moduleName: 'dsh-themer', enabled: true }] }) } })
    const result = await gateway.setEnabled({ name: 'dsh-themer', enabled: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.activation).toBe('reload')
  })

  it('reports activation live from setEnabled for a host-only package', async () => {
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-tooler', "- insert:\n    - id: tooler-row\n      name: 'dsh-tooler/host'\n")
    const gateway = new ShopGateway(stubCtx(), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [{ entryId: 'tooler-row', moduleName: 'dsh-tooler', enabled: true }] }) } })
    const result = await gateway.setEnabled({ name: 'dsh-tooler', enabled: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.activation).toBe('live')
  })
})

describe('ShopGateway.installed', () => {
  const entries = [
    { name: 'dsh-one', version: '2.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' },
    { name: 'dsh-two', version: '1.5.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' },
  ]

  function gatewayWithManifest(dependencies: Record<string, string>): ShopGateway {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-installed-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies }))
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries, denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
  }

  // The mirror of the uninstall case below: an entry named for an inherited
  // key must not be reported as installed when the profile does not have it.
  it('omits an entry named for an Object.prototype key that is not installed', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-installed-proto-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', dsh: { profile: { bundles: [] } },
      dependencies: { 'dsh-one': '^1.0.0' },
    }))
    const proto = { ...entries[0]!, name: 'constructor' }
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries: [proto], denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([])
  })

  it('carries the inventory enabled state onto the installed rows', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-installed-inv-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: { 'dsh-one': '^1.0.0' } }))
    // The disabled state is read through the ids dsh-one's own bundle patch
    // inserts — the entry's module name is deliberately NOT the package name,
    // the shape that made the module-name lookup report every such package as
    // enabled no matter what the inventory said.
    fixturePackage(dir, 'dsh-one', "- insert:\n    - id: one-row\n      name: 'dsh-one/host'\n")
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: { 'dsh-one': '^1.0.0' } }))
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries, denied: [], stars: {} }, stale: false }) as CatalogResult,
      inventory: { list: async () => ({ entries: [{ entryId: 'one-row', moduleName: 'dsh-one/host', enabled: false }] }) },
    })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-one', source: 'npm', installed: '^1.0.0', latest: '2.0.0', outdated: true, enabled: false }])
  })

  it('reads the enabled state through the live ids a REAL boot produces', async () => {
    // Same root include as setEnabled's: the inventory reports
    // `include:one-row`, so matching only the bare id found no live entry and
    // `enabledOf` fell through to its "nothing live, assume enabled" default
    // — a plugin the person had disabled kept rendering with its switch on.
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-installed-inc-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: { 'dsh-one': '^1.0.0' } }))
    fixturePackage(dir, 'dsh-one', "- insert:\n    - id: one-row\n      name: 'dsh-one/host'\n")
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: { 'dsh-one': '^1.0.0' } }))
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries, denied: [], stars: {} }, stale: false }) as CatalogResult,
      inventory: { list: async () => ({ entries: [{ entryId: 'include:one-row', moduleName: 'dsh-one/host', enabled: false }] }) },
    })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-one', source: 'npm', installed: '^1.0.0', latest: '2.0.0', outdated: true, enabled: false }])
  })

  it('reports an installed plugin behind the catalog with outdated: true', async () => {
    const gateway = gatewayWithManifest({ 'dsh-one': '^1.0.0' })
    await gateway.catalog({}) // populates lastSnapshot
    expect(await gateway.installed()).toEqual([{ name: 'dsh-one', source: 'npm', installed: '^1.0.0', latest: '2.0.0', outdated: true, enabled: true }])
  })

  it('reports a current installed plugin with outdated: false', async () => {
    const gateway = gatewayWithManifest({ 'dsh-one': '^2.0.0' })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-one', source: 'npm', installed: '^2.0.0', latest: '2.0.0', outdated: false, enabled: true }])
  })

  it('reads a non-semver installed spec as current instead of throwing', async () => {
    const gateway = gatewayWithManifest({ 'dsh-one': '^1.0.0', 'dsh-two': 'workspace:*' })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([
      { name: 'dsh-one', source: 'npm', installed: '^1.0.0', latest: '2.0.0', outdated: true, enabled: true },
      { name: 'dsh-two', source: 'npm', installed: 'workspace:*', latest: '1.5.0', outdated: false, enabled: true },
    ])
  })

  it('lazily loads the catalog when installed() is called without a prior catalog()', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-installed-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: { 'dsh-one': '^1.0.0' } }))
    let loadCalls = 0
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => {
        loadCalls += 1
        return { snapshot: { schemaVersion: 2, builtAt: '', entries, denied: [], stars: {} }, stale: false } as CatalogResult
      },
    })
    const installed = await gateway.installed()
    expect(loadCalls).toBe(1)
    expect(installed).toEqual([{ name: 'dsh-one', source: 'npm', installed: '^1.0.0', latest: '2.0.0', outdated: true, enabled: true }])
  })
})

describe('forwards-only outdated', () => {
  // dsh-market's update incident: a `latest` dist-tag pointing at an OLDER
  // release made a plain `!==` comparison turn "update" into a downgrade
  // that broke the profile's boot (their updates.ts:86-100). The npm verdict
  // here is strictly forwards-only: semver `lt` between the installed spec's
  // floor and the catalog version.
  const entries = [
    { name: 'dsh-one', version: '2.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' },
    { name: 'dsh-two', version: '1.5.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' },
  ]

  function gatewayWithManifest(dependencies: Record<string, string>): ShopGateway {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-forwards-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies }))
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries, denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
  }

  it('reports an equal installed version as current', async () => {
    const gateway = gatewayWithManifest({ 'dsh-two': '1.5.0' })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-two', source: 'npm', installed: '1.5.0', latest: '1.5.0', outdated: false, enabled: true }])
  })

  it('reports a backwards catalog version as current, never "outdated"', async () => {
    const gateway = gatewayWithManifest({ 'dsh-two': '2.0.0' })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-two', source: 'npm', installed: '2.0.0', latest: '1.5.0', outdated: false, enabled: true }])
  })

  it('reports a behind installed version as outdated', async () => {
    const gateway = gatewayWithManifest({ 'dsh-two': '^1.0.0' })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-two', source: 'npm', installed: '^1.0.0', latest: '1.5.0', outdated: true, enabled: true }])
  })

  // The github arm is NOT forwards-only, and cannot be. There `outdated` is
  // `pin !== entry.version`: an inequality between two commit shas, which
  // nothing the Host holds can order. A default branch reverted or
  // force-pushed BEHIND the pin still reports outdated, and Update syncs to
  // the catalog rather than moving strictly forward. Pinned here, beside the
  // npm cases that establish the opposite, so the asymmetry stays deliberate
  // and visible; §7.3's 2026-09-16 follow-up records why it is not narrowed.
  it('reports a github pin that merely DIFFERS from the catalog commit as outdated', async () => {
    const catalogCommit = 'c'.repeat(40)
    const aheadPin = 'd'.repeat(40)
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-forwards-gh-'))
    mkdirSync(join(dir, 'cache'), { recursive: true })
    writeFileSync(join(dir, 'cache/github-pins.json'), JSON.stringify({ 'github:carol/dsh-three#': aheadPin }))
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-forwards-gh-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', dsh: { profile: { bundles: [] } },
      dependencies: { 'dsh-three': 'github:carol/dsh-three' },
    }))
    const repoEntry: CatalogEntry = {
      name: 'dsh-three', version: catalogCommit, integrity: catalogCommit, publishedAt: null,
      repository: 'https://github.com/carol/dsh-three', license: 'MIT',
      tier: 'community', metadata: 'derived', source: 'github', repo: 'carol/dsh-three',
      added: '2026-08-25',
    }
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 6, builtAt: '', entries: [repoEntry], denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{
      name: 'dsh-three', source: 'github', repo: 'carol/dsh-three',
      installed: aheadPin, latest: catalogCommit, outdated: true, enabled: true,
    }])
  })
})

describe('ShopGateway.uninstall', () => {
  const entries = [
    { name: 'dsh-one', version: '2.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' },
  ]

  function gatewayWithManifest(dependencies: Record<string, string>): ShopGateway {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-uninstall-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies }))
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries, denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
  }

  it('rejects a name outside the catalog without spawning', async () => {
    const gateway = gatewayWithManifest({ 'dsh-one': '^2.0.0' })
    await gateway.catalog({})
    expect(await gateway.uninstall({ name: 'dsh-unknown' })).toEqual({
      ok: false, detail: 'dsh-plugin-shop: dsh-unknown is not in the catalog',
    })
  })

  it('rejects a catalog entry that is not installed', async () => {
    const gateway = gatewayWithManifest({})
    await gateway.catalog({})
    expect(await gateway.uninstall({ name: 'dsh-one' })).toEqual({
      ok: false, detail: 'dsh-plugin-shop: dsh-one is not installed',
    })
  })

  // `constructor` is a legal npm name, and the manifest's `dependencies` is
  // parsed JSON carrying Object.prototype — so an index read hands back a
  // function, the `spec === undefined` guard passes, and `installedSpecMatches`
  // answers TRUE for an npm entry because `parseRepoSpec` coerces the function
  // to a string that matches no `github:` shorthand. The uninstall then spawns
  // a removal for a package that was never installed.
  it('rejects an entry named for an Object.prototype key that is not installed', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-uninstall-proto-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', dsh: { profile: { bundles: [] } },
      dependencies: { 'dsh-one': '^2.0.0' },
    }))
    const proto = { ...entries[0]!, name: 'constructor' }
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries: [proto], denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
    await gateway.catalog({})
    expect(await gateway.uninstall({ name: 'constructor' })).toEqual({
      ok: false, detail: 'dsh-plugin-shop: constructor is not installed',
    })
  })

  it('lazily loads the catalog when uninstall() is called without a prior catalog()', async () => {
    const gateway = gatewayWithManifest({})
    expect(await gateway.uninstall({ name: 'dsh-unknown' })).toEqual({
      ok: false, detail: 'dsh-plugin-shop: dsh-unknown is not in the catalog',
    })
  })
})

describe('ShopGateway.restart', () => {
  // The handoff is two-phase: the helper waits for the parent pid before
  // exec'ing dsh. Point it at a pid that is already dead so the fixture
  // would run immediately — the gateway tests assert the RPC and the exit,
  // not the helper's wait (covered in restart.test.ts).
  // The helper exec's the fixture as soon as the (already dead) parent pid
  // check passes; the fixture is a harmless echo-exit so no real dsh web is
  // ever spawned by a test.
  function restartingGateway(options: { exit: ReturnType<typeof vi.fn>; cacheDir?: string; restartArgv?: string[] }): ShopGateway {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-gateway-restart-'))
    const bin = fakeDshRecording(dir, 0, { silent: true })
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/',
      cacheDir: options.cacheDir ?? mkdtempSync(join(TEMP_ROOT, 'dsh-restart-cache-')),
      profile: 'web',
      dshBin: bin,
      restartArgv: options.restartArgv ?? ['web'],
      exit: options.exit,
      restartExitDelayMs: 5,
      // The handoff helper is POSIX-only; these cases are about the RPC and
      // the exit, so the platform is pinned rather than inherited.
      platform: 'linux',
      // The vitest worker is alive for the whole file; a pid beyond the
      // kernel's pid_max is guaranteed dead, so the helper runs the fixture
      // at once and never lingers past the test run.
      restartParentPid: 1_000_000_000,
    })
  }

  it('commits the handoff with { ok: true } and exits after the response', async () => {
    const exit = vi.fn<() => void>()
    const gateway = restartingGateway({ exit })
    const result = await gateway.restart()
    expect(result).toEqual({ ok: true })
    // The exit is delayed past the RPC round-trip, then fires.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('refuses --port 0 without exiting: the new port would strand the browser', async () => {
    const exit = vi.fn<() => void>()
    const gateway = restartingGateway({ exit, restartArgv: ['web', '--port', '0'] })
    const result = await gateway.restart()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain('--port 0')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(exit).not.toHaveBeenCalled()
  })

  it('reports a typed failure without exiting when the shop row config is missing', async () => {
    const exit = vi.fn<() => void>()
    const gateway = new ShopGateway(stubCtx(), {
      profile: 'web',
      restartArgv: ['web'],
      exit,
      restartExitDelayMs: 5,
      // This case is about the missing row config, which is platform-
      // independent; pinned so the earlier Windows gate does not answer first.
      platform: 'linux',
    })
    const result = await gateway.restart()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain('restart could not be started')
    expect(exit).not.toHaveBeenCalled()
  })

  // POSIX-only, and the product is too: the two-phase handoff spawns `sh -c`
  // with `kill -0`, `sleep` and `exec "$@"` (restart.ts), so this case cannot
  // observe its marker on Windows however the platform option is set. The
  // Windows behaviour is asserted rather than skipped — the two cases above
  // pin `platform: 'win32'` and check the typed refusal and
  // `restartBlocked: 'windows'` — so nothing here is left uncovered by the skip.
  it.skipIf(process.platform === 'win32')("re-runs this process's own entry when dshBin is the bare default", async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-restart-node-'))
    const marker = join(dir, 'ran.log')
    const script = join(dir, 'fake-bin.js')
    writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + '\\n')\n`)
    const exit = vi.fn()
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: dir, profile: 'web',
      exit, restartExitDelayMs: 1, restartParentPid: 1_000_000_000,
      restartArgv: ['web', '--no-open'], restartScript: script,
    })
    expect(await gateway.restart()).toEqual({ ok: true })
    await vi.waitFor(() => { expect(existsSync(marker)).toBe(true) }, { timeout: 5000 })
    expect(readFileSync(marker, 'utf8')).toContain('web --no-open')
    rmSync(dir, { recursive: true, force: true })
  })
})

// File-scope fixture options shared by the restart-guard describe and the hot
// paths (C-2): a fixture dsh and a pid beyond pid_max (guaranteed dead), so
// the takeover helper runs the fixture at once and no real dsh web is ever
// spawned. The cacheDir is a scratch dir — the handoff opens restart.log
// inside it before committing. Hot-path cases spread these and add the
// profile manifest, catalog fixture, and the hot/loader injections.
function gatewayOptions() {
  const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-restart-guard-'))
  const bin = fakeDshRecording(dir, 0, { silent: true })
  return {
    catalogUrl: 'https://shop.test/v1/',
    cacheDir: mkdtempSync(join(TEMP_ROOT, 'dsh-restart-guard-cache-')),
    profile: 'web',
    exit: () => {}, restartExitDelayMs: 0,
    dshBin: bin,
    prefetcher: fixturePrefetcher(),
    restartParentPid: 1_000_000_000,
    // Pinned: these cases assert the systemd and --port 0 policies, which
    // must not change meaning with the host OS now that the platform is also
    // a restart gate. The Windows cases override it explicitly.
    platform: 'linux' as NodeJS.Platform,
    // Pinned for the same reason, one layer down: `restartArgv` defaults to
    // `process.argv.slice(2)`, which under vitest is the RUNNER's command
    // line. Now that `--port 0` is a reason `version()` reports rather than
    // only a refusal `restart()` raises, an unpinned argv would let the way
    // the suite was invoked decide what these cases observe.
    restartArgv: ['web'],
  }
}

describe('restart guard (systemd)', () => {
  it('refuses restart when systemd owns the process', async () => {
    const gateway = new ShopGateway(stubCtx(), { ...gatewayOptions(), env: { INVOCATION_ID: 'abc' }, ppid: 1 })
    const result = await gateway.restart()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain('systemd')
  })

  it('allows restart when the row config overrides', async () => {
    const gateway = new ShopGateway(stubCtx(), { ...gatewayOptions(), allowRestart: true, env: { INVOCATION_ID: 'abc' }, ppid: 1 })
    // startRestart is spawned; the test injects exit and a dead parent pid so
    // nothing really restarts. Assert the call was committed.
    const result = await gateway.restart()
    expect(result.ok).toBe(true)
  })

  it("reports restartBlocked: 'systemd' under systemd without the override", async () => {
    const gateway = new ShopGateway(stubCtx(), { ...gatewayOptions(), env: { INVOCATION_ID: 'abc' }, ppid: 1, fetchLatestVersion: async () => '9.9.9' })
    const version = await gateway.version()
    expect(version.restartBlocked).toBe('systemd')
  })

  it('reports restartBlocked: null outside a supervisor', async () => {
    const gateway = new ShopGateway(stubCtx(), { ...gatewayOptions(), env: {}, ppid: 4321, fetchLatestVersion: async () => null })
    const version = await gateway.version()
    expect(version.restartBlocked).toBe(null)
  })

  it("reports restartBlocked: 'port-zero' under --port 0, which restart() refused but version() used to hide", async () => {
    // The gap this closes: `restart()` has always refused `--port 0`, but the
    // boolean `version()` answered was computed from the platform and the
    // supervisor alone. So a dsh launched with `--port 0` advertised a restart
    // offer the host would refuse the instant it was pressed — including to
    // this project's own web e2e, which boots exactly that way.
    const gateway = new ShopGateway(stubCtx(), {
      ...gatewayOptions(), env: {}, ppid: 4321, restartArgv: ['web', '--port', '0'], fetchLatestVersion: async () => null,
    })
    expect((await gateway.version()).restartBlocked).toBe('port-zero')
  })

  it('names Windows ahead of systemd, because the systemd copy sends the reader to an override Windows cannot use', async () => {
    // Order, not just membership: both gates are shut here. `allowRestart:
    // true` overrides the systemd gate and nothing overrides the platform
    // one, so reporting 'systemd' would tell a Windows reader to set a config
    // key that leaves them exactly where they were.
    const gateway = new ShopGateway(stubCtx(), {
      ...gatewayOptions(), platform: 'win32', env: { INVOCATION_ID: 'abc' }, ppid: 1, fetchLatestVersion: async () => null,
    })
    expect((await gateway.version()).restartBlocked).toBe('windows')
  })

  it('answers the same reason from version() that restart() refuses with, for every reason', async () => {
    // The invariant the typed reason exists to create: what the card was told
    // at mount and what a press actually gets are one decision, read twice.
    // While `version()` answered a boolean it covered two of the three static
    // refusals, and the client had one string for all of them.
    // One shape for all three, so the array stays homogeneous and each case
    // states every input the predicate reads rather than inheriting some.
    const cases: Array<{ reason: RestartBlockedReason; detail: string; options: Partial<ShopGatewayOptions> }> = [
      { reason: 'windows', detail: 'not supported on Windows', options: { platform: 'win32', env: {}, ppid: 4321, restartArgv: ['web'] } },
      { reason: 'systemd', detail: 'systemd service', options: { platform: 'linux', env: { INVOCATION_ID: 'abc' }, ppid: 1, restartArgv: ['web'] } },
      { reason: 'port-zero', detail: '--port 0', options: { platform: 'linux', env: {}, ppid: 4321, restartArgv: ['web', '--port', '0'] } },
    ]
    for (const { reason, detail, options } of cases) {
      const gateway = new ShopGateway(stubCtx(), { ...gatewayOptions(), ...options, fetchLatestVersion: async () => null })
      expect((await gateway.version()).restartBlocked).toBe(reason)
      const result = await gateway.restart()
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.detail).toContain(detail)
    }
  })
})

describe('restart guard (Windows)', () => {
  // The handoff helper is a POSIX shell one-liner — `sh -c 'while kill -0
  // "$1"; do sleep 0.2; done; shift; exec "$@"'` — and there is no `sh` on
  // Windows. That failure is ASYNCHRONOUS, so `startRestart` returns
  // normally, the RPC answers `ok: true`, and the gateway then exits: dsh
  // dies and nothing brings it back. Measured on Windows 2026-09-02, where
  // the restart.test.ts cases fail with `spawn sh ENOENT`. Refusing before
  // anything is torn down is the only safe answer until the handoff has a
  // Windows implementation.
  it('refuses restart on Windows rather than exiting into nothing', async () => {
    const exit = vi.fn<() => void>()
    const gateway = new ShopGateway(stubCtx(), { ...gatewayOptions(), platform: 'win32', exit, restartExitDelayMs: 5 })
    const result = await gateway.restart()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toMatch(/Windows/)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(exit).not.toHaveBeenCalled()
  })

  it("reports restartBlocked: 'windows' so the client hides the offer and says why", async () => {
    // The client drops the restart button and keeps the pending-change
    // notice. What it says in the button's place is the reason's OWN copy:
    // while this was a boolean the client had a single string for it, and
    // that string named systemd — so this case passed while every Windows
    // reader was told to restart a systemd unit.
    const gateway = new ShopGateway(stubCtx(), {
      ...gatewayOptions(), platform: 'win32', env: {}, ppid: 4321, fetchLatestVersion: async () => null,
    })
    expect((await gateway.version()).restartBlocked).toBe('windows')
  })
})

describe('ShopGateway.version', () => {
  // The running version is read from the package.json next to src/host —
  // the repo's own version. Keep the expectations on properties the gateway
  // computes, not on the literal version string, so a version bump does not
  // rewrite this test.
  const versionGateway = (latest: string | null): ShopGateway => new ShopGateway(stubCtx(), {
    catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web',
    fetchLatestVersion: async () => latest,
  })

  it('reports the running version, the latest, and the outdated verdict', async () => {
    const gateway = versionGateway('9.9.9')
    const result = await gateway.version()
    // The prerelease suffix is part of the shape now: a beta build reports
    // its own `X.Y.Z-beta.N`, and semver orders that below the release it
    // precedes, which is what makes the beta channel's update prompt correct.
    expect(result.installed).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
    expect(result.latest).toBe('9.9.9')
    expect(result.outdated).toBe(true)
  })

  it('is not outdated when the latest equals the running version', async () => {
    const gateway = versionGateway('0.0.1')
    const result = await gateway.version()
    expect(result.outdated).toBe(false)
  })

  it('leaves latest null when the check cannot answer, and never reports outdated', async () => {
    const gateway = versionGateway(null)
    const result = await gateway.version()
    expect(result.latest).toBeNull()
    expect(result.outdated).toBe(false)
  })
})

describe('ShopGateway.updateStart', () => {
  it('refuses a version that is not plain semver', async () => {
    const gateway = new ShopGateway(stubCtx(), { catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web' })
    expect(await gateway.updateStart({ version: '9.9.9 --force' })).toEqual({
      ok: false, detail: 'dsh-plugin-shop: 9.9.9 --force is not a valid version',
    })
  })

  it('spawns the pinned self-update spec through the executor', async () => {
    // The confirm re-reads the profile manifest for the shop's bundle, so
    // the fixture home must already list it (an update keeps it listed).
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-self-update-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dsh: { profile: { bundles: ['dsh-plugin-shop'] } },
    }))
    const binDir = mkdtempSync(join(TEMP_ROOT, 'dsh-self-update-bin-'))
    const bin = fakeDshRecording(binDir, 0, { silent: true })
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir, dshBin: bin,
      prefetcher: fixturePrefetcher(),
    })
    const result = await gateway.updateStart({ version: '9.9.9' })
    expect(result.ok).toBe(true)
    // Poll the public status RPC — the record's private internals stay
    // inside the gateway — until the pinned spec reaches done.
    if (result.ok) {
      const deadline = Date.now() + 5000
      for (;;) {
        const status = gateway.installStatus({ installId: result.installId })
        if (status.state === 'done') break
        if (Date.now() > deadline) throw new Error(`self-update did not finish: ${status.detail ?? status.state}`)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    expect(readFileSync(join(binDir, 'calls.log'), 'utf8')).toContain('add dsh-plugin-shop@9.9.9')
  })
})

describe('ShopGateway github entries', () => {
  const commit = 'd'.repeat(40)
  const repoEntry: CatalogEntry = {
    name: 'dsh-repo-plugin', version: commit, integrity: commit, publishedAt: null,
    repository: 'https://github.com/someone/dsh-repo-plugin', license: 'MIT',
    tier: 'community', metadata: 'declared', source: 'github', repo: 'someone/dsh-repo-plugin',
    added: '2026-08-25',
  }

  function gatewayWithRepo(dir: string): ShopGateway {
    const bin = fakeDshRecording(dir, 0, { silent: true })
    // The install flow reads the running profile manifest before spawning.
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-repo-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 3, builtAt: '', entries: [repoEntry], denied: [], stars: {} }, stale: false }) as CatalogResult,
      dshBin: bin,
      prefetcher: fixturePrefetcher(),
    })
  }

  it('spawns github:owner/slug#commit from snapshot fields and records the pin', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-github-install-'))
    const gateway = gatewayWithRepo(dir)
    const result = await gateway.install({ name: 'dsh-repo-plugin', version: commit, acknowledged: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const deadline = Date.now() + 5000
    let terminal = gateway.installStatus({ installId: result.installId })
    while (!isTerminalInstallState(terminal.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      terminal = gateway.installStatus({ installId: result.installId })
    }
    expect(terminal.state).toBe('done')
    expect(readFileSync(join(dir, 'calls.log'), 'utf8')).toContain(`plugin --profile web add github:someone/dsh-repo-plugin#${commit}`)
    expect(JSON.parse(readFileSync(join(dir, 'cache/github-pins.json'), 'utf8'))).toEqual({ 'github:someone/dsh-repo-plugin#': commit })
  })

  it('reports a github install by its pin, outdated when the catalog commit moved', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-github-installed-'))
    mkdirSync(join(dir, 'cache'), { recursive: true })
    const oldCommit = 'a'.repeat(40)
    writeFileSync(join(dir, 'cache/github-pins.json'), JSON.stringify({ 'dsh-repo-plugin': oldCommit }))
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-github-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: { 'dsh-repo-plugin': 'github:someone/dsh-repo-plugin' } }))
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 3, builtAt: '', entries: [repoEntry], denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-repo-plugin', source: 'github', repo: 'someone/dsh-repo-plugin', installed: oldCommit, latest: commit, outdated: true, enabled: true }])
  })

  it('forgets the pin on uninstall', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-github-uninstall-'))
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-github-profile-'))
    mkdirSync(join(dir, 'cache'), { recursive: true })
    writeFileSync(join(dir, 'cache/github-pins.json'), JSON.stringify({ 'dsh-repo-plugin': commit }))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: { 'dsh-repo-plugin': 'github:someone/dsh-repo-plugin' } }))
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 3, builtAt: '', entries: [repoEntry], denied: [], stars: {} }, stale: false }) as CatalogResult,
      dshBin: '/bin/false',
    })
    await gateway.catalog({})
    const result = await gateway.uninstall({ name: 'dsh-repo-plugin' })
    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'cache/github-pins.json'), 'utf8'))).toEqual({})
  })
})

describe('subpackage install spec', () => {
  const commit = 'b'.repeat(40)
  const subEntry: CatalogEntry = {
    name: 'sub-plugin', version: commit, integrity: commit, publishedAt: null,
    repository: 'https://github.com/someone/monorepo', license: 'MIT',
    tier: 'community', metadata: 'declared', source: 'github', repo: 'someone/monorepo',
    subdir: 'packages/sub-plugin',
    added: '2026-08-25',
  }

  function gatewayWithSub(dir: string): ShopGateway {
    const bin = fakeDshRecording(dir, 0, { silent: true })
    // The install flow reads the running profile manifest before spawning.
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-sub-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 4, builtAt: '', entries: [subEntry], denied: [], stars: {} }, stale: false }) as CatalogResult,
      dshBin: bin,
      prefetcher: fixturePrefetcher(),
    })
  }

  it('spawns github:owner/slug#commit&path:<subdir> and records the pin', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-sub-install-'))
    const gateway = gatewayWithSub(dir)
    const result = await gateway.install({ name: 'sub-plugin', version: commit, acknowledged: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const deadline = Date.now() + 5000
    let terminal = gateway.installStatus({ installId: result.installId })
    while (!isTerminalInstallState(terminal.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      terminal = gateway.installStatus({ installId: result.installId })
    }
    expect(terminal.state).toBe('done')
    // The spec, as the downstream dsh actually receives it — which on Windows
    // is quoted, because that is the only spelling that survives the shell
    // dsh puts it through there (`shellSafeTarget`). The quoting rule itself
    // is pinned with literal expectations for both platforms in
    // `executor.test.ts`; this case is about the spec being COMPOSED from the
    // snapshot's repo, commit and subdir, so it states the platform's
    // spelling rather than asserting the POSIX one everywhere. The install
    // path reads `process.platform`, not the gateway's `platform` option —
    // that one only feeds the restart gate — so there is nothing to pin.
    const spec = `github:someone/monorepo#${commit}&path:packages/sub-plugin`
    const asDshSawIt = process.platform === 'win32' ? `"${spec}"` : spec
    expect(readFileSync(join(dir, 'calls.log'), 'utf8')).toContain(`plugin --profile web add ${asDshSawIt}`)
    expect(JSON.parse(readFileSync(join(dir, 'cache/github-pins.json'), 'utf8'))).toEqual({ 'github:someone/monorepo#packages/sub-plugin': commit })
  })
})

describe('release-rescued tarball install', () => {
  const tag = 'v1.0.0'
  const TARBALL_URL = 'https://github.com/owner/slug/releases/download/v1.0.0/plugin.tgz'
  // The fixture tarball bytes the injected fetch serves, and the sha256 the
  // entry records for them — computed here, never hand-typed, so the fixture
  // arithmetic is true by construction.
  const tarballBytes = new TextEncoder().encode('fixture release tarball bytes')
  const tarballSha256 = createHash('sha256').update(tarballBytes).digest('hex')
  const tarballEntry: CatalogEntry = {
    name: 'dsh-rescued', version: tag, integrity: 'a'.repeat(64), publishedAt: null,
    repository: 'https://github.com/owner/slug', license: 'MIT',
    tier: 'community', metadata: 'declared', source: 'github', repo: 'owner/slug',
    added: '2026-08-01',
    tarball: { url: TARBALL_URL, sha256: tarballSha256 },
  }

  function gatewayWithTarball(dir: string, fetchTarball: (url: string) => Promise<Response>): ShopGateway {
    const bin = fakeDshRecording(dir, 0, { silent: true })
    // The install flow reads the running profile manifest before spawning.
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-tarball-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 5, builtAt: '', entries: [tarballEntry], denied: [], stars: {} }, stale: false }) as CatalogResult,
      dshBin: bin,
      fetchTarball,
      prefetcher: fixturePrefetcher(),
    })
  }

  it('verifies the sha256, then installs the validated tarball url and records the tag pin', async () => {
    // The spec is the snapshot's tarball url (a https github.com release of
    // this very repo, validated at parse), NOT a github: spec.
    // The pin write records the tag, which is the entry's version (the
    // manifest records only `github:owner/slug`, so the pins file is how
    // `installed()` reports outdated honestly).
    const fetchTarball = vi.fn(async () => new Response(tarballBytes))
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-tarball-install-'))
    const gateway = gatewayWithTarball(dir, fetchTarball)
    const result = await gateway.install({ name: 'dsh-rescued', version: tag, acknowledged: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(fetchTarball).toHaveBeenCalledWith(TARBALL_URL)
    const deadline = Date.now() + 5000
    let terminal = gateway.installStatus({ installId: result.installId })
    while (!isTerminalInstallState(terminal.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      terminal = gateway.installStatus({ installId: result.installId })
    }
    expect(terminal.state).toBe('done')
    expect(readFileSync(join(dir, 'calls.log'), 'utf8')).toContain(`plugin --profile web add ${TARBALL_URL}`)
    expect(JSON.parse(readFileSync(join(dir, 'cache/github-pins.json'), 'utf8'))).toEqual({ 'github:owner/slug#': tag })
  })

  it('rejects tarball-integrity without spawning when the bytes do not match the recorded sha256', async () => {
    const fetchTarball = vi.fn(async () => new Response(new TextEncoder().encode('tampered bytes')))
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-tarball-mismatch-'))
    const gateway = gatewayWithTarball(dir, fetchTarball)
    const result = await gateway.install({ name: 'dsh-rescued', version: tag, acknowledged: true })
    expect(result).toEqual({
      ok: false,
      code: 'tarball-integrity',
      detail: 'dsh-plugin-shop: the release tarball failed sha256 verification against the catalog record; refusing to install',
    })
    expect(fetchTarball).toHaveBeenCalledWith(TARBALL_URL)
    // A spawned fixture would have created the calls log within this settle window.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(join(dir, 'calls.log'))).toBe(false)
  })

  it('rejects tarball-integrity with a network-failure detail when the fetch throws', async () => {
    const fetchTarball = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-tarball-fetchfail-'))
    const gateway = gatewayWithTarball(dir, fetchTarball)
    const result = await gateway.install({ name: 'dsh-rescued', version: tag, acknowledged: true })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('tarball-integrity')
      expect(result.detail).toContain('network failure: ECONNREFUSED')
    }
    // Same no-spawn property as the mismatch: the check failed, nothing ran.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(join(dir, 'calls.log'))).toBe(false)
  })

  it('never calls fetchTarball for npm or github-commit installs', async () => {
    const fetchTarball = vi.fn(async () => new Response(tarballBytes))
    // The npm path: the spec is `name@version`, no release asset involved.
    const npmEntry: CatalogEntry = { name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' }
    const npmDir = mkdtempSync(join(TEMP_ROOT, 'dsh-npm-notarball-'))
    const npmBin = fakeDshRecording(npmDir, 0, { silent: true })
    const npmProfileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-npm-notarball-profile-'))
    writeFileSync(join(npmProfileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    const npmGateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(npmDir, 'cache'), profile: 'web', profileDir: npmProfileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 5, builtAt: '', entries: [npmEntry], denied: [], stars: {} }, stale: false }) as CatalogResult,
      dshBin: npmBin,
      fetchTarball,
      prefetcher: fixturePrefetcher(),
    })
    const npmResult = await npmGateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(npmResult.ok).toBe(true)
    // The github-commit path: the sibling of the tarball arm, spec
    // `github:owner/slug#commit` — still no release asset.
    const commit = 'c'.repeat(40)
    const repoEntry: CatalogEntry = {
      name: 'dsh-repo-plugin', version: commit, integrity: commit, publishedAt: null,
      repository: 'https://github.com/someone/dsh-repo-plugin', license: 'MIT',
      tier: 'community', metadata: 'declared', source: 'github', repo: 'someone/dsh-repo-plugin',
      added: '2026-08-25',
    }
    const repoDir = mkdtempSync(join(TEMP_ROOT, 'dsh-github-notarball-'))
    const repoBin = fakeDshRecording(repoDir, 0, { silent: true })
    const repoProfileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-github-notarball-profile-'))
    writeFileSync(join(repoProfileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    const repoGateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(repoDir, 'cache'), profile: 'web', profileDir: repoProfileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 5, builtAt: '', entries: [repoEntry], denied: [], stars: {} }, stale: false }) as CatalogResult,
      dshBin: repoBin,
      fetchTarball,
      prefetcher: fixturePrefetcher(),
    })
    const repoResult = await repoGateway.install({ name: 'dsh-repo-plugin', version: commit, acknowledged: true })
    expect(repoResult.ok).toBe(true)
    expect(fetchTarball).not.toHaveBeenCalled()
  })

  it('reports a release-rescued install as outdated when the catalog tag moves (G-11)', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-tarball-outdated-'))
    mkdirSync(join(dir, 'cache'), { recursive: true })
    writeFileSync(join(dir, 'cache/github-pins.json'), JSON.stringify({ 'github:owner/slug#': 'v1.0.0' }))
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-tarball-outdated-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', dsh: { profile: { bundles: [] } },
      dependencies: { 'dsh-rescued': TARBALL_URL },
    }))
    const newer: CatalogEntry = {
      ...tarballEntry, version: 'v1.1.0',
      tarball: { url: 'https://github.com/owner/slug/releases/download/v1.1.0/plugin.tgz', sha256: 'b'.repeat(64) },
    }
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 6, builtAt: '', entries: [newer], denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{
      name: 'dsh-rescued', source: 'github', repo: 'owner/slug',
      installed: 'v1.0.0', latest: 'v1.1.0', outdated: true, enabled: true,
    }])
  })
})

describe('verifyTarballSha256', () => {
  const url = 'https://github.com/owner/slug/releases/download/v1.0.0/plugin.tgz'
  const bytes = new TextEncoder().encode('fixture release tarball bytes')
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  it('returns null for matching bytes', async () => {
    await expect(verifyTarballSha256(async () => new Response(bytes), url, sha256)).resolves.toBeNull()
  })

  it('reports the mismatch in the detail', async () => {
    const detail = await verifyTarballSha256(
      async () => new Response(new TextEncoder().encode('different bytes')),
      url,
      sha256,
    )
    expect(detail).toBe('dsh-plugin-shop: the release tarball failed sha256 verification against the catalog record; refusing to install')
  })

  it('refuses a body over the byte cap with a size-cap detail', async () => {
    const detail = await verifyTarballSha256(async () => new Response(bytes), url, sha256, 8)
    expect(detail).toContain('exceeds the size cap')
    expect(detail).toContain('refusing to install')
  })

  it('names the HTTP status when the fetch answers non-2xx', async () => {
    const detail = await verifyTarballSha256(async () => new Response('nope', { status: 404 }), url, sha256)
    expect(detail).toBe('dsh-plugin-shop: the release tarball could not be fetched (HTTP 404); refusing to install')
  })
})

describe('hot paths — install / uninstall / update through the afterDone seam', () => {
  // The fixtures below drive the flows through the public RPC methods; the
  // hot functions and the loader entry list are injected exactly like the
  // other test-only seams (inventory, loadCatalog, ...).
  const hotMount = vi.fn(async (): Promise<HotMountResult> => ({ ok: true, reason: null }))
  const hotUnmount = vi.fn(async () => false)

  beforeEach(() => {
    hotMount.mockClear()
    hotUnmount.mockClear()
  })

  const snapshot: CatalogSnapshot = {
    schemaVersion: 6,
    builtAt: '',
    entries: [
      { name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' },
      { name: 'dsh-goodbye-plugin', version: '1.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' },
    ],
    denied: [],
    stars: {},
  }

  function hotGateway(options: {
    dependencies?: Record<string, string>
    hot?: ShopGatewayOptions['hot']
    loaderEntries?: ShopGatewayOptions['loaderEntries']
    /** Test-only: build the fake dsh CLI from the profile dir this function
     * is about to create, in place of the shared `gatewayOptions()` default.
     * Exists for the one test that needs a `remove` invocation to actually
     * delete the package's manifest — see `fakeDshRemovingManifest`. */
    dshBin?: (profileDir: string) => string
    /** The `hasClientHalf` read seam. Lets a test state what each VERSION of
     * a package declares, which a real manifest on disk cannot express: the
     * old one is overwritten by the time `afterDone` runs. */
    hotFs?: ShopGatewayOptions['hotFs']
  }): { gateway: ShopGateway; profileDir: string } {
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-hot-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dsh: { profile: { bundles: [] } },
      ...(options.dependencies !== undefined ? { dependencies: options.dependencies } : {}),
    }))
    for (const name of Object.keys(options.dependencies ?? {})) {
      fixturePackage(profileDir, name, `- insert:\n    - id: ${name}-row\n      name: '${name}/host'\n`)
    }
    const gateway = new ShopGateway(stubCtx(), {
      ...gatewayOptions(),
      profileDir,
      loadCatalog: async () => ({ snapshot, stale: false }) as CatalogResult,
      hot: options.hot,
      loaderEntries: options.loaderEntries,
      hotFs: options.hotFs,
      ...(options.dshBin !== undefined ? { dshBin: options.dshBin(profileDir) } : {}),
    })
    return { gateway, profileDir }
  }

  async function pollTerminal(gateway: ShopGateway, installId: string): Promise<ShopInstallStatusResult> {
    const deadline = Date.now() + 5000
    let status = gateway.installStatus({ installId })
    // TERMINAL, which is what this helper is named for. Asking `=== 'running'`
    // returned a QUEUED install's 'downloading' as though it were settled, and
    // every caller below then asserts `state === 'done'` against it.
    while (!isTerminalInstallState(status.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      status = gateway.installStatus({ installId })
    }
    return status
  }

  it('install reports activation restart when no manifest exists yet (the conservative fallback)', async () => {
    const { gateway, profileDir } = hotGateway({
      hot: { mount: hotMount, unmount: hotUnmount },
      loaderEntries: () => [],
    })
    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await pollTerminal(gateway, started.installId)
    expect(status.state).toBe('done')
    // No node_modules/dsh-hello-plugin/package.json exists in this fixture —
    // hasClientHalf's conservative fallback (unreadable manifest => assume a
    // browser half) answers true, so this is not 'live'. And on the hot-mount
    // path a browser half means `restart`, never `reload`: the mount adds to
    // the live loader entries without entering the composition the client
    // registry enumerates, so a reload has nothing to fetch (activation.ts).
    // The dedicated tests below pin each case with an explicit manifest
    // instead of relying on the fallback.
    expect(status.activation).toBe('restart')
    expect(status.restartReason).toBe('client-half')
    expect(hotMount).toHaveBeenCalledTimes(1)
    expect(hotMount).toHaveBeenCalledWith(expect.anything(), profileDir, 'dsh-hello-plugin')
  })

  it('an update disables the live boot entry before the new instance mounts, retrying until the fiber is down', async () => {
    const order: string[] = []
    const entry: LoaderEntryLike = {
      id: 'dsh-hello-plugin-row',
      options: { name: 'dsh-hello-plugin/host' },
      fiber: {},
      update: vi.fn(async () => {
        order.push('disable')
        // The first two updates leave the fiber up (a finishing init still
        // in flight); the third clears it, so liveDisable stops retrying.
        if (order.filter(call => call === 'disable').length >= 3) entry.fiber = undefined
      }),
    }
    const mount = vi.fn(async () => {
      order.push('mount')
      return { ok: true, reason: null }
    })
    const { gateway } = hotGateway({
      dependencies: { 'dsh-hello-plugin': '1.2.0' },
      hot: { mount, unmount: hotUnmount },
      loaderEntries: () => [entry],
    })
    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await pollTerminal(gateway, started.installId)
    expect(status.state).toBe('done')
    expect(status.activation).toBe('live')
    expect(entry.update).toHaveBeenCalledTimes(3)
    expect(entry.update).toHaveBeenCalledWith({ disabled: true }, false, true)
    expect(order).toEqual(['disable', 'disable', 'disable', 'mount'])
  })

  it('a failed hot mount reports done with activation restart and the restart reason', async () => {
    hotMount.mockResolvedValueOnce({ ok: false, reason: 'not-simple' })
    const { gateway } = hotGateway({ hot: { mount: hotMount, unmount: hotUnmount }, loaderEntries: () => [] })
    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await pollTerminal(gateway, started.installId)
    expect(status.state).toBe('done')
    expect(status.activation).toBe('restart')
    expect(status.restartReason).toBe('not-simple')
  })

  it('uninstall of a hot-mounted plugin unmounts it without touching the loader', async () => {
    const unmount = vi.fn(async () => true)
    const update = vi.fn(async () => {})
    const { gateway } = hotGateway({
      dependencies: { 'dsh-goodbye-plugin': '1.0.0' },
      hot: { mount: hotMount, unmount },
      loaderEntries: () => [{ options: { name: 'dsh-goodbye-plugin' }, update }],
    })
    const result = await gateway.uninstall({ name: 'dsh-goodbye-plugin' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const status = await pollTerminal(gateway, result.installId)
    expect(status.state).toBe('done')
    expect(status.activation).toBe('live')
    expect(unmount).toHaveBeenCalledWith('dsh-goodbye-plugin')
    expect(update).not.toHaveBeenCalled()
  })

  it('uninstall without a hot mount live-disables the boot entry and still reports done without restart', async () => {
    const update = vi.fn(async () => {})
    const { gateway } = hotGateway({
      dependencies: { 'dsh-goodbye-plugin': '1.0.0' },
      hot: { mount: hotMount, unmount: hotUnmount },
      loaderEntries: () => [{ id: 'dsh-goodbye-plugin-row', options: { name: 'dsh-goodbye-plugin/host' }, update }],
    })
    const result = await gateway.uninstall({ name: 'dsh-goodbye-plugin' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const status = await pollTerminal(gateway, result.installId)
    expect(status.state).toBe('done')
    expect(status.activation).toBe('live')
    expect(hotUnmount).toHaveBeenCalledWith('dsh-goodbye-plugin')
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ disabled: true }, false, true)
  })

  it('uninstall still completes for a package whose bundle patch cannot be read', async () => {
    // Resolving the live entry ids is an optimization on this path; a package
    // with an unreadable patch must still be removable.
    const { gateway, profileDir } = hotGateway({
      dependencies: { 'dsh-goodbye-plugin': '1.0.0' },
      hot: { mount: hotMount, unmount: hotUnmount },
      loaderEntries: () => [],
    })
    writeFileSync(join(profileDir, 'node_modules', 'dsh-goodbye-plugin', 'cordis.patch.yml'), 'this: is not: a patch list\n')
    const result = await gateway.uninstall({ name: 'dsh-goodbye-plugin' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const status = await pollTerminal(gateway, result.installId)
    expect(status.state).toBe('done')
  })

  it('uninstall of a plugin that never loaded still reports activation live (host-only)', async () => {
    // This doubles as "live after uninstalling a host-only package":
    // fixturePackage's auto-seeded manifest here has a bundle patch and no
    // dsh.client, which is exactly that shape — a separate test with the
    // same setup and assertion would only restate this one.
    //
    // The fake dsh here is `fakeDshRemovingManifest`, not the usual
    // `fakeDshRecording`: a real `dsh plugin remove` deletes the package's
    // manifest, and without that this test cannot tell "hadClientHalf read
    // before startUninstall" from "read inside afterDone" apart —
    // hasClientHalf would see the same still-present, client-less manifest
    // either way and answer `false` regardless of when it ran. Deleting it
    // makes the two orderings diverge: a post-removal read hits the
    // unreadable-manifest fallback (`true`, conservative) and reports
    // `reload` instead of `live`.
    const binDir = mkdtempSync(join(TEMP_ROOT, 'dsh-uninstall-removing-'))
    const { gateway } = hotGateway({
      dependencies: { 'dsh-goodbye-plugin': '1.0.0' },
      hot: { mount: hotMount, unmount: hotUnmount },
      loaderEntries: () => [],
      dshBin: profileDir => fakeDshRemovingManifest(binDir, profileDir, 0),
    })
    const result = await gateway.uninstall({ name: 'dsh-goodbye-plugin' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const status = await pollTerminal(gateway, result.installId)
    expect(status.state).toBe('done')
    expect(status.activation).toBe('live')
  })

  it('reports activation restart when the uninstalled plugin will not go down', async () => {
    const entry: LoaderEntryLike = {
      id: 'dsh-goodbye-plugin-row',
      options: { name: 'dsh-goodbye-plugin/host' },
      // Every update is accepted and the fiber never clears: the row is
      // disabled in the user layer, but the instance is still running.
      fiber: {},
      update: vi.fn(async () => {}),
    }
    const { gateway } = hotGateway({
      dependencies: { 'dsh-goodbye-plugin': '1.0.0' },
      // `hotUnmount` resolves false: this plugin was composed at boot, not
      // hot-mounted by the shop this session, so that arm removes nothing.
      hot: { mount: hotMount, unmount: hotUnmount },
      loaderEntries: () => [entry],
    })
    const result = await gateway.uninstall({ name: 'dsh-goodbye-plugin' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const status = await pollTerminal(gateway, result.installId)
    expect(status.state).toBe('done')
    // The dependency is gone and nothing comes back at the next boot, but the
    // fiber is up NOW — so "Removed and stopped immediately" is a false claim
    // about privilege revocation, and a restart is the honest advice. The
    // verdict that answers this was already computed here, and discarded.
    expect(status.activation).toBe('restart')
    expect(entry.update).toHaveBeenCalledTimes(3)
  })

  it('reports activation restart when an update removes the package browser half', async () => {
    const hotFs = memHotFs()
    const mount = vi.fn(async (_ctx: unknown, dir: string, name: string): Promise<HotMountResult> => {
      // By the time the mount runs, the new tarball has overwritten the
      // manifest — and this version declares no browser half any more.
      hotFs.write(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name }))
      return { ok: true, reason: null }
    })
    const { gateway, profileDir } = hotGateway({
      // Same spelling as the sibling update test: the fake CLI rewrites no
      // manifest, and the post-install confirm reads DSH_HOME's fixture
      // profile — which lists dsh-hello-plugin and not dsh-goodbye-plugin.
      dependencies: { 'dsh-hello-plugin': '1.2.0' },
      hot: { mount, unmount: hotUnmount },
      loaderEntries: () => [],
      hotFs,
    })
    // The version on disk when the update starts HAS a browser half, and
    // the open tab is running that bundle right now.
    hotFs.write(join(profileDir, 'node_modules', 'dsh-hello-plugin', 'package.json'), JSON.stringify({
      name: 'dsh-hello-plugin',
      dsh: { client: { inject: [], platform: 'web' } },
    }))

    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await pollTerminal(gateway, started.installId)
    expect(status.state).toBe('done')
    // Reading only in `afterDone` answers about the NEW version — `live`,
    // "nothing to do" — while the tab still holds the old bundle. The union
    // of the two reads is what separates this from `live`, and it is still
    // load-bearing after the hot-mount path moved from `reload` to
    // `restart`: without it this case answers "nothing to do" about a tab
    // that is showing a browser half the server no longer intends.
    //
    // `restart` rather than `reload` deliberately, and conservatively: a
    // reload might well drop the old bundle here, but the only thing
    // measured on this path is that a reload does NOT deliver a hot-mounted
    // one (2026-09-14), so the step known to work is the one offered.
    expect(status.activation).toBe('restart')
    expect(status.restartReason).toBe('client-half')
    expect(mount).toHaveBeenCalledTimes(1)
  })

  it('self-update still reports activation restart — no hot path is wired', async () => {
    const { gateway } = hotGateway({ hot: { mount: hotMount, unmount: hotUnmount } })
    const started = await gateway.updateStart({ version: '9.9.9' })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await pollTerminal(gateway, started.installId)
    expect(status.state).toBe('done')
    expect(status.activation).toBe('restart')
    expect(hotMount).not.toHaveBeenCalled()
    expect(hotUnmount).not.toHaveBeenCalled()
  })

  it('reports activation restart when a hot-mounted install has a browser half', async () => {
    const { gateway, profileDir } = hotGateway({ hot: { mount: hotMount, unmount: hotUnmount }, loaderEntries: () => [] })
    // fixturePackage cannot express `dsh.client`; write the manifest by hand
    // before the install call, matching the shape a real client-half
    // package declares.
    mkdirSync(join(profileDir, 'node_modules', 'dsh-hello-plugin'), { recursive: true })
    writeFileSync(join(profileDir, 'node_modules', 'dsh-hello-plugin', 'package.json'), JSON.stringify({
      name: 'dsh-hello-plugin',
      dsh: { client: { inject: [], platform: 'web' } },
    }))
    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await pollTerminal(gateway, started.installId)
    expect(status.state).toBe('done')
    // The host half mounted and is running; its browser half is not in the
    // graph a reloading tab is served, and cannot be put there without a
    // restart. The reason distinguishes this from the four mount FAILURES,
    // which would otherwise all read as one generic restart line.
    expect(status.activation).toBe('restart')
    expect(status.restartReason).toBe('client-half')
  })

  it('reports activation live when a hot-mounted install is host-only', async () => {
    const { gateway } = hotGateway({
      dependencies: { 'dsh-hello-plugin': '1.2.0' },
      hot: { mount: hotMount, unmount: hotUnmount },
      loaderEntries: () => [],
    })
    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await pollTerminal(gateway, started.installId)
    expect(status.state).toBe('done')
    expect(status.activation).toBe('live')
  })

  it('reports activation restart when the hot mount fails, client half or not', async () => {
    hotMount.mockResolvedValueOnce({ ok: false, reason: 'not-simple' })
    const { gateway, profileDir } = hotGateway({ hot: { mount: hotMount, unmount: hotUnmount }, loaderEntries: () => [] })
    // A manifest that WOULD read as a browser half if anyone looked: the
    // mount failure short-circuits before packageHasClientHalf is even
    // called, so this fixture proves restart wins regardless.
    mkdirSync(join(profileDir, 'node_modules', 'dsh-hello-plugin'), { recursive: true })
    writeFileSync(join(profileDir, 'node_modules', 'dsh-hello-plugin', 'package.json'), JSON.stringify({
      name: 'dsh-hello-plugin',
      dsh: { client: { inject: [], platform: 'web' } },
    }))
    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await pollTerminal(gateway, started.installId)
    expect(status.state).toBe('done')
    expect(status.activation).toBe('restart')
    expect(status.restartReason).toBe('not-simple')
  })

  it('reports activation reload after uninstalling a hot-mounted package with a browser half', async () => {
    const { gateway, profileDir } = hotGateway({
      dependencies: { 'dsh-goodbye-plugin': '1.0.0' },
      hot: { mount: hotMount, unmount: hotUnmount },
      loaderEntries: () => [],
    })
    // Overwrite the auto-seeded host-only manifest with a client-half one —
    // fixturePackage cannot express `dsh.client` — before calling uninstall.
    //
    // This is NOT the ordering discriminator, and the spec no longer claims
    // it is (§5): for a client-declaring package both orderings answer
    // `reload`, because a late read hits the deleted manifest and the
    // conservative fallback assumes a browser half. The host-only sibling
    // above, which runs `fakeDshRemovingManifest` and asserts `live`, is the
    // one that separates them. What this test establishes is the other half:
    // that a declared browser half reaches `reload` at all.
    // Re-seeded rather than overwritten: hotGateway already wrote this
    // package's manifest AND its bundle patch, and replacing the manifest
    // with a client-only one drops the patch — which empties priorEntryIds
    // and makes this test's live-disable arm inert.
    fixturePackage(
      profileDir,
      'dsh-goodbye-plugin',
      "- insert:\n    - id: dsh-goodbye-plugin-row\n      name: 'dsh-goodbye-plugin/host'\n",
      { inject: [], platform: 'web' },
    )
    const result = await gateway.uninstall({ name: 'dsh-goodbye-plugin' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const status = await pollTerminal(gateway, result.installId)
    expect(status.state).toBe('done')
    expect(status.activation).toBe('reload')
  })
})

describe('ShopGateway.setEnabled entry ownership', () => {
  // @tt-a1i/archify-dsh's real published shape: it registers no module of its
  // own, it inserts a configured instance of a harness module. Every fixture
  // in this file used to give the entry the package's own name, so the
  // module-name lookup passed for a coincidence and the toggle reported this
  // package — and every package like it — as not installed.
  const archifyPatch = "- insert:\n    - id: archify-skill-filesystem\n      name: '@deepseek-ai/dsh-skill-filesystem'\n"

  it('toggles a package whose entry mounts another package\'s module', async () => {
    const profileDir = toggleProfile()
    fixturePackage(profileDir, '@tt-a1i/archify-dsh', archifyPatch)
    const gateway = new ShopGateway(stubCtx(), {
      profile: 'web', profileDir,
      inventory: { list: async () => ({ entries: [
        { entryId: 'archify-skill-filesystem', moduleName: '@deepseek-ai/dsh-skill-filesystem', enabled: true },
      ] }) },
    })
    const result = await gateway.setEnabled({ name: '@tt-a1i/archify-dsh', enabled: false })
    expect(result).toEqual({ ok: true, activation: 'live' })
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('archify-skill-filesystem')
  })

  it('toggles a package the REAL harness composed — the live ids carry the root include prefix', async () => {
    // dsh's app-boot mounts the whole profile as one root Include, so the
    // inventory reports `include:<id>` for every entry a bundle patch
    // inserted. The shop matched only the bare id, so no row was ever found
    // and every plugin's switch answered "not in the running plugin tree".
    const profileDir = toggleProfile()
    fixturePackage(profileDir, '@tt-a1i/archify-dsh', archifyPatch)
    const gateway = new ShopGateway(stubCtx(), {
      profile: 'web', profileDir,
      inventory: { list: async () => ({ entries: [
        { entryId: 'include:archify-skill-filesystem', moduleName: '@deepseek-ai/dsh-skill-filesystem', enabled: true },
      ] }) },
    })
    expect(await gateway.setEnabled({ name: '@tt-a1i/archify-dsh', enabled: false })).toEqual({ ok: true, activation: 'live' })
    const written = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    // The user layer is applied in the CONFIG id space: the harness's
    // applyEntryPatches looks each row's id up among the ids the bundle
    // patches declared, so a row naming the live `include:` spelling matches
    // nothing and the disable is a silent no-op (verified against dsh
    // 0.1.1-rc.2: the prefixed row left the plugin running, the bare one
    // brought its fiber down).
    expect(written).toContain('archify-skill-filesystem')
    expect(written).not.toContain('include:')
  })

  it('writes the config id for a plugin still mounted in the shop\'s hot subtree', async () => {
    // A plugin installed this session runs from the hot tree as
    // `include:<tree>:mkt-<id>`. That spelling exists only in this process:
    // the user layer never composes it, and after the restart the entry
    // returns under its bare id — so a row naming the hot id would be lost
    // forever. The row names what the next boot will compose.
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-fresh', '- insert:\n    - id: fresh-entry\n      name: dsh-fresh\n')
    const gateway = new ShopGateway(stubCtx(), {
      profile: 'web', profileDir,
      inventory: { list: async () => ({ entries: [
        { entryId: 'include:typert-gateway:mkt-fresh-entry', moduleName: 'dsh-fresh', enabled: true },
      ] }) },
    })
    expect(await gateway.setEnabled({ name: 'dsh-fresh', enabled: false })).toEqual({ ok: true, activation: 'live' })
    const written = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(written).toContain('fresh-entry')
    expect(written).not.toContain('mkt-')
  })

  it('re-enabling drops the row again', async () => {
    const profileDir = toggleProfile()
    fixturePackage(profileDir, '@tt-a1i/archify-dsh', archifyPatch)
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: archify-skill-filesystem\n  disabled: true\n')
    const gateway = new ShopGateway(stubCtx(), {
      profile: 'web', profileDir,
      inventory: { list: async () => ({ entries: [
        { entryId: 'archify-skill-filesystem', moduleName: '@deepseek-ai/dsh-skill-filesystem', enabled: false },
      ] }) },
    })
    expect(await gateway.setEnabled({ name: '@tt-a1i/archify-dsh', enabled: true })).toEqual({ ok: true, activation: 'live' })
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).not.toContain('archify-skill-filesystem')
  })

  it('toggles every entry of a package that inserts several', async () => {
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-many', '- insert:\n    - id: many-host\n      name: dsh-many/host\n    - id: many-web\n      name: dsh-many/web\n')
    const gateway = new ShopGateway(stubCtx(), {
      profile: 'web', profileDir,
      inventory: { list: async () => ({ entries: [
        { entryId: 'many-host', moduleName: 'dsh-many/host', enabled: true },
        { entryId: 'many-web', moduleName: 'dsh-many/web', enabled: true },
      ] }) },
    })
    expect(await gateway.setEnabled({ name: 'dsh-many', enabled: false })).toEqual({ ok: true, activation: 'live' })
    const written = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(written).toContain('many-host')
    expect(written).toContain('many-web')
  })

  it('says a package contributes no entries rather than calling it uninstalled', async () => {
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-libonly', null)
    const gateway = new ShopGateway(stubCtx(), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [] }) } })
    const result = await gateway.setEnabled({ name: 'dsh-libonly', enabled: false })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.detail).toContain('contributes no plugin entries')
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
  })

  it('reports an unreadable bundle patch as a reason instead of throwing past the RPC', async () => {
    // A throw here crosses the wire as a bare transport failure, and the
    // client can only say "please retry" — the one rejection on this path
    // with no author-readable detail. Malformed patch content is ordinary
    // hostile npm input, so it must arrive as a reason.
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-broken', 'this: is not: a patch list\n')
    const gateway = new ShopGateway(stubCtx(), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [] }) } })
    const result = await gateway.setEnabled({ name: 'dsh-broken', enabled: false })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.detail).toContain('dsh-broken')
    expect(result.ok === false && result.detail).toContain('bundle patch that could not be read')
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
  })

  it('reports a patch path that escapes the package directory the same way', async () => {
    const profileDir = toggleProfile()
    const dir = join(profileDir, 'node_modules', 'dsh-escapee')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-escapee', dsh: { bundle: { patch: '../../../evil.yml' } } }))
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
    manifest.dependencies = { 'dsh-escapee': '1.0.0' }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const gateway = new ShopGateway(stubCtx(), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [] }) } })
    const result = await gateway.setEnabled({ name: 'dsh-escapee', enabled: false })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.detail).toContain('outside its own directory')
  })

  it('says the entries are not in the running tree when none is live', async () => {
    const profileDir = toggleProfile()
    fixturePackage(profileDir, '@tt-a1i/archify-dsh', archifyPatch)
    const gateway = new ShopGateway(stubCtx(), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [] }) } })
    const result = await gateway.setEnabled({ name: '@tt-a1i/archify-dsh', enabled: false })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.detail).toContain('not in the running plugin tree')
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
  })
})

describe('ShopGateway.catalog incompatibility', () => {
  // Annotated so the literal's tier/metadata/source do not widen to `string`
  // (the same reason `listed` above is annotated `CatalogEntry`).
  const peered: CatalogEntry = {
    name: 'dsh-timeline', version: '0.1.4', integrity: null, publishedAt: null, repository: null,
    license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25',
    peers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store'],
  }

  it('names the missing peer on the catalog result', async () => {
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 6, builtAt: '', entries: [peered], denied: [], stars: {} },
      { resolvePeer: (spec: string) => spec !== '@deepseek-ai/dsh-client-store' },
    )
    const result = await gateway.catalog({})
    expect(result.incompatible).toEqual({ 'npm:dsh-timeline': ['@deepseek-ai/dsh-client-store'] })
  })

  it('reports nothing when every peer resolves', async () => {
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 6, builtAt: '', entries: [peered], denied: [], stars: {} },
      { resolvePeer: () => true },
    )
    expect((await gateway.catalog({})).incompatible).toEqual({})
  })

  it('reports nothing for an entry that carries no peers, however resolution would answer', async () => {
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [{ ...peered, peers: undefined }], denied: [], stars: {} },
      { resolvePeer: () => false },
    )
    expect((await gateway.catalog({})).incompatible).toEqual({})
  })

  it('reports nothing, rather than throwing, when no profile anchor exists for a peer-bearing entry', async () => {
    // Pairs the two conditions the no-profile branch in `catalog()` exists
    // for: no `profileDir` (so no profile directory can be discovered and no
    // resolver can be anchored) together with an entry that DOES declare
    // peers (so there is something for a resolver to be asked about, if one
    // existed). Neither condition alone exercises that branch's real job: the
    // "no profileDir" tests in `describe('ShopGateway.catalog', ...)` above
    // use an entry with no `peers` at all, so incompatibilityMap skips it
    // before ever touching a resolver; every other test in this block injects
    // `resolvePeer` with a profile directory, so the branch is never taken.
    // Only this pairing proves a plugin we cannot judge is never accused — do
    // not "simplify" this fixture back to either half. (Until 2026-09-25 a
    // catch around a throwing profile lookup did this job; the directory is
    // now looked up once per call, and its absence answers directly.)
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/',
      cacheDir: '/cache',
      profile: 'web',
      loadCatalog: async () => ({
        snapshot: { schemaVersion: 6, builtAt: '', entries: [peered], denied: [], stars: {} },
        stale: false,
      }) as CatalogResult,
    })

    const result = await gateway.catalog({})
    expect(result.incompatible).toEqual({})
  })

  it('degrades a peer list it cannot read to no peer verdicts, rather than rejecting', async () => {
    // `peers: 5` never survives the catalog's zod parse; injected through
    // `loadCatalog` it reaches incompatibilityMap, which throws on it. The
    // guard around that call is what keeps one such entry from rejecting
    // catalog() for everyone. (The same guard on the harness map is the last
    // case of `ShopGateway.catalog harness compatibility`.)
    const malformed = { ...peered, name: 'malformed', peers: 5 } as unknown as CatalogEntry
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 6, builtAt: '', entries: [peered, malformed], denied: [], stars: {} },
      { resolvePeer: () => false },
    )
    const result = await gateway.catalog({})
    expect(result.incompatible).toEqual({})
    expect(result.plugins).toHaveLength(2)
  })

  it('asks again on every call, so a peer installed between two calls stops being reported', async () => {
    // The ordinary event: the reader installs the peer a badge names, and the
    // next time the tab asks, the badge must be gone. Both calls load the SAME
    // snapshot object — gatewayWithSnapshot's stub closes over one — which is
    // precisely the case a cache keyed on the snapshot answers from memory,
    // replaying "missing" for a peer that now resolves. The snapshot records
    // what an entry declares; what this installation provides is not in it,
    // and moves under it.
    let installed = false
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [peered], denied: [], stars: {} },
      { resolvePeer: (spec: string) => spec !== '@deepseek-ai/dsh-client-store' || installed },
    )

    const before = await gateway.catalog({})
    expect(before.incompatible).toEqual({ 'npm:dsh-timeline': ['@deepseek-ai/dsh-client-store'] })

    installed = true
    const after = await gateway.catalog({})
    expect(after.incompatible).toEqual({})
  })
})

/** `PROFILE_TEMPLATES` as dsh-app-boot 0.1.5-rc.3 exports it, verbatim: five
 * templates, `acp` among them — which the app-boot this repository installs
 * as a devDependency (0.1.1-rc.2: `web` and `headless` only) does not have. A
 * verdict that judges `acp` can only have read the fixture's table. */
const RC3_PROFILE_TEMPLATES = {
  acp: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'], patchReload: 'startup' },
  web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' },
  headless: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'], patchReload: 'startup' },
  sdk: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'], patchReload: 'startup' },
  'sdk-minimal': { bundles: ['@deepseek-ai/dsh-sdk-minimal'], patchReload: 'startup' },
}

/**
 * A dsh installation to run the gateway inside, the production path: the
 * gateway identifies the running harness from `restartScript` (`harness.ts`),
 * and this returns one. `<root>/node_modules/@deepseek-ai/dsh` carries
 * `manifest` and the `lib/bin.js` its `bin` names — never executed — with its
 * own `@deepseek-ai/dsh-app-boot` nested under it, whose entry exports
 * `templates` and nothing else. `tests/host/harness.test.ts` covers the
 * reader's own rules; this is only the shape the gateway needs.
 */
function fixtureHarness(manifest: Record<string, unknown> = { version: '0.1.5-rc.3' }, templates: unknown = RC3_PROFILE_TEMPLATES): { root: string; script: string } {
  const root = mkdtempSync(join(TEMP_ROOT, 'dsh-harness-'))
  const dshDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(dshDir, 'lib'), { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module', bin: { dsh: 'lib/bin.js' }, ...manifest }))
  writeFileSync(join(dshDir, 'lib', 'bin.js'), '')
  const appBoot = join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  mkdirSync(join(appBoot, 'lib'), { recursive: true })
  writeFileSync(join(appBoot, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-app-boot', version: '0.1.5-rc.3', type: 'module',
    main: 'lib/index.js', exports: { '.': { default: './lib/index.js' } },
  }))
  writeFileSync(join(appBoot, 'lib', 'index.js'), `export const PROFILE_TEMPLATES = ${JSON.stringify(templates)}\n`)
  return { root, script: join(dshDir, 'lib', 'bin.js') }
}

describe('ShopGateway.catalog harness compatibility', () => {
  /** `@xmanrui/dsh-im@4.19.2`'s own `dsh.compatibility.dsh`, verbatim (design
   * 2026-09-01-harness-compatibility §8.2): five exact versions, none of them
   * a harness anyone runs today. */
  const DSH_IM_RANGE = '0.1.2-alpha.4 || 0.1.2-alpha.5 || 0.1.2-rc.1 || 0.1.3-alpha.1 || 0.1.5-alpha.1'
  const dshIm: CatalogEntry = {
    name: '@xmanrui/dsh-im', version: '4.19.2', integrity: null, publishedAt: null, repository: null,
    license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25',
    compatibility: { dsh: DSH_IM_RANGE, profiles: ['web'] },
  }
  /** A range no harness on the 0.1 line satisfies, so a READABLE version
   * always adds a `dsh` half — which is what makes its absence mean something.
   *
   * `headless` is a template in the fixture harness's table, and one the
   * fixture profile does not compose (its bundles are the web template's), so
   * a readable table always adds a `profile` half too. `tui`, the name this
   * used to declare, is no template at all — silence under §9.9, which would
   * make these tests pass for the wrong reason. */
  const headlessOnly: CatalogEntry = { ...dshIm, name: 'dsh-headless-only', compatibility: { dsh: '0.9.0', profiles: ['headless'] } }
  const HEADLESS_UNMET = { profile: { declared: ['headless'], running: 'web' } }

  it('carries the verdict, naming what the author declared and what is running', async () => {
    // The running version is the fixture dsh's own. The profile is named
    // `tui`, a name no template carries, so its bundles decide `web`, and
    // they are the web template's: met. The RANGE is what this declaration
    // fails.
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [dshIm], denied: [], stars: {} },
      { profile: 'tui', restartScript: fixtureHarness().script },
    )
    expect((await gateway.catalog({})).incompatibleHarness).toEqual({
      'npm:@xmanrui/dsh-im': { dsh: { range: DSH_IM_RANGE, running: '0.1.5-rc.3' } },
    })
  })

  it('reads the running version from the dsh that runs, not from a copy the profile can import', async () => {
    // The defect this replaced, reproduced with real installs: a listed plugin
    // (`dsh-claude-tui@0.1.6`) depends on `@deepseek-ai/dsh` 0.1.2-rc.1, pnpm
    // hoists that copy into `<profile>/node_modules`, and the verdict read it
    // — "running 0.1.2-rc.1" on every card while 0.1.5-rc.3 ran. Until
    // 2026-09-25 this test PINNED that read: it put a copy in the profile and
    // expected the verdict to name it. The copy is here again, at the version
    // the hoisted one had, and must change nothing: an entry declaring exactly
    // that version is told what actually runs.
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-harness-hoisted-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }, dependencies: {} }))
    const hoisted = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(hoisted, { recursive: true })
    writeFileSync(join(hoisted, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-rc.1' }))
    const declaresHoisted: CatalogEntry = { ...dshIm, name: 'declares-hoisted', compatibility: { dsh: '0.1.2-rc.1' } }
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [declaresHoisted], denied: [], stars: {} },
      { profileDir, restartScript: fixtureHarness().script },
    )
    expect((await gateway.catalog({})).incompatibleHarness).toEqual({
      'npm:declares-hoisted': { dsh: { range: '0.1.2-rc.1', running: '0.1.5-rc.3' } },
    })
  })

  it("judges the profile half by the running dsh's own template table", async () => {
    // `acp` is in 0.1.5-rc.3's table and not in the app-boot this repository
    // installs (0.1.1-rc.2), which is what the shop's own `import * as appBoot`
    // used to read — under a `link:` install, beside a 0.1.5-rc.3 dsh half.
    const acpOnly: CatalogEntry = { ...dshIm, name: 'acp-only', compatibility: { profiles: ['acp'] } }
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [acpOnly], denied: [], stars: {} },
      { restartScript: fixtureHarness().script },
    )
    expect((await gateway.catalog({})).incompatibleHarness).toEqual({
      'npm:acp-only': { profile: { declared: ['acp'], running: 'web' } },
    })
  })

  it('leaves both halves silent when the running script is not owned by @deepseek-ai/dsh', async () => {
    // Nothing then says which harness runs: a test runner, another host. The
    // default script under vitest is the runner's own worker entry (today
    // tinypool's `dist/entry/process.js`) — the second gateway below — so
    // every other catalog test in this file is silent on this map for the
    // same reason. `headlessOnly` fails both halves against any readable
    // harness, so only an unidentified one says nothing.
    const host = mkdtempSync(join(TEMP_ROOT, 'dsh-harness-other-'))
    writeFileSync(join(host, 'package.json'), JSON.stringify({ name: 'some-host', version: '1.0.0' }))
    writeFileSync(join(host, 'main.js'), '')
    const snapshot: CatalogSnapshot = { schemaVersion: 5, builtAt: '', entries: [headlessOnly], denied: [], stars: {} }
    for (const options of [{ restartScript: join(host, 'main.js') }, {}]) {
      const { gateway } = gatewayWithSnapshot(snapshot, options)
      expect((await gateway.catalog({})).incompatibleHarness, JSON.stringify(options)).toEqual({})
    }
  })

  it('judges the range half without a profile directory, and leaves the profile half silent', async () => {
    // No `profileDir` and nothing above this module is a profile, so the
    // profile's bundles are a fact nobody can read — while the running
    // version never depended on the profile, and is judged. (Until
    // 2026-09-25 the version was read from the profile anchor, so this case
    // expected no verdict at all.)
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/',
      cacheDir: '/cache',
      profile: 'web',
      restartScript: fixtureHarness().script,
      loadCatalog: async () => ({
        snapshot: { schemaVersion: 5, builtAt: '', entries: [headlessOnly], denied: [], stars: {} },
        stale: false,
      }) as CatalogResult,
    })

    const result = await gateway.catalog({})
    expect(result.incompatibleHarness).toEqual({ 'npm:dsh-headless-only': { dsh: { range: '0.9.0', running: '0.1.5-rc.3' } } })
    expect(result.incompatible).toEqual({})
  })

  it.each([
    ['declares no version', {}],
    ['declares an empty one', { version: '' }],
    ['declares one that is not semver', { version: 'nightly' }],
  ])('judges only the profile half when the running dsh %s', async (_label, manifest) => {
    // An unknown silences its own half and no other (design §8.2): the
    // template table is read whatever the version is.
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [headlessOnly], denied: [], stars: {} },
      { restartScript: fixtureHarness(manifest).script },
    )
    expect((await gateway.catalog({})).incompatibleHarness).toEqual({ 'npm:dsh-headless-only': HEADLESS_UNMET })
  })

  it('reads the running harness once per gateway', async () => {
    // Which dsh this process is cannot change while it runs, and the read
    // imports a module, so the gateway keeps it. The fixture is deleted after
    // the first call: a second read would find nothing and name no version.
    // (Until 2026-09-25 the version was re-read on every call, from the
    // profile anchor — which is where a hoisted copy could move it.)
    const harness = fixtureHarness()
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [headlessOnly], denied: [], stars: {} },
      { restartScript: harness.script },
    )
    const both = { 'npm:dsh-headless-only': { dsh: { range: '0.9.0', running: '0.1.5-rc.3' }, ...HEADLESS_UNMET } }
    expect((await gateway.catalog({})).incompatibleHarness).toEqual(both)

    rmSync(harness.root, { recursive: true, force: true })
    expect((await gateway.catalog({})).incompatibleHarness).toEqual(both)
  })

  it("reads the running profile's bundles again on every call", async () => {
    // Only the harness is kept. What the profile composes moves under a
    // running dsh — an install appends a bundle — so the profile half follows
    // the manifest as it stands, and the same snapshot object is served twice.
    const acpOnly: CatalogEntry = { ...dshIm, name: 'acp-only', compatibility: { profiles: ['acp'] } }
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-harness-bundles-'))
    const writeBundles = (bundles: string[]): void =>
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } }, dependencies: {} }))
    writeBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [acpOnly], denied: [], stars: {} },
      { profileDir, restartScript: fixtureHarness().script },
    )
    expect(Object.keys((await gateway.catalog({})).incompatibleHarness)).toEqual(['npm:acp-only'])

    writeBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-acp-app'])
    expect((await gateway.catalog({})).incompatibleHarness).toEqual({})
  })

  it('answers the catalog when an entry declares a profile named after an Object.prototype member', async () => {
    // One entry declaring `profiles: ["constructor"]` made every catalog()
    // call reject for every user: the template table was a plain object, and
    // `templates.constructor` is a function. It is an unknown name now —
    // unjudged, silent — and the entry beside it is still judged.
    const prototypeNamed: CatalogEntry = { ...dshIm, name: 'prototype-named', compatibility: { profiles: ['constructor'] } }
    const acpOnly: CatalogEntry = { ...dshIm, name: 'acp-only', compatibility: { profiles: ['acp'] } }
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [prototypeNamed, acpOnly], denied: [], stars: {} },
      { restartScript: fixtureHarness().script },
    )
    expect((await gateway.catalog({})).incompatibleHarness).toEqual({
      'npm:acp-only': { profile: { declared: ['acp'], running: 'web' } },
    })
  })

  it('degrades a declaration it cannot judge to no harness verdicts, and keeps the peer map', async () => {
    // `profiles: 5` never survives the catalog's zod parse; injected through
    // `loadCatalog` it reaches compatibilityMap, which throws on it. That
    // throw must cost this map and nothing else — the call resolves, the peer
    // verdict beside it stands — the same rule as the peer map's own guard.
    // The whole map goes, the genuine `acp-only` verdict with it: a shape the
    // parse refuses means this snapshot is not one this build can judge.
    const malformed = { ...dshIm, name: 'malformed', compatibility: { profiles: 5 } } as unknown as CatalogEntry
    const acpOnly: CatalogEntry = { ...dshIm, name: 'acp-only', compatibility: { profiles: ['acp'] } }
    const peered: CatalogEntry = { ...dshIm, name: 'peered', compatibility: undefined, peers: ['dsh-peer-installed-nowhere'] }
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [acpOnly, malformed, peered], denied: [], stars: {} },
      { restartScript: fixtureHarness().script, resolvePeer: () => false },
    )
    const result = await gateway.catalog({})
    expect(result.incompatibleHarness).toEqual({})
    expect(result.incompatible).toEqual({ 'npm:peered': ['dsh-peer-installed-nowhere'] })
  })
})

describe('concurrent catalog loads (G-7)', () => {
  const entries: CatalogEntry[] = [{
    name: 'dsh-one', version: '2.0.0', integrity: null, publishedAt: null, repository: null,
    license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25',
  }]

  it('loads once when catalog() and installed() are called together on a cold cache', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-once-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: { 'dsh-one': '^1.0.0' } }))
    let loadCalls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => {
        loadCalls += 1
        await gate
        return { snapshot: { schemaVersion: 6, builtAt: '', entries, denied: [], stars: {} }, stale: false } as CatalogResult
      },
    })
    const both = Promise.all([gateway.catalog({}), gateway.installed()])
    await vi.waitFor(() => expect(loadCalls).toBeGreaterThan(0))
    release()
    const [, installed] = await both
    expect(loadCalls).toBe(1)
    expect(installed).toHaveLength(1)
  })

  it('still re-asks the loader after a failed load', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-once-fail-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    let loadCalls = 0
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => {
        loadCalls += 1
        if (loadCalls === 1) throw new Error('offline')
        return { snapshot: { schemaVersion: 6, builtAt: '', entries, denied: [], stars: {} }, stale: false } as CatalogResult
      },
    })
    await expect(gateway.catalog({})).rejects.toThrow('offline')
    await expect(gateway.catalog({})).resolves.toMatchObject({ schemaVersion: 6 })
    expect(loadCalls).toBe(2)
  })

  it('a refresh always reaches the loader', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-once-refresh-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    const seen: Array<boolean | undefined> = []
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async options => {
        seen.push(options.refresh)
        return { snapshot: { schemaVersion: 6, builtAt: '', entries, denied: [], stars: {} }, stale: false } as CatalogResult
      },
    })
    await gateway.catalog({})
    await gateway.catalog({ refresh: true })
    expect(seen).toEqual([false, true])
  })

  it('joins a plain catalog() to a refresh in flight: one load, and the refresh\'s result', async () => {
    // The client's reverdict asks with this plain call, and a Refresh still
    // pending takes precedence over it only because of this join: the tab
    // drops the superseded refresh's own result, so the reverdict's answer
    // must BE the refreshed snapshot (design 2026-09-01-harness-compatibility
    // section 9.1). Each load stamps its own `builtAt`, so a second, plain
    // load would show in the answer as well as in the call count.
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-once-join-refresh-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    const seen: Array<boolean | undefined> = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async options => {
        seen.push(options.refresh)
        await gate
        const builtAt = options.refresh === true ? 'from-the-refresh' : 'from-a-plain-load'
        return { snapshot: { schemaVersion: 6, builtAt, entries, denied: [], stars: {} }, stale: false } as CatalogResult
      },
    })
    const refreshing = gateway.catalog({ refresh: true })
    await vi.waitFor(() => expect(seen).toEqual([true]))
    const plain = gateway.catalog()
    release()
    const [refreshed, joined] = await Promise.all([refreshing, plain])
    expect(seen).toEqual([true])
    expect(refreshed.builtAt).toBe('from-the-refresh')
    expect(joined.builtAt).toBe('from-the-refresh')
  })
})

describe('restart while an install is running (F-5)', () => {
  it('refuses instead of booting a new dsh against a half-mutated profile', async () => {
    // A command that is still rewriting the profile owns the profile for the
    // duration of the operation. Restart must leave both that child and the
    // serving process alone until it has settled.
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-restart-busy-'))
    const slow = fakeDsh(dir, [
      'await new Promise(resolve => setTimeout(resolve, 2000))',
      'process.exit(0)',
    ].join('\n'))
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-restart-busy-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    const listed: CatalogEntry = {
      name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null, repository: null,
      license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25',
    }
    const exit = vi.fn()
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: mkdtempSync(join(TEMP_ROOT, 'dsh-restart-busy-cache-')),
      profile: 'web', profileDir, dshBin: slow, exit, restartArgv: ['web'],
      // A dead pid lets the pre-fix helper run without waiting for this test
      // worker; the failing assertion is the returned restart outcome.
      restartParentPid: 1_000_000_000,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 6, builtAt: '', entries: [listed], denied: [], stars: {} }, stale: false }) as CatalogResult,
      prefetcher: fixturePrefetcher(),
    })
    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true, source: 'npm' })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    // LIVE, not specifically 'running': this one holds the queue, but a
    // previous case's install may still be draining into the same profile, in
    // which case this one queued behind it and reports 'downloading'. Either
    // way a command owns the profile, which is what the refusal below is
    // about — and a terminal state here would make the case vacuous.
    expect(isTerminalInstallState(gateway.installStatus({ installId: started.installId }).state)).toBe(false)

    const outcome = await gateway.restart()
    expect(outcome).toEqual({
      ok: false,
      detail: 'dsh-plugin-shop: an install is still running in this profile; a restart now would boot the new dsh against a half-written profile. Wait for it to finish and try again.',
    })
    expect(exit).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(isTerminalInstallState(gateway.installStatus({ installId: started.installId }).state)).toBe(true)
    }, { timeout: 5000 })
  })

  it('allows the restart once the install has settled', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-restart-idle-'))
    const quick = fakeDsh(dir, 'process.exit(0)')
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-restart-idle-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-hello-plugin'] } }, dependencies: {} }))
    const listed: CatalogEntry = {
      name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null, repository: null,
      license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25',
    }
    const exit = vi.fn()
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: mkdtempSync(join(TEMP_ROOT, 'dsh-restart-idle-cache-')),
      profile: 'web', profileDir, dshBin: quick, exit, restartArgv: ['web'],
      restartExitDelayMs: 1, restartParentPid: 1,
      // Pinned like the guard cases above it: this one is about the INSTALL
      // gate releasing, and inheriting the host platform would have Windows'
      // restart refusal answer first and hide whether the gate released at
      // all. The helper's own POSIX-only spawn fails asynchronously, after
      // `restart()` has returned, and lands in restart.log where the stubbed
      // `exit` leaves it harmless.
      platform: 'linux',
      loadCatalog: async () => ({ snapshot: { schemaVersion: 6, builtAt: '', entries: [listed], denied: [], stars: {} }, stale: false }) as CatalogResult,
      prefetcher: fixturePrefetcher(),
    })
    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true, source: 'npm' })
    if (!started.ok) throw new Error('the fixture install was rejected')
    await vi.waitFor(() => {
      // TERMINAL, not "not running": a queued install reports 'downloading',
      // and treating that as settled would let this case pass while a command
      // is still on its way to touching the profile.
      expect(isTerminalInstallState(gateway.installStatus({ installId: started.installId }).state)).toBe(true)
    }, { timeout: 5000 })
    expect(await gateway.restart()).toEqual({ ok: true })
  })
})

describe('a queued install is live, not finished', () => {
  const listed: CatalogEntry = {
    name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null, repository: null,
    license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25',
  }

  it('does not evict a queued install as though it had finished', async () => {
    // `evictFinishedInstalls` counted anything not 'running' as finished and
    // evictable. A queued install reports 'downloading', so once the retained
    // records pass the 32 cap the OLDEST QUEUED one is deleted — and
    // installStatus then answers found: false, which the client's reducer
    // renders as "install record lost" on an install that is about to run.
    // The existing 33-install eviction case cannot catch this: it awaits every
    // install's completion before adding the one that triggers eviction, so no
    // record is 'downloading' at that moment. This one never awaits.
    const { gateway } = gatewayWithSnapshot({ schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} })
    const ids: string[] = []
    for (let i = 0; i < 34; i += 1) {
      const result = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
      if (!result.ok) throw new Error('fixture install was rejected')
      ids.push(result.installId)
    }
    const second = ids[1]
    const last = ids[ids.length - 1]
    if (second === undefined || last === undefined) throw new Error('no install ids collected')
    // The first holds the queue; every later one is queued behind it.
    expect(gateway.installStatus({ installId: second }).found).toBe(true)
    // Drain, so the suite does not tear down with 34 children mid-flight.
    // TERMINAL, not `=== 'running'`: the last install is QUEUED and reports
    // 'downloading', so that condition would end the drain before a single
    // child had even started.
    const deadline = Date.now() + 20000
    while (!isTerminalInstallState(gateway.installStatus({ installId: last }).state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(isTerminalInstallState(gateway.installStatus({ installId: last }).state)).toBe(true)
  })

  it('refuses a restart while an install is still queued', async () => {
    // `hasRunningCommand` asked `state === 'running'`, so a queued install did
    // not count and a restart was allowed to boot a new dsh against a profile
    // with installs pending — the very case F-5 exists to refuse.
    //
    // The three options are the F-5 case's own safety net, for the run in
    // which the gate does NOT hold: a permitted restart spawns a detached
    // helper and then exits this process, so the exit is stubbed and the
    // waited-for pid is one beyond pid_max (guaranteed dead), which leaves the
    // helper exec'ing the fixture `dshBin` instead of the test runner's own
    // argv.
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} },
      { exit: vi.fn(), restartParentPid: 1_000_000_000, restartExitDelayMs: 1, restartArgv: ['web'] },
    )
    const first = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    const second = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    if (!first.ok || !second.ok) throw new Error('fixture install was rejected')
    expect(second.state).toBe('downloading')
    const restart = await gateway.restart()
    expect(restart).toEqual({
      ok: false,
      detail: 'dsh-plugin-shop: an install is still running in this profile; a restart now would boot the new dsh against a half-written profile. Wait for it to finish and try again.',
    })
    const deadline = Date.now() + 20000
    while (!isTerminalInstallState(gateway.installStatus({ installId: second.installId }).state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  })

  it('refuses a restart for a queued install this gateway does not own the queue head of', async () => {
    // The case above reaches the refusal through the RUNNING install it owns,
    // so it passes even with the old `=== 'running'` predicate. Here the
    // mutex is held by a command this gateway did not start — the ordinary
    // consequence of a queue keyed by profile that outlives any one gateway —
    // and the gateway's own record is queued. Nothing of its own reports
    // 'running', so `=== 'running'` answered "no command is running" about a
    // profile with an install pending, which is what F-5 refuses.
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-queued-restart-'))
    const slow = fakeDsh(dir, [
      'await new Promise(resolve => setTimeout(resolve, 1500))',
      'process.exit(0)',
    ].join('\n'))
    const holder = startInstall({ profile: 'web', spec: 'a@1', dshBin: slow })
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} },
      { exit: vi.fn(), restartParentPid: 1_000_000_000, restartExitDelayMs: 1, restartArgv: ['web'] },
    )
    const queued = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    if (!queued.ok) throw new Error('fixture install was rejected')
    expect(queued.state).toBe('downloading')
    const restart = await gateway.restart()
    expect(restart).toEqual({
      ok: false,
      detail: 'dsh-plugin-shop: an install is still running in this profile; a restart now would boot the new dsh against a half-written profile. Wait for it to finish and try again.',
    })
    const deadline = Date.now() + 20000
    while (!isTerminalInstallState(gateway.installStatus({ installId: queued.installId }).state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await holder.finished
  })
})
