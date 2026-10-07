/**
 * A listed npm package the harvest no longer returns, and why (design
 * 2026-09-26-market-borrowings §8).
 *
 * npm search returns no deprecated package and its `total` counts none, so a
 * package deprecated after it was listed never reaches the gate's own
 * `deprecated` rule, and an unpublished, removed or un-keyworded one leaves the
 * same way. The harvest compares the last published catalog with what it
 * produced and asks npm once about each name it lost. Pure: an answer comes
 * in, an outcome goes out; `npm-client.ts` does the reading.
 * @module departures
 */
import { FEED_PACKAGE_NAME_MAX_LENGTH, isDeprecated, isUnpublishStub, latestVersionOf } from './feed-state.ts'
import { DERIVED_SUMMARY_MAX_LENGTH, VERSION_MAX_LENGTH, deprecatedDetail, deprecationMessageOf, truncateWholeCharacters } from './gate.ts'
import { compareStrings } from './identity.ts'
import type { Rejection } from './types.ts'

/** What reading one departed name's packument answered. */
export type DepartureAnswer =
  | { readonly kind: 'packument'; readonly body: unknown }
  /** The registry answered 404. */
  | { readonly kind: 'missing' }
  /** Anything that is not npm's answer about the package: a transport
   * failure, a deadline, another status, an unreadable or oversized body. */
  | { readonly kind: 'failed'; readonly reason: string }

/** Why one departed name left, or that it stays: §8.2's table. */
export type DepartureOutcome =
  | { readonly kind: 'carried'; readonly name: string }
  | { readonly kind: 'deprecated'; readonly name: string; readonly message: string | undefined }
  | { readonly kind: 'unpublished'; readonly name: string; readonly date: string | undefined }
  | { readonly kind: 'removed'; readonly name: string }
  | { readonly kind: 'keyword-dropped'; readonly name: string; readonly version: string }
  | { readonly kind: 'unanswered'; readonly name: string; readonly reason: string }

/** One run's departures, for the report and the harvest handoff. */
export interface DepartureSummary {
  /** Names listed in the last catalog and absent from this harvest. */
  readonly departed: number
  /** The carried ones, sorted. */
  readonly carried: readonly string[]
  readonly deprecated: number
  readonly npmGone: number
}

/** The heading of the report line; a guard test pins it. */
export const DEPARTURES_HEADING = 'npm packages missing from the harvest since the last catalog'

/**
 * The names the last catalog listed that this harvest did not produce, sorted
 * and deduplicated. A name the harvest produced stays the gate's to judge.
 * @param listed - the npm names of the last published catalog.
 * @param harvested - every name this run's harvest produced, candidates and
 *   `fetch-failed` rows alike.
 */
export function departedNames(listed: readonly string[], harvested: ReadonlySet<string>): string[] {
  return [...new Set(listed)].filter(name => !harvested.has(name)).sort(compareStrings)
}

/**
 * Why one departed name left, read off npm's answer.
 *
 * The membership rule is the change feed's (`classifyManifest`): the latest
 * version lists a harvest keyword by exact code-unit equality and is not
 * deprecated. A package that still passes it is carried; the gate judges it.
 * @param name - the departed name.
 * @param answer - what reading its packument answered.
 * @param harvestKeywords - `HARVEST_KEYWORDS`, passed in because this module is pure.
 */
export function classifyDeparture(name: string, answer: DepartureAnswer, harvestKeywords: readonly string[]): DepartureOutcome {
  if (answer.kind === 'missing') return { kind: 'removed', name }
  if (answer.kind === 'failed') return { kind: 'unanswered', name, reason: answer.reason }
  const body = answer.body
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'unanswered', name, reason: 'the registry answered a body that is not a packument' }
  }
  if ((body as { name?: unknown }).name !== name) {
    return { kind: 'unanswered', name, reason: 'the registry answered the packument of another package' }
  }
  if (isUnpublishStub(body)) return { kind: 'unpublished', name, date: unpublishDate(body) }
  const latest = latestVersionOf(body)
  if (latest === null) {
    return { kind: 'unanswered', name, reason: 'the registry answered a packument with no latest version' }
  }
  const { deprecated, keywords } = latest.manifest as { deprecated?: unknown; keywords?: unknown }
  if (isDeprecated(deprecated)) return { kind: 'deprecated', name, message: deprecationMessageOf(deprecated) }
  const declared: readonly unknown[] = Array.isArray(keywords) ? keywords : []
  if (!harvestKeywords.some(keyword => declared.includes(keyword))) {
    return { kind: 'keyword-dropped', name, version: truncateWholeCharacters(latest.version, VERSION_MAX_LENGTH) }
  }
  return { kind: 'carried', name }
}

