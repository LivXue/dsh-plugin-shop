/**
 * A minimal in-process npm registry for the origin tests: serves the
 * abbreviated `latest` manifest and the tarball it names, with
 * `dist.integrity` computed from the bytes actually served — the same
 * binding a real registry makes.
 *
 * Port 0 → the OS assigns an ephemeral port; the caller reads `registryUrl`
 * and closes the server in teardown.
 */

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface NpmRegistryFixture {
  registryUrl: string
  close: () => Promise<void>
}

/**
 * @param packageName - the package to serve; any other path 404s.
 * @param version - the version `latest` resolves to.
 * @param tarball - a real gzipped tar, e.g. from `npm pack`.
 */
export async function startNpmRegistry(
  packageName: string,
  version: string,
  tarball: Buffer,
): Promise<NpmRegistryFixture> {
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  let registryUrl = ''
  const server: Server = createServer((request, response) => {
    const path = request.url ?? '/'
    if (path === `/${packageName}/latest`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        name: packageName,
        version,
        dist: { tarball: `${registryUrl}${packageName}/-/${packageName}-${version}.tgz`, integrity },
      }))
      return
    }
    if (path === `/${packageName}/-/${packageName}-${version}.tgz`) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(tarball)
      return
    }
    response.writeHead(404).end('not found')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  registryUrl = `http://127.0.0.1:${port}/`
  return {
    registryUrl,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}
