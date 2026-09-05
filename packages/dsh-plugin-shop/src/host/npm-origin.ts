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
import { MAX_BODY_BYTES, readCappedBytes, type CatalogOrigin, type OriginHandle, TransportError } from './origin.ts'

/** The abbreviated `latest` manifest. Non-strict: a registry may add keys,
 * and stripping them is what keeps an old host working against a new one. */
const latestSchema = z.object({
  version: z.string(),
  dist: z.object({ tarball: z.string(), integrity: z.string() }),
})

/** Where the published package keeps the catalog tree (design §2). */
const PACKAGE_ROOT = 'package/v1/'

/** Maximum compressed package bytes read from a registry. */
export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024

/** Maximum bytes allowed after gzip inflation. */
export const MAX_INFLATED_BYTES = MAX_BODY_BYTES

/** Verify tarball bytes against npm's own Subresource-Integrity string.
 * `dist.integrity` may carry several space-separated digests; npm publishes
 * one, and the first is the one we check. */
function verifyIntegrity(bytes: Buffer, integrity: string, registryUrl: string): void {
  const first = integrity.trim().split(/\s+/)[0] ?? ''
  const dash = first.indexOf('-')
  const algorithm = dash === -1 ? '' : first.slice(0, dash)
  const expected = dash === -1 ? '' : first.slice(dash + 1)
  // Both failures below disqualify the mirror rather than fail the load, for
  // the same reason: `dist.integrity` is the digest the REGISTRY computed over
  // the REGISTRY's own tarball, published in its own manifest. It is not an
  // independent signature the Host holds, so neither branch can speak to
  // whether the catalog is genuine — a mirror set on serving a forgery would
  // publish a digest over the forgery and sail past both.
  if (algorithm !== 'sha512' && algorithm !== 'sha256') {
    throw new TransportError(
      `npm origin ${registryUrl}: unsupported dist.integrity algorithm ${JSON.stringify(algorithm)}`,
    )
  }
  const actual = createHash(algorithm).update(bytes).digest('base64')
  if (actual !== expected) {
    // The mirror's manifest and the mirror's tarball disagree with each other.
    // That is a statement about this mirror, not about the content: the same
    // statement as an unparsable manifest or a tarball that is not gzip.
    // Loud here cost more than it bought — running before the gunzip, it was
    // the FIRST thing tripped by a mirror serving anything unexpected, so one
    // broken mirror closed a shop two healthy origins could have opened.
    throw new TransportError(
      `npm origin ${registryUrl}: tarball failed dist.integrity check (${algorithm})`,
    )
  }
}

/** Normalise to a trailing slash so relative `URL` resolution against a
 * registry that carries a path — every corporate registry, e.g.
 * `https://artifactory.corp/api/npm/npm-repo` — keeps that path instead of
 * eating its last segment; a host-root registry's trailing slash is already
 * a no-op either way. Exported so `catalog.ts`'s dedupe compares against the
 * same normalised form `npmOrigin` races on. */
