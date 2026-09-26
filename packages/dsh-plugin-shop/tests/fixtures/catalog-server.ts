/**
 * A minimal in-process catalog server for the web full-flow e2e: serves the
 * §9.2 wire shape — a `/v1/index.json` pointer plus the `/v1/plugins.<sha>.json`
 * data file it names — with the sha256 computed at startup, the same binding
 * the real publishing pipeline makes between the two files.
 *
 * Six community-tier, derived (§6.1) fixture entries. The first,
 * `dsh-e2e-fixture-plugin@1.0.0`, is a name that does not exist on npm (and
 * that the hot-mount local registry does not serve) — the browser install of
 * it fails with REAL pnpm stderr, the failed view and its recovery hint being
 * part of what this e2e proves; a name that resolved would make the install
 * succeed and sidestep that surface entirely. The other five,
 * `dsh-shop-e2e-live`, `dsh-shop-e2e-config`, `dsh-shop-e2e-peer`,
 * `dsh-shop-e2e-client`, and `dsh-shop-e2e-update`, ARE served by the local
 * registry (tests/fixtures/local-registry.ts): the simple-patch fixture
 * mounts without a restart, the config-row fixture falls back to a restart,
 * the peer fixture carries every harness-compatibility verdict the shop can
 * form (below), the client fixture additionally declares `dsh.client`
 * (activation-model design, §3) so a hot-mounted install has a browser half
 * and reports `reload` rather than `live` — the first three live fixtures are
 * host-only, so none of them can exercise that path — and the update fixture is listed here at 2.0.0 while the e2e
 * installs 1.0.0 before dsh boots, so its card offers an update of a package
 * the running process has already imported (activation-model design, §3
 * amendment 2026-09-26).
 *
 * The compatibility verdict is formed in two stages — the host's node
 * resolution, then the browser's module table (design 2026-09-01 §9) — and
 * only a real harness can show the second stage, so the fixtures split the
 * cases between two cards:
 *
 * - `dsh-shop-e2e-peer` declares `@deepseek-ai/dsh-client-store` — the module
 *   whose absence broke a real user on 0.1.1-rc.2, and a platform seed word
 *   on the pinned 0.1.5-rc.3, so it must NOT be named — beside
 *   `@dsh-shop-e2e/absent-peer`, which nothing anywhere provides and so must
 *   be, and `@deepseek-ai/dsh-llm`, a host package the harness ships, which
 *   must not be: 0.1.5 links it into the profile, 0.1.7 serves it through
 *   its runtime resolution with no link farm, and only a real harness shows
 *   the difference (design 2026-09-01-harness-compatibility §11). It also
 *   declares a `dsh.compatibility` that the running harness does
 *   not meet on either half, so the declaration is proven through a real host
 *   parse: a consumer schema that stripped the key would lose exactly those
 *   two lines, whatever the peer badge did. And it declares a harness peer
 *   dsh itself refuses from 0.1.7-rc.1 (`dshPeers`), whose refusal the card
 *   states with its button disabled until the profile exempts it — on the
 *   one card that is incompatible already, so the filter's count below does
 *   not depend on which harness runs.
 * - `dsh-shop-e2e-live` declares only seed words (`react`, `react-dom`), which
 *   the host cannot resolve (they have no package on disk) and the module
 *   table serves. Before 2026-09-24 this was the false alarm on 755 live
 *   entries; now the card must carry no blocker at all.
 *
 * That leaves exactly one incompatible entry on the shelf, so the filter's
 * count and the card it removes are both determinate — and the filter
 * leaving `dsh-shop-e2e-live` in place is itself the seed-word assertion.
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

/** The six fixture entries. No `catalog` section: derived metadata, so the
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
    // Seed words only: node resolution reports both missing, the browser's
    // module table serves both, and the card must say nothing (header).
    peers: ['react', 'react-dom'],
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
    peers: ['@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-llm', '@dsh-shop-e2e/absent-peer'],
    // Unmet on both halves by the harness the e2e boots: no 0.1.5 build
    // satisfies `0.1.2-rc.1`, and the e2e's `web` profile does not compose
    // the `acp` template — a declared profile is judged by the harness's own
    // PROFILE_TEMPLATES bundles, so it has to be a template this harness
    // ships and whose bundles (`dsh-base`, `dsh-acp-app`) the web profile
    // lacks. A name that is no template, `tui` included, would be silence.
    compatibility: { dsh: '0.1.2-rc.1', profiles: ['acp'] },
    // The package's peers on the harness, verbatim, as the registry harvests
    // them: the required `dsh-client-store` and `dsh-llm` (`*`, which every
    // dsh accepts) and an OPTIONAL `@deepseek-ai/dsh` pinned to a release no
    // 0.1 build satisfies. Optional, so `peers` above — required peers only —
    // is unchanged; dsh's installer checks optional peers all the same, so
    // from 0.1.7-rc.1 it refuses this install until the profile exempts it
    // (design 2026-09-26-dsh-017-readiness, B1).
    dshPeers: { '@deepseek-ai/dsh-client-store': '*', '@deepseek-ai/dsh-llm': '*', '@deepseek-ai/dsh': '0.1.2-rc.1' },
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
  {
    // Offered at 2.0.0; the e2e installs 1.0.0 before dsh boots, so the
    // profile manifest's `1.0.0` reads as behind this and the card offers the
    // update the A1 case drives.
    name: 'dsh-shop-e2e-update',
    version: '2.0.0',
    integrity: null,
    publishedAt: '2026-09-26T00:00:00.000Z',
    repository: 'https://github.com/octocat/dsh-shop-e2e-update',
    license: null,
    tier: 'community',
    metadata: 'derived',
    added: '2026-09-26',
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