/** The date part of `time.unpublished.time`, when that is a well-formed timestamp. */
function unpublishDate(stub: object): string | undefined {
  const time = (stub as { time?: unknown }).time
  const unpublished = time !== null && typeof time === 'object' ? (time as { unpublished?: unknown }).unpublished : undefined
  const at = unpublished !== null && typeof unpublished === 'object' ? (unpublished as { time?: unknown }).time : undefined
  return typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(at) ? at.slice(0, 10) : undefined
}

/**
 * The row a departed name leaves with. `deprecated` uses the gate's own
 * sentence; every other cause is `npm-gone`, the npm half of `repo-gone`.
 * @param outcome - a classified departure that is not carried.
 * @param harvestKeywords - named in the keyword-dropped sentence.
 */
export function departureRejection(
  outcome: Exclude<DepartureOutcome, { kind: 'carried' }>,
  harvestKeywords: readonly string[],
): Rejection {
  const { name } = outcome
  switch (outcome.kind) {
    case 'deprecated':
      return { name, code: 'deprecated', detail: deprecatedDetail(outcome.message) }
    case 'unpublished':
      return {
        name,
        code: 'npm-gone',
        detail: outcome.date === undefined
          ? 'Unpublished from npm, so no version is left to install.'
          : `Unpublished from npm on ${outcome.date}, so no version is left to install.`,
      }
    case 'removed':
      return { name, code: 'npm-gone', detail: 'npm no longer has a package of this name: the registry answers 404.' }
    case 'keyword-dropped':
      return {
        name,
        code: 'npm-gone',
        detail: `Its latest version, ${outcome.version}, no longer lists the ${harvestKeywords.join(' or ')} keyword,`
          + ' so the harvest does not select it. Add one back and the next build lists it again.',
      }
    case 'unanswered':
      return {
        name,
        code: 'npm-gone',
        detail: `It left the keyword harvest, and npm did not answer when asked why: ${truncateWholeCharacters(outcome.reason, DERIVED_SUMMARY_MAX_LENGTH)}.`,
      }
  }
}

/** One run's outcomes, counted. */
export function summarizeDepartures(outcomes: readonly DepartureOutcome[]): DepartureSummary {
  const carried = outcomes.filter(outcome => outcome.kind === 'carried').map(outcome => outcome.name).sort(compareStrings)
  const deprecated = outcomes.filter(outcome => outcome.kind === 'deprecated').length
  return { departed: outcomes.length, carried, deprecated, npmGone: outcomes.length - carried.length - deprecated }
}

/**
 * The report's lines: the count, written whether or not it is zero so a reader
 * can see the step ran, then the carried names when there are any.
 */
export function describeDepartures(summary: DepartureSummary): string[] {
  const head = `${DEPARTURES_HEADING}: ${summary.departed} (carried ${summary.carried.length}, deprecated ${summary.deprecated}, npm-gone ${summary.npmGone})`
  return summary.carried.length === 0
    ? [head]
    : [head, `carried, still carrying a harvest keyword that neither npm search nor the change feed returned: ${summary.carried.join(', ')}`]
}

/**
 * Read the handoff's `departures` record. Its counts are interpolated into a
 * published report, so a shape this module never writes throws, the rule
 * `parseKeywordShortfall` applies to `shortfalls`.
 * @param raw - the record, unvalidated.
 * @param source - names the file in the error.
 */
export function parseDepartureSummary(raw: unknown, source: string): DepartureSummary {
  const fail = (): never => {
    throw new Error(`${source}: expected \`departures\` to be { departed, carried, deprecated, npmGone } with counts that add up`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail()
  const { departed, carried, deprecated, npmGone } = raw as Record<string, unknown>
  const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (!isCount(departed) || !isCount(deprecated) || !isCount(npmGone)) return fail()
  if (!Array.isArray(carried)
    || !carried.every(name => typeof name === 'string' && name !== '' && name.length <= FEED_PACKAGE_NAME_MAX_LENGTH)) {
    return fail()
  }
  if (departed !== carried.length + deprecated + npmGone) return fail()
  return { departed, carried: [...(carried as string[])].sort(compareStrings), deprecated, npmGone }
}
