/**
 * The patch files a bundle declares, read the way dsh reads them (design
 * 2026-09-26-dsh-017-readiness, B4).
 *
 * dsh 0.1.7's app-boot (`bundlePatchFiles`) accepts `dsh.bundle.patch` as one
 * package-relative file or as a list of them, applied in order, and throws on
 * anything else. dsh 0.1.5 reads only the string form: it joins the
 * declaration onto the package directory, so a list makes the profile fail to
 * start. What the RUNNING dsh accepts is `RunningHarness.patchLists`; this
 * reads the declaration itself, for the shop's own readers of a package's
 * patch — the entries it owns, the rows a hot mount replicates.
 */

/**
 * The declared patch files in application order: one for a string, the
 * listed ones for a list of strings. Null for a declaration dsh refuses —
 * neither a path nor a list of paths — which is distinct from an absent one:
 * only absence means the conventional `cordis.patch.yml`, and a caller that
 * fell back to it for a refused declaration would act on a patch dsh never
 * applies. Pure, and the list is a copy.
 */
export function bundlePatchFiles(declared: unknown): string[] | null {
  if (typeof declared === 'string') return [declared]
  if (Array.isArray(declared) && declared.every(file => typeof file === 'string')) return [...declared]
  return null
}

/** Why a bundle patch declaration would stop the profile from starting:
 * `list-unsupported` is a list on a dsh that reads one file, `malformed` a
 * declaration no dsh loads. */
export type PatchHazard = 'list-unsupported' | 'malformed'

/**
 * Whether an installed package's `dsh.bundle.patch` would stop the profile
 * from starting at the next boot, given whether the running dsh reads a list
 * (`RunningHarness.patchLists`). An absent declaration is no hazard: dsh adds
 * a package to the profile's bundles only when it declares a patch, so
 * nothing reads the field. An unknown harness (null) forms no verdict on a
 * list — the rule for every harness read — but a malformed declaration is
 * refused by every dsh, so it is named whatever is known. Pure.
 */
export function patchDeclarationHazard(declared: unknown, patchLists: boolean | null): PatchHazard | null {
  if (declared === undefined) return null
  if (bundlePatchFiles(declared) === null) return 'malformed'
  return Array.isArray(declared) && patchLists === false ? 'list-unsupported' : null
}
