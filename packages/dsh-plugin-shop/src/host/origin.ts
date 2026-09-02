/** The transport seam under `loadCatalog` (design §3).
 *
 * An origin answers a cheap probe, then serves the pointer and the files the
 * pointer names. HTTP and npm are interchangeable behind it, so every line of
 * cache and validation logic in `catalog.ts` stays transport-blind. */

/** A failure of the link, not of the content: the wire threw, or answered
 * non-2xx. This is the ONLY class `loadCatalog` retries on another origin.
 * A bad schema, a sha mismatch, or a refused url is an interpretation
 * failure and throws — masking a corrupt origin behind a healthy one is
 * exactly the silent-wrongness this project refuses. */
export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TransportError'
  }
}

export interface OriginHandle {
  readonly id: string
  /** The pointer JSON text. Cheap: the probe has already paid for it. */
  pointer: () => Promise<string>
  /** One file named by the pointer, by the pointer's own raw url string.
   * Callers pass that string verbatim — never a basename, which would strip
   * a hostile absolute url into a fetchable relative one. */
  file: (url: string) => Promise<string>
}

export interface CatalogOrigin {
  readonly id: string
  /** Cheap reachability + identity request. Resolving means this origin can
   * serve; the expensive work happens on the returned handle. */
  probe: (signal: AbortSignal) => Promise<OriginHandle>
}

/** Resolve the pointer's data URL against the catalog base. An absolute URL —
 * any scheme, or a protocol-relative `//host/...` — would hand the pointer a
 * fetch primitive to arbitrary hosts, so it is refused loudly before any
 * fetch (§9.2). The guard is the resolved origin, not the raw string: WHATWG
 * normalization strips leading whitespace and accepts backslash spellings
 * before the string could be inspected, so only comparing the resolved URL's
 * origin to the base's closes every spelling class. */
export function resolveDataUrl(baseUrl: string, url: string): string {
  const resolved = new URL(url, baseUrl)
  if (resolved.origin !== new URL(baseUrl).origin) {
    throw new Error('catalog data url must be relative to the catalog base')
  }
  return resolved.href
}

/** The transport this project has always used: a static `v1/` tree. */
export function httpOrigin(baseUrl: string, fetchImpl: typeof fetch): CatalogOrigin {
  const id = `http:${baseUrl}`
  return {
    id,
    async probe(signal) {
      let response: Response
      try {
        response = await fetchImpl(new URL('index.json', baseUrl).href, { signal })
      } catch (error) {
        // The cause is attached for a debugger, but callers here (and the
        // pre-existing catalog tests) match on `.message` alone — folding the
        // underlying reason in is what keeps "offline" visible after the wrap.
        const detail = error instanceof Error ? error.message : String(error)
        throw new TransportError(`catalog pointer fetch failed for ${id}: ${detail}`, { cause: error })
      }
      if (!response.ok) throw new TransportError(`catalog pointer returned ${response.status}`)
      const pointerText = await response.text()
      return {
        id,
        pointer: async () => pointerText,
        // resolveDataUrl throws a plain Error on a refused url — deliberately
        // NOT a TransportError. A pointer naming another host is a poisoned
        // catalog, not a flaky link, and must not be retried elsewhere.
        file: async (url) => {
          const resolved = resolveDataUrl(baseUrl, url)
          let dataResponse: Response
          try {
            dataResponse = await fetchImpl(resolved)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            throw new TransportError(`catalog data fetch failed for ${id}: ${detail}`, { cause: error })
          }
          if (!dataResponse.ok) throw new TransportError(`catalog data returned ${dataResponse.status}`)
          return dataResponse.text()
        },
      }
    },
  }
}
