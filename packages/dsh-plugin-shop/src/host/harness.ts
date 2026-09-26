/**
 * The harness this process runs: which `@deepseek-ai/dsh` it is, and that
 * dsh's own profile-template table — the running side of the
 * `dsh.compatibility` verdict (design 2026-09-01-harness-compatibility §9.9).
 *
 * Both used to be read from somewhere that is not the running harness, and
 * both were wrong there:
 *
 * - The version was the first `node_modules/@deepseek-ai/dsh` found walking up
 *   from the profile: what the profile can IMPORT, not what RUNS. A plugin
 *   that depends on the dsh package gets its copy hoisted into
 *   `<profile>/node_modules` — the listed `dsh-claude-tui@0.1.6` pulls
 *   0.1.2-rc.1 — a second install sharing DSH_HOME re-points the link farm,
 *   and under a packaged dsh the bin-only package gets no link-farm proxy at
 *   all, so the read was dead or stale. The first was reproduced with real
 *   installs on 2026-09-25 (the design's section 9.9 amendment): every
 *   verdict said "running 0.1.2-rc.1" while 0.1.5-rc.3 ran.
 * - The templates came from the shop's own `import * as appBoot`, which
 *   resolves from the SHOP's real path: under a `link:` install that is this
 *   repository's devDependency, 0.1.1-rc.2 with two templates, while
 *   0.1.5-rc.3 with five runs — and in production a copy hoisted from some
 *   plugin's dependencies can shadow it the same way.
 *
 * Both now come from the one thing that names the running harness: the script
 * this process was started with. Resolved through symlinks, the package that
 * owns it IS the dsh CLI that is running, if it is one at all; its manifest
 * says its version, and the app-boot it imports says its templates.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { profileTemplatesOf, type ProfileTemplates } from './compatibility.ts'
import { DSH_PACKAGE } from './dsh-cli.ts'
import { packageDirectory } from './peers.ts'

/** The package whose `PROFILE_TEMPLATES` the running dsh composes profiles
 * from. */
const APP_BOOT = '@deepseek-ai/dsh-app-boot'

/** One package's harness peers as the running dsh judges them: app-boot's
 * `evaluatePluginCompatibility` result, the shape 0.1.7 returns. */
export interface PeerIssue {
  name: string
  version: string
  /** The dsh version the check judged against — app-boot's own. */
  runtimeVersion: string
  /** The refused peers, each with the range the package declared. */
  peers: Record<string, string>
  /** Whether the profile holds dsh's exact-version exemption for this
   * package on this dsh, in which case dsh accepts the install anyway. */
  exempted: boolean
}

/** The running dsh's own install-time check (app-boot, from 0.1.7): the rule
 * it refuses an install by, and the exemptions a profile holds. Taken from the
 * dsh that runs rather than reimplemented, so a verdict cannot drift from the
 * refusal it predicts (design 2026-09-26-dsh-017-readiness, B1). */
export interface PeerCheck {
  /** `evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)` with
   * app-boot's own version as the runtime — the version dsh's installer
   * judges by, since it passes none and the default reads app-boot's
   * manifest. That version is read once, here, rather than per call: the
   * default re-reads the file on every call, which measured 75 ms against
   * 12 ms for 2,000 manifests on 0.1.7-rc.2. The incompatible harness peers
   * of one manifest, or undefined when there are none. Throws for a manifest
   * it cannot judge. */
  evaluate(manifest: { name: string; version: string; peerDependencies: Record<string, string> }, exemptions: Record<string, string[]>): PeerIssue | undefined
  /** `readProfileVersionExemptions(profileDir)`: exact `name@version` keys
   * mapped to the dsh versions each is exempted on. */
  exemptions(profileDir: string): Record<string, string[]>
}

/** The running side of the `dsh.compatibility` verdict. The gateway reads it
 * once and keeps it: a running process cannot change which dsh it is. */
