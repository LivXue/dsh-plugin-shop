import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ShopGateway, { verifyTarballSha256 } from '../../src/host/index.ts'
import { nodeVersionResolver } from '../../src/host/peers.ts'
import { ownPeerRanges } from '../../src/own-version.ts'
import type { InventoryEntry, LoaderEntryLike, RestartBlockedReason, ShopGatewayOptions, ShopInstallStatusResult } from '../../src/host/index.ts'
import type { HotContext, HotMountResult } from '../../src/host/hot.ts'
import type { CatalogResult, CatalogSnapshot, LoadCatalogOptions } from '../../src/host/catalog.ts'
import type { CatalogEntry } from '../../src/host/types.ts'
import { profileTemplatesOf } from '../../src/host/compatibility.ts'
import type { PeerCheck, RunningHarness } from '../../src/host/harness.ts'
import { INSTALL_TIMEOUT_MS, inProfileQueue, startInstall } from '../../src/host/executor.ts'
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
const INSTALLED_BY_FIXTURE = ['dsh-hello-plugin', 'dsh-repo-plugin', 'sub-plugin', 'dsh-rescued', 'dsh-plugin-shop', 'dsh-lifetime-probe']
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
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: Object.keys(dependencies) } }, dependencies }))
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
      name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-foo'] } },
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
  // It also selects a bundle it installed, as `dsh plugin add` does: a
  // package missing from `dsh.profile.bundles` is one dsh composes none of,
  // and the shop reads it as switched off.
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
  const bundles = manifest.dsh?.profile?.bundles
  if (patch !== null && bundles !== undefined && !bundles.includes(name)) bundles.push(name)
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

  it("reads the declared peers' versions through dsh's pluginPackages where the harness has one", async () => {
    // dsh 0.1.7 keeps no link farm, so the walk read no version for any of
    // the shop's own peers there and this check could never speak (design
    // 2026-09-01-harness-compatibility §11). Only the range table is
    // injected; the resolver is the production one, reaching the service
    // through the context as it does in dsh. The peer is a name installed
    // nowhere, so the version found can only have come from the service.
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-peerversion-harness-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    const peer = '@dsh-shop-fixture/harness-served-peer'
    const served = join(mkdtempSync(join(TEMP_ROOT, 'dsh-installation-')), 'node_modules', ...peer.split('/'))
    mkdirSync(served, { recursive: true })
    writeFileSync(join(served, 'package.json'), JSON.stringify({ name: peer, version: '0.2.0-rc.1' }))
    const pluginPackages = { packageOf: (spec: string) => spec === peer ? { manifestPath: join(served, 'package.json') } : undefined }
    const warnings: string[] = []
    const ctx = {
      get: (name: string) => name === 'pluginPackages' ? pluginPackages : undefined,
      reflect: { provide: () => {} },
      logger: { warn: (m: string) => warnings.push(m) },
    } as never
    new ShopGateway(ctx, { profile: 'web', profileDir, peerRanges: { [peer]: '^0.1.1-rc.2' } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`${peer} ^0.1.1-rc.2, found 0.2.0-rc.1`)
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
    // Its own record of what "this process" imported (see gatewayOptions).
    importedModules: new Set<string>(),
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

  it('setEnabled on a disabled plugin writes disabled: false on its row', async () => {
    // It REMOVED the row until 2026-09-26; removing is what lost a row the
    // user wrote, or the comment above it (design
    // 2026-09-26-market-borrowings §2.2).
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-hello-fixture', "- insert:\n    - id: hello-row\n      name: 'dsh-hello-fixture'\n")
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: hello-row\n  disabled: true\n')
    const gateway = new ShopGateway(stubCtx(), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [{ entryId: 'hello-row', moduleName: 'dsh-hello-fixture', enabled: false }] }) } })
    const result = await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: true })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe('- id: hello-row\n  disabled: false\n')
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

describe("switches through dsh's pluginManager", () => {
  const applied = { changed: true, application: 'applied', stage: 'enable', target: 'x', enabled: false, warnings: [] }

  /** A gateway whose pluginManager answers the nth `setPluginEnabled` with
   * `answers[n]`, or the last answer once they run out, and throws an answer
   * that is an Error. The package is `dsh-two-rows`, whose two live entries
   * switch one after the other, or with `oneRow` `dsh-one-row`, which has
   * one. */
  function switchingGateway(
    answers: Array<object | Error>,
    options: { profile?: string; oneRow?: boolean } = {},
  ): { gateway: ShopGateway; calls: unknown[][]; profileDir: string } {
    const { profile = 'web', oneRow = false } = options
    const calls: unknown[][] = []
    const service = {
      installBundle: async () => { throw new Error('this case must not call installBundle') },
      removeBundle: async () => { throw new Error('this case must not call removeBundle') },
      setBundleEnabled: async () => { throw new Error('this case must not call setBundleEnabled') },
      setPluginEnabled: async (id: string, enabled: boolean) => {
        calls.push([id, enabled])
        const answer = answers[calls.length - 1] ?? answers[answers.length - 1]
        if (answer instanceof Error) throw answer
        return answer
      },
    }
    const profileDir = toggleProfile()
    if (oneRow) fixturePackage(profileDir, 'dsh-one-row', "- insert:\n    - id: one-row\n      name: 'dsh-one-row/host'\n")
    else fixturePackage(profileDir, 'dsh-two-rows', "- insert:\n    - id: host-row\n      name: 'dsh-two-rows/host'\n    - id: client-row\n      name: 'dsh-two-rows/client'\n")
    const entries = oneRow
      ? [{ entryId: 'include:one-row', moduleName: 'dsh-one-row/host', enabled: false }]
      : [
          { entryId: 'include:host-row', moduleName: 'dsh-two-rows/host', enabled: true },
          { entryId: 'include:client-row', moduleName: 'dsh-two-rows/client', enabled: true },
        ]
    const gateway = new ShopGateway(
      { get: (name: string) => name === 'pluginManager' ? service : undefined, reflect: { provide: () => {} } } as never,
      { profile, profileDir, inventory: { list: async () => ({ entries }) } },
    )
    return { gateway, calls, profileDir }
  }

  it('switches every live entry the package owns through setPluginEnabled, by live id, and writes no row itself', async () => {
    const { gateway, calls, profileDir } = switchingGateway([applied])
    expect(await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })).toMatchObject({ ok: true })
    expect(calls).toEqual([['include:host-row', false], ['include:client-row', false]])
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
  })

  it('reports the first entry dsh refused, with the sentence for its code, and stops there', async () => {
    const { gateway, calls } = switchingGateway([{ ...applied, application: 'failed', error: { code: 'management-required' } }])
    const result = await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })
    expect(result).toEqual({ ok: false, detail: 'dsh-plugin-shop: dsh refused to switch dsh-two-rows (management-required): the plugin belongs to dsh itself.' })
    expect(calls).toHaveLength(1)
  })

  it('asks for a restart when any entry needs one', async () => {
    const { gateway } = switchingGateway([applied, { ...applied, application: 'restart-required' }])
    expect(await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })).toEqual({ ok: true, activation: 'restart' })
  })

  // R39: dsh answers `overridden` when the entry's state still differs from
  // the request after it wrote the row and reloaded (dsh-plugin-manager
  // 0.1.7-rc.2, setPluginEnabled), and its README names what outranks the
  // profile's own patch: home and invocation patches. Saved, not applied.
  it('fails a switch dsh saved but a higher-priority patch overrides, saying the plugin stays as it was', async () => {
    const { gateway, calls } = switchingGateway([{ ...applied, enabled: true, application: 'overridden' }], { oneRow: true })
    expect(await gateway.setEnabled({ name: 'dsh-one-row', enabled: true })).toEqual({
      ok: false,
      detail: "dsh-plugin-shop: dsh saved the switch for dsh-one-row, but a home or invocation patch, which outranks the profile's own, keeps it off.",
    })
    expect(calls).toEqual([['include:one-row', true]])
  })

  it('says how many plugins had already switched when a later one is overridden', async () => {
    const { gateway, calls } = switchingGateway([applied, { ...applied, application: 'overridden' }])
    expect(await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })).toEqual({
      ok: false,
      detail: "dsh-plugin-shop: dsh saved the switch for dsh-two-rows, but a home or invocation patch, which outranks the profile's own, keeps it on."
        + ' 1 of its 2 plugins had already switched off.',
    })
    expect(calls).toHaveLength(2)
  })

  it('fails a switch dsh answers with an application it does not know, naming it, and stops there', async () => {
    // R42.3: a later harness answering something new must not read as a
    // switch that applied.
    const { gateway, calls } = switchingGateway([{ ...applied, application: 'deferred' }])
    expect(await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })).toEqual({
      ok: false,
      detail: 'dsh-plugin-shop: dsh answered the switch for dsh-two-rows with "deferred", which this shop does not know how to read.',
    })
    expect(calls).toHaveLength(1)
  })

  it('says dsh could not switch, rather than that it refused, on an unexpected error', async () => {
    // R42.11, through the answer reader a reselection shares.
    const { gateway } = switchingGateway([{ ...applied, application: 'failed', error: { code: 'operation-error', diagnostic: 'EACCES: cordis.patch.yml' } }])
    expect(await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })).toEqual({
      ok: false,
      detail: 'dsh-plugin-shop: dsh could not switch dsh-two-rows (operation-error): dsh hit an unexpected error. dsh reported: EACCES: cordis.patch.yml.',
    })
  })

  it('pins a refusal diagnostic to exactly one trailing period', async () => {
    const { gateway } = switchingGateway([{ ...applied, application: 'failed', error: { code: 'unaddressable', diagnostic: 'not a root row.' } }])
    const result = await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })
    expect(result).toEqual({
      ok: false,
      detail: "dsh-plugin-shop: dsh refused to switch dsh-two-rows (unaddressable): the plugin is not a row of the profile's own patch, so dsh cannot address it. dsh reported: not a root row.",
    })
  })

  it('gives a desktop reader a refusal detail with no dsh-CLI language in it', async () => {
    const { gateway } = switchingGateway(
      [{ ...applied, application: 'failed', error: { code: 'operation-error', diagnostic: 'Use `dsh plugin allow-version` to grant it.' } }],
      { profile: 'desktop' },
    )
    const result = await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).not.toContain('dsh plugin')
  })

  it('says how many of the package plugins had already switched before dsh refused one', async () => {
    const { gateway, calls } = switchingGateway([applied, { ...applied, application: 'failed', error: { code: 'management-required' } }])
    const result = await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })
    expect(result).toEqual({
      ok: false,
      detail: 'dsh-plugin-shop: dsh refused to switch dsh-two-rows (management-required): the plugin belongs to dsh itself. 1 of its 2 plugins had already switched off.',
    })
    expect(calls).toHaveLength(2)
  })

  it('publishes what a thrown answer says, without an Error: prefix', async () => {
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-two-rows', "- insert:\n    - id: host-row\n      name: 'dsh-two-rows/host'\n    - id: client-row\n      name: 'dsh-two-rows/client'\n")
    const gateway = new ShopGateway(
      {
        get: (name: string) => name === 'pluginManager' ? {
          installBundle: async () => { throw new Error('this case must not call installBundle') },
          removeBundle: async () => { throw new Error('this case must not call removeBundle') },
          setBundleEnabled: async () => { throw new Error('this case must not call setBundleEnabled') },
          setPluginEnabled: async () => { throw new Error('lock held') },
        } : undefined,
        reflect: { provide: () => {} },
      } as never,
      {
        profile: 'web', profileDir,
        inventory: { list: async () => ({ entries: [
          { entryId: 'include:host-row', moduleName: 'dsh-two-rows/host', enabled: true },
          { entryId: 'include:client-row', moduleName: 'dsh-two-rows/client', enabled: true },
        ] }) },
      },
    )
    const result = await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })
    expect(result).toEqual({ ok: false, detail: 'dsh-plugin-shop: dsh could not switch dsh-two-rows: lock held' })
  })

  it('says how many plugins had already switched when dsh throws on a later one', async () => {
    // R42.2: a thrown answer partway through keeps R21's sentence, after a
    // period that ends the thrown message's own.
    const { gateway, calls } = switchingGateway([applied, new Error('lock held')])
    expect(await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })).toEqual({
      ok: false,
      detail: 'dsh-plugin-shop: dsh could not switch dsh-two-rows: lock held. 1 of its 2 plugins had already switched off.',
    })
    expect(calls).toHaveLength(2)
  })

  it("keeps a thrown message's dsh plugin clause from a desktop reader", async () => {
    // R42.4: a thrown message is scrubbed as dsh's answer is.
    const { gateway } = switchingGateway([new Error("the profile is locked; run 'dsh plugin install'")], { profile: 'desktop' })
    expect(await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })).toEqual({
      ok: false,
      detail: 'dsh-plugin-shop: dsh could not switch dsh-two-rows: the profile is locked',
    })
  })

  it('refuses a switch through dsh while an operation runs in the profile, and takes it once that has finished', async () => {
    // R42.5: dsh holds its profile lock for a whole install (change() wraps
    // pnpm) and waits up to lockWaitMs, 120 s, for it, so a switch clicked
    // mid-install spun for two minutes and then failed on the lock.
    const calls: unknown[][] = []
    let release!: (answer: unknown) => void
    const service = {
      installBundle: (spec: string) => { calls.push(['installBundle', spec]); return new Promise(resolve => { release = resolve }) },
      removeBundle: async () => { throw new Error('this case must not call removeBundle') },
      setPluginEnabled: async (id: string, enabled: boolean) => { calls.push(['setPluginEnabled', id, enabled]); return applied },
      setBundleEnabled: async (name: string, enabled: boolean) => { calls.push(['setBundleEnabled', name, enabled]); return applied },
    }
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-two-rows', "- insert:\n    - id: host-row\n      name: 'dsh-two-rows/host'\n    - id: client-row\n      name: 'dsh-two-rows/client'\n")
    fixturePackage(profileDir, 'dsh-hello-fixture', "- insert:\n    - id: hello-row\n      name: 'dsh-hello-fixture'\n")
    // Installed, but only dsh-two-rows is selected.
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    manifest.dsh.profile.bundles = ['dsh-two-rows']
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const managed: CatalogEntry = { name: 'dsh-managed', version: '1.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-09-28' }
    // A profile of its own: the held install holds this profile's queue.
    const profile = 'switch-busy'
    const gateway = new ShopGateway(
      { get: (name: string) => name === 'pluginManager' ? service : undefined, reflect: { provide: () => {} } } as never,
      {
        catalogUrl: 'https://shop.test/v1/', cacheDir: mkdtempSync(join(TEMP_ROOT, 'dsh-switch-busy-cache-')), profile, profileDir,
        loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries: [managed], denied: [], stars: {} }, stale: false }) as CatalogResult,
        inventory: { list: async () => ({ entries: [
          { entryId: 'include:host-row', moduleName: 'dsh-two-rows/host', enabled: true },
          { entryId: 'include:client-row', moduleName: 'dsh-two-rows/client', enabled: true },
        ] }) },
        prefetcher: fixturePrefetcher(),
        importedModules: new Set<string>(),
      },
    )
    const started = await gateway.install({ name: 'dsh-managed', version: '1.0.0', acknowledged: true })
    if (!started.ok) throw new Error(started.detail)
    await vi.waitFor(() => expect(calls).toEqual([['installBundle', 'dsh-managed@1.0.0']]), { timeout: 5000 })
    const busy = (name: string): string => 'dsh-plugin-shop: an install, update or uninstall is still running in this profile,'
      + ` and dsh holds the profile until it ends; switch ${name} after it finishes.`
    expect(await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })).toEqual({ ok: false, detail: busy('dsh-two-rows') })
    expect(await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: true })).toEqual({ ok: false, detail: busy('dsh-hello-fixture') })
    // Switching a deselected package off is the shop's own row write, which
    // takes no dsh lock, so it is not refused.
    expect(await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: false })).toEqual({ ok: true, activation: 'live' })
    expect(calls).toHaveLength(1)
    fixturePackage(profileDir, 'dsh-managed', "- insert:\n    - id: managed-row\n      name: 'dsh-managed'\n")
    release({ changed: true, application: 'applied', stage: 'enable', target: 'dsh-managed', enabled: true, bundle: 'dsh-managed', registries: [null], warnings: [], packageResult: { exitCode: 0, output: '', truncated: false, logPath: '/l' } })
    await vi.waitFor(() => expect(isTerminalInstallState(gateway.installStatus({ installId: started.installId }).state)).toBe(true), { timeout: 5000 })
    expect(await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })).toMatchObject({ ok: true })
    expect(calls.slice(1)).toEqual([['setPluginEnabled', 'include:host-row', false], ['setPluginEnabled', 'include:client-row', false]])
  })
})

