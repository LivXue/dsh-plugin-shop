import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ShopGateway, { verifyTarballSha256 } from '../../src/host/index.ts'
import type { InventoryEntry, LoaderEntryLike, ShopGatewayOptions, ShopInstallStatusResult } from '../../src/host/index.ts'
import type { HotMountResult } from '../../src/host/hot.ts'
import type { CatalogResult, CatalogSnapshot } from '../../src/host/catalog.ts'
import type { CatalogEntry } from '../../src/host/types.ts'

// The install tests drive the full §7.2 path including the post-install
// confirm, which re-reads the profile manifest through app-boot's
// resolveProfileDir honoring DSH_HOME. Pin it to a fixture home whose `web`
// profile manifest already lists the bundle the install tests install, so the
// exit-0 fixture dsh passes the confirm without any dsh reconcile. Each test
// file runs in its own vitest worker, so the pin never leaves this file.
const shopHome = mkdtempSync(join(tmpdir(), 'dsh-gateway-home-'))
process.env.DSH_HOME = shopHome
mkdirSync(join(shopHome, 'profiles', 'web'), { recursive: true })
writeFileSync(join(shopHome, 'profiles', 'web', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-hello-plugin', 'dsh-repo-plugin', 'sub-plugin', 'dsh-rescued', 'dsh-plugin-shop'] } } }))

afterAll(() => {
  delete process.env.DSH_HOME
  rmSync(shopHome, { recursive: true, force: true })
})

function stubCtx(): never {
  return { get: () => undefined, reflect: { provide: () => {} } } as never
}

/** Materialize an installed package with the bundle patch it declares, the
 * shape the loader actually composes: the shop resolves a package's rows
 * through its patch's inserted ids, never through the entry's module name. */
function fixturePackage(profileDir: string, name: string, patch: string | null): void {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  const dsh = patch === null ? {} : { bundle: { patch: './cordis.patch.yml' } }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dsh }))
  if (patch !== null) writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  // An install writes the dependency too, and installed-ness is read from it.
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
  manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
  writeFileSync(manifestPath, JSON.stringify(manifest))
}

