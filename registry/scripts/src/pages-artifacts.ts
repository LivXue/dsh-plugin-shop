/**
 * What the Pages site is allowed to contain.
 *
 * `upload-pages-artifact` was pointed at `dist/`, so everything the build and
 * the classifier happened to write there was published. Measured against the
 * live site on 2026-09-04: `/v1/harvest.json` (4,037,180 bytes of every
 * candidate verbatim, rejected ones included, with unvalidated `dsh.catalog`
 * values), `/v1/report.md` (1,722,904 bytes), and
 * `/v1/classification-report.md`. None of the three is in the spec's artifact
 * list (design §6.2 plus the README's badge endpoint), none is
 * content-addressed, and none is referenced by the pointer.
 *
 * The list of publishable names is policy, so it lives in the pure core where
 * a test can hold it to the spec; `build.ts` copies what this returns into a
 * directory it creates from scratch.
 * @module pages-artifacts
 */

/** The emitted pointer, as far as this module needs to read it. */
export interface PagesPointer {
  plugins: { url: string }
  /** Absent when the build published no sidecar — the stars fetch is
   * advisory, and a failure publishes without it. */
  stars?: { url: string }
}

/**
 * The fixed-name artifacts every build publishes: the pointer, and the
 * shields.io endpoint payload the README's `catalog` badge reads.
 */
export const PAGES_FIXED_FILES: readonly string[] = ['index.json', 'badge.json']

/**
 * Every file the Pages site publishes for one build, in a deterministic
 * order: the fixed-name artifacts, then the content-addressed data file, then
 * the stars sidecar when this build produced one.
 * @param pointer - the emitted `index.json`, which names the addressed files.
 * @returns a fresh array of file names, relative to `v1/`.
 */
export function pagesArtifactNames(pointer: PagesPointer): string[] {
  return [
    ...PAGES_FIXED_FILES,
    pointer.plugins.url,
    ...(pointer.stars === undefined ? [] : [pointer.stars.url]),
  ]
}

/**
 * Every file the npm catalog package publishes for one build.
 *
 * The same set as {@link pagesArtifactNames} minus `badge.json`: that file is
 * the shields.io endpoint the README's badge fetches over HTTP, so it is a
 * Pages artifact and nothing reads it out of the tarball.
 *
 * Stated here rather than inline in `publish-catalog.ts` because a transport's
 * publishable set is policy, and leaving one transport's list in the shell
 * while the other is tested is exactly the asymmetry that let Pages publish a
 * 4 MB handoff for months.
 * @param pointer - the emitted `index.json`, which names the addressed files.
 * @returns a fresh array of file names, relative to `v1/`.
 */
export function npmArtifactNames(pointer: PagesPointer): string[] {
  return pagesArtifactNames(pointer).filter(name => name !== 'badge.json')
}

