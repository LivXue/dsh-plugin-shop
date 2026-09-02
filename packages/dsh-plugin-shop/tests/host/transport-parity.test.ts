/**
 * The load-bearing property of design §2: one build, two transports, one
 * snapshot. If the npm package and the Pages tree can produce different
 * catalogs, the whole design's premise is gone — so this test builds a real
 * tarball from the same bytes the HTTP fixture serves and compares the two
 * loaded snapshots exactly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCatalog, type CatalogFs } from '../../src/host/catalog.ts'
import { httpOrigin } from '../../src/host/origin.ts'
import { npmOrigin } from '../../src/host/npm-origin.ts'
import { startNpmRegistry, type NpmRegistryFixture } from '../fixtures/npm-registry.ts'

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

function memFs(): CatalogFs {
  const files = new Map<string, string>()
  return { exists: p => files.has(p), read: p => files.get(p) ?? '', write: (p, d) => { files.set(p, d) } }
}

let pagesServer: Server
let pagesUrl = ''
let registry: NpmRegistryFixture
let workDir = ''

beforeAll(async () => {
  // The Pages transport: the three files, served as-is.
  const bodies = new Map([
    ['/v1/index.json', indexText],
    [`/v1/${pluginsName}`, pluginsText],
    [`/v1/${starsName}`, starsText],
  ])
  pagesServer = createServer((request, response) => {
    const body = bodies.get(request.url ?? '')
    if (body === undefined) { response.writeHead(404).end('not found'); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(body)
  })
  await new Promise<void>(resolve => pagesServer.listen(0, '127.0.0.1', resolve))
  pagesUrl = `http://127.0.0.1:${(pagesServer.address() as AddressInfo).port}/v1/`

  // The npm transport: the SAME three files, packed by npm itself.
  workDir = mkdtempSync(join(tmpdir(), 'shop-parity-'))
  mkdirSync(join(workDir, 'v1'), { recursive: true })
  writeFileSync(join(workDir, 'v1', 'index.json'), indexText)
  writeFileSync(join(workDir, 'v1', pluginsName), pluginsText)
  writeFileSync(join(workDir, 'v1', starsName), starsText)
  writeFileSync(join(workDir, 'package.json'), `${JSON.stringify({
    name: PKG, version: VERSION, license: 'MIT', files: ['v1'],
  }, null, 2)}\n`)
  execFileSync('npm', ['pack', '--silent'], { cwd: workDir, stdio: 'pipe' })
  const packed = readdirSync(workDir).find(f => f.endsWith('.tgz'))
  if (packed === undefined) throw new Error('npm pack produced no tarball')
  registry = await startNpmRegistry(PKG, VERSION, readFileSync(join(workDir, packed)))
}, 60_000)

afterAll(async () => {
  await new Promise<void>(resolve => pagesServer.close(() => resolve()))
  await registry.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('transport parity', () => {
  it('produces an identical snapshot over HTTP and over npm', async () => {
    const viaHttp = await loadCatalog({
      cacheDir: '/cache-http', fsImpl: memFs(),
      origins: [httpOrigin(pagesUrl, fetch)],
    })
    const viaNpm = await loadCatalog({
      cacheDir: '/cache-npm', fsImpl: memFs(),
      origins: [npmOrigin(registry.registryUrl, PKG, fetch)],
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
      origins: [npmOrigin(registry.registryUrl, PKG, fetch), httpOrigin(pagesUrl, fetch)],
    })
    expect(raced.snapshot).toEqual(viaHttp.snapshot)
  })

  it('survives a dead origin in the list', async () => {
    const raced = await loadCatalog({
      cacheDir: '/cache-dead', fsImpl: memFs(),
      origins: [
        npmOrigin('http://127.0.0.1:1/', PKG, fetch),
        httpOrigin('http://127.0.0.1:1/v1/', fetch),
        npmOrigin(registry.registryUrl, PKG, fetch),
      ],
    })
    expect(raced.snapshot.entries).toHaveLength(1)
  })
})
