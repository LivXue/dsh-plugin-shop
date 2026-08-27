/** Self-update version check: the shop's latest published version, from the
 * npm packument. Advisory by design — like the stars sidecar, a failed
 * check degrades to `null` and never throws, never blocks a publish. The
 * catalog cannot serve here: the shop is bootstrap-installed and is not
 * harvested into its own catalog. */

/** The npm package the shop itself is published as. */
const SHOP_PACKAGE = 'dsh-plugin-shop'

/** Fetch the shop's `latest` dist-tag, or `null` when the registry cannot
 * answer (network failure, unexpected payload — anything). The caller
 * renders `null` as "no update check", never as a failure. */
export async function fetchLatestVersion(
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchFn(`https://registry.npmjs.org/${SHOP_PACKAGE}`)
    if (!response.ok) return null
    const packument = await response.json() as { 'dist-tags'?: { latest?: unknown } }
    const latest = packument['dist-tags']?.latest
    return typeof latest === 'string' ? latest : null
  } catch {
    // Any fetch or parse failure is the same outcome: no answer, not an
    // error — the version row simply shows the installed version alone.
    return null
  }
}
