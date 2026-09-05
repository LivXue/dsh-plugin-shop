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
  // `null` is legal JSON and reaches here as a parsed manifest, and every
  // property read below throws on it. A function taking `unknown` has to be
  // total for `unknown`; see subpackage-select.test.ts for the outage this
  // otherwise allows any public repository to cause.
  if (typeof manifest !== 'object' || manifest === null) return false
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
  // Same rule as monorepoSignal above: total for `unknown`, never throwing.
  if (typeof manifest !== 'object' || manifest === null) return false
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

/**
 * Convert one `workspaces` entry to a regex anchored at BOTH ends, matched
 * against a subpackage directory path with no trailing slash.
 *
 * The end anchor is the fix: with only a start anchor, `packages/*` also
 * matched `packages/a/lib0`, so seven nested manifests of one package filled
 * the cap of 8 and the repository's real siblings were never probed.
 *
 * `*` matches one path segment, `**` matches one or more — the two forms
 * monorepo declarations use. An entry with no `*` at all is a literal path
 * and becomes its own exact matcher: `workspaces: ['packages/core']` is a
 * real declaration, and dropping it left the repository with no matcher.
 * Anything else (negations, brace expansion, `***`) yields null, and the
 * caller falls back to the convention rather than probing nothing.
 * @param glob - one raw workspaces entry.
 * @returns the matcher, or null when the entry is not a form we support.
 */
function globToRegex(glob: string): RegExp | null {
  const cleaned = glob.replace(/^\.?\//, '').replace(/\/+$/, '')
  if (cleaned === '') return null
  if (cleaned.includes('***') || /[?![\]{}()!]/.test(cleaned)) return null
  const pattern = cleaned
    .split(/(\*\*|\*)/)
    .map(part => (part === '**' ? '.+' : part === '*' ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${pattern}$`)
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
  // Same rule again. A root that is not an object declares no `workspaces`,
  // which is exactly the case the convention glob below already covers, so
  // the guard normalizes it rather than short-circuiting the selection.
  const m = (typeof rootManifest === 'object' && rootManifest !== null
    ? rootManifest
    : {}) as { workspaces?: unknown }
  let globs: string[]
  if (Array.isArray(m.workspaces)) {
    globs = m.workspaces.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  } else if (typeof m.workspaces === 'object' && m.workspaces !== null && Array.isArray((m.workspaces as { packages?: unknown }).packages)) {
    const packages = (m.workspaces as { packages: unknown[] }).packages
    globs = packages.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  } else {
    globs = [CONVENTION_GLOB]
  }
  if (globs.length === 0) globs = [CONVENTION_GLOB]
  let matchers = globs.map(globToRegex).filter((r): r is RegExp => r !== null)
  if (matchers.length === 0) {
    // Every declared entry was a form we do not support. Probing nothing
    // would report the repository `no-bundle` with no probe having happened;
    // the convention is a better guess than silence.
    const fallback = globToRegex(CONVENTION_GLOB)
    matchers = fallback === null ? [] : [fallback]
  }

  const dirs = new Set<string>()
  for (const path of treePaths) {
    if (!path.endsWith('/package.json')) continue
    const dir = path.slice(0, -'/package.json'.length)
    if (dir === '') continue // the root's own manifest is never a subpackage
    if (EXCLUDED_DIRS.test(dir)) continue
    // Matched against the directory itself, with both anchors: matching
    // `${dir}/` against a start-anchored regex is what let a nested manifest
    // satisfy its parent's glob.
    if (!matchers.some(regex => regex.test(dir))) continue
    dirs.add(dir)
  }
  return [...dirs].sort().slice(0, MAX_SUBPACKAGES)
}
