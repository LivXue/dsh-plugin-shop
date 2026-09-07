/**
 * What the Pages site and the npm catalog package are allowed to contain.
 *
 * `upload-pages-artifact` was pointed at `dist/`, so everything the build and
 * the classifier happened to write there was published. Measured against the
 * live site on 2026-09-04: `/v1/harvest.json` (4,037,180 bytes of every
 * candidate verbatim, rejected ones included, with unvalidated `dsh.catalog`
 * values), `/v1/report.md` (1,722,904 bytes), and
 * `/v1/classification-report.md`. The allowlist below replaced that, and
 * `harvest.json` stays out of it permanently: it is an internal handoff from
 * `classify.ts` to `build.ts`, it is not escaped for any reader, and nothing
 * is meant to read it.
 *
 * **Amendment (2026-09-07): the two reports are published again, on purpose.**
 * Sweeping them out with `harvest.json` cost the property they exist for. Every
 * rejection carries an author-readable `detail`, and an author reads it to find
 * out why their package is not listed — so a report reachable only as a zipped
 * run artifact makes "named machine rejections rather than silent drops" a
 * claim about a file the author cannot open. Asked and answered in upstream
 * discussion #5867, where a plugin author searched the build metadata for their
 * own name, found nothing, and concluded the harvest could not see their
 * packages; one of the six was in fact harvested and rejected with a named
 * reason they had no way to read. The reports are unlike `harvest.json` in the
 * two ways that matter: every cell is escaped at emit (`escapeCell`), and a
 * human is the intended reader.
 *
 * They are deliberately NOT content-addressed and NOT named by the pointer.
 * Those two properties exist to keep the plugin data hash cache-stable
 * (design §6.2); a report is regenerated per build and read by a person who
 * fetches it by name, so neither buys anything here. The rule the allowlist
 * enforces is "exactly the artifacts the spec lists", not "everything is
 * hashed".
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
 * Which human-facing reports this build has on disk.
 *
 * Only the classification report is in question. `build.ts` writes `report.md`
 * itself, immediately before staging, so a build always has one; the
 * classification report comes from `classify.ts` — a separate process, which
 * the daily workflow runs first but a local `pnpm build:catalog` does not run
 * at all. The caller states what it has rather than this module guessing,
 * because a name in the returned list that is not on disk is a copy that
 * throws and takes the whole build with it.
 */
export interface ReportsPresent {
  classificationReport: boolean
}

/**
 * The fixed-name artifacts every build publishes to Pages and nowhere else:
 * the shields.io endpoint payload the README's `catalog` badge reads, and the
 * two build reports. Nothing reads any of them out of the npm tarball — the
 * badge is fetched over HTTP by shields.io, and a report is opened by a person
 * in a browser — so this is exactly the set that separates the two transports.
 */
export const PAGES_ONLY_FILES: readonly string[] = ['badge.json', 'report.md', 'classification-report.md']

/**
 * The machine-readable artifacts: the pointer, the content-addressed data
 * file, and the stars sidecar when this build produced one. Both transports
 * carry all of these, which is why they are stated once.
 * @param pointer - the emitted `index.json`, which names the addressed files.
 * @returns a fresh array of file names, relative to `v1/`.
 */
function dataFileNames(pointer: PagesPointer): string[] {
  return [
    'index.json',
    pointer.plugins.url,
    ...(pointer.stars === undefined ? [] : [pointer.stars.url]),
  ]
}

/**
 * Every file the Pages site publishes for one build, in a deterministic order:
 * the machine-readable set, then the browser-only extras.
 * @param pointer - the emitted `index.json`, which names the addressed files.
 * @param reports - which reports this build has on disk (see
 *   {@link ReportsPresent}); required, so a caller cannot omit its way into
 *   silently unpublishing one.
 * @returns a fresh array of file names, relative to `v1/`.
 */
export function pagesArtifactNames(pointer: PagesPointer, reports: ReportsPresent): string[] {
  return [
    ...dataFileNames(pointer),
    'badge.json',
    'report.md',
    ...(reports.classificationReport ? ['classification-report.md'] : []),
  ]
}

/**
 * Every file the npm catalog package publishes for one build: the
 * machine-readable set, and nothing else.
 *
 * Stated here rather than inline in `publish-catalog.ts` because a transport's
 * publishable set is policy, and leaving one transport's list in the shell
 * while the other is tested is exactly the asymmetry that let Pages publish a
 * 4 MB handoff for months. The two sets are derived from one list, so a new
 * data artifact reaches both transports or neither.
 * @param pointer - the emitted `index.json`, which names the addressed files.
 * @returns a fresh array of file names, relative to `v1/`.
 */
export function npmArtifactNames(pointer: PagesPointer): string[] {
  return dataFileNames(pointer)
}
