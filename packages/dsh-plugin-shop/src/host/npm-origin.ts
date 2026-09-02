/** The npm transport (design §2, §3): the catalog as a package.
 *
 * Shell — this and `origin.ts`'s fetch half are the only places the catalog
 * loader touches the network. The payoff is measured, not assumed: the same
 * bytes reach a China-side machine at 12.53 MB/s from npmmirror against
 * 0.03 MB/s from GitHub Pages. */

import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { z } from 'zod'
import { readTar } from './tar.ts'
import { type CatalogOrigin, type OriginHandle, TransportError } from './origin.ts'

/** The abbreviated `latest` manifest. Non-strict: a registry may add keys,
 * and stripping them is what keeps an old host working against a new one. */
const latestSchema = z.object({
  version: z.string(),
  dist: z.object({ tarball: z.string(), integrity: z.string() }),
})

/** Where the published package keeps the catalog tree (design §2). */
const PACKAGE_ROOT = 'package/v1/'

/** Verify tarball bytes against npm's own Subresource-Integrity string.
 * `dist.integrity` may carry several space-separated digests; npm publishes
 * one, and the first is the one we check. */
function verifyIntegrity(bytes: Buffer, integrity: string): void {
  const first = integrity.trim().split(/\s+/)[0] ?? ''
  const dash = first.indexOf('-')
  const algorithm = dash === -1 ? '' : first.slice(0, dash)
  const expected = dash === -1 ? '' : first.slice(dash + 1)
  if (algorithm !== 'sha512' && algorithm !== 'sha256') {
    throw new Error(`npm origin: unsupported dist.integrity algorithm ${JSON.stringify(algorithm)}`)
  }
  const actual = createHash(algorithm).update(bytes).digest('base64')
  if (actual !== expected) {
    throw new Error(`npm origin: tarball failed dist.integrity check (${algorithm})`)
  }
}

/**
 * An origin that reads the catalog out of `<registryUrl>`'s copy of
 * `<packageName>`.
 *
 * The probe is the abbreviated `latest` manifest — 13.5 KB against the live
 * registry — so the race is decided without downloading anything large. The
 * tarball is fetched lazily on the first `pointer()` or `file()` and kept on
 * the handle, so one origin download serves the whole load.
 */
export function npmOrigin(registryUrl: string, packageName: string, fetchImpl: typeof fetch): CatalogOrigin {
  const id = `npm:${registryUrl}`
  return {
    id,
    async probe(signal): Promise<OriginHandle> {
      const url = new URL(`${encodeURIComponent(packageName)}/latest`, registryUrl).href
      let response: Response
      try {
        response = await fetchImpl(url, { signal })
      } catch (error) {
        // Fold the cause's message into the text, as httpOrigin does: the
        // cause is for a debugger, but a person reading why their shop will
        // not open sees `.message` and nothing else.
        const detail = error instanceof Error ? error.message : String(error)
        throw new TransportError(`npm origin ${registryUrl} probe failed: ${detail}`, { cause: error })
      }
      if (!response.ok) throw new TransportError(`npm origin ${registryUrl} returned ${response.status}`)
      const manifest = latestSchema.parse(await response.json())

      let files: Map<string, Buffer> | null = null
      const load = async (): Promise<Map<string, Buffer>> => {
        if (files !== null) return files
        // A registry that serves its tarballs from somewhere else is refused
        // rather than followed. npmmirror rewrites dist.tarball to its own
        // host, so the mirrors this design targets pass; an origin that does
        // not simply loses the race, which costs the reader nothing.
        const tarballUrl = new URL(manifest.dist.tarball)
        if (tarballUrl.origin !== new URL(registryUrl).origin) {
          throw new Error(`npm origin: dist.tarball host ${tarballUrl.origin} is not the registry's`)
        }
        let tarballResponse: Response
        try {
          tarballResponse = await fetchImpl(tarballUrl.href)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new TransportError(`npm origin ${registryUrl} tarball fetch failed: ${detail}`, { cause: error })
        }
        if (!tarballResponse.ok) {
          throw new TransportError(`npm origin tarball returned ${tarballResponse.status}`)
        }
        const bytes = Buffer.from(await tarballResponse.arrayBuffer())
        verifyIntegrity(bytes, manifest.dist.integrity)
        files = readTar(gunzipSync(bytes))
        return files
      }

      const read = async (name: string): Promise<string> => {
        const entry = (await load()).get(`${PACKAGE_ROOT}${name}`)
        if (entry === undefined) throw new Error(`npm origin: ${name} is not in the catalog package`)
        return entry.toString('utf8')
      }

      return {
        id,
        pointer: async () => read('index.json'),
        // The pointer's url is a bare file name in every catalog this project
        // publishes. Anything else — a path, an absolute url — is refused
        // rather than resolved, the npm-side equivalent of resolveDataUrl's
        // cross-origin guard.
        file: async (url) => {
          if (url.includes('/') || url.startsWith('.')) {
            throw new Error(`npm origin: ${JSON.stringify(url)} must be a plain file name`)
          }
          return read(url)
        },
      }
    },
  }
}
