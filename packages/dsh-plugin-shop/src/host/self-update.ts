/** Self-update version check: the shop's latest published version, from the
 * npm packument. Advisory by design — like the stars sidecar, a failed
 * check degrades to `null` and never throws, never blocks a publish. The
 * catalog cannot serve here: the shop is bootstrap-installed and is not
 * harvested into its own catalog. */

/** The npm package the shop itself is published as. */
const SHOP_PACKAGE = 'dsh-plugin-shop'

/** The registry that always gets asked, last. */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

/** How long one registry gets to answer. `shop/version` is warmed at every
 * web boot, so a silent socket must not hold the boot indefinitely. */
export const VERSION_CHECK_TIMEOUT_MS = 5000

/** Ask one registry. Any failure — network, non-2xx, unexpected payload,
 * deadline — is the same outcome: no answer from this registry. */
async function askRegistry(
  fetchFn: typeof fetch,
  registry: string,
  timeoutMs: number,
): Promise<string | null> {
  const url = `${registry}${SHOP_PACKAGE}`
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    // The signal is handed to fetch and raced, so the bound also holds for an
    // injected dispatcher that ignores AbortSignal.
    const response = await Promise.race([
      fetchFn(url, { signal }),
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error(`the version check did not answer within ${timeoutMs} ms`))
        }, { once: true })
      }),
    ])
    if (!response.ok) return null
    const packument = await response.json() as { 'dist-tags'?: { latest?: unknown } }
    const latest = packument['dist-tags']?.latest
    return typeof latest === 'string' ? latest : null
  } catch {
    return null
  }
}

/**
 * Fetch the shop's `latest` dist-tag, or `null` when no registry can answer.
 * The user's own registry is tried first when known; npmjs is always the
 * fallback so a mirror that lags cannot hide a release.
 */
export async function fetchLatestVersion(
  fetchFn: typeof fetch = fetch,
  options: { registry?: string | null; timeoutMs?: number } = {},
): Promise<string | null> {
  const { registry = null, timeoutMs = VERSION_CHECK_TIMEOUT_MS } = options
  const asked = new Set<string>()
  const registries = registry === null ? [DEFAULT_REGISTRY] : [registry, DEFAULT_REGISTRY]
  for (const base of registries) {
    const normalized = base.endsWith('/') ? base : `${base}/`
    if (asked.has(normalized)) continue
    asked.add(normalized)
    const latest = await askRegistry(fetchFn, normalized, timeoutMs)
    if (latest !== null) return latest
  }
  return null
}
