/**
 * A minimal in-process catalog server for the web full-flow e2e: serves the
 * §9.2 wire shape — a `/v1/index.json` pointer plus the `/v1/plugins.<sha>.json`
 * data file it names — with the sha256 computed at startup, the same binding
 * the real publishing pipeline makes between the two files.
 *
 * One community-tier, derived (unclaimed, §6.1) fixture entry:
 * `dsh-e2e-fixture-plugin@1.0.0`, a name that does not exist on npm. The
 * browser install therefore fails with REAL pnpm stderr — the failed view and
 * its recovery hint are part of what this e2e proves; a name that resolved
 * would make the install succeed and sidestep that surface entirely.
 *
 * Port 0 → the OS assigns an ephemeral port; the caller reads `baseUrl` and
 * closes the server in teardown. The fixture lives here, not in the test, so
 * the wire shape (and its sha binding) is defined once.
 */

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface CatalogServer {
  /** Catalog base, e.g. `http://127.0.0.1:<port>/v1/` — what the profile's
   * shop row reads from DSH_SHOP_CATALOG_URL. */
  baseUrl: string
  close: () => Promise<void>
}

/** The single fixture entry. No `catalog` section: derived metadata, so the
 * shop presents the entry as unclaimed (§6.1) — the badge the e2e asserts.
 * `publishedAt` stays fixed so the snapshot is deterministic per run. */
const FIXTURE_ENTRY = {
  name: 'dsh-e2e-fixture-plugin',
  version: '1.0.0',
  integrity: null,
  publishedAt: '2026-08-25T00:00:00.000Z',
  repository: 'https://github.com/octocat/dsh-e2e-fixture',
  license: null,
  tier: 'community',
  metadata: 'derived',
} as const

export async function startCatalogServer(): Promise<CatalogServer> {
  const data = JSON.stringify({ schemaVersion: 2, plugins: [FIXTURE_ENTRY], denied: [] })
  const sha256 = createHash('sha256').update(data).digest('hex')
  const dataName = `plugins.${sha256}.json`
  const stars = JSON.stringify({ stars: { 'dsh-e2e-fixture-plugin': 4321 } })
  const starsSha = createHash('sha256').update(stars).digest('hex')
  const starsName = `stars.${starsSha}.json`
  const pointer = JSON.stringify({
    schemaVersion: 2,
    builtAt: new Date().toISOString(),
    count: 1,
    plugins: { url: dataName, sha256 },
    stars: { url: starsName, sha256: starsSha },
  })
  const routes = new Map<string, string>([
    ['/v1/index.json', pointer],
    [`/v1/${dataName}`, data],
    [`/v1/${starsName}`, stars],
  ])
  const server: Server = createServer((req, res) => {
    const body = routes.get(req.url ?? '')
    if (body === undefined) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1/`,
    close: () => new Promise<void>((resolve, reject) => {
      // Drop every connection first: the shop gateway's fetch pool keeps
      // keep-alive sockets to this server open, and a bare close() would
      // wait on them forever even after the gateway process is dead.
      server.closeAllConnections()
      server.close(error => (error === undefined ? resolve() : reject(error)))
    }),
  }
}