export function normalizeRegistryUrl(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
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
export function npmOrigin(rawRegistryUrl: string, packageName: string, fetchImpl: typeof fetch): CatalogOrigin {
  const registryUrl = normalizeRegistryUrl(rawRegistryUrl)
  const id = `npm:${registryUrl}`
  return {
    id,
    async probe(signal): Promise<OriginHandle> {
      // Defence in depth behind `npmrc.ts`'s validation, which is where a
      // user's own `registry=` line is now rejected if it is not an absolute
      // http(s) URL. Unguarded, `new URL` throws a raw TypeError for a bare
      // host, a relative path, or npm's unexpanded `${VAR}` syntax — and
      // catalog.ts's race loop rethrows anything that is not a
      // TransportError, so one unusable registry from any future caller
      // would fail the whole load with every other origin healthy. A
      // registry this origin cannot even address is this origin
      // disqualifying itself, exactly like an unparsable manifest below.
      let url: string
      try {
        url = new URL(`${encodeURIComponent(packageName)}/latest`, registryUrl).href
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new TransportError(`npm origin ${registryUrl} is not a usable registry url: ${detail}`, { cause: error })
      }
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
      // npm itself generates the abbreviated manifest; the only way a 2xx
      // body fails to parse as one is that whatever answered is not actually
      // npm — a broken mirror, or a corporate proxy's login page on a
      // registry URL a user's own .npmrc pointed us at. That is a
      // transport-layer disqualification ("this does not speak the
      // protocol"), not corrupt catalog content, so it falls through to the
      // next origin instead of failing the whole load. Contrast
      // verifyIntegrity below: a sha mismatch says these ARE npm's bytes and
      // they do not match, which must stay a loud, non-retried throw.
      let manifest: z.infer<typeof latestSchema>
      try {
        manifest = latestSchema.parse(await response.json())
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new TransportError(`npm origin ${registryUrl} returned an unparsable manifest: ${detail}`, { cause: error })
      }

      let files: Map<string, Buffer> | null = null
      const load = async (loadSignal?: AbortSignal): Promise<Map<string, Buffer>> => {
        if (files !== null) return files
        // A registry that serves its tarballs from somewhere else is refused
        // rather than followed. npmmirror rewrites dist.tarball to its own
        // host, so the mirrors this design targets pass. Declining to follow
        // a foreign tarball host is a property of the ORIGIN, not of our
        // content — nothing has been fetched yet to be suspicious of — so
        // this is a transport-layer disqualification, exactly like an
        // unparsable manifest, and must fall through to the next origin
        // rather than fail the whole load. Not hypothetical:
        // registry.npm.taobao.org, still named in countless ~/.npmrc files,
        // redirects to registry.npmmirror.com and answers with npmmirror's
        // own tarball host — an origin that wins races on measured speed and
        // must not then kill the load.
        let tarballUrl: URL
        try {
          tarballUrl = new URL(manifest.dist.tarball)
        } catch (error) {
          // latestSchema admits any string for dist.tarball, so a mirror
          // answering 200 with junk-but-schema-valid JSON reaches here with
          // something that is not a URL at all.
          const detail = error instanceof Error ? error.message : String(error)
          throw new TransportError(`npm origin ${registryUrl}: dist.tarball is not a valid url: ${detail}`, { cause: error })
        }
        if (tarballUrl.origin !== new URL(registryUrl).origin) {
          throw new TransportError(`npm origin ${registryUrl}: dist.tarball host ${tarballUrl.origin} is not the registry's`)
        }
        let tarballResponse: Response
        try {
          tarballResponse = await fetchImpl(tarballUrl.href, loadSignal === undefined ? undefined : { signal: loadSignal })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new TransportError(`npm origin ${registryUrl} tarball fetch failed: ${detail}`, { cause: error })
        }
        if (!tarballResponse.ok) {
          throw new TransportError(`npm origin ${registryUrl} tarball returned ${tarballResponse.status}`)
        }
        const declaredLength = Number(tarballResponse.headers.get('content-length'))
        if (Number.isFinite(declaredLength) && declaredLength > MAX_PACKAGE_BYTES) {
          throw new TransportError(`npm origin ${registryUrl} tarball exceeded the ${MAX_PACKAGE_BYTES}-byte cap`)
        }
        // Stream through the wire cap; arrayBuffer() would hold an
        // attacker-controlled body in full before any bound could apply.
        const bytes = await readCappedBytes(
          tarballResponse,
          `npm origin ${registryUrl} tarball`,
          MAX_PACKAGE_BYTES,
        )
        // Deliberately OUTSIDE the try below. A sha MISMATCH says "these
        // bytes are not what they claim" — a claim about content — and stays
        // a loud, non-retried plain Error (§4). What follows is a different
        // statement about a different subject.
        verifyIntegrity(bytes, manifest.dist.integrity, registryUrl)
        // An unparsable TARBALL is the same statement about the same mirror
        // as an unparsable manifest above: it does not speak the protocol.
        // `gunzipSync` throws a plain Error (Z_DATA_ERROR) on non-gzip
        // bytes, and `readTar` throws plain Errors on an unparseable size
        // field or a path escaping the archive root — all of which escape
        // catalog.ts's race loop as written. tar.ts's "refuses everything
        // else loudly" was decided when the tarball came from one trusted
        // publisher; it now arrives from a raced mirror, so loud has to mean
        // "disqualify this mirror", not "fail the load with three healthy
        // origins standing".
        let parsed: Map<string, Buffer>
        try {
          parsed = readTar(gunzipSync(bytes, { maxOutputLength: MAX_INFLATED_BYTES }))
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ERR_BUFFER_TOO_LARGE' || /larger than|too large/i.test(detail)) {
            throw new TransportError(
              `npm origin ${registryUrl}: the tarball inflates past the ${MAX_INFLATED_BYTES}-byte cap; refusing to read it`,
              { cause: error },
            )
          }
          throw new TransportError(`npm origin ${registryUrl} served an unparsable tarball: ${detail}`, { cause: error })
        }
        files = parsed
        return files
      }

      const read = async (name: string, readSignal?: AbortSignal): Promise<string> => {
        const entry = (await load(readSignal)).get(`${PACKAGE_ROOT}${name}`)
        // A file the pointer or the package itself should carry, but does
        // not — a tarball published without v1/, a version skew between the
        // pointer and the package — is this mirror failing to speak the
        // protocol, not corrupt catalog content. It falls through to
        // another origin when this is the pointer read, or degrades to the
        // cache when it is a data file read, the same posture httpOrigin
        // already takes on a 404.
        if (entry === undefined) {
          throw new TransportError(`npm origin ${registryUrl}: ${name} is not in the catalog package`)
        }
        return entry.toString('utf8')
      }

      return {
        id,
        pointer: async () => read('index.json'),
        // The pointer's url is a bare file name in every catalog this project
        // publishes. Anything else — a path, an absolute url — is refused
        // rather than resolved, the npm-side equivalent of resolveDataUrl's
        // cross-origin guard.
        file: async (url, fileSignal) => {
          if (url.includes('/') || url.startsWith('.')) {
            throw new Error(`npm origin ${registryUrl}: ${JSON.stringify(url)} must be a plain file name`)
          }
          return read(url, fileSignal)
        },
      }
    },
  }
}