function toggleProfile(): string {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-shop-'))
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
    const home = mkdtempSync(join(tmpdir(), 'dsh-linked-'))
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
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-toggle-snapshot-'))
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
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-toggle-malformed-'))
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
    expect(calls).toEqual([expect.objectContaining({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', refresh: true })])
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
    const calls: Array<{ baseUrl: string; cacheDir: string; refresh?: boolean }> = []
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
    expect(calls).toEqual([expect.objectContaining({ baseUrl: 'https://row.test/v1/', cacheDir: '/row-cache' })])
  })
})

// A fixture `dsh` that records its argv and exits 0; the calls log path lets
// a rejection's no-spawn property be proven by the file's absence.
function gatewayWithSnapshot(snapshot: CatalogSnapshot, options: Partial<ShopGatewayOptions> = {}): { gateway: ShopGateway; callsLog: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gateway-fixture-'))
  const bin = join(dir, 'dsh')
  writeFileSync(bin, [
    '#!/bin/sh',
    `echo "$1 $2 $3 $4 $5" >> "${join(dir, 'calls.log')}"`,
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(bin, 0o755)
  // The install flow reads the running profile manifest before spawning (to
  // tell an update from a fresh install); the fixture supplies one.
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-gateway-profile-'))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
  const gateway = new ShopGateway(stubCtx(), {
    catalogUrl: 'https://shop.test/v1/',
    cacheDir: '/cache',
    profile: 'web',
    profileDir,
    loadCatalog: async () => ({ snapshot, stale: false }) as CatalogResult,
    dshBin: bin,
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

  it('spawns only for an acknowledged install and reports progress', async () => {
    const { gateway, callsLog } = gatewayWithSnapshot({ schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} })
    const result = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const status = gateway.installStatus({ installId: result.installId })
    expect(status.found).toBe(true)
    // The fixture dsh exits 0 immediately; the status may already be done.
    expect(['running', 'done']).toContain(status.state)
    // Poll installStatus until the fixture's subprocess is done (finished
    // records are retained), then prove the exact argv was recorded — the
    // profile and the pinned spec pass through to the subprocess.
    const deadline = Date.now() + 5000
    let terminal = status
    while (terminal.state === 'running' && Date.now() < deadline) {
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
    while (status.state === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      status = gateway.installStatus({ installId: result.installId })
    }
    expect(status.found).toBe(true)
    expect(status.state).toBe('done')
    expect(status.needsRestart).toBe(true)
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
    // terminal, all 33 are finished.
    const deadline = Date.now() + 15000
    let last = gateway.installStatus({ installId: lastId })
    while (last.state === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      last = gateway.installStatus({ installId: lastId })
    }
    expect(last.state).not.toBe('running')
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
      while (status.state === 'running' && Date.now() < deadline) {
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
})

describe('ShopGateway.installed', () => {
  const entries = [
    { name: 'dsh-one', version: '2.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' },
    { name: 'dsh-two', version: '1.5.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' },
  ]

  function gatewayWithManifest(dependencies: Record<string, string>): ShopGateway {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-installed-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies }))
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries, denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
  }

  it('carries the inventory enabled state onto the installed rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-installed-inv-'))
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
    expect(await gateway.installed()).toEqual([{ name: 'dsh-one', installed: '^1.0.0', latest: '2.0.0', outdated: true, enabled: false }])
  })

  it('reports an installed plugin behind the catalog with outdated: true', async () => {
    const gateway = gatewayWithManifest({ 'dsh-one': '^1.0.0' })
    await gateway.catalog({}) // populates lastSnapshot
    expect(await gateway.installed()).toEqual([{ name: 'dsh-one', installed: '^1.0.0', latest: '2.0.0', outdated: true, enabled: true }])
  })

  it('reports a current installed plugin with outdated: false', async () => {
    const gateway = gatewayWithManifest({ 'dsh-one': '^2.0.0' })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-one', installed: '^2.0.0', latest: '2.0.0', outdated: false, enabled: true }])
  })

  it('reads a non-semver installed spec as current instead of throwing', async () => {
    const gateway = gatewayWithManifest({ 'dsh-one': '^1.0.0', 'dsh-two': 'workspace:*' })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([
      { name: 'dsh-one', installed: '^1.0.0', latest: '2.0.0', outdated: true, enabled: true },
      { name: 'dsh-two', installed: 'workspace:*', latest: '1.5.0', outdated: false, enabled: true },
    ])
  })

  it('lazily loads the catalog when installed() is called without a prior catalog()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-installed-'))
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
    expect(installed).toEqual([{ name: 'dsh-one', installed: '^1.0.0', latest: '2.0.0', outdated: true, enabled: true }])
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
    const dir = mkdtempSync(join(tmpdir(), 'dsh-forwards-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies }))
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries, denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
  }

  it('reports an equal installed version as current', async () => {
    const gateway = gatewayWithManifest({ 'dsh-two': '1.5.0' })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-two', installed: '1.5.0', latest: '1.5.0', outdated: false, enabled: true }])
  })

  it('reports a backwards catalog version as current, never "outdated"', async () => {
    const gateway = gatewayWithManifest({ 'dsh-two': '2.0.0' })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-two', installed: '2.0.0', latest: '1.5.0', outdated: false, enabled: true }])
  })

  it('reports a behind installed version as outdated', async () => {
    const gateway = gatewayWithManifest({ 'dsh-two': '^1.0.0' })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-two', installed: '^1.0.0', latest: '1.5.0', outdated: true, enabled: true }])
  })
})

describe('ShopGateway.uninstall', () => {
  const entries = [
    { name: 'dsh-one', version: '2.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25' },
  ]

  function gatewayWithManifest(dependencies: Record<string, string>): ShopGateway {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-uninstall-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gateway-restart-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, `#!/bin/sh\necho "$1 $2 $3" >> "${join(dir, 'calls.log')}"\nexit 0\n`)
    chmodSync(bin, 0o755)
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/',
      cacheDir: options.cacheDir ?? mkdtempSync(join(tmpdir(), 'dsh-restart-cache-')),
      profile: 'web',
      dshBin: bin,
      restartArgv: options.restartArgv ?? ['web'],
      exit: options.exit,
      restartExitDelayMs: 5,
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
    })
    const result = await gateway.restart()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain('restart could not be started')
    expect(exit).not.toHaveBeenCalled()
  })
})

