import { afterAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ShopGateway from '../../src/host/index.ts'
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
writeFileSync(join(shopHome, 'profiles', 'web', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-hello-plugin'] } } }))

afterAll(() => {
  delete process.env.DSH_HOME
  rmSync(shopHome, { recursive: true, force: true })
})

function stubCtx(): never {
  return { get: () => undefined, reflect: { provide: () => {} } } as never
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

  it('discovers the profile from the boot baseUrl when the module is not under a profile', () => {
    // Regression for `link:` installs: pnpm keeps the package at its source,
    // so the walk-up from import.meta.url finds the repo, not a profile. The
    // boot's ctx.baseUrl — the profile's cordis.yml directory — is the
    // authoritative source, and the constructor must use it.
    const home = mkdtempSync(join(tmpdir(), 'dsh-linked-'))
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-plugin-shop'] } } }))
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
    const inventory = [{ entryId: 'shop-row', moduleName: 'dsh-plugin-shop', enabled: true }]
    const withInventory = new ShopGateway(ctx, { inventory: { list: () => inventory } })
    const result = withInventory.setEnabled({ name: 'dsh-plugin-shop', enabled: false })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('shop-row')
  })
})

describe('ShopGateway.catalog', () => {
  const snapshot = {
    schemaVersion: 2,
    builtAt: '2026-08-25T00:00:00Z',
    entries: [{ name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived' }],
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
function gatewayWithSnapshot(snapshot: CatalogSnapshot): { gateway: ShopGateway; callsLog: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gateway-fixture-'))
  const bin = join(dir, 'dsh')
  writeFileSync(bin, [
    '#!/bin/sh',
    `echo "$1 $2 $3 $4 $5" >> "${join(dir, 'calls.log')}"`,
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(bin, 0o755)
  const gateway = new ShopGateway(stubCtx(), {
    catalogUrl: 'https://shop.test/v1/',
    cacheDir: '/cache',
    profile: 'web',
    loadCatalog: async () => ({ snapshot, stale: false }) as CatalogResult,
    dshBin: bin,
  })
  return { gateway, callsLog: join(dir, 'calls.log') }
}

describe('ShopGateway.install — the four rejection paths, through the executor', () => {
  // Annotated so the literal's tier/metadata do not widen to `string`, which
  // would not be assignable to the CatalogEntry union members.
  const listed: CatalogEntry = { name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived' }

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
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-shop-'))
    writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    const gateway = new ShopGateway(stubCtx(), { profile: 'web', profileDir, inventory: { list: () => [{ entryId: 'hello-row', moduleName: 'dsh-hello-fixture', enabled: true }] } })
    const result = await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: false })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('hello-row')
  })

  it('setEnabled on an enabled plugin removes the disable row', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-shop-'))
    writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: hello-row\n  disabled: true\n')
    const gateway = new ShopGateway(stubCtx(), { profile: 'web', profileDir, inventory: { list: () => [{ entryId: 'hello-row', moduleName: 'dsh-hello-fixture', enabled: false }] } })
    const result = await gateway.setEnabled({ name: 'dsh-hello-fixture', enabled: true })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).not.toContain('hello-row')
  })

  it('reports not installed for an unknown name without writing', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-shop-'))
    writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    const gateway = new ShopGateway(stubCtx(), { profile: 'web', profileDir, inventory: { list: () => [] } })
    const result = await gateway.setEnabled({ name: 'dsh-not-here', enabled: false })
    expect(result).toEqual({ ok: false, detail: 'dsh-plugin-shop: dsh-not-here is not installed' })
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
  })
})

describe('ShopGateway.installed', () => {
  const entries = [
    { name: 'dsh-one', version: '2.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived' },
    { name: 'dsh-two', version: '1.5.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived' },
  ]

  function gatewayWithManifest(dependencies: Record<string, string>): ShopGateway {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-installed-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies }))
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries, denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
  }

  it('reports an installed plugin behind the catalog with outdated: true', async () => {
    const gateway = gatewayWithManifest({ 'dsh-one': '^1.0.0' })
    await gateway.catalog({}) // populates lastSnapshot
    expect(await gateway.installed()).toEqual([{ name: 'dsh-one', installed: '^1.0.0', latest: '2.0.0', outdated: true }])
  })

  it('reports a current installed plugin with outdated: false', async () => {
    const gateway = gatewayWithManifest({ 'dsh-one': '^2.0.0' })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{ name: 'dsh-one', installed: '^2.0.0', latest: '2.0.0', outdated: false }])
  })

  it('reads a non-semver installed spec as current instead of throwing', async () => {
    const gateway = gatewayWithManifest({ 'dsh-one': '^1.0.0', 'dsh-two': 'workspace:*' })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([
      { name: 'dsh-one', installed: '^1.0.0', latest: '2.0.0', outdated: true },
      { name: 'dsh-two', installed: 'workspace:*', latest: '1.5.0', outdated: false },
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
    expect(installed).toEqual([{ name: 'dsh-one', installed: '^1.0.0', latest: '2.0.0', outdated: true }])
  })
})

describe('ShopGateway.uninstall', () => {
  const entries = [
    { name: 'dsh-one', version: '2.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived' },
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
  // A fixture `dsh` for the success path: prints the announce line and then
  // stays up, so the gateway's restart resolves the URL without a real web
  // boot. The failure path uses a fixture that exits during boot.
  function announcingDsh(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gateway-restart-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, '#!/bin/sh\necho "dsh web: http://127.0.0.1:4567"\nsleep 60\n')
    chmodSync(bin, 0o755)
    return bin
  }

  function failingDsh(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gateway-restart-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, '#!/bin/sh\necho "boom: cannot bind" >&2\nexit 1\n')
    chmodSync(bin, 0o755)
    return bin
  }

  it('re-spawns the original argv, resolves the announced URL, and exits after the response', async () => {
    const exit = vi.fn<() => void>()
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web',
      dshBin: announcingDsh(),
      restartArgv: ['web', '--no-open'],
      exit,
      restartExitDelayMs: 5,
    })
    const result = await gateway.restart()
    expect(result).toEqual({ ok: true, url: 'http://127.0.0.1:4567' })
    // The exit is delayed past the RPC round-trip, then fires.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('reports the typed failure and does NOT exit when the child fails to boot', async () => {
    const exit = vi.fn<() => void>()
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web',
      dshBin: failingDsh(),
      restartArgv: ['web'],
      exit,
      restartExitDelayMs: 5,
    })
    const result = await gateway.restart()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain('exited during boot')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(exit).not.toHaveBeenCalled()
  })
})
