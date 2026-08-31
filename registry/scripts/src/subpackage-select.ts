/**
 * The pure half of the monorepo-subpackage borrowing (A): which repositories
 * deserve a subpackage probe, which tree paths are probed, and whether a
 * manifest's dependencies can resolve outside the repo's workspace. The
 * fetching lives in `github-client.ts`; the policy here is what fixtures
 * drive.
 * @module subpackage-select
 */

/** Upper bound on subpackage manifests probed per repository — the probe's
 * quota cost grows linearly with this number. */
export const MAX_SUBPACKAGES = 8

/**
 * Whether a root manifest signals a monorepo worth probing. `private: true`
 * roots are publish-only containers (the hub's aggregate class); a
 * `workspaces` declaration is the pnpm/npm/yarn form. A plain public
 * package without a bundle is just not a plugin — probing its tree would
 * only burn quota.
 */
export function monorepoSignal(manifest: unknown): boolean {
  const m = manifest as { private?: unknown; workspaces?: unknown }
  return m.private === true || m.workspaces !== undefined
}

/** One dependency-holding section of a manifest. */
type DepsSection = Record<string, unknown>

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

/**
 * Whether the manifest declares any `workspace:`-protocol dependency. Those
 * resolve only inside the repository's own workspace, so a git install from
 * outside it cannot succeed (measured: pnpm fails with
 * WORKSPACE_PKG_NOT_FOUND).
 */
export function hasWorkspaceDeps(manifest: unknown): boolean {
  const m = manifest as Record<string, unknown>
  for (const section of DEP_SECTIONS) {
    const deps = m[section]
    if (typeof deps !== 'object' || deps === null) continue
    for (const value of Object.values(deps as DepsSection)) {
      if (typeof value === 'string' && /^workspace:/.test(value)) return true
    }
  }
  return false
}

/** Convert one workspaces glob to an anchored regex. Supports the `*` forms
 * actually used in monorepo declarations; anything else matches nothing. */
function globToRegex(glob: string): RegExp | null {
  const escaped = glob
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+')
  if (!/^\.?\/?[^*]*\*[^*]*$/.test(glob)) return null
  return new RegExp(`^${escaped.replace(/^\.\//, '')}`)
}

/** The convention fallback when no workspaces declaration exists. */
const CONVENTION_GLOB = 'packages/*'

/** Directories that are never plugins, however the globs match. */
const EXCLUDED_DIRS = /(^|\/)(node_modules|examples?|docs?|demo|test|tests|scripts|fixtures?)(\/|$)/

/**
 * Select the subpackage directories to probe from a repository's tree
 * listing. Preference: the root manifest's `workspaces` globs (array form,
 * or the `packages` object form); otherwise the `packages/*` convention.
 * Each selected path is a `package.json` location; the returned value is
 * its parent directory, sorted for determinism and capped at
 * {@link MAX_SUBPACKAGES}.
 * @param rootManifest - the parsed root package.json (workspaces read here).
 * @param treePaths - every `package.json` path in the tree listing.
 */
export function selectSubpackagePaths(rootManifest: unknown, treePaths: string[]): string[] {
  const m = rootManifest as { workspaces?: unknown }
  let globs: string[]
  if (Array.isArray(m.workspaces)) {
    globs = m.workspaces.filter((entry): entry is string => typeof entry === 'string' && entry.includes('*'))
  } else if (typeof m.workspaces === 'object' && m.workspaces !== null && Array.isArray((m.workspaces as { packages?: unknown }).packages)) {
    const packages = (m.workspaces as { packages: unknown[] }).packages
    globs = packages.filter((entry): entry is string => typeof entry === 'string' && entry.includes('*'))
  } else {
    globs = [CONVENTION_GLOB]
  }
  if (globs.length === 0) globs = [CONVENTION_GLOB]
  const matchers = globs.map(globToRegex).filter((r): r is RegExp => r !== null)

  const dirs = new Set<string>()
  for (const path of treePaths) {
    if (!path.endsWith('/package.json')) continue
    const dir = path.slice(0, -'/package.json'.length)
    if (dir === '') continue // the root's own manifest is never a subpackage
    if (EXCLUDED_DIRS.test(dir)) continue
    if (!matchers.some(regex => regex.test(`${dir}/`))) continue
    dirs.add(dir)
  }
  return [...dirs].sort().slice(0, MAX_SUBPACKAGES)
}
