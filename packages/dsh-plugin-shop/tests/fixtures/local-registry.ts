/**
 * A minimal in-process npm registry for the hot-mount e2e: serves packuments
 * and tarballs for the live fixture packages (packed once with `npm pack`
 * at startup) and PROXIES every other name to the real npm registry — a
 * fixture install re-resolves the profile's whole dependency tree, so the
 * shop's own deps (js-yaml, semver, zod) must resolve too. The e2e points
 * the profile's `.npmrc` at this registry — pnpm, unlike npm, never reads
 * the registry from env vars, so the project config is the only lever — and
 * the gateway-spawned `dsh plugin add <name>@<version>` resolves fixture
 * installs locally; the beforeAll `file:` installs keep the real registry.
 *
 * The 404 for an unknown name survives the proxy: the failed-install
 * scenario installs a name that is not on npm either, so pnpm fails in the
 * profile with real stderr — the same terminal state the spec asserts, now
 * arriving through the local registry.
 *
 * The packument is the minimal shape pnpm accepts: `dist-tags.latest` plus a
 * `versions` map whose entry carries `dist.tarball` / `shasum` / `integrity`
 * taken from the `npm pack --json` output, so the bytes served are the exact
 * packed tarball.
 */

import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface LocalRegistry {
  /** Registry base, e.g. `http://127.0.0.1:<port>/` — pnpm appends the
   * package name. */
  baseUrl: string
  close: () => Promise<void>
}

interface PackedFixture {
  name: string
  version: string
  filename: string
  shasum: string
  integrity: string
  tarball: Buffer
}

function packFixture(root: string, dir: string): PackedFixture {
  const result = spawnSync('npm', ['pack', '--json', '--pack-destination', root, dir], {
    stdio: 'pipe',
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`npm pack failed for ${dir}:\n${result.stderr ?? result.stdout}`)
  }
  const [summary] = JSON.parse(result.stdout) as Array<{
    name: string
    version: string
    filename: string
    shasum: string
    integrity: string
  }>
  if (summary === undefined) {
    throw new Error(`npm pack produced no summary for ${dir}`)
  }
  return {
    name: summary.name,
    version: summary.version,
    filename: summary.filename,
    shasum: summary.shasum,
    integrity: summary.integrity,
    tarball: readFileSync(join(root, summary.filename)),
  }
}

/** The minimal packument pnpm accepts for `name@version` resolution. */
function packument(fixture: PackedFixture, baseUrl: string): string {
  const version = {
    name: fixture.name,
    version: fixture.version,
    dist: {
      tarball: `${baseUrl}${fixture.name}/-/${fixture.filename}`,
      shasum: fixture.shasum,
      integrity: fixture.integrity,
    },
  }
  return JSON.stringify({
    name: fixture.name,
    'dist-tags': { latest: fixture.version },
    versions: { [fixture.version]: version },
  })
}

/** The upstream every unknown name is proxied to. */
const NPMJS = 'https://registry.npmjs.org'

export async function startLocalRegistry(fixtureDirs: string[]): Promise<LocalRegistry> {
  // One scratch root holds the packed tarballs for the server's lifetime;
  // teardown removes it with the fixture dirs.
  const root = mkdtempSync(join(tmpdir(), 'dsh-registry-'))
  const fixtures = fixtureDirs.map(dir => packFixture(root, dir))
  const byName = new Map(fixtures.map(fixture => [fixture.name, fixture] as const))

  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? ''
    const segments = url.split('/')
    // `/<name>` → packument; `/<name>/-/<filename>` → tarball; anything else
    // — the rest of the profile's dependency tree, and the failed-install
    // scenario's unknown name — goes to the real registry (where that name
    // 404s too, so the failure mode is unchanged).
    const name = segments[1]
    if (name !== undefined) {
      const fixture = byName.get(name)
      if (fixture !== undefined && segments.length === 2) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(packument(fixture, serverBase))
        return
      }
      if (fixture !== undefined && segments[2] === '-' && segments[3] === fixture.filename) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(fixture.tarball)
        return
      }
    }
    try {
      const upstream = await fetch(`${NPMJS}${url}`, {
        headers: { accept: req.headers.accept ?? 'application/json' },
      })
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      })
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (error) {
      // The upstream is unreachable — fail the request loudly rather than
      // answer with a plausible empty registry.
      res.writeHead(502).end(`local-registry: upstream fetch failed: ${String(error)}`)
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const serverBase = `http://127.0.0.1:${port}/`
  return {
    baseUrl: serverBase,
    close: () => new Promise<void>((resolve, reject) => {
      // Drop every connection first: pnpm's fetch pool keeps keep-alive
      // sockets to this server open, and a bare close() would wait on them
      // forever even after the gateway process is dead.
      server.closeAllConnections()
      server.close(error => {
        if (error !== undefined) {
          reject(error)
          return
        }
        rmSync(root, { recursive: true, force: true })
        resolve()
      })
    }),
  }
}
