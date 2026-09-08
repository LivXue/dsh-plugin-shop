/**
 * The load-bearing property of design §2: one build, two transports, one
 * snapshot. If the npm package and the Pages tree can produce different
 * catalogs, the whole design's premise is gone — so this test builds a real
 * tarball from the same bytes the HTTP fixture serves and compares the two
 * loaded snapshots exactly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { loadCatalog } from '../../src/host/catalog.ts'
import { httpOrigin } from '../../src/host/origin.ts'
import { npmOrigin } from '../../src/host/npm-origin.ts'
import { npmCommand } from '../fixtures/node-cli.ts'
import { startNpmRegistry, type NpmRegistryFixture } from '../fixtures/npm-registry.ts'
import { memCatalogFs as memFs } from './mem-fs.ts'
import { fileTempRoot } from './temp-root.ts'

const TEMP_ROOT = fileTempRoot('transport-parity')

const PKG = 'dsh-plugin-shop-catalog-parity'
const VERSION = '2026.901.0'

const ENTRY = {
  name: 'dsh-parity-plugin', version: '2.0.0', integrity: 'sha512-p', publishedAt: null,
  repository: null, license: 'MIT', tier: 'community', metadata: 'derived', added: '2026-08-25',
}

const pluginsText = `${JSON.stringify({ schemaVersion: 5, plugins: [ENTRY], denied: [] }, null, 2)}\n`
const pluginsSha = createHash('sha256').update(pluginsText).digest('hex')
const pluginsName = `plugins.${pluginsSha}.json`
const starsText = `${JSON.stringify({ stars: { 'dsh-parity-plugin': 7 } }, null, 2)}\n`
const starsSha = createHash('sha256').update(starsText).digest('hex')
const starsName = `stars.${starsSha}.json`
const indexText = `${JSON.stringify({
  schemaVersion: 5, builtAt: '2026-09-01T03:17:00.000Z', count: 1, rejected: 0,
  plugins: { url: pluginsName, sha256: pluginsSha },
  stars: { url: starsName, sha256: starsSha },
}, null, 2)}\n`

let pagesServer: Server | undefined
let pagesUrl = ''
let registry: NpmRegistryFixture | undefined
let workDir = ''

beforeAll(async () => {
  // The Pages transport: the three files, served as-is.
  const bodies = new Map([
    ['/v1/index.json', indexText],
    [`/v1/${pluginsName}`, pluginsText],
    [`/v1/${starsName}`, starsText],
  ])
  // Published to the module handle BEFORE listening, so a failure to bind
  // still leaves afterAll something to close.
  const server = createServer((request, response) => {
    const body = bodies.get(request.url ?? '')
    if (body === undefined) { response.writeHead(404).end('not found'); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(body)
  })
  pagesServer = server
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  pagesUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`

  // The npm transport: the SAME three files, packed by npm itself.
  workDir = mkdtempSync(join(TEMP_ROOT, 'shop-parity-'))
  mkdirSync(join(workDir, 'v1'), { recursive: true })
  writeFileSync(join(workDir, 'v1', 'index.json'), indexText)
  writeFileSync(join(workDir, 'v1', pluginsName), pluginsText)
  writeFileSync(join(workDir, 'v1', starsName), starsText)
  writeFileSync(join(workDir, 'package.json'), `${JSON.stringify({
    name: PKG, version: VERSION, license: 'MIT', files: ['v1'],
  }, null, 2)}\n`)
  // Through the shared helper, not `execFileSync('npm', …)`: a bare `npm` is
  // ENOENT on Windows, and this beforeAll throwing skipped all three cases
  // below — so the load-bearing §2 property was unverified on the platform
  // the shop is developed on.
  const { command, args } = npmCommand(['pack', '--silent'])
  const pack = spawnSync(command, args, { cwd: workDir, stdio: 'pipe', encoding: 'utf8' })
  if (pack.status !== 0) {
    // `error` is the only populated field when the binary never started,
    // which is the case where the reason matters most.
    throw new Error(`npm pack failed in ${workDir} (${command}):\n${pack.error?.message ?? pack.stderr ?? '(no output)'}`)
  }
  const packed = readdirSync(workDir).find(f => f.endsWith('.tgz'))
  if (packed === undefined) throw new Error('npm pack produced no tarball')
  registry = await startNpmRegistry(PKG, VERSION, readFileSync(join(workDir, packed)))
}, 60_000)

afterAll(async () => {
  // Every step guarded, and the workDir removed regardless of the others. A
  // beforeAll that threw part-way used to produce a SECOND failure here —
  // `Cannot read properties of undefined (reading 'close')` — which buried
  // the real cause and skipped the removal below it. tsc could not warn:
  // both handles were typed non-optional because beforeAll assigns them.
  const server = pagesServer
  if (server !== undefined) await new Promise<void>(resolve => server.close(() => resolve()))
  if (registry !== undefined) await registry.close()
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true })
})

/** The started fixture, or a failure naming what did not start — never an
 * `undefined` dereference several frames from the cause. */