describe('ShopGateway.installed', () => {
  const entries = [
    { name: 'dsh-one', version: '2.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' },
    { name: 'dsh-two', version: '1.5.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' },
  ]

  function gatewayWithManifest(dependencies: Record<string, string>): ShopGateway {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-installed-'))
    // Installed means selected: `dsh plugin add` puts a bundle it installs in
    // dsh.profile.bundles, and the shop reads a missing one as switched off.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: Object.keys(dependencies) } }, dependencies }))
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
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-one'] } }, dependencies: { 'dsh-one': '^1.0.0' } }))
    // The disabled state is read through the ids dsh-one's own bundle patch
    // inserts — the entry's module name is deliberately NOT the package name,
    // the shape that made the module-name lookup report every such package as
    // enabled no matter what the inventory said.
    fixturePackage(dir, 'dsh-one', "- insert:\n    - id: one-row\n      name: 'dsh-one/host'\n")
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-one'] } }, dependencies: { 'dsh-one': '^1.0.0' } }))
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
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-one'] } }, dependencies: { 'dsh-one': '^1.0.0' } }))
    fixturePackage(dir, 'dsh-one', "- insert:\n    - id: one-row\n      name: 'dsh-one/host'\n")
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-one'] } }, dependencies: { 'dsh-one': '^1.0.0' } }))
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
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-one'] } }, dependencies: { 'dsh-one': '^1.0.0' } }))
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

describe("the bundle switch of dsh 0.1.7's own Plugins page", () => {
  // Measured 2026-09-26 on 0.1.7-rc.2: `pluginManager.setBundleEnabled(name,
  // false)` takes the package out of `dsh.profile.bundles` and keeps it
  // installed. Nothing of it is then composed, so `pluginInventory` holds NO
  // entry for it, and `installed()` read that silence as "enabled": the shop
  // showed the switch on, and switching it on answered "restart dsh to
  // compose them", which no restart does for a bundle nobody selects.
  const entries = [
    { name: 'dsh-one', version: '2.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' },
  ]
  const helloPatch = "- insert:\n    - id: hello-row\n      name: 'dsh-hello-fixture'\n"

  /** A profile holding `name` as a dependency, with the bundle list given. */
  function profileWith(name: string, patch: string, bundles: string[]): string {
    const profileDir = toggleProfile()
    fixturePackage(profileDir, name, patch)
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    manifest.dsh.profile.bundles = bundles
    writeFileSync(manifestPath, JSON.stringify(manifest))
    return profileDir
  }

  /** dsh 0.1.7's `pluginManager`, answering `setBundleEnabled` with `result`
   * in the full ChangeResult shape the real service returned when probed. */
  function managerAnswering(result: object): { calls: unknown[][]; service: object } {
    const calls: unknown[][] = []
    return {
      calls,
      service: {
        setBundleEnabled: async (...args: unknown[]) => {
          calls.push(args)
          return result
        },
      },
    }
  }
  /** A pluginManager: `partial`'s operations, and every other one the shop's
   * detection requires, each rejecting so a stray call fails the case. */
  const completeService = (partial: object): object => {
    const refuse = (method: string) => async (): Promise<never> => { throw new Error(`this case must not call ${method}`) }
    return {
      installBundle: refuse('installBundle'),
      removeBundle: refuse('removeBundle'),
      setPluginEnabled: refuse('setPluginEnabled'),
      setBundleEnabled: refuse('setBundleEnabled'),
      ...partial,
    }
  }
  const withManager = (service: object): never =>
    ({ get: (name: string) => name === 'pluginManager' ? completeService(service) : undefined, reflect: { provide: () => {} } }) as never
  const applied = { changed: true, application: 'applied', stage: 'enable', target: 'dsh-hello-fixture', enabled: true, warnings: [] }

  function installedGateway(bundles: string[]): ShopGateway {
    const dir = profileWith('dsh-one', "- insert:\n    - id: one-row\n      name: 'dsh-one/host'\n", bundles)
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries, denied: [], stars: {} }, stale: false }) as CatalogResult,
      // Silent, as the real inventory is about a bundle nothing composes.
      inventory: { list: async () => ({ entries: [] }) },
    })
  }

  it('reports a package whose bundle dsh deselected as disabled, though the inventory says nothing of it', async () => {
    const gateway = installedGateway(['@deepseek-ai/dsh-base'])
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-one', source: 'npm', installed: '1.0.0', latest: '2.0.0', outdated: true, enabled: false }])
  })

  it('still reads a selected package with no live entry as enabled', async () => {
    // The verdict comes from the selection, not from the inventory's silence:
    // a bundle installed this session and not composed until a restart is
    // selected, and must not read as switched off.
    const gateway = installedGateway(['@deepseek-ai/dsh-base', 'dsh-one'])
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-one', source: 'npm', installed: '1.0.0', latest: '2.0.0', outdated: true, enabled: true }])
  })

  it("selects a deselected package again through dsh's pluginManager, and clears its plugin-level switch", async () => {
    const profileDir = profileWith('dsh-hello-fixture', helloPatch, ['@deepseek-ai/dsh-base'])
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: hello-row\n  disabled: true\n')
    const manager = managerAnswering(applied)
    const gateway = new ShopGateway(withManager(manager.service), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [] }) } })
    const result = await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: true })
    expect(result).toEqual({ ok: true, activation: 'live' })
    expect(manager.calls).toEqual([['dsh-hello-fixture', true]])
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe('- id: hello-row\n  disabled: false\n')
  })

  it('says restart when dsh reports the reselected bundle needs one', async () => {
    const profileDir = profileWith('dsh-hello-fixture', helloPatch, [])
    const manager = managerAnswering({ ...applied, application: 'restart-required' })
    const gateway = new ShopGateway(withManager(manager.service), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [] }) } })
    expect(await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: true })).toEqual({ ok: true, activation: 'restart' })
  })

  it('fails a reselection dsh answers with an application it does not know, naming it, and writes nothing', async () => {
    // R42.3, through the same answer reader as a switch.
    const profileDir = profileWith('dsh-hello-fixture', helloPatch, [])
    const manager = managerAnswering({ ...applied, application: 'deferred' })
    const gateway = new ShopGateway(withManager(manager.service), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [] }) } })
    expect(await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: true })).toEqual({
      ok: false,
      detail: 'dsh-plugin-shop: dsh answered the selection of dsh-hello-fixture with "deferred", which this shop does not know how to read.',
    })
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
  })

  it("passes dsh's refusal through when it will not select the bundle, and writes nothing", async () => {
    const profileDir = profileWith('dsh-hello-fixture', helloPatch, [])
    const manager = managerAnswering({
      changed: false, application: 'failed', stage: 'enable', target: 'dsh-hello-fixture', enabled: true,
      error: { code: 'incompatible-version', incompatible: [{ name: 'dsh-hello-fixture', version: '1.0.0', runtimeVersion: '0.1.7-rc.2', peers: { '@deepseek-ai/dsh': '0.1.2-rc.1' } }] },
    })
    const gateway = new ShopGateway(withManager(manager.service), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [] }) } })
    const result = await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: true })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('incompatible-version')
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
  })

  it('reports the diagnostic dsh gave for refusing to reselect the bundle', async () => {
    const profileDir = profileWith('dsh-hello-fixture', helloPatch, [])
    const manager = managerAnswering({
      changed: false, application: 'failed', stage: 'enable', target: 'dsh-hello-fixture', enabled: true,
      error: { code: 'bundle-in-use', diagnostic: 'still mounted' },
    })
    const gateway = new ShopGateway(withManager(manager.service), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [] }) } })
    const result = await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: true })
    expect(result).toEqual({
      ok: false,
      detail: 'dsh-plugin-shop: dsh refused to select dsh-hello-fixture again (bundle-in-use): the bundle was switched off, but some of its plugins are still running. dsh reported: still mounted.',
    })
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
  })

  it("keeps a thrown message's dsh plugin clause from a desktop reader when reselecting the bundle", async () => {
    // R42.4, the reselection's catch.
    const profileDir = profileWith('dsh-hello-fixture', helloPatch, [])
    const service = { setBundleEnabled: async () => { throw new Error("the profile is locked; run 'dsh plugin install'") } }
    const gateway = new ShopGateway(withManager(service), { profile: 'desktop', profileDir, inventory: { list: async () => ({ entries: [] }) } })
    expect(await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: true })).toEqual({
      ok: false,
      detail: 'dsh-plugin-shop: dsh could not select dsh-hello-fixture again: the profile is locked',
    })
  })

  it('gives a desktop reader no dsh-CLI language when reselecting the bundle fails', async () => {
    const profileDir = profileWith('dsh-hello-fixture', helloPatch, [])
    const manager = managerAnswering({
      changed: false, application: 'failed', stage: 'enable', target: 'dsh-hello-fixture', enabled: true,
      error: { code: 'management-required', diagnostic: 'Use `dsh plugin allow-version` to grant it.' },
    })
    const gateway = new ShopGateway(withManager(manager.service), { profile: 'desktop', profileDir, inventory: { list: async () => ({ entries: [] }) } })
    const result = await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: true })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).not.toContain('dsh plugin')
  })

  it('refuses on a harness without pluginManager by naming the bundle list, not a restart', async () => {
    // dsh 0.1.5 has no such service, and its CLI is no way back on 0.1.7:
    // measured 2026-09-27, `dsh plugin add <name>` re-selects a deselected
    // bundle on 0.1.5-rc.3 and does not on 0.1.7-rc.2. Nor does the detail
    // print that command, which would let pnpm float a registry package to
    // `latest`.
    const profileDir = profileWith('dsh-hello-fixture', helloPatch, [])
    const gateway = new ShopGateway(stubCtx(), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [] }) } })
    const result = await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: true })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('dsh.profile.bundles')
    expect(result.detail).not.toMatch(/restart dsh to compose/)
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
  })

  it('switches a deselected package off at the plugin level without asking dsh to select it', async () => {
    const profileDir = profileWith('dsh-hello-fixture', helloPatch, [])
    const manager = managerAnswering(applied)
    const gateway = new ShopGateway(withManager(manager.service), { profile: 'web', profileDir, inventory: { list: async () => ({ entries: [] }) } })
    expect(await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: false })).toEqual({ ok: true, activation: 'live' })
    expect(manager.calls).toEqual([])
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('disabled: true')
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
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: Object.keys(dependencies) } }, dependencies }))
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
      name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-three'] } },
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

  it('commits the handoff, names the log the new process writes, and exits after the response', async () => {
    // The log's path depends on DSH_HOME and on the shop row's cacheDir, which
    // only the host knows; the client names it when the new server does not
    // come back (design 2026-09-26-market-borrowings §3).
    const exit = vi.fn<() => void>()
    const cacheDir = mkdtempSync(join(TEMP_ROOT, 'dsh-restart-cache-'))
    const gateway = restartingGateway({ exit, cacheDir })
    const result = await gateway.restart()
    expect(result).toEqual({ ok: true, logFile: join(cacheDir, 'restart.log') })
    // The exit is delayed past the RPC round-trip, then fires.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('answers every later press with the restart it already committed, and exits once', async () => {
    // A page whose tab dsh's client HMR swapped out mid-request cannot tell
    // whether that request reached the host, so it asks again through the
    // module instance that replaced it (restart-monitor.ts). Measured
    // 2026-09-27 on dsh 0.1.7-rc.2: the first request can commit while its
    // answer is lost. An ask inside the exit delay then reaches this same
    // process, and a second commit is a second exit timer and a second
    // takeover helper racing the first for the port.
    const exit = vi.fn<() => void>()
    const cacheDir = mkdtempSync(join(TEMP_ROOT, 'dsh-restart-cache-'))
    const gateway = restartingGateway({ exit, cacheDir })
    const first = await gateway.restart()
    expect(first).toEqual({ ok: true, logFile: join(cacheDir, 'restart.log') })
    expect(await gateway.restart()).toEqual(first)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(exit).toHaveBeenCalledTimes(1)
  })

  // POSIX-only for the reason the case below is: the marker is written by
  // the process the `sh` helper exec's.
  it.skipIf(process.platform === 'win32')('starts one takeover helper however many presses reach it', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-restart-once-'))
    const marker = join(dir, 'ran.log')
    const script = join(dir, 'fake-bin.js')
    writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n')\n`)
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: dir, profile: 'web',
      exit: vi.fn(), restartExitDelayMs: 1, restartParentPid: 1_000_000_000,
      restartArgv: ['web'], restartScript: script,
    })
    expect(await gateway.restart()).toMatchObject({ ok: true })
    expect(await gateway.restart()).toMatchObject({ ok: true })
    await vi.waitFor(() => { expect(existsSync(marker)).toBe(true) }, { timeout: 5000 })
    // Each helper runs the fixture as soon as it starts (the parent pid is
    // dead); a second one would have written its line well inside this.
    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(readFileSync(marker, 'utf8')).toBe('ran\n')
    rmSync(dir, { recursive: true, force: true })
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
    expect(await gateway.restart()).toMatchObject({ ok: true })
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
    // One record per gateway of the packages "this process" has imported.
    // The production default is a module-scope set every gateway in the
    // process shares — which, in this file, is every case — and a name one
    // case seeds would turn another case's fresh install into a restart. The
    // one case about that sharing opts out of this explicitly.
    importedModules: new Set<string>(),
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

