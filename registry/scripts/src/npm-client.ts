import type { Candidate } from './types.ts'

/**
 * The keyword a plugin author declares. Ecosystem-neutral by design: an author
 * declares "I am a dsh plugin", not membership of this store.
 */
export const HARVEST_KEYWORD = 'dsh-plugin'

const REGISTRY = 'https://registry.npmjs.org'
const PAGE_SIZE = 250

/** Normalize an npm repository field to a plain https URL. */
function normalizeRepository(value: unknown): string | null {
  const url = typeof value === 'string'
    ? value
    : typeof (value as { url?: unknown } | null)?.url === 'string'
      ? (value as { url: string }).url
      : null
  if (url === null) return null
  return url.replace(/^git\+/, '').replace(/\.git$/, '')
}

/**
 * Project one npm packument into a candidate.
 * @param packument - the parsed registry document for one package.
 * @returns the candidate, or null when the document names no usable latest version.
 */
export function toCandidate(packument: unknown): Candidate | null {
  const doc = packument as {
    name?: unknown
    'dist-tags'?: { latest?: unknown }
    time?: Record<string, unknown>
    versions?: Record<string, {
      dist?: { integrity?: unknown }
      license?: unknown
      repository?: unknown
      deprecated?: unknown
      dsh?: { bundle?: unknown; catalog?: unknown }
    }>
  }
  const name = doc.name
  const version = doc['dist-tags']?.latest
  if (typeof name !== 'string' || typeof version !== 'string') return null
  const manifest = doc.versions?.[version]
  if (manifest === undefined) return null
  const publishedAt = doc.time?.[version]
  return {
    name,
    version,
    integrity: typeof manifest.dist?.integrity === 'string' ? manifest.dist.integrity : null,
    publishedAt: typeof publishedAt === 'string' ? publishedAt : null,
    repository: normalizeRepository(manifest.repository),
    license: typeof manifest.license === 'string' ? manifest.license : null,
    deprecated: manifest.deprecated !== undefined,
    hasBundle: manifest.dsh?.bundle !== undefined,
    catalog: manifest.dsh?.catalog ?? null,
  }
}

/**
 * List every package name carrying the harvest keyword.
 *
 * Harvesting by keyword rather than by name pattern is deliberate: a name
 * pattern is trivially spoofed.
 * @param fetchImpl - the fetch implementation, injected for testing.
 * @returns every matching package name, in registry order.
 * @throws when the registry answers with a non-OK status.
 */
export async function searchByKeyword(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const names: string[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const url = `${REGISTRY}/-/v1/search?text=keywords:${HARVEST_KEYWORD}&size=${PAGE_SIZE}&from=${from}`
    const response = await fetchImpl(url)
    if (!response.ok) throw new Error(`npm search failed: ${response.status}`)
    const body = await response.json() as { objects?: { package?: { name?: unknown } }[] }
    const objects = body.objects ?? []
    for (const object of objects) {
      if (typeof object.package?.name === 'string') names.push(object.package.name)
    }
    if (objects.length < PAGE_SIZE) return names
  }
}

/**
 * Fetch one package's full packument and project it into a candidate.
 * @param name - the package name.
 * @param fetchImpl - the fetch implementation, injected for testing.
 * @returns the candidate, or null when the package is unreadable or has no usable latest version.
 */
export async function fetchCandidate(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Candidate | null> {
  const response = await fetchImpl(`${REGISTRY}/${encodeURIComponent(name)}`)
  if (!response.ok) return null
  return toCandidate(await response.json())
}