export interface RunningHarness {
  /** The running dsh's own `version`, or null when this process was not
   * started by dsh's CLI or its manifest carries no non-empty string there.
   * Whether it is semver is `compatibilityMap`'s question. */
  dshVersion: string | null
  /** That dsh's own `PROFILE_TEMPLATES`, normalized by `profileTemplatesOf`;
   * empty whenever the table could not be read. */
  templates: ProfileTemplates
  /** Whether that dsh reads a LIST-valued `dsh.bundle.patch`: its app-boot
   * exports `bundlePatchFiles`, which 0.1.7 does and 0.1.5 does not. A dsh
   * without it joins the declaration onto a path, so a package declaring a
   * list stops the profile from starting (design 2026-09-26-dsh-017-readiness,
   * B4). Null whenever the app-boot could not be read — unknown, which forms
   * no verdict. */
  patchLists: boolean | null
  /** That dsh's own install-time peer check, or null when its app-boot
   * exports none (before 0.1.7, which refuses no install on peers) or could
   * not be read — no verdict either way. */
  peerCheck: PeerCheck | null
}

/** What is known when nothing says which harness runs. */
function noHarness(): RunningHarness {
  return { dshVersion: null, templates: profileTemplatesOf(undefined), patchLists: null, peerCheck: null }
}

/** Whether `path` stats as a regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    // Swallows any stat failure: a `package.json` nobody can stat is not a
    // manifest the walk can stop at, so the walk moves on — the same answer
    // as a directory that holds none. Nothing else is read here.
    return false
  }
}

/**
 * The package that owns `start`: the FIRST directory at or above it holding a
 * `package.json` file, and its parsed manifest — or null when there is none
 * up to the root, or when that manifest cannot be read or parsed. The walk
 * stops at the first manifest whatever it names, the rule `owningEntry` in
 * `dsh-cli.ts` follows: a script owned by some other package is not dsh's,
 * and climbing on would find an unrelated ancestor — a workspace root, or dsh
 * itself above a package vendored inside it.
 */