function npmRegistry(): NpmRegistryFixture {
  if (registry === undefined) throw new Error('the npm registry fixture did not start (see the beforeAll failure)')
  return registry
}

describe('transport parity', () => {
  it('produces an identical snapshot over HTTP and over npm', async () => {
    const viaHttp = await loadCatalog({
      cacheDir: '/cache-http', fsImpl: memFs(),
      origins: [httpOrigin(pagesUrl, fetch)],
    })
    const viaNpm = await loadCatalog({
      cacheDir: '/cache-npm', fsImpl: memFs(),
      origins: [npmOrigin(npmRegistry().registryUrl, PKG, fetch)],
    })
    expect(viaNpm.snapshot).toEqual(viaHttp.snapshot)
    expect(viaNpm.snapshot.entries).toHaveLength(1)
    expect(viaNpm.snapshot.stars).toEqual({ 'dsh-parity-plugin': 7 })
    expect(viaNpm.stale).toBe(false)
  })

  it('races the two and still produces that same snapshot', async () => {
    const viaHttp = await loadCatalog({
      cacheDir: '/cache-http2', fsImpl: memFs(),
      origins: [httpOrigin(pagesUrl, fetch)],
    })
    const raced = await loadCatalog({
      cacheDir: '/cache-race', fsImpl: memFs(),
      origins: [npmOrigin(npmRegistry().registryUrl, PKG, fetch), httpOrigin(pagesUrl, fetch)],
    })
    expect(raced.snapshot).toEqual(viaHttp.snapshot)
  })

  it('survives a dead origin in the list', async () => {
    const raced = await loadCatalog({
      cacheDir: '/cache-dead', fsImpl: memFs(),
      origins: [
        npmOrigin('http://127.0.0.1:1/', PKG, fetch),
        httpOrigin('http://127.0.0.1:1/v1/', fetch),
        npmOrigin(npmRegistry().registryUrl, PKG, fetch),
      ],
    })
    expect(raced.snapshot.entries).toHaveLength(1)
  })

  it('serves the cache each transport wrote once every origin is dead', async () => {
    // Parity extends to what each transport LEAVES ON DISK, not just to what
    // it returns: a cache written under a name the next boot cannot address
    // would degrade to a throw instead of a stale shelf, and only on the
    // platform where the two spellings differ. No case here seeded a cache
    // before, which is why this file's own copy of the fixture could hold the
    // un-normalised keying for months without anything going red.
    for (const [label, origin] of [
      ['http', httpOrigin(pagesUrl, fetch)] as const,
      ['npm', npmOrigin(npmRegistry().registryUrl, PKG, fetch)] as const,
    ]) {
      const fsImpl = memFs()
      const cacheDir = `/cache-reload-${label}`
      // Both clocks are explicit. Left to the real one, the first load stamps
      // `index.meta.json` with today and the second's fixed date reads as
      // EARLIER — a negative age, which is inside the freshness window, so
      // the shortcut answers and the case passes with `stale: false` without
      // ever re-reading the cached bytes.
      const first = await loadCatalog({
        cacheDir, fsImpl, origins: [origin],
        now: () => new Date('2026-09-01T04:00:00.000Z'),
      })
      expect(first.stale, label).toBe(false)

      const second = await loadCatalog({
        cacheDir, fsImpl,
        origins: [httpOrigin('http://127.0.0.1:1/v1/', fetch)],
        // A day past the five-minute freshness window, so the shortcut cannot
        // answer and the cache is genuinely re-read from its own bytes.
        now: () => new Date('2026-09-02T04:00:00.000Z'),
      })
      expect(second.stale, label).toBe(true)
      expect(second.snapshot, label).toEqual(first.snapshot)
    }
  })
})
