/**
 * A minimal in-process catalog server for the web full-flow e2e: serves the
 * §9.2 wire shape — a `/v1/index.json` pointer plus the `/v1/plugins.<sha>.json`
 * data file it names — with the sha256 computed at startup, the same binding
 * the real publishing pipeline makes between the two files.
 *
 * Five community-tier, derived (§6.1) fixture entries. The first,
 * `dsh-e2e-fixture-plugin@1.0.0`, is a name that does not exist on npm (and
 * that the hot-mount local registry does not serve) — the browser install of
 * it fails with REAL pnpm stderr, the failed view and its recovery hint being
 * part of what this e2e proves; a name that resolved would make the install
 * succeed and sidestep that surface entirely. The other four,
 * `dsh-shop-e2e-live`, `dsh-shop-e2e-config`, `dsh-shop-e2e-peer`, and
 * `dsh-shop-e2e-client`, ARE served by the local registry
 * (tests/fixtures/local-registry.ts): the simple-patch fixture mounts
 * without a restart, the config-row fixture falls back to a restart, the
 * peer fixture declares `peers: ["@deepseek-ai/dsh-client-store"]` — a
 * module this test's profile never installs — so the harness-compatibility
 * badge and install-gate warning have a genuinely-missing peer to report
 * against a real host resolver, and the client fixture additionally declares
 * `dsh.client` (activation-model design, §3) so a hot-mounted install has a
 * browser half and reports `reload` rather than `live` — the other three
 * live fixtures are host-only, so none of them can exercise that path. That
 * one missing peer is also the incompatible FILTER's subject: it makes the
 * shelf hold exactly one incompatible entry, so the filter's count and the
 * card it removes are both determinate.
 *
 * Port 0 → the OS assigns an ephemeral port; the caller reads `baseUrl` and
 * closes the server in teardown. The fixtures live here, not in the test, so
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

/** The five fixture entries. No `catalog` section: derived metadata, so the
 * shop presents each entry's derived summary (§6.1).
 * `publishedAt` stays fixed so the snapshot is deterministic per run. */
const FIXTURE_ENTRIES = [
  {
    name: 'dsh-e2e-fixture-plugin',
    version: '1.0.0',
    integrity: null,
    publishedAt: '2026-08-25T00:00:00.000Z',
    repository: 'https://github.com/octocat/dsh-e2e-fixture',
    license: null,
    tier: 'community',
    metadata: 'derived',
    added: '2026-08-25',
    // The npm publishing account, so the expanded detail's npm row is proven
    // in a real browser and not only in jsdom. No other entry here carries
    // one, which is also the live catalog's state until the next daily build.
    // Stated without a count on purpose: "the other two" was written when
    // there were three entries and was quietly false at four.
    publisher: 'octocat',
    // npm's `dist.unpackedSize`, so the size label is proven through the real
    // wire → host zod → client format path. 847407 is the MEDIAN of the 250
    // live `dsh-plugin` packages measured on 2026-09-07, and it renders
    // "847.4 kB".
    //
    // This entry carries the OLD key ALONE, which no live entry does any more
    // — deliberately, because that is the rolled-back or cached catalog the
    // parse-boundary merge exists for: `catalog.ts`'s transform fills
    // `installSize` from it, the client reads `installSize` alone, and this is
    // the only lane where a real host zod does that merge before a real
    // browser renders the result. The `dsh-shop-e2e-live` entry carries the
    // new key alone and proves the other half.
    unpackedSize: 847407,
  },
  {
    name: 'dsh-shop-e2e-live',
    version: '1.0.0',
    integrity: null,
    publishedAt: '2026-08-25T00:00:00.000Z',
    repository: 'https://github.com/octocat/dsh-shop-e2e-live',
    license: null,
    tier: 'community',
    metadata: 'derived',
    added: '2026-08-31',
    // The NEW key ALONE — and what that proves here is the KEY surviving a
    // real host parse, not the github shape. This row declares no `source`,
    // so `catalog.ts` defaults it to `npm` and it takes the npm early-return
    // before any github check runs; it also carries no `repo` and a semver
    // `version`, both of which the github branch would refuse. It cannot be
    // flipped to `source: 'github'` either: the hot-mount spec installs this
    // same name from the local npm registry (`web-full-flow.e2e.ts`), so a
    // github source would break that lane.
    //
    // The key alone is the point, because that is what was lost: the registry
    // published a size for every github entry from 0.8.1 and no shelf ever
    // showed one, because the consumer schema declared no such key and a
    // non-strict zod dropped it in silence. Only a real host parse can catch
    // that — the jsdom specs build their snapshot object directly and never
    // cross it. The GITHUB shape is covered where it can be: the parse in
    // `tests/host/catalog.test.ts` (a github entry with `repo`, a commit-sha
    // version and an `installSize`), the render in
    // `tests/client/ShopTab.client.spec.tsx`. 4123461 renders "4.1 MB".
    installSize: 4123461,
  },
  {
    name: 'dsh-shop-e2e-config',
    version: '1.0.0',
    integrity: null,
    publishedAt: '2026-08-25T00:00:00.000Z',
    repository: 'https://github.com/octocat/dsh-shop-e2e-config',
    license: null,
    tier: 'community',
    metadata: 'derived',
    added: '2026-08-31',
  },
  {
    name: 'dsh-shop-e2e-peer',
    version: '1.0.0',
    integrity: null,
    publishedAt: '2026-08-25T00:00:00.000Z',
    repository: 'https://github.com/octocat/dsh-shop-e2e-peer',
    license: null,
    tier: 'community',
    metadata: 'derived',
    added: '2026-08-31',
    peers: ['@deepseek-ai/dsh-client-store'],
  },
  {
    name: 'dsh-shop-e2e-client',
    version: '1.0.0',
    integrity: null,
    publishedAt: '2026-09-11T00:00:00.000Z',
    repository: 'https://github.com/octocat/dsh-shop-e2e-client',
    license: null,
    tier: 'community',
    metadata: 'derived',
    added: '2026-09-11',
  },
] as const

export async function startCatalogServer(): Promise<CatalogServer> {
  const data = JSON.stringify({ schemaVersion: 6, plugins: FIXTURE_ENTRIES, denied: [] })
  const sha256 = createHash('sha256').update(data).digest('hex')
  const dataName = `plugins.${sha256}.json`
  const stars = JSON.stringify({
    stars: {
      'dsh-e2e-fixture-plugin': 4321,
      'dsh-shop-e2e-live': 111,
      'dsh-shop-e2e-config': 222,
    },
  })
  const starsSha = createHash('sha256').update(stars).digest('hex')
  const starsName = `stars.${starsSha}.json`
  const pointer = JSON.stringify({
    schemaVersion: 6,
    builtAt: new Date().toISOString(),
    count: FIXTURE_ENTRIES.length,
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