describe('the desktop profile, which dsh refuses to manage from its CLI', () => {
  // dsh's launcher refuses `--profile desktop`, in any letter case, for a
  // launch and for `dsh plugin` alike: "profile "desktop" is managed
  // exclusively by the Electron application" (`rejectElectronProfile`, the
  // same in 0.1.5-rc.3 and 0.1.7-rc.2). Every mutation the shop makes goes
  // through that CLI, so each is refused up front — before anything spawns,
  // naming the app — instead of failing as "pnpm failed in the profile".
  const INSTALL_DETAIL = 'dsh-plugin-shop: the desktop profile is managed by the DeepSeek Harness desktop app, and dsh'
    + ' refuses to change it from the command line the shop runs; add and remove its plugins from the app instead'
  const RESTART_DETAIL = 'dsh-plugin-shop: the desktop profile is managed by the DeepSeek Harness desktop app, and dsh'
    + ' refuses to restart it from here; restart the app to apply the change'

  const desktopGateway = (profile: string, dir: string, exit = vi.fn<() => void>()): ShopGateway => new ShopGateway(stubCtx(), {
    ...gatewayOptions(), profile, dshBin: fakeDshRecording(dir, 0, { silent: true }), exit, restartExitDelayMs: 5,
    fetchLatestVersion: async () => null,
  })

  for (const profile of ['desktop', 'Desktop']) {
    it(`refuses an install, an uninstall and a self-update in the ${profile} profile without spawning`, async () => {
      const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-desktop-'))
      const gateway = desktopGateway(profile, dir)
      expect(await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true }))
        .toEqual({ ok: false, code: 'desktop-profile', detail: INSTALL_DETAIL })
      expect(await gateway.uninstall({ name: 'dsh-hello-plugin' })).toEqual({ ok: false, detail: INSTALL_DETAIL })
      expect(await gateway.updateStart({ version: '9.9.9' })).toEqual({ ok: false, detail: INSTALL_DETAIL })
      // A spawned fixture would have created the calls log within this window.
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(existsSync(join(dir, 'calls.log'))).toBe(false)
    })
  }

  it("reports restartBlocked: 'desktop' ahead of every other reason, and restart refuses without exiting", async () => {
    // First in the gate: the platform, the supervisor and the port only say
    // how a restart would go, and in this profile none would be allowed.
    const exit = vi.fn<() => void>()
    const gateway = new ShopGateway(stubCtx(), {
      ...gatewayOptions(), profile: 'desktop', platform: 'win32', exit, restartExitDelayMs: 5,
      fetchLatestVersion: async () => null,
    })
    expect((await gateway.version()).restartBlocked).toBe('desktop')
    expect(await gateway.restart()).toEqual({ ok: false, detail: RESTART_DETAIL })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(exit).not.toHaveBeenCalled()
  })

  it('leaves every other profile alone, including one merely named like it', async () => {
    const gateway = new ShopGateway(stubCtx(), { ...gatewayOptions(), profile: 'desktop-2', env: {}, ppid: 4321, fetchLatestVersion: async () => null })
    expect((await gateway.version()).restartBlocked).toBeNull()
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

  /** A profile whose installed shop copy declares `installedCopy`, or holds
   * no copy at all when it is null. */
  const profileWithShopCopy = (installedCopy: string | null): string => {
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-version-copy-'))
    if (installedCopy !== null) {
      const copy = join(profileDir, 'node_modules', 'dsh-plugin-shop')
      mkdirSync(copy, { recursive: true })
      writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: 'dsh-plugin-shop', version: installedCopy }))
    }
    return profileDir
  }

  it('reports the version this process loaded, and names the newer copy an update wrote under it', async () => {
    // A profile installs hoisted, so a self-update rewrites the running
    // package's own directory in place. Re-reading package.json there is
    // what made the row claim the new version while the old code still ran,
    // and left the client no way to tell a landed update from a finished one.
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web',
      profileDir: profileWithShopCopy('1.1.0'), runningVersion: '1.0.0',
      fetchLatestVersion: async () => '1.1.0',
    })
    const result = await gateway.version()
    expect(result.installed).toBe('1.0.0')
    expect(result.pendingVersion).toBe('1.1.0')
    expect(result.outdated).toBe(true)
  })

  it('reports nothing pending when the installed copy is the version running', async () => {
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web',
      profileDir: profileWithShopCopy('1.0.0'), runningVersion: '1.0.0',
      fetchLatestVersion: async () => '1.0.0',
    })
    expect((await gateway.version()).pendingVersion).toBeNull()
  })

  it('reports nothing pending, rather than failing the check, when the installed copy cannot be read', async () => {
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web',
      profileDir: profileWithShopCopy(null), runningVersion: '1.0.0',
      fetchLatestVersion: async () => '1.0.0',
    })
    expect((await gateway.version()).pendingVersion).toBeNull()
  })

  it('sends pendingVersion even when no profile can be found, so its absence always means an older host', async () => {
    // The client reads a MISSING field as a host older than it, and so as an
    // update still waiting for its restart. That inference is only sound if
    // this host never omits the field, including on the path where the
    // profile lookup itself fails.
    const result = await versionGateway('9.9.9').version()
    expect(result).toHaveProperty('pendingVersion', null)
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
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-repo-plugin'] } }, dependencies: { 'dsh-repo-plugin': 'github:someone/dsh-repo-plugin' } }))
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
      name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-rescued'] } },
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
    /** The context the gateway is built with — the shop's own, in a real boot. */
    ctx?: object
    /** Which harness the gateway believes it runs under. */
    readHarness?: ShopGatewayOptions['readHarness']
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
    const gateway = new ShopGateway((options.ctx ?? stubCtx()) as never, {
      ...gatewayOptions(),
      profileDir,
      loadCatalog: async () => ({ snapshot, stale: false }) as CatalogResult,
      hot: options.hot,
      loaderEntries: options.loaderEntries,
      hotFs: options.hotFs,
      ...(options.readHarness !== undefined ? { readHarness: options.readHarness } : {}),
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

  /** What a FRESH install puts on disk, written before the call because the
   * fixture CLI writes nothing: the package's own host-only manifest, and
   * deliberately NOT the profile manifest's dependency. `fixturePackage`
   * writes that too, and a dependency present BEFORE the install is exactly
   * what makes it an update. */
  function landedFreshPackage(profileDir: string, name: string): void {
    mkdirSync(join(profileDir, 'node_modules', name), { recursive: true })
    writeFileSync(join(profileDir, 'node_modules', name, 'package.json'), JSON.stringify({
      name,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
  }

  it('install reports activation reload when no manifest exists yet (the conservative fallback)', async () => {
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
    // browser half) answers true, so this is not 'live'. A hot-mounted
    // browser half is one reload away: the tree hangs off the shop's own
    // loader entry, where the client registry composes it (activation.ts).
    // The dedicated tests below pin each case with an explicit manifest
    // instead of relying on the fallback.
    expect(status.activation).toBe('reload')
    expect(status.restartReason).toBeUndefined()
    expect(hotMount).toHaveBeenCalledTimes(1)
    expect(hotMount).toHaveBeenCalledWith(expect.anything(), profileDir, 'dsh-hello-plugin')
  })

  it('an update reports restart, already-loaded, and leaves the running instance alone', async () => {
    // This process imported the package when it booted, and Node caches a
    // module by its URL. The update rewrites the files at that same URL, so a
    // hot mount would re-run the cached OLD module under the new version's
    // name — measured, in web-full-flow.e2e.ts. So nothing is disabled and
    // nothing is mounted: the instance that is running keeps running until
    // the restart that loads the new files. (This case used to pin the swap
    // that did the disabling, retries included.)
    const entry: LoaderEntryLike = {
      id: 'dsh-hello-plugin-row',
      options: { name: 'dsh-hello-plugin/host' },
      fiber: {},
      update: vi.fn(async () => {}),
    }
    const mount = vi.fn(async (): Promise<HotMountResult> => ({ ok: true, reason: null }))
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
    expect(status.activation).toBe('restart')
    expect(status.restartReason).toBe('already-loaded')
    expect(entry.update).not.toHaveBeenCalled()
    expect(mount).not.toHaveBeenCalled()
  })

  it('a package the profile held at boot is still treated as imported after it leaves the manifest', async () => {
    // An uninstall followed by a reinstall in one session. The manifest no
    // longer names the package, so this is not an update — but the module the
    // boot imported is still in Node's cache: an uninstall disposes the fiber,
    // never the module record. Only the record seeded at construction knows.
    const mount = vi.fn(async (): Promise<HotMountResult> => ({ ok: true, reason: null }))
    const { gateway, profileDir } = hotGateway({
      dependencies: { 'dsh-hello-plugin': '1.2.0' },
      hot: { mount, unmount: hotUnmount },
      loaderEntries: () => [],
    })
    // What the uninstall leaves behind: the same profile without the package.
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dsh: { profile: { bundles: [] } },
      dependencies: {},
    }))
    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await pollTerminal(gateway, started.installId)
    expect(status.state).toBe('done')
    expect(status.activation).toBe('restart')
    expect(status.restartReason).toBe('already-loaded')
    expect(mount).not.toHaveBeenCalled()
  })

  it('a package the hot path mounted is treated as imported on the next install', async () => {
    const mount = vi.fn(async (): Promise<HotMountResult> => ({ ok: true, reason: null }))
    const { gateway, profileDir } = hotGateway({ hot: { mount, unmount: hotUnmount }, loaderEntries: () => [] })
    landedFreshPackage(profileDir, 'dsh-hello-plugin')
    const first = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect((await pollTerminal(gateway, first.installId)).activation).toBe('live')
    // The fixture CLI writes no manifest, so the second install is not an
    // update either: what stops a second mount is the first mount's import.
    const second = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const status = await pollTerminal(gateway, second.installId)
    expect(status.state).toBe('done')
    expect(status.activation).toBe('restart')
    expect(status.restartReason).toBe('already-loaded')
    expect(mount).toHaveBeenCalledTimes(1)
  })

  it('what one gateway recorded, a gateway built later in the same process still knows', async () => {
    // Module scope, not a gateway field: a shop fiber restarted inside a
    // running dsh builds a new gateway, and the process has not forgotten
    // what it imported. So neither gateway here takes gatewayOptions()' own
    // set; both use the production default, and the name is unique to this
    // case because nothing ever leaves that set.
    const probe: CatalogEntry = { name: 'dsh-lifetime-probe', version: '1.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-09-26' }
    const profileAt = (dependencies: Record<string, string>): string => {
      const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-lifetime-profile-'))
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies }))
      return profileDir
    }
    const mount = vi.fn(async (): Promise<HotMountResult> => ({ ok: true, reason: null }))
    const build = (profileDir: string): ShopGateway => new ShopGateway(stubCtx(), {
      ...gatewayOptions(),
      importedModules: undefined,
      profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 6, builtAt: '', entries: [probe], denied: [], stars: {} }, stale: false }) as CatalogResult,
      hot: { mount, unmount: hotUnmount },
      loaderEntries: () => [],
    })
    // The first gateway is built over a profile holding the probe, as the
    // boot's shop would be...
    build(profileAt({ 'dsh-lifetime-probe': '1.0.0' }))
    // ...and a later one over the same process, after the probe was removed.
    const later = build(profileAt({}))
    const started = await later.install({ name: 'dsh-lifetime-probe', version: '1.0.0', acknowledged: true })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await pollTerminal(later, started.installId)
    expect(status.state).toBe('done')
    expect(status.activation).toBe('restart')
    expect(status.restartReason).toBe('already-loaded')
    expect(mount).not.toHaveBeenCalled()
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

  it('reports activation reload when a hot-mounted install has a browser half', async () => {
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
    // The host half mounted and is running, and its browser half is in the
    // graph the next page load is served — measured in the web e2e, where the
    // reload after a hot mount runs the fixture's browser half. It read
    // `restart` with a `client-half` reason until 2026-09-26, when the tree
    // still hung off the RPC caller's context, where the registry never
    // composed it.
    expect(status.activation).toBe('reload')
    expect(status.restartReason).toBeUndefined()
  })

  it('mounts the hot tree from the context the shop was built with, never from the calling one', async () => {
    // cordis hands a service out with `ctx` rebound to the context that looked
    // it up, so inside an RPC method `this.ctx` is the CALLER's — the typert
    // gateway's, on 0.1.5-rc.3 and 0.1.7-rc.2 alike. A tree registered from
    // there is owned by the gateway's fiber, listed under the gateway's loader
    // entry, and never composed by dsh's client registry. It must be a child
    // of the shop's own fiber. `Object.create` stands in for the rebinding:
    // the same gateway, seen with another `ctx`.
    const handle = { await: async () => {}, dispose: () => {} }
    const own = { get: () => undefined, reflect: { provide: () => {} }, plugin: vi.fn(() => handle) }
    const caller = { get: () => undefined, reflect: { provide: () => {} }, plugin: vi.fn(() => handle) }
    const mount = vi.fn(async (ctx: HotContext): Promise<HotMountResult> => {
      ctx.plugin('the-hot-tree', { path: 'hot-1.yml' })
      return { ok: true, reason: null }
    })
    const { gateway, profileDir } = hotGateway({ ctx: own, hot: { mount, unmount: hotUnmount }, loaderEntries: () => [] })
    landedFreshPackage(profileDir, 'dsh-hello-plugin')
    const seenByCaller = Object.create(gateway, { ctx: { value: caller } }) as ShopGateway
    const started = await seenByCaller.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await pollTerminal(seenByCaller, started.installId)
    expect(status.state).toBe('done')
    expect(mount).toHaveBeenCalledTimes(1)
    expect(own.plugin).toHaveBeenCalledWith('the-hot-tree', { path: 'hot-1.yml' })
    expect(caller.plugin).not.toHaveBeenCalled()
  })

  it('fails an install whose bundle patch the running dsh cannot load, before anything mounts it', async () => {
    // dsh 0.1.5 joins `dsh.bundle.patch` onto a path, so a LIST (which 0.1.7
    // applies in order) stops the profile from starting at the next boot —
    // after an install that succeeded and a hot mount that ran it. A
    // declaration that is neither a path nor a list stops every dsh. Both are
    // reported the way a duplicate entry id is: failed, with the undo.
    const harness = (patchLists: boolean | null) => async (): Promise<RunningHarness> =>
      ({ dshVersion: '0.1.5-rc.3', templates: {}, patchLists, peerCheck: null })
    const cases: Array<[unknown, boolean | null, string | null]> = [
      [['./host.yml', './web.yml'], false, 'dsh-plugin-shop: dsh-hello-plugin lists its bundle patch as several files, which dsh reads from 0.1.7 on;'
        + ' this dsh (0.1.5-rc.3) reads one and would not start with it installed.'
        + ' It is on disk: run `dsh plugin --profile web remove dsh-hello-plugin` to undo this install.'],
      [['./host.yml', './web.yml'], true, null],
      [['./host.yml', './web.yml'], null, null],
      [7, null, 'dsh-plugin-shop: dsh-hello-plugin declares its bundle patch as neither a file path nor a list of them,'
        + ' which dsh refuses to load, so the profile would not start.'
        + ' It is on disk: run `dsh plugin --profile web remove dsh-hello-plugin` to undo this install.'],
    ]
    for (const [patch, patchLists, detail] of cases) {
      const label = `${JSON.stringify(patch)} on patchLists=${String(patchLists)}`
      const { gateway, profileDir } = hotGateway({
        hot: { mount: hotMount, unmount: hotUnmount },
        loaderEntries: () => [],
        readHarness: harness(patchLists),
      })
      mkdirSync(join(profileDir, 'node_modules', 'dsh-hello-plugin'), { recursive: true })
      writeFileSync(join(profileDir, 'node_modules', 'dsh-hello-plugin', 'package.json'), JSON.stringify({
        name: 'dsh-hello-plugin',
        dsh: { bundle: { patch } },
      }))
      const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
      expect(started.ok, label).toBe(true)
      if (!started.ok) return
      const status = await pollTerminal(gateway, started.installId)
      if (detail === null) {
        expect(status.state, label).toBe('done')
        expect(hotMount, label).toHaveBeenCalledTimes(1)
      } else {
        expect(status.state, label).toBe('failed')
        expect(status.detail, label).toBe(detail)
        expect(hotMount, label).not.toHaveBeenCalled()
      }
      hotMount.mockClear()
    }
  })

  it('reports activation live when a hot-mounted install is host-only', async () => {
    // The host-only manifest lands in node_modules alone: listing the
    // package in the profile manifest, as this case used to, made it an
    // UPDATE — which no longer mounts at all.
    const { gateway, profileDir } = hotGateway({
      hot: { mount: hotMount, unmount: hotUnmount },
      loaderEntries: () => [],
    })
    landedFreshPackage(profileDir, 'dsh-hello-plugin')
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

  it('writes the user\'s own named row for the entry, because it knows which module the entry mounts', async () => {
    // A row naming the entry's module is one the harness applies, so it is
    // the row to write — but only the package's own patch says which module
    // that is. Without it the toggle could not tell this row from one the
    // harness skips, and would append a second row beside it.
    const profileDir = toggleProfile()
    fixturePackage(profileDir, '@tt-a1i/archify-dsh', archifyPatch)
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '- id: archify-skill-filesystem',
      "  name: '@deepseek-ai/dsh-skill-filesystem'",
      '  config:',
      '    root: ~/notes',
      '',
    ].join('\n'))
    const gateway = new ShopGateway(stubCtx(), {
      profile: 'web', profileDir,
      inventory: { list: async () => ({ entries: [
        { entryId: 'include:archify-skill-filesystem', moduleName: '@deepseek-ai/dsh-skill-filesystem', enabled: true },
      ] }) },
    })
    expect(await gateway.setEnabled({ name: '@tt-a1i/archify-dsh', enabled: false })).toEqual({ ok: true, activation: 'live' })
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe([
      '- id: archify-skill-filesystem',
      "  name: '@deepseek-ai/dsh-skill-filesystem'",
      '  config:',
      '    root: ~/notes',
      '  disabled: true',
      '',
    ].join('\n'))
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
        { entryId: 'include:shop:mkt-fresh-entry', moduleName: 'dsh-fresh', enabled: true },
      ] }) },
    })
    expect(await gateway.setEnabled({ name: 'dsh-fresh', enabled: false })).toEqual({ ok: true, activation: 'live' })
    const written = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(written).toContain('fresh-entry')
    expect(written).not.toContain('mkt-')
  })

  it('re-enabling writes disabled: false on the same row, in the config id space', async () => {
    // It dropped the row until 2026-09-26 (see the enable case above). The
    // id is still the CONFIG id, never the live `include:` spelling.
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
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe('- id: archify-skill-filesystem\n  disabled: false\n')
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

  it("asks dsh's pluginPackages for a peer the profile's disk does not hold, and still names one nothing serves", async () => {
    // dsh 0.1.7 serves its own packages to plugins through Node's module
    // hooks and keeps no link farm, so the walk alone badged every plugin
    // declaring one: 2,214 entries on 0.1.7-rc.2 against 570 on 0.1.5-rc.3
    // (design 2026-09-01-harness-compatibility §11). No `resolvePeer` here —
    // the production resolver is under test, with the service the context
    // provides, asked from the profile anchor. Both peers are names installed
    // nowhere, so each verdict can only be the service's and the walk's.
    const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-gateway-pluginpackages-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    const servedName = '@dsh-shop-fixture/harness-served'
    const missingName = '@dsh-shop-fixture/served-by-nothing'
    const served = join(mkdtempSync(join(TEMP_ROOT, 'dsh-installation-')), 'node_modules', ...servedName.split('/'))
    mkdirSync(served, { recursive: true })
    writeFileSync(join(served, 'package.json'), JSON.stringify({ name: servedName, version: '0.1.7-rc.2' }))
    const anchors = new Set<string>()
    const pluginPackages = {
      packageOf: (spec: string, parentURL: string) => {
        anchors.add(parentURL)
        return spec === servedName ? { manifestPath: join(served, 'package.json') } : undefined
      },
    }
    const ctx = { get: (name: string) => name === 'pluginPackages' ? pluginPackages : undefined, reflect: { provide: () => {} } } as never
    const gateway = new ShopGateway(ctx, {
      catalogUrl: 'https://shop.test/v1/',
      cacheDir: '/cache',
      profile: 'web',
      profileDir,
      loadCatalog: async () => ({
        snapshot: { schemaVersion: 6, builtAt: '', entries: [{ ...peered, peers: [servedName, missingName] }], denied: [], stars: {} },
        stale: false,
      }) as CatalogResult,
    })

    expect((await gateway.catalog({})).incompatible).toEqual({ 'npm:dsh-timeline': [missingName] })
    expect([...anchors]).toEqual([pathToFileURL(join(profileDir, 'cordis.yml')).href])
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

/**
 * A gateway `readHarness` that answers with the harness `fixtureHarness()`
 * describes, without reading one: its version, `0.1.5-rc.3` unless a test
 * passes the one the reader makes of another manifest, and the table
 * `readRunningHarness` makes of `RC3_PROFILE_TEMPLATES`. `reads` records the
 * script of every call.
 *
 * Why these tests inject rather than read. In-process, the gateway's own read
 * imports the fixture's app-boot through vitest's module runner, and on a
 * Windows runner, with the checkout on D: and the temp dir on C:, that import
 * failed, so the table read empty and every test that needs one failed. The
 * real read, the table and the lookup that finds it included, is covered by
 * `tests/host/harness.test.ts`, which runs it under Node's own loader, in a
 * child process, on every platform. What is left to test here is what the
 * gateway does with the answer. The two tests whose point is where the
 * running VERSION comes from still read for real, through `restartScript`:
 * neither depends on that import, and both pass on every platform.
 */
function injectedHarness(dshVersion: string | null = '0.1.5-rc.3'): {
  readHarness: (script: string | undefined) => Promise<RunningHarness>
  reads: Array<string | undefined>
} {
  const reads: Array<string | undefined> = []
  return {
    readHarness: async script => {
      reads.push(script)
      return { dshVersion, templates: profileTemplatesOf(RC3_PROFILE_TEMPLATES), patchLists: false, peerCheck: null }
    },
    reads,
  }
}

describe('ShopGateway.catalog: what the running dsh itself refuses', () => {
  /** A package pinning the harness to one release, as dsh 0.1.7's installer
   * refuses it: dsh's own rule answers, scripted — `harness.test.ts` covers
   * taking the real one from the running app-boot, and this suite what the
   * gateway does with its answer. */
  const pinned: CatalogEntry = {
    name: 'dsh-pinned', version: '1.2.0', integrity: null, publishedAt: null, repository: null,
    license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-09-26',
    dshPeers: { '@deepseek-ai/dsh': '0.1.5-rc.3' },
  }

  /** A harness whose peer check refuses `dsh-pinned@1.2.0` unless the
   * exemptions it is handed carry that key for 0.1.7-rc.2 — the shape of
   * dsh's rule, with `exemptions()` answering from `held` as the test sets
   * it and recording the directory it was asked about. */
  function refusingHarness(held: { record: Record<string, string[]> | 'throws' }) {
    const asked: string[] = []
    const check: PeerCheck = {
      evaluate: (manifest, exemptions) => (manifest.name === 'dsh-pinned'
        ? { name: manifest.name, version: manifest.version, runtimeVersion: '0.1.7-rc.2', peers: { ...manifest.peerDependencies }, exempted: exemptions[`${manifest.name}@${manifest.version}`]?.includes('0.1.7-rc.2') === true }
        : undefined),
      exemptions: dir => {
        asked.push(dir)
        if (held.record === 'throws') throw new Error('EACCES: compatibility.json')
        return held.record
      },
    }
    const harness: RunningHarness = { dshVersion: '0.1.7-rc.2', templates: profileTemplatesOf(RC3_PROFILE_TEMPLATES), patchLists: true, peerCheck: check }
    return { readHarness: async () => harness, asked }
  }

  const REFUSAL = {
    refused: { '@deepseek-ai/dsh': '0.1.5-rc.3' },
    running: '0.1.7-rc.2',
    allowCommand: 'dsh plugin --profile web allow-version dsh-pinned@1.2.0 --dsh-version 0.1.7-rc.2 --accept-risk',
  }

  it("carries dsh's refusal and the command that exempts it, beside what the author declared", async () => {
    const declared: CatalogEntry = { ...pinned, compatibility: { dsh: '0.9.0' } }
    const { readHarness, asked } = refusingHarness({ record: {} })
    const { gateway } = gatewayWithSnapshot({ schemaVersion: 5, builtAt: '', entries: [declared], denied: [], stars: {} }, { readHarness })
    expect((await gateway.catalog({})).incompatibleHarness).toEqual({
      'npm:dsh-pinned': { dsh: { range: '0.9.0', running: '0.1.7-rc.2' }, peers: REFUSAL },
    })
    // The exemptions are the running profile's own, from the directory the
    // other verdicts read.
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/dsh-gateway-profile-/)
  })

  it('reads the exemptions again on every call, so running the command and pressing Refresh clears the card', async () => {
    // The whole way out of a disabled button: dsh records the exemption, and
    // the next catalog call must see it. A verdict remembered per snapshot
    // would keep the button disabled for as long as the snapshot is served.
    const held: { record: Record<string, string[]> } = { record: {} }
    const { readHarness } = refusingHarness(held)
    const { gateway } = gatewayWithSnapshot({ schemaVersion: 5, builtAt: '', entries: [pinned], denied: [], stars: {} }, { readHarness })
    expect((await gateway.catalog({})).incompatibleHarness).toEqual({ 'npm:dsh-pinned': { peers: REFUSAL } })
    held.record = { 'dsh-pinned@1.2.0': ['0.1.7-rc.2'] }
    expect((await gateway.catalog({})).incompatibleHarness).toEqual({})
  })

  it('says nothing on a dsh that has no such check, which refuses no install on its peers', async () => {
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [pinned], denied: [], stars: {} },
      { readHarness: injectedHarness().readHarness },
    )
    expect((await gateway.catalog({})).incompatibleHarness).toEqual({})
  })

  it('says nothing when the exemptions cannot be read, and the declared halves still stand', async () => {
    // Without the exemptions an allowed install and a refused one look the
    // same, and a disabled button nobody could justify is the worst answer.
    const declared: CatalogEntry = { ...pinned, compatibility: { dsh: '0.9.0' } }
    const { readHarness } = refusingHarness({ record: 'throws' })
    const { gateway } = gatewayWithSnapshot({ schemaVersion: 5, builtAt: '', entries: [declared], denied: [], stars: {} }, { readHarness })
    const result = await gateway.catalog({})
    expect(result.incompatibleHarness).toEqual({ 'npm:dsh-pinned': { dsh: { range: '0.9.0', running: '0.1.7-rc.2' } } })
    expect(result.plugins).toHaveLength(1)
  })
})

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
    // fails. Injected: without a readable table, `web` would be no template
    // at all, and the profile half silent for that reason instead.
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [dshIm], denied: [], stars: {} },
      { profile: 'tui', readHarness: injectedHarness().readHarness },
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
    // The table reaches the gateway through `readHarness`; that the reader
    // takes it from the running dsh's own app-boot is harness.test.ts's case.
    const acpOnly: CatalogEntry = { ...dshIm, name: 'acp-only', compatibility: { profiles: ['acp'] } }
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [acpOnly], denied: [], stars: {} },
      { readHarness: injectedHarness().readHarness },
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
    // expected no verdict at all.) Injected, so the table is readable and the
    // profile half is silent for the missing directory alone.
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/',
      cacheDir: '/cache',
      profile: 'web',
      readHarness: injectedHarness().readHarness,
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
    ['declares no version', null],
    ['declares an empty one', null],
    ['declares one that is not semver', 'nightly'],
  ])('judges only the profile half when the running dsh %s', async (_label, dshVersion) => {
    // An unknown silences its own half and no other (design §8.2): the
    // template table is read whatever the version is. Each row injects the
    // version `readRunningHarness` makes of such a manifest: none for the
    // first two, and `nightly` passed through for `compatibilityMap` to find
    // no semver in. harness.test.ts pins that reading, and that the table is
    // read beside each of them.
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [headlessOnly], denied: [], stars: {} },
      { readHarness: injectedHarness(dshVersion).readHarness },
    )
    expect((await gateway.catalog({})).incompatibleHarness).toEqual({ 'npm:dsh-headless-only': HEADLESS_UNMET })
  })

  it('reads the running harness once per gateway', async () => {
    // Which dsh this process is cannot change while it runs, and the read
    // imports a module, so the gateway keeps it: two calls, one read, counted
    // at the injected reader.
    // (Until 2026-09-25 the version was re-read on every call, from the
    // profile anchor — which is where a hoisted copy could move it.)
    const harness = injectedHarness()
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [headlessOnly], denied: [], stars: {} },
      { readHarness: harness.readHarness },
    )
    const both = { 'npm:dsh-headless-only': { dsh: { range: '0.9.0', running: '0.1.5-rc.3' }, ...HEADLESS_UNMET } }
    expect((await gateway.catalog({})).incompatibleHarness).toEqual(both)
    expect((await gateway.catalog({})).incompatibleHarness).toEqual(both)
    expect(harness.reads).toHaveLength(1)
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
      { profileDir, readHarness: injectedHarness().readHarness },
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
      { readHarness: injectedHarness().readHarness },
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
    // Injected, so the table is readable and `acp-only` alone would be judged.
    const malformed = { ...dshIm, name: 'malformed', compatibility: { profiles: 5 } } as unknown as CatalogEntry
    const acpOnly: CatalogEntry = { ...dshIm, name: 'acp-only', compatibility: { profiles: ['acp'] } }
    const peered: CatalogEntry = { ...dshIm, name: 'peered', compatibility: undefined, peers: ['dsh-peer-installed-nowhere'] }
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [acpOnly, malformed, peered], denied: [], stars: {} },
      { readHarness: injectedHarness().readHarness, resolvePeer: () => false },
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
      // A pid that cannot exist, like every sibling case. Pid 1 always exists,
      // and `kill -0 1` succeeds for root, so the detached helper polled it
      // forever: each run of this file left one `sh` forking `sleep 0.2` five
      // times a second, and 351 had piled up on one machine by 2026-09-27.
      restartExitDelayMs: 1, restartParentPid: 1_000_000_000,
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
    expect(await gateway.restart()).toMatchObject({ ok: true })
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