function owningPackage(start: string): { dir: string; manifest: unknown } | null {
  for (let dir = start; ;) {
    const manifestPath = join(dir, 'package.json')
    if (isFile(manifestPath)) {
      try {
        return { dir, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) }
      } catch {
        // Swallows an owning manifest that cannot be read or parsed: the
        // script's owner is then unknown, which is no harness — never a
        // reason to keep climbing to an ancestor that owns nothing here.
        return null
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * What the app-boot the dsh at `dshDir` imports says about that dsh: its
 * template table, and whether it reads a list-valued bundle patch. Null when
 * no app-boot is on the resolution path.
 *
 * Found with the node_modules walk the peer check uses (`packageDirectory`)
 * from the dsh package directory — the copy nested under dsh first, then one
 * beside it, as dsh's own import finds it — and never through `NODE_PATH`:
 * pnpm's bin shims export one, and a bare CJS lookup finds a package through
 * it from any directory at all. Only the ABSOLUTE directory then reaches
 * Node's CJS resolver, which reads its `main` (an `exports` map applies to
 * bare specifiers only), and the entry is imported by file URL, which Windows
 * requires of an absolute path. Under the dsh that runs, that URL is the one
 * dsh itself loaded — the CJS resolver realpaths as the ESM loader does, and
 * app-boot's `main` and `exports` name the same file — so the import is a
 * cache hit, not a second instance. Measured against a global npm install of
 * 0.1.5-rc.3: this chain and the ESM resolution from dsh's own `lib/bin.js`
 * give the same URL, and the reader, handed `<prefix>/bin/dsh`, answers
 * 0.1.5-rc.3 with all five templates.
 *
 * Throws for whatever that chain cannot do; `readRunningHarness` turns any
 * throw into an empty table, an unknown `patchLists` and no peer check.
 */
async function appBootFacts(dshDir: string): Promise<{ templates: ProfileTemplates; patchLists: boolean; peerCheck: PeerCheck | null } | null> {
  const appBootDir = packageDirectory(dshDir, APP_BOOT)
  if (appBootDir === null) return null
  const entry = createRequire(import.meta.url).resolve(appBootDir)
  const exported = await import(pathToFileURL(entry).href) as {
    PROFILE_TEMPLATES?: unknown
    bundlePatchFiles?: unknown
    evaluatePluginCompatibility?: unknown
    readProfileVersionExemptions?: unknown
  }
  return {
    templates: profileTemplatesOf(exported.PROFILE_TEMPLATES),
    patchLists: typeof exported.bundlePatchFiles === 'function',
    peerCheck: peerCheckOf(exported, appBootDir),
  }
}

/**
 * The peer check an app-boot exports, bound to its own version (see
 * `PeerCheck.evaluate`), or null when it exports only part of one — a rule
 * without the exemptions would refuse what a profile has already allowed —
 * or when its manifest carries no version, which is the one `evaluate`
 * judges by. Never throws, so a check that cannot be formed costs the
 * templates and the patch-list answer nothing.
 */
function peerCheckOf(exported: { evaluatePluginCompatibility?: unknown; readProfileVersionExemptions?: unknown }, appBootDir: string): PeerCheck | null {
  const { evaluatePluginCompatibility: evaluate, readProfileVersionExemptions: exemptions } = exported
  if (typeof evaluate !== 'function' || typeof exemptions !== 'function') return null
  let version: unknown
  try {
    version = (JSON.parse(readFileSync(join(appBootDir, 'package.json'), 'utf8')) as { version?: unknown }).version
  } catch {
    // Swallows an app-boot manifest that cannot be read or parsed, including
    // one that parses to null. The resolver read it a moment ago to find the
    // entry, so this is a race or a hand edit; with no version there is
    // nothing to judge by, and the answer is no check.
    return null
  }
  if (typeof version !== 'string' || version.length === 0) return null
  const runtime = version
  const judge = evaluate as (manifest: unknown, exemptions: unknown, runtimeVersion: string) => PeerIssue | undefined
  return {
    evaluate: (manifest, profileExemptions) => judge(manifest, profileExemptions, runtime),
    exemptions: exemptions as PeerCheck['exemptions'],
  }
}

/**
 * The harness this process runs, identified from `script` — the gateway's
 * `restartScript`, `process.argv[1]` in production — or nothing, never a
 * guess:
 *
 * 1. `script` is resolved through symlinks, because `argv[1]` is the path the
 *    shell ran — `<prefix>/bin/dsh`, a link — and only its target lies inside
 *    the dsh package. No script, or one that does not resolve: nothing known.
 *    An empty path is no script either: `realpathSync('')` answers the
 *    working directory, which says where dsh was started, not what it is.
 * 2. The package that owns it (`owningPackage`) must be `@deepseek-ai/dsh`.
 *    Anything else — a test runner, another host embedding the shop — means
 *    nothing here can say which harness runs, and both halves of the verdict
 *    stay silent.
 * 3. `dshVersion` is that manifest's `version` when it is a non-empty string.
 * 4. `templates`, `patchLists` and `peerCheck` come from that dsh's own
 *    app-boot (`appBootFacts`). Any failure there costs all three and keeps
 *    the version.
 *
 * Never throws and never rejects: a harness nobody could identify forms no
 * verdict, and must never be the reason the catalog fails to load.
 */
export async function readRunningHarness(script: string | undefined): Promise<RunningHarness> {
  try {
    if (script === undefined || script === '') return noHarness()
    const owner = owningPackage(dirname(realpathSync(script)))
    if (owner === null || typeof owner.manifest !== 'object' || owner.manifest === null) return noHarness()
    const { name, version } = owner.manifest as { name?: unknown; version?: unknown }
    if (name !== DSH_PACKAGE) return noHarness()
    const dshVersion = typeof version === 'string' && version.length > 0 ? version : null
    let facts: Awaited<ReturnType<typeof appBootFacts>>
    try {
      facts = await appBootFacts(owner.dir)
    } catch {
      // Swallows every way the running dsh's app-boot can fail to supply a
      // table — a resolver that cannot enter it, an entry that throws on
      // import. The profile half then has no templates to judge by, and the
      // patch-list question has no answer, which is silence; the version was
      // read apart and stands.
      facts = null
    }
    return {
      dshVersion,
      templates: facts?.templates ?? profileTemplatesOf(undefined),
      patchLists: facts?.patchLists ?? null,
      peerCheck: facts?.peerCheck ?? null,
    }
  } catch {
    // Swallows a script `realpathSync` cannot resolve (missing, or not a
    // path at all) — the one other throw on this path. Nothing identifies the
    // harness then, and the answer for that is silence.
    return noHarness()
  }
}