// File-scope fixture options shared by the restart-guard describe and the hot
// paths (C-2): a fixture dsh and a pid beyond pid_max (guaranteed dead), so
// the takeover helper runs the fixture at once and no real dsh web is ever
// spawned. The cacheDir is a scratch dir — the handoff opens restart.log
// inside it before committing. Hot-path cases spread these and add the
// profile manifest, catalog fixture, and the hot/loader injections.
function gatewayOptions() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-guard-'))
  const bin = join(dir, 'dsh')
  writeFileSync(bin, `#!/bin/sh\necho "$1 $2 $3" >> "${join(dir, 'calls.log')}"\nexit 0\n`)
  chmodSync(bin, 0o755)
  return {
    catalogUrl: 'https://shop.test/v1/',
    cacheDir: mkdtempSync(join(tmpdir(), 'dsh-restart-guard-cache-')),
    profile: 'web',
    exit: () => {}, restartExitDelayMs: 0,
    dshBin: bin,
    restartParentPid: 1_000_000_000,
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

  it('reports restartSupported: false under systemd without the override', async () => {
    const gateway = new ShopGateway(stubCtx(), { ...gatewayOptions(), env: { INVOCATION_ID: 'abc' }, ppid: 1, fetchLatestVersion: async () => '9.9.9' })
    const version = await gateway.version()
    expect(version.restartSupported).toBe(false)
  })

  it('reports restartSupported: true outside a supervisor', async () => {
    const gateway = new ShopGateway(stubCtx(), { ...gatewayOptions(), env: {}, ppid: 4321, fetchLatestVersion: async () => null })
    const version = await gateway.version()
    expect(version.restartSupported).toBe(true)
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
    const dir = mkdtempSync(join(tmpdir(), 'dsh-self-update-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dsh: { profile: { bundles: ['dsh-plugin-shop'] } },
    }))
    const binDir = mkdtempSync(join(tmpdir(), 'dsh-self-update-bin-'))
    const bin = join(binDir, 'dsh')
    writeFileSync(bin, [
      '#!/bin/sh',
      `echo "$1 $2 $3 $4 $5" >> "${join(binDir, 'calls.log')}"`,
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir, dshBin: bin,
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

  function gatewayWithRepo(dir: string, hasGit = true): ShopGateway {
    const bin = join(dir, 'fake-dsh')
    writeFileSync(bin, [
      '#!/bin/sh',
      `echo "$1 $2 $3 $4 $5" >> "${join(dir, 'calls.log')}"`,
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    // The install flow reads the running profile manifest before spawning.
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-repo-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 3, builtAt: '', entries: [repoEntry], denied: [], stars: {} }, stale: false }) as CatalogResult,
      dshBin: bin,
      hasGit: () => hasGit,
    })
  }

  it('spawns github:owner/slug#commit from snapshot fields and records the pin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-github-install-'))
    const gateway = gatewayWithRepo(dir)
    const result = await gateway.install({ name: 'dsh-repo-plugin', version: commit, acknowledged: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const deadline = Date.now() + 5000
    let terminal = gateway.installStatus({ installId: result.installId })
    while (terminal.state === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      terminal = gateway.installStatus({ installId: result.installId })
    }
    expect(terminal.state).toBe('done')
    expect(readFileSync(join(dir, 'calls.log'), 'utf8')).toContain(`plugin --profile web add github:someone/dsh-repo-plugin#${commit}`)
    expect(JSON.parse(readFileSync(join(dir, 'cache/github-pins.json'), 'utf8'))).toEqual({ 'dsh-repo-plugin': commit })
  })

  it('rejects git-missing before spawning when git is not on PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-github-nogit-'))
    const gateway = gatewayWithRepo(dir, false)
    const result = await gateway.install({ name: 'dsh-repo-plugin', version: commit, acknowledged: true })
    expect(result).toMatchObject({ ok: false, code: 'git-missing' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(join(dir, 'calls.log'))).toBe(false)
  })

  it('reports a github install by its pin, outdated when the catalog commit moved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-github-installed-'))
    mkdirSync(join(dir, 'cache'), { recursive: true })
    const oldCommit = 'a'.repeat(40)
    writeFileSync(join(dir, 'cache/github-pins.json'), JSON.stringify({ 'dsh-repo-plugin': oldCommit }))
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-github-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: { 'dsh-repo-plugin': 'github:someone/dsh-repo-plugin' } }))
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 3, builtAt: '', entries: [repoEntry], denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-repo-plugin', installed: oldCommit, latest: commit, outdated: true, enabled: true }])
  })

  it('forgets the pin on uninstall', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-github-uninstall-'))
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-github-profile-'))
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
    const bin = join(dir, 'fake-dsh')
    writeFileSync(bin, [
      '#!/bin/sh',
      `echo "$1 $2 $3 $4 $5" >> "${join(dir, 'calls.log')}"`,
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    // The install flow reads the running profile manifest before spawning.
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-sub-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 4, builtAt: '', entries: [subEntry], denied: [], stars: {} }, stale: false }) as CatalogResult,
      dshBin: bin,
      hasGit: () => true,
    })
  }

  it('spawns github:owner/slug#commit&path:<subdir> and records the pin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sub-install-'))
    const gateway = gatewayWithSub(dir)
    const result = await gateway.install({ name: 'sub-plugin', version: commit, acknowledged: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const deadline = Date.now() + 5000
    let terminal = gateway.installStatus({ installId: result.installId })
    while (terminal.state === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      terminal = gateway.installStatus({ installId: result.installId })
    }
    expect(terminal.state).toBe('done')
    expect(readFileSync(join(dir, 'calls.log'), 'utf8')).toContain(`plugin --profile web add github:someone/monorepo#${commit}&path:packages/sub-plugin`)
    expect(JSON.parse(readFileSync(join(dir, 'cache/github-pins.json'), 'utf8'))).toEqual({ 'sub-plugin': commit })
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
    const bin = join(dir, 'fake-dsh')
    writeFileSync(bin, [
      '#!/bin/sh',
      `echo "$1 $2 $3 $4 $5" >> "${join(dir, 'calls.log')}"`,
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    // The install flow reads the running profile manifest before spawning.
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-tarball-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 5, builtAt: '', entries: [tarballEntry], denied: [], stars: {} }, stale: false }) as CatalogResult,
      dshBin: bin,
      hasGit: () => false,
      fetchTarball,
    })
  }

  it('verifies the sha256, then installs the validated tarball url without git and records the tag pin', async () => {
    // The spec is the snapshot's tarball url (a https github.com release of
    // this very repo, validated at parse), NOT a github: spec — and the git
    // check is skipped, so hasGit: () => false must not stop the install.
    // The pin write records the tag, which is the entry's version (the
    // manifest records only `github:owner/slug`, so the pins file is how
    // `installed()` reports outdated honestly).
    const fetchTarball = vi.fn(async () => new Response(tarballBytes))
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tarball-install-'))
    const gateway = gatewayWithTarball(dir, fetchTarball)
    const result = await gateway.install({ name: 'dsh-rescued', version: tag, acknowledged: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(fetchTarball).toHaveBeenCalledWith(TARBALL_URL)
    const deadline = Date.now() + 5000
    let terminal = gateway.installStatus({ installId: result.installId })
    while (terminal.state === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      terminal = gateway.installStatus({ installId: result.installId })
    }
    expect(terminal.state).toBe('done')
    expect(readFileSync(join(dir, 'calls.log'), 'utf8')).toContain(`plugin --profile web add ${TARBALL_URL}`)
    expect(JSON.parse(readFileSync(join(dir, 'cache/github-pins.json'), 'utf8'))).toEqual({ 'dsh-rescued': tag })
  })

  it('rejects tarball-integrity without spawning when the bytes do not match the recorded sha256', async () => {
    const fetchTarball = vi.fn(async () => new Response(new TextEncoder().encode('tampered bytes')))
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tarball-mismatch-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tarball-fetchfail-'))
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
    const npmDir = mkdtempSync(join(tmpdir(), 'dsh-npm-notarball-'))
    const npmBin = join(npmDir, 'fake-dsh')
    writeFileSync(npmBin, ['#!/bin/sh', `echo "$1 $2 $3 $4 $5" >> "${join(npmDir, 'calls.log')}"`, 'exit 0', ''].join('\n'))
    chmodSync(npmBin, 0o755)
    const npmProfileDir = mkdtempSync(join(tmpdir(), 'dsh-npm-notarball-profile-'))
    writeFileSync(join(npmProfileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    const npmGateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(npmDir, 'cache'), profile: 'web', profileDir: npmProfileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 5, builtAt: '', entries: [npmEntry], denied: [], stars: {} }, stale: false }) as CatalogResult,
      dshBin: npmBin,
      fetchTarball,
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
    const repoDir = mkdtempSync(join(tmpdir(), 'dsh-github-notarball-'))
    const repoBin = join(repoDir, 'fake-dsh')
    writeFileSync(repoBin, ['#!/bin/sh', `echo "$1 $2 $3 $4 $5" >> "${join(repoDir, 'calls.log')}"`, 'exit 0', ''].join('\n'))
    chmodSync(repoBin, 0o755)
    const repoProfileDir = mkdtempSync(join(tmpdir(), 'dsh-github-notarball-profile-'))
    writeFileSync(join(repoProfileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    const repoGateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(repoDir, 'cache'), profile: 'web', profileDir: repoProfileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 5, builtAt: '', entries: [repoEntry], denied: [], stars: {} }, stale: false }) as CatalogResult,
      dshBin: repoBin,
      hasGit: () => true,
      fetchTarball,
    })
    const repoResult = await repoGateway.install({ name: 'dsh-repo-plugin', version: commit, acknowledged: true })
    expect(repoResult.ok).toBe(true)
    expect(fetchTarball).not.toHaveBeenCalled()
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
  }): { gateway: ShopGateway; profileDir: string } {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-hot-profile-'))
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
    })
    return { gateway, profileDir }
  }

  async function pollTerminal(gateway: ShopGateway, installId: string): Promise<ShopInstallStatusResult> {
    const deadline = Date.now() + 5000
    let status = gateway.installStatus({ installId })
    while (status.state === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      status = gateway.installStatus({ installId })
    }
    return status
  }

  it('install reports done with needsRestart false after a hot mount (fresh install)', async () => {
    const { gateway, profileDir } = hotGateway({
      hot: { mount: hotMount, unmount: hotUnmount },
      loaderEntries: () => [],
    })
    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await pollTerminal(gateway, started.installId)
    expect(status.state).toBe('done')
    expect(status.needsRestart).toBe(false)
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
    expect(status.needsRestart).toBe(false)
    expect(entry.update).toHaveBeenCalledTimes(3)
    expect(entry.update).toHaveBeenCalledWith({ disabled: true }, false, true)
    expect(order).toEqual(['disable', 'disable', 'disable', 'mount'])
  })

  it('a failed hot mount reports done with needsRestart true and the restart reason', async () => {
    hotMount.mockResolvedValueOnce({ ok: false, reason: 'not-simple' })
    const { gateway } = hotGateway({ hot: { mount: hotMount, unmount: hotUnmount }, loaderEntries: () => [] })
    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await pollTerminal(gateway, started.installId)
    expect(status.state).toBe('done')
    expect(status.needsRestart).toBe(true)
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
    expect(status.needsRestart).toBe(false)
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
    expect(status.needsRestart).toBe(false)
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

  it('uninstall of a plugin that never loaded still reports done without restart', async () => {
    const { gateway } = hotGateway({
      dependencies: { 'dsh-goodbye-plugin': '1.0.0' },
      hot: { mount: hotMount, unmount: hotUnmount },
      loaderEntries: () => [],
    })
    const result = await gateway.uninstall({ name: 'dsh-goodbye-plugin' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const status = await pollTerminal(gateway, result.installId)
    expect(status.state).toBe('done')
    expect(status.needsRestart).toBe(false)
  })

  it('self-update still reports needsRestart true — no hot path is wired', async () => {
    const { gateway } = hotGateway({ hot: { mount: hotMount, unmount: hotUnmount } })
    const started = await gateway.updateStart({ version: '9.9.9' })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await pollTerminal(gateway, started.installId)
    expect(status.state).toBe('done')
    expect(status.needsRestart).toBe(true)
    expect(hotMount).not.toHaveBeenCalled()
    expect(hotUnmount).not.toHaveBeenCalled()
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
    expect(result).toEqual({ ok: true })
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('archify-skill-filesystem')
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
    expect(await gateway.setEnabled({ name: '@tt-a1i/archify-dsh', enabled: true })).toEqual({ ok: true })
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
    expect(await gateway.setEnabled({ name: 'dsh-many', enabled: false })).toEqual({ ok: true })
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
    expect(result.incompatible).toEqual({ 'dsh-timeline': ['@deepseek-ai/dsh-client-store'] })
  })

  it('reports nothing when every peer resolves', async () => {
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 6, builtAt: '', entries: [peered], denied: [], stars: {} },
      { resolvePeer: () => true },
    )
    expect((await gateway.catalog({})).incompatible).toEqual({})
  })

  it('reports nothing for a v5 catalog, whose entries carry no peers', async () => {
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [{ ...peered, peers: undefined }], denied: [], stars: {} },
      { resolvePeer: () => false },
    )
    expect((await gateway.catalog({})).incompatible).toEqual({})
  })

  it('reports nothing, rather than throwing, when no profile anchor exists for a peer-bearing entry', async () => {
    // Pairs the two conditions the catch in `catalog()` exists for: no
    // `profileDir` (so `profileDirResolved()` throws and no resolver can be
    // built) together with an entry that DOES declare peers (so there is
    // something for a resolver to be asked about, if one existed). Neither
    // condition alone exercises the catch's real job: the "no profileDir"
    // tests in `describe('ShopGateway.catalog', ...)` above use an entry
    // with no `peers` at all, so incompatibilityMap skips it before ever
    // touching a resolver; every other test in this block injects
    // `resolvePeer` directly, so the catch is never reached. Only this
    // pairing proves a plugin we cannot judge is never accused — do not
    // "simplify" this fixture back to either half.
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

  it('caches the incompatibility map for a snapshot instead of recomputing on a repeat call', async () => {
    // gatewayWithSnapshot's loadCatalog stub closes over one fixed snapshot
    // object, so both calls below load the exact same object — the scenario
    // design §3 calls "once per loaded snapshot", and the real loadCatalog's
    // five-minute on-disk freshness window means a real reopened tab hits
    // this same path far more often than a fresh snapshot.
    const resolvePeer = vi.fn((spec: string) => spec !== '@deepseek-ai/dsh-client-store')
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 6, builtAt: '', entries: [peered], denied: [], stars: {} },
      { resolvePeer },
    )

    const first = await gateway.catalog({})
    expect(first.incompatible).toEqual({ 'dsh-timeline': ['@deepseek-ai/dsh-client-store'] })
    expect(resolvePeer).toHaveBeenCalledTimes(2) // the two distinct peer names on `peered`

    const second = await gateway.catalog({})
    expect(second.incompatible).toEqual({ 'dsh-timeline': ['@deepseek-ai/dsh-client-store'] })
    // Unchanged: the second call must reuse the cached map, never ask the
    // resolver again for a snapshot it has already judged.
    expect(resolvePeer).toHaveBeenCalledTimes(2)
  })
})