describe("installs and updates through dsh's pluginManager", () => {
  const managed: CatalogEntry = { name: 'dsh-managed', version: '1.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-09-27' }
  // A second name, for the installs dsh makes without the shop.
  const other: CatalogEntry = { ...managed, name: 'dsh-other' }
  const commit = 'e'.repeat(40)
  const managedRepo: CatalogEntry = {
    ...managed, name: 'dsh-managed-repo', version: commit, integrity: commit, metadata: 'declared',
    repository: 'https://github.com/someone/dsh-managed-repo', source: 'github', repo: 'someone/dsh-managed-repo',
  }
  // dsh's answers as measured on 0.1.7-rc.2 (spec section 2, and the O1 and
  // O4 measurements of 2026-09-27): an install of a name the profile did not
  // hold, and one of a name it did, which carries no `warnings` key.
  const applied = { changed: true, application: 'applied', stage: 'enable', target: 'dsh-managed', enabled: true, bundle: 'dsh-managed', registries: [null], packageResult: { exitCode: 0, output: 'Packages: +1\n', truncated: false, logPath: '/l' }, warnings: [] }
  const restartRequired = { changed: true, application: 'restart-required', stage: 'enable', target: 'dsh-managed', enabled: true, bundle: 'dsh-managed', registries: [null], packageResult: { exitCode: 0, output: 'Packages: +1\n', truncated: false, logPath: '/l' } }
  const managedPatch = "- insert:\n    - id: managed-row\n      name: 'dsh-managed'\n"
  /** The patch of each package the fake can land: a row of its own apiece. */
  const patches = new Map([['dsh-managed', managedPatch], ['dsh-other', "- insert:\n    - id: other-row\n      name: 'dsh-other'\n"]])

  /** The profile manifest holding `dependencies`, each one selected, as
   * `dsh plugin add` and dsh's own installer leave it. */
  function writeManifest(profileDir: string, dependencies: Record<string, string>): void {
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: Object.keys(dependencies) } }, dependencies }))
  }

  /** A gateway whose pluginManager records its calls, streams each install's
   * output through `plugin-manager/install-log` (one stdout line unless
   * `output` says otherwise), and, when `lands`, puts the package the spec
   * names on disk as a real install does before it answers. When `hangs`, an
   * install answers only once dsh's `cancelInstall` stops it. The context
   * keeps every listener the gateway registers, and `emit` calls one as dsh
   * would.
   *
   * Every gateway gets a record of its own of what "this process" imported:
   * the process-wide default would carry a name one case installed into every
   * later case, and the cases reading `live` would then depend on the order
   * they run in. A case passes `importedModules` to share one between two
   * gateways. The CLI stand-ins are this file's own (see its header), so a
   * case that fell back to the CLI fails on its own assertions instead of
   * running a real dsh or pnpm. `entries` join the catalog, straight from
   * the injected loadCatalog and so past catalog.ts's validation. With
   * `rejectsWith`, installBundle and removeBundle throw it instead of
   * answering. With `vanishes`, the context serves the service to its first
   * lookup only, as a harness disposing it mid-call would. */
  function managedGateway(result: object, options: {
    dependencies?: Record<string, string>
    profile?: string
    lands?: boolean
    hangs?: boolean
    importedModules?: Set<string>
    output?: (spec: string) => Array<{ stream: string; text: string }>
    prefetcher?: Prefetcher
    pinFs?: ShopGatewayOptions['pinFs']
    entries?: CatalogEntry[]
    rejectsWith?: Error
    vanishes?: boolean
  } = {}): { gateway: ShopGateway; calls: unknown[][]; profileDir: string; cacheDir: string; emit: (event: string, payload: unknown) => void } {
    const {
      dependencies = {}, profile = 'web', lands = true, hangs = false, importedModules = new Set<string>(),
      output = (spec: string) => [{ stream: 'stdout', text: `+ ${spec}\n` }], prefetcher = fixturePrefetcher(), pinFs, entries = [], rejectsWith,
      vanishes = false,
    } = options
    const profileDir = toggleProfile()
    writeManifest(profileDir, dependencies)
    const cacheDir = mkdtempSync(join(TEMP_ROOT, 'dsh-managed-cache-'))
    const calls: unknown[][] = []
    const listeners = new Map<string, (payload: unknown) => void>()
    const service = {
      /** The installs waiting for `cancelInstall`, by request id. */
      stalled: new Map<string, () => void>(),
      installBundle(spec: string, request: { requestId: string }): Promise<unknown> {
        calls.push(['installBundle', spec, request.requestId])
        if (rejectsWith !== undefined) return Promise.reject(rejectsWith)
        for (const chunk of output(spec)) {
          listeners.get('plugin-manager/install-log')?.({ requestId: request.requestId, jobId: 'j', argv: ['pnpm', 'add', spec], cwd: profileDir, ...chunk })
        }
        if (hangs) {
          return new Promise(resolve => {
            // dsh's answer once it has stopped an install: nothing landed.
            this.stalled.set(request.requestId, () => resolve({
              changed: false, application: 'cancelled', stage: 'install', target: spec, enabled: true, registries: [null],
              packageResult: { exitCode: null, output: '', truncated: false, logPath: '/l' },
            }))
          })
        }
        const name = /^(.+)@[^@/]+$/.exec(spec)?.[1]
        const patch = name === undefined ? undefined : patches.get(name)
        if (lands && name !== undefined && patch !== undefined) fixturePackage(profileDir, name, patch)
        return Promise.resolve(result)
      },
      removeBundle: async (name: string) => {
        calls.push(['removeBundle', name])
        throw rejectsWith ?? new Error('this case must not call removeBundle')
      },
      setPluginEnabled: async () => { throw new Error('this case must not call setPluginEnabled') },
      setBundleEnabled: async () => { throw new Error('this case must not call setBundleEnabled') },
      // A method that reads `this`, as dsh's own does: the shop has to call
      // it on the service, never as a bare function.
      async cancelInstall(requestId: string): Promise<unknown> {
        calls.push(['cancelInstall', requestId])
        const stop = this.stalled.get(requestId)
        if (stop === undefined) return { status: 'not-running' }
        stop()
        return { status: 'cancelled' }
      },
    }
    let served = false
    const ctx = {
      get: (name: string) => {
        if (name !== 'pluginManager' || (vanishes && served)) return undefined
        served = true
        return service
      },
      on: (event: string, listener: (payload: unknown) => void) => { listeners.set(event, listener) },
      reflect: { provide: () => {} },
    } as never
    const gateway = new ShopGateway(ctx, {
      catalogUrl: 'https://shop.test/v1/', cacheDir, profile, profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries: [managed, other, managedRepo, ...entries], denied: [], stars: {} }, stale: false }) as CatalogResult,
      importedModules,
      prefetcher,
      dshBin: fakeDshRecording(mkdtempSync(join(TEMP_ROOT, 'dsh-managed-cli-')), 0, { silent: true }),
      ...(pinFs !== undefined ? { pinFs } : {}),
    })
    const emit = (event: string, payload: unknown): void => {
      const listener = listeners.get(event)
      // A missing listener fails the case rather than passing it: a case that
      // asserts an event changes nothing would otherwise hold without one.
      if (listener === undefined) throw new Error(`the gateway does not listen for ${event}`)
      listener(payload)
    }
    return { gateway, calls, profileDir, cacheDir, emit }
  }

  const finish = async (gateway: ShopGateway, installId: string): Promise<ShopInstallStatusResult> => {
    await vi.waitFor(() => expect(isTerminalInstallState(gateway.installStatus({ installId }).state)).toBe(true), { timeout: 5000 })
    return gateway.installStatus({ installId })
  }

  /** Install `entry` at its catalog version, acknowledged, and wait for the record to settle. */
  const installAndSettle = async (gateway: ShopGateway, entry: CatalogEntry): Promise<ShopInstallStatusResult> => {
    const started = await gateway.install({ name: entry.name, version: entry.version, acknowledged: true })
    if (!started.ok) throw new Error(started.detail)
    return finish(gateway, started.installId)
  }

  it('installs through installBundle, with the catalog spec and the record id as request id', async () => {
    const { gateway, calls } = managedGateway(applied)
    const started = await gateway.install({ name: 'dsh-managed', version: '1.0.0', acknowledged: true })
    if (!started.ok) throw new Error(started.detail)
    const status = await finish(gateway, started.installId)
    expect(calls).toEqual([['installBundle', 'dsh-managed@1.0.0', started.installId]])
    expect(status).toMatchObject({ state: 'done', activation: 'live' })
    expect(status.log).toEqual(["via dsh's plugin manager: install dsh-managed@1.0.0", '+ dsh-managed@1.0.0'])
  })

  it('reads an update as a restart the package already loaded', async () => {
    const { gateway } = managedGateway(restartRequired, { dependencies: { 'dsh-managed': '0.9.0' } })
    const started = await gateway.install({ name: 'dsh-managed', version: '1.0.0', acknowledged: true })
    if (!started.ok) throw new Error(started.detail)
    expect(await finish(gateway, started.installId)).toMatchObject({ state: 'done', activation: 'restart', restartReason: 'already-loaded' })
  })

  it('updates the shop itself through installBundle', async () => {
    const { gateway, calls } = managedGateway({ ...restartRequired, target: 'dsh-plugin-shop', bundle: 'dsh-plugin-shop' })
    const started = await gateway.updateStart({ version: '9.9.9' })
    if (!started.ok) throw new Error(started.detail)
    const status = await finish(gateway, started.installId)
    expect(calls[0]?.slice(0, 2)).toEqual(['installBundle', 'dsh-plugin-shop@9.9.9'])
    // The host half running here is the shop's own, so dsh answers with a
    // restart and loads nothing (open item O4, measured).
    expect(status).toMatchObject({ state: 'done', activation: 'restart', restartReason: 'already-loaded' })
    expect(status.log[0]).toBe("via dsh's plugin manager: update dsh-plugin-shop@9.9.9")
  })

  it('asks for a restart on a reinstall in one session, whatever dsh answered', async () => {
    // Open item O1, measured on 0.1.7-rc.2: after removeBundle and a new
    // installBundle both answered `applied`, the re-created entry ran the
    // module Node had cached, because every version of a name loads from one
    // path under `nodeLinker: hoisted`. `applied` does not say the new code runs.
    const { gateway, profileDir } = managedGateway(applied)
    expect(await installAndSettle(gateway, managed)).toMatchObject({ state: 'done', activation: 'live' })
    // What the uninstall leaves behind: the profile without the package.
    writeManifest(profileDir, {})
    expect(await installAndSettle(gateway, managed)).toMatchObject({ state: 'done', activation: 'restart', restartReason: 'already-loaded' })
  })

  it('leaves the name unimported when an install never reached the enable stage', async () => {
    // pnpm failed, so dsh put the profile back and loaded nothing. The answer
    // is the one dsh 0.1.7-rc.2 gives a failed `pnpm add`: it throws the
    // output as a plain error, which it codes `operation-error`.
    const pnpmFailed = {
      changed: false, application: 'failed', stage: 'install', target: 'dsh-managed@1.0.0', enabled: true, registries: [null], pendingBuilds: [],
      packageResult: { exitCode: 1, output: 'ERR_PNPM_FETCH_404', truncated: false, logPath: '/l', kind: 'not-found' },
      error: { code: 'operation-error', diagnostic: 'ERR_PNPM_FETCH_404' },
    }
    // The fake answers every install of one gateway alike, so the second
    // install runs on a second gateway sharing the first one's record, as
    // every gateway in one process does.
    const imported = new Set<string>()
    const failing = managedGateway(pnpmFailed, { lands: false, importedModules: imported })
    expect((await installAndSettle(failing.gateway, managed)).state).toBe('failed')
    const later = managedGateway(applied, { importedModules: imported })
    expect(await installAndSettle(later.gateway, managed)).toMatchObject({ state: 'done', activation: 'live' })
  })

  it('reads a name dsh installed but could not enable as imported', async () => {
    // The enable stage is where dsh loads the package, so a failure there has
    // filled Node's cache all the same. dsh leaves such a package installed.
    const notEnabled = {
      changed: true, application: 'failed', stage: 'enable', target: 'dsh-managed', enabled: true, bundle: 'dsh-managed', registries: [null],
      packageResult: { exitCode: 0, output: 'Packages: +1\n', truncated: false, logPath: '/l' },
      error: { code: 'operation-error', diagnostic: 'duplicate entry id' },
    }
    const imported = new Set<string>()
    const failing = managedGateway(notEnabled, { importedModules: imported })
    expect((await installAndSettle(failing.gateway, managed)).state).toBe('failed')
    const later = managedGateway(applied, { importedModules: imported })
    expect(await installAndSettle(later.gateway, managed)).toMatchObject({ state: 'done', activation: 'restart', restartReason: 'already-loaded' })
  })

  it('reads a name dsh installed outside the shop as imported', async () => {
    // dsh's own Plugins page installs through the same service, and the
    // `plugin-manager/changed` event it sends names no package (measured), so
    // the shop reads the profile manifest again.
    const { gateway, profileDir, emit } = managedGateway({ ...applied, target: 'dsh-other', bundle: 'dsh-other' })
    writeManifest(profileDir, { 'dsh-other': '1.0.0' })
    emit('plugin-manager/changed', { reason: 'install' })
    writeManifest(profileDir, {})
    expect(await installAndSettle(gateway, other)).toMatchObject({ state: 'done', activation: 'restart', restartReason: 'already-loaded' })
  })

  it('re-reads the manifest only for an install event', async () => {
    const { gateway, profileDir, emit } = managedGateway({ ...applied, target: 'dsh-other', bundle: 'dsh-other' })
    writeManifest(profileDir, { 'dsh-other': '1.0.0' })
    emit('plugin-manager/changed', { reason: 'remove' })
    writeManifest(profileDir, {})
    expect(await installAndSettle(gateway, other)).toMatchObject({ state: 'done', activation: 'live' })
  })

  it("keeps dsh's stdout and stderr lines apart when their chunks interleave", async () => {
    const { gateway } = managedGateway(applied, {
      output: () => [
        { stream: 'stdout', text: 'Progress: resolved 1, reused 0, down' },
        { stream: 'stderr', text: ' WARN  deprecated dsh-old@1.0.0\n' },
        { stream: 'stdout', text: 'loaded 1, added 1\n' },
      ],
    })
    expect((await installAndSettle(gateway, managed)).log).toEqual([
      "via dsh's plugin manager: install dsh-managed@1.0.0",
      ' WARN  deprecated dsh-old@1.0.0',
      'Progress: resolved 1, reused 0, downloaded 1, added 1',
    ])
  })

  it('cancels an install still running at the deadline, through the service itself', async () => {
    // A profile of its own: an install the deadline fails to stop never
    // settles, and would hold the queue of every later case in `web`.
    const { gateway, calls } = managedGateway(applied, { hangs: true, profile: 'deadline' })
    // Only the two timer functions the deadline uses: the queue, the fake
    // CLI and vitest's own polling keep the real clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const started = await gateway.install({ name: 'dsh-managed', version: '1.0.0', acknowledged: true })
      if (!started.ok) throw new Error(started.detail)
      await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5000 })
      await vi.advanceTimersByTimeAsync(INSTALL_TIMEOUT_MS)
      const status = await finish(gateway, started.installId)
      expect(calls).toEqual([['installBundle', 'dsh-managed@1.0.0', started.installId], ['cancelInstall', started.installId]])
      expect(status.state).toBe('failed')
      // What dsh did, not the CLI path's timeout detail (R42.8).
      expect(status.detail).toMatch(/^dsh-plugin-shop: the install did not finish within \d+s, so the shop cancelled it\. dsh stopped it, restored the profile's package\.json and pnpm-lock\.yaml, and installed nothing\./)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits behind a command already running in the profile, warming the store for the catalog spec', async () => {
    const requested: Array<{ profile: string; spec: string }> = []
    const prefetcher: Prefetcher = {
      request: ({ profile, spec }) => { requested.push({ profile, spec }); return { started: true } },
      release: () => {},
    }
    // A profile of its own, and the holder freed whatever happens: a held
    // queue would stall every later case in `web`.
    const { gateway, calls } = managedGateway(applied, { prefetcher, profile: 'queued' })
    let free!: () => void
    const holder = inProfileQueue('queued', () => new Promise<void>(resolve => { free = resolve }))
    try {
      const started = await gateway.install({ name: 'dsh-managed', version: '1.0.0', acknowledged: true })
      if (!started.ok) throw new Error(started.detail)
      expect(started.state).toBe('downloading')
      expect(requested).toEqual([{ profile: 'queued', spec: 'dsh-managed@1.0.0' }])
      expect(calls).toEqual([])
      free()
      await holder.finished
      expect(await finish(gateway, started.installId)).toMatchObject({ state: 'done', activation: 'live' })
    } finally {
      free()
    }
  })

  it('refuses a flag-like or unsafe spec before dsh or the download phase sees it', async () => {
    // R41: prefetch.ts takes the operand gate as the caller's guarantee, and
    // spawns through a shell on win32. catalog.ts's validation keeps such a
    // spec out of the real catalog; the injected loadCatalog does not, so
    // this reaches the gate itself.
    const flagLike: CatalogEntry = { ...managed, name: '-managed' }
    const unsafe: CatalogEntry = { ...managed, name: 'dsh-unsafe', version: '1.0.0;x' }
    const requested: string[] = []
    const prefetcher: Prefetcher = { request: ({ spec }) => { requested.push(spec); return { started: true } }, release: () => {} }
    const { gateway, calls } = managedGateway(applied, { entries: [flagLike, unsafe], prefetcher, profile: 'gated' })
    // A command already holds the profile, so an install that got past the
    // gate would ask the download phase to warm its spec at once.
    let free!: () => void
    const holder = inProfileQueue('gated', () => new Promise<void>(resolve => { free = resolve }))
    try {
      await expect(gateway.install({ name: '-managed', version: '1.0.0', acknowledged: true }))
        .rejects.toThrow('dsh-plugin-shop: refusing to spawn with a flag-like operand: -managed@1.0.0')
      await expect(gateway.install({ name: 'dsh-unsafe', version: '1.0.0;x', acknowledged: true }))
        .rejects.toThrow('dsh-plugin-shop: refusing to spawn with an unsafe operand: "dsh-unsafe@1.0.0;x"')
      expect(requested).toEqual([])
    } finally {
      free()
    }
    await holder.finished
    expect(calls).toEqual([])
  })

  it('installs a github entry through installBundle and records its commit pin', async () => {
    // The manifest records only `github:owner/slug`, so the pins file is how
    // `installed()` tells outdated: this path writes it as the CLI one does.
    const { gateway, calls, cacheDir } = managedGateway({ ...applied, target: 'dsh-managed-repo', bundle: 'dsh-managed-repo' })
    const started = await gateway.install({ name: 'dsh-managed-repo', version: commit, acknowledged: true })
    if (!started.ok) throw new Error(started.detail)
    await finish(gateway, started.installId)
    expect(calls).toEqual([['installBundle', `github:someone/dsh-managed-repo#${commit}`, started.installId]])
    expect(JSON.parse(readFileSync(join(cacheDir, 'github-pins.json'), 'utf8'))).toEqual({ 'github:someone/dsh-managed-repo#': commit })
  })

  it('tracks the record before it writes the github pin, so a write that throws leaves nothing running unseen', async () => {
    // The pin write is the one step after the start that can throw. The RPC
    // then fails, but the operation is already queued, so its record must be
    // where installStatus and the restart gate look for it.
    const failingPins = { exists: () => false, read: () => '{}', write: () => { throw new Error('EACCES: github-pins.json') } }
    const { gateway, calls } = managedGateway({ ...applied, target: 'dsh-managed-repo', bundle: 'dsh-managed-repo' }, { pinFs: failingPins })
    await expect(gateway.install({ name: 'dsh-managed-repo', version: commit, acknowledged: true })).rejects.toThrow('EACCES: github-pins.json')
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5000 })
    const installId = calls[0]?.[2]
    if (typeof installId !== 'string') throw new Error('installBundle was called without a request id')
    expect(gateway.installStatus({ installId }).found).toBe(true)
    expect((await finish(gateway, installId)).state).toBe('done')
  })

  it('tracks an uninstall before it forgets the pins, so a write that throws leaves nothing running unseen', async () => {
    // forgetPins writes only when the pins file holds one of the package's
    // pins, and that write is the one step after the start that can throw.
    // The RPC then fails, but removeBundle is already queued, so its record
    // must be where the restart gate looks for running operations. It carries
    // no request id, so the gate (F-5) is what observes it.
    let release!: (answer: unknown) => void
    const removing = new Promise(resolve => { release = resolve })
    const service = {
      installBundle: async () => { throw new Error('this case must not call installBundle') },
      removeBundle: vi.fn(() => removing),
      setPluginEnabled: async () => { throw new Error('this case must not call setPluginEnabled') },
      setBundleEnabled: async () => { throw new Error('this case must not call setBundleEnabled') },
    }
    const pinned = { exists: () => true, read: () => JSON.stringify({ 'dsh-managed': '1.0.0' }), write: () => { throw new Error('EACCES: github-pins.json') } }
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-managed', managedPatch)
    // A profile of its own: the held removeBundle holds this profile's queue.
    const profile = 'forget-pins'
    const gateway = new ShopGateway(
      { get: (name: string) => name === 'pluginManager' ? service : undefined, reflect: { provide: () => {} } } as never,
      {
        catalogUrl: 'https://shop.test/v1/', cacheDir: mkdtempSync(join(TEMP_ROOT, 'dsh-forget-pins-cache-')), profile, profileDir,
        loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries: [managed], denied: [], stars: {} }, stale: false }) as CatalogResult,
        pinFs: pinned,
        // The F-5 cases' safety net, for the order in which the gate does not
        // hold: a permitted restart starts the takeover helper and schedules
        // the exit, so the exit is a spy, the pid the helper waits on is past
        // pid_max, and what it runs is a fixture dsh.
        exit: vi.fn(), restartParentPid: 1_000_000_000, restartExitDelayMs: 1, restartArgv: ['web'], platform: 'linux',
        dshBin: fakeDshRecording(mkdtempSync(join(TEMP_ROOT, 'dsh-forget-pins-cli-')), 0, { silent: true }),
      },
    )
    await expect(gateway.uninstall({ name: 'dsh-managed' })).rejects.toThrow('EACCES: github-pins.json')
    await vi.waitFor(() => expect(service.removeBundle).toHaveBeenCalledOnce(), { timeout: 5000 })
    expect(await gateway.restart()).toEqual({
      ok: false,
      detail: 'dsh-plugin-shop: an install is still running in this profile; a restart now would boot the new dsh against a half-written profile. Wait for it to finish and try again.',
    })
    release({ changed: true, application: 'applied', stage: 'remove', target: 'dsh-managed', warnings: [], packageResult: { exitCode: 0, output: 'Packages: -1', truncated: false, logPath: '/l' } })
    // The queue runs one operation at a time, so a task queued behind the
    // removal finishes only once the removal has settled.
    await inProfileQueue(profile, async () => {}).finished
  })

  it("fails an install whose landed package would stop the profile, with the shop's uninstall as the undo", async () => {
    // The shop's own check on the landed files runs on this path too. The
    // undo names the shop rather than a `dsh plugin` command, which dsh's CLI
    // refuses in the desktop profile.
    const { gateway, profileDir } = managedGateway(applied)
    fixturePackage(profileDir, 'dsh-holder', "- insert:\n    - id: managed-row\n      name: 'dsh-holder'\n")
    expect(await installAndSettle(gateway, managed)).toMatchObject({
      state: 'failed',
      detail: 'dsh-plugin-shop: dsh-managed declares the loader entry id "managed-row", which dsh-holder already declares.'
        + ' dsh refuses to load a plugin tree holding a duplicate entry id, so the profile would not start.'
        + ' It is on disk: uninstall it from the shop to undo this install.',
    })
  })

  it('uninstalls through removeBundle, with the mechanism line and the final output', async () => {
    const calls: unknown[][] = []
    const service = {
      installBundle: async () => { throw new Error('this case must not call installBundle') },
      removeBundle: async (name: string) => {
        calls.push(['removeBundle', name])
        return { changed: true, application: 'applied', stage: 'remove', target: name, warnings: [], packageResult: { exitCode: 0, output: 'Packages: -1', truncated: false, logPath: '/l' } }
      },
      setPluginEnabled: async () => { throw new Error('this case must not call setPluginEnabled') },
      setBundleEnabled: async () => { throw new Error('this case must not call setBundleEnabled') },
    }
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-managed', managedPatch)
    const gateway = new ShopGateway(
      { get: (name: string) => name === 'pluginManager' ? service : undefined, reflect: { provide: () => {} } } as never,
      {
        catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir,
        loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries: [managed], denied: [], stars: {} }, stale: false }) as CatalogResult,
      },
    )
    const started = await gateway.uninstall({ name: 'dsh-managed' })
    if (!started.ok) throw new Error(started.detail)
    const status = await finish(gateway, started.installId)
    expect(calls).toEqual([['removeBundle', 'dsh-managed']])
    expect(status).toMatchObject({ state: 'done', activation: 'live' })
    expect(status.log).toEqual(["via dsh's plugin manager: remove dsh-managed", 'Packages: -1'])
  })

  // R20: the brief's case above answers `applied`, which reads `live` for
  // an install and an uninstall alike, so it does not by itself prove the
  // wiring hands managerOutcome an uninstall operation. This refusal reads
  // differently for each operation, and pins that it is read as one.
  it('reads a refused removeBundle answer as an uninstall refusal, not an install one', async () => {
    const calls: unknown[][] = []
    const service = {
      installBundle: async () => { throw new Error('this case must not call installBundle') },
      removeBundle: async (name: string) => {
        calls.push(['removeBundle', name])
        return { changed: false, application: 'failed', stage: 'remove', target: name, error: { code: 'bundle-in-use', diagnostic: 'still mounted' } }
      },
      setPluginEnabled: async () => { throw new Error('this case must not call setPluginEnabled') },
      setBundleEnabled: async () => { throw new Error('this case must not call setBundleEnabled') },
    }
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-managed', managedPatch)
    const gateway = new ShopGateway(
      { get: (name: string) => name === 'pluginManager' ? service : undefined, reflect: { provide: () => {} } } as never,
      {
        catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir,
        loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries: [managed], denied: [], stars: {} }, stale: false }) as CatalogResult,
      },
    )
    const started = await gateway.uninstall({ name: 'dsh-managed' })
    if (!started.ok) throw new Error(started.detail)
    const status = await finish(gateway, started.installId)
    expect(status.state).toBe('failed')
    expect(status.detail).toBe(
      'dsh-plugin-shop: dsh refused the uninstall of dsh-managed (bundle-in-use): the bundle was switched off, but some of its plugins are still running. dsh reported: still mounted.',
    )
  })

  it('routes a desktop install to the service when the harness offers one', async () => {
    const { gateway, calls } = managedGateway(applied, { profile: 'Desktop' })
    const started = await gateway.install({ name: 'dsh-managed', version: '1.0.0', acknowledged: true })
    if (!started.ok) throw new Error(started.detail)
    await finish(gateway, started.installId)
    expect(calls).toHaveLength(1)
  })

  it('hands a desktop reader no dsh plugin command when the service refuses', async () => {
    // Review Focus 5: every detail a desktop reader reaches comes through
    // managerOutcome with `desktop: true`.
    const refusal = {
      changed: false, application: 'failed', stage: 'install', target: 'dsh-managed@1.0.0', registries: [null],
      error: { code: 'incompatible-version', incompatible: [{ name: 'dsh-managed', version: '1.0.0', runtimeVersion: '0.1.7-rc.2', peers: { '@deepseek-ai/dsh': '0.1.2-rc.1' } }] },
    }
    const { gateway } = managedGateway(refusal, { profile: 'desktop', lands: false })
    const started = await gateway.install({ name: 'dsh-managed', version: '1.0.0', acknowledged: true })
    if (!started.ok) throw new Error(started.detail)
    const status = await finish(gateway, started.installId)
    expect(status.state).toBe('failed')
    expect(status.detail).not.toContain('dsh plugin')
  })

  it('reads pluginManager once per call, so a service gone by the time the path is chosen cannot send a desktop mutation to the CLI', async () => {
    // R42.6: the desktop gate and the choice of path read one service. Read
    // twice, around the catalog and harness awaits, a service that vanished
    // in between let the gate pass and then took the CLI path, which dsh
    // refuses for the desktop profile.
    const install = managedGateway(applied, { profile: 'desktop', vanishes: true })
    await installAndSettle(install.gateway, managed)
    expect(install.calls.map(call => call[0])).toEqual(['installBundle'])
    const update = managedGateway(restartRequired, { profile: 'desktop', vanishes: true })
    const updating = await update.gateway.updateStart({ version: '9.9.9' })
    if (!updating.ok) throw new Error(updating.detail)
    await finish(update.gateway, updating.installId)
    expect(update.calls.map(call => call[0])).toEqual(['installBundle'])
    const removal = managedGateway(applied, { profile: 'desktop', vanishes: true, dependencies: { 'dsh-other': '1.0.0' } })
    const removing = await removal.gateway.uninstall({ name: 'dsh-other' })
    if (!removing.ok) throw new Error(removing.detail)
    await finish(removal.gateway, removing.installId)
    expect(removal.calls.map(call => call[0])).toEqual(['removeBundle'])
  })

  it("keeps a thrown message's dsh plugin clause from a desktop reader, for an install and an uninstall", async () => {
    // R42.4: the runner scrubs a thrown message for a desktop reader as
    // managerOutcome scrubs dsh's answer, and both calls into the runner say
    // which reader it has.
    const rejection = new Error("plugin-manager: the profile is locked; run 'dsh plugin install'")
    const scrubbed = "dsh-plugin-shop: dsh's plugin manager failed: plugin-manager: the profile is locked"
    const { gateway } = managedGateway(applied, { profile: 'desktop', lands: false, rejectsWith: rejection, dependencies: { 'dsh-other': '1.0.0' } })
    expect(await installAndSettle(gateway, managed)).toMatchObject({ state: 'failed', detail: scrubbed })
    const removal = await gateway.uninstall({ name: 'dsh-other' })
    if (!removal.ok) throw new Error(removal.detail)
    expect(await finish(gateway, removal.installId)).toMatchObject({ state: 'failed', detail: scrubbed })
  })

  it('still refuses every desktop mutation without the service', async () => {
    const gateway = new ShopGateway(stubCtx(), { profile: 'desktop', profileDir: toggleProfile() })
    expect(await gateway.install({ name: 'dsh-managed', version: '1.0.0', acknowledged: true })).toMatchObject({ ok: false, code: 'desktop-profile' })
    expect((await gateway.uninstall({ name: 'dsh-managed' })).ok).toBe(false)
    expect((await gateway.updateStart({ version: '9.9.9' })).ok).toBe(false)
  })

  // R25 (Review Focus 5, at the gateway, once per mutation path): the
  // service can fail a desktop mutation too, through a plain pnpm run gone
  // wrong rather than a version refusal — dsh 0.1.7-rc.2's own shape for
  // that answer.
  const rollback = "ERR_PNPM_SOMETHING broke\ndsh: restored package.json and pnpm-lock.yaml, but node_modules could not be reinstalled; run 'dsh plugin install'.\n"
  const pnpmFailed = (stage: string, target: string): object => ({
    changed: false, application: 'failed', stage, target, registries: [null],
    error: { code: 'operation-error', diagnostic: rollback },
    packageResult: { exitCode: 1, output: rollback, truncated: false, logPath: '/l', kind: 'unknown' },
  })

  it('fails a desktop install without naming dsh plugin, when the service reports a failed pnpm run', async () => {
    const { gateway } = managedGateway(pnpmFailed('install', 'dsh-managed@1.0.0'), { profile: 'desktop', lands: false })
    const started = await gateway.install({ name: 'dsh-managed', version: '1.0.0', acknowledged: true })
    if (!started.ok) throw new Error(started.detail)
    const status = await finish(gateway, started.installId)
    expect(status.state).toBe('failed')
    expect(status.detail).not.toContain('dsh plugin')
    expect(status.detail).toContain('ERR_PNPM_SOMETHING broke')
  })

  it('fails a desktop uninstall without naming dsh plugin, when the service reports a failed pnpm run', async () => {
    const service = {
      installBundle: async () => { throw new Error('this case must not call installBundle') },
      removeBundle: async () => pnpmFailed('remove', 'dsh-managed'),
      setPluginEnabled: async () => { throw new Error('this case must not call setPluginEnabled') },
      setBundleEnabled: async () => { throw new Error('this case must not call setBundleEnabled') },
    }
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-managed', managedPatch)
    const gateway = new ShopGateway(
      { get: (name: string) => name === 'pluginManager' ? service : undefined, reflect: { provide: () => {} } } as never,
      {
        catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'desktop', profileDir,
        loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries: [managed], denied: [], stars: {} }, stale: false }) as CatalogResult,
      },
    )
    const started = await gateway.uninstall({ name: 'dsh-managed' })
    if (!started.ok) throw new Error(started.detail)
    const status = await finish(gateway, started.installId)
    expect(status.state).toBe('failed')
    expect(status.detail).not.toContain('dsh plugin')
  })

  it('fails a desktop self-update without naming dsh plugin, when the service reports a failed pnpm run', async () => {
    const { gateway } = managedGateway(pnpmFailed('install', 'dsh-plugin-shop@9.9.9'), { profile: 'desktop', lands: false })
    const started = await gateway.updateStart({ version: '9.9.9' })
    if (!started.ok) throw new Error(started.detail)
    const status = await finish(gateway, started.installId)
    expect(status.state).toBe('failed')
    expect(status.detail).not.toContain('dsh plugin')
  })
})
