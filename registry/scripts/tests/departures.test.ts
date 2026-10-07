import { describe, expect, it } from 'vitest'
import {
  classifyDeparture, departedNames, departureRejection, describeDepartures, parseDepartureSummary,
  summarizeDepartures, type DepartureOutcome,
} from '../src/departures.ts'
import { deprecatedDetail, deprecationMessageOf } from '../src/gate.ts'

const KEYWORDS: readonly string[] = ['dsh-plugin', 'deepseek-harness']

/** A packument whose latest version carries `latest` on top of a keyworded default. */
function packument(latest: Record<string, unknown> = {}, name = 'dsh-x'): unknown {
  return {
    name,
    'dist-tags': { latest: '2.0.0' },
    versions: { '2.0.0': { name, version: '2.0.0', keywords: ['dsh-plugin'], ...latest } },
  }
}

describe('departedNames', () => {
  it('keeps the listed names the harvest did not produce, sorted and deduplicated', () => {
    expect(departedNames(['dsh-b', 'dsh-a', 'dsh-c', 'dsh-a'], new Set(['dsh-c']))).toEqual(['dsh-a', 'dsh-b'])
  })

  it('departs nothing from an empty lock', () => {
    expect(departedNames([], new Set(['dsh-a']))).toEqual([])
  })
})

describe('classifyDeparture', () => {
  it('carries a package whose latest version still lists a harvest keyword, undeprecated', () => {
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: packument() }, KEYWORDS)).toEqual({ kind: 'carried', name: 'dsh-x' })
  })

  it('carries a package npm un-deprecated with a blank message, as isDeprecated reads it', () => {
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: packument({ deprecated: '   ' }) }, KEYWORDS))
      .toEqual({ kind: 'carried', name: 'dsh-x' })
  })

  it('reads a deprecated latest version with its message, and a bare true without one', () => {
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: packument({ deprecated: 'Renamed to dsh-y.' }) }, KEYWORDS))
      .toEqual({ kind: 'deprecated', name: 'dsh-x', message: 'Renamed to dsh-y.' })
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: packument({ deprecated: true }) }, KEYWORDS))
      .toEqual({ kind: 'deprecated', name: 'dsh-x', message: undefined })
  })

  it('reads npm\'s unpublish stub with its date, and without one when the time is malformed', () => {
    const stub = (at: unknown): unknown => ({ name: 'dsh-x', time: { unpublished: { time: at, versions: ['1.0.0'] } } })
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: stub('2026-09-30T08:00:00.000Z') }, KEYWORDS))
      .toEqual({ kind: 'unpublished', name: 'dsh-x', date: '2026-09-30' })
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: stub(42) }, KEYWORDS))
      .toEqual({ kind: 'unpublished', name: 'dsh-x', date: undefined })
  })

  it('reads a 404 as removed', () => {
    expect(classifyDeparture('dsh-x', { kind: 'missing' }, KEYWORDS)).toEqual({ kind: 'removed', name: 'dsh-x' })
  })

  it('reads a latest version with neither harvest keyword as keyword-dropped, naming the version', () => {
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: packument({ keywords: ['tool'] }) }, KEYWORDS))
      .toEqual({ kind: 'keyword-dropped', name: 'dsh-x', version: '2.0.0' })
  })

  it('reads a latest version both deprecated and un-keyworded as deprecated, the cause its author gave', () => {
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: packument({ deprecated: 'Renamed to dsh-y.', keywords: ['tool'] }) }, KEYWORDS))
      .toEqual({ kind: 'deprecated', name: 'dsh-x', message: 'Renamed to dsh-y.' })
  })

  it('compares keywords exactly, by code unit: DSH-PLUGIN lists no harvest keyword', () => {
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: packument({ keywords: ['DSH-PLUGIN'] }) }, KEYWORDS))
      .toEqual({ kind: 'keyword-dropped', name: 'dsh-x', version: '2.0.0' })
  })

  it('cuts a keyword-dropped version at 128 characters', () => {
    // 6 + 123 = 129 characters, one past VERSION_MAX_LENGTH; the cut keeps 6 + 122 = 128.
    const version = `1.0.0-${'a'.repeat(123)}`
    const body = { name: 'dsh-x', 'dist-tags': { latest: version }, versions: { [version]: { name: 'dsh-x', version, keywords: ['tool'] } } }
    expect(classifyDeparture('dsh-x', { kind: 'packument', body }, KEYWORDS))
      .toEqual({ kind: 'keyword-dropped', name: 'dsh-x', version: `1.0.0-${'a'.repeat(122)}` })
  })

  it.each([
    ['a transport failure', { kind: 'failed', reason: 'npm registry returned 503' }, 'npm registry returned 503'],
    ['another package\'s packument', { kind: 'packument', body: packument({}, 'dsh-y') }, 'the registry answered the packument of another package'],
    ['a body that is not a packument', { kind: 'packument', body: ['dsh-x'] }, 'the registry answered a body that is not a packument'],
    ['a packument with no latest version', { kind: 'packument', body: { name: 'dsh-x', 'dist-tags': {}, versions: {} } }, 'the registry answered a packument with no latest version'],
  ] as const)('reads %s as unanswered', (_what, answer, reason) => {
    expect(classifyDeparture('dsh-x', answer, KEYWORDS)).toEqual({ kind: 'unanswered', name: 'dsh-x', reason })
  })
})

describe('departureRejection', () => {
  it.each([
    [{ kind: 'deprecated', name: 'dsh-x', message: 'Renamed to dsh-y.' }, 'deprecated', 'Marked deprecated on npm: "Renamed to dsh-y.".'],
    [{ kind: 'unpublished', name: 'dsh-x', date: '2026-09-30' }, 'npm-gone', 'Unpublished from npm on 2026-09-30, so no version is left to install.'],
    [{ kind: 'unpublished', name: 'dsh-x', date: undefined }, 'npm-gone', 'Unpublished from npm, so no version is left to install.'],
    [{ kind: 'removed', name: 'dsh-x' }, 'npm-gone', 'npm no longer has a package of this name: the registry answers 404.'],
    [{ kind: 'keyword-dropped', name: 'dsh-x', version: '2.0.0' }, 'npm-gone', 'Its latest version, 2.0.0, no longer lists the dsh-plugin or deepseek-harness keyword, so the harvest does not select it. Add one back and the next build lists it again.'],
    [{ kind: 'unanswered', name: 'dsh-x', reason: 'npm registry returned 503' }, 'npm-gone', 'It left the keyword harvest, and npm did not answer when asked why: npm registry returned 503.'],
  ] as const)('words %o', (outcome, code, detail) => {
    expect(departureRejection(outcome, KEYWORDS)).toEqual({ name: 'dsh-x', code, detail })
  })

  it('writes the gate\'s own sentence for a message holding a double quote, a pipe and a newline', () => {
    // Review Focus 2: one hostile message is one sentence, whichever path
    // reads it. JSON quoting escapes the quote and the newline; the pipe is
    // escapeCell's, as in every report cell.
    const message = 'Use "dsh-b" | not this\nsee README'
    const detail = departureRejection({ kind: 'deprecated', name: 'dsh-x', message }, KEYWORDS).detail
    expect(detail).toBe(deprecatedDetail(message))
    expect(detail).toBe('Marked deprecated on npm: "Use \\"dsh-b\\" | not this\\nsee README".')
    // npm's raw value, padded as an author can leave it: the departure path
    // bounds it with the gate's own reader, so the message above is what it quotes.
    const raw = `  ${message}\n`
    expect(deprecationMessageOf(raw)).toBe(message)
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: packument({ deprecated: raw }) }, KEYWORDS))
      .toEqual({ kind: 'deprecated', name: 'dsh-x', message: deprecationMessageOf(raw) })
  })

  it('cuts an unanswered reason at 200 characters', () => {
    // 26 + 175 = 201 characters, one past DERIVED_SUMMARY_MAX_LENGTH; the cut keeps 26 + 174 = 200.
    const reason = `npm registry returned 503 ${'x'.repeat(175)}`
    expect(departureRejection({ kind: 'unanswered', name: 'dsh-x', reason }, KEYWORDS).detail)
      .toBe(`It left the keyword harvest, and npm did not answer when asked why: npm registry returned 503 ${'x'.repeat(174)}.`)
  })
})

describe('summarizeDepartures, describeDepartures and parseDepartureSummary', () => {
  const outcomes: DepartureOutcome[] = [
    { kind: 'carried', name: 'dsh-b' },
    { kind: 'deprecated', name: 'dsh-c', message: undefined },
    { kind: 'removed', name: 'dsh-d' },
    { kind: 'carried', name: 'dsh-a' },
  ]

  it('counts each outcome and sorts the carried names', () => {
    // 4 departed = 2 carried + 1 deprecated + 1 npm-gone.
    expect(summarizeDepartures(outcomes)).toEqual({ departed: 4, carried: ['dsh-a', 'dsh-b'], deprecated: 1, npmGone: 1 })
  })

  it('writes the count line, and the carried names only when there are some', () => {
    expect(describeDepartures(summarizeDepartures(outcomes))).toEqual([
      'npm packages missing from the harvest since the last catalog: 4 (carried 2, deprecated 1, npm-gone 1)',
      'carried, still carrying a harvest keyword that neither npm search nor the change feed returned: dsh-a, dsh-b',
    ])
    expect(describeDepartures({ departed: 0, carried: [], deprecated: 0, npmGone: 0 })).toEqual([
      'npm packages missing from the harvest since the last catalog: 0 (carried 0, deprecated 0, npm-gone 0)',
    ])
  })

  it('escapes the carried names, so one the parser never saw still cannot forge a report line', () => {
    // Built by hand, past parseDepartureSummary. escapeCell writes `|` as `\|`
    // and the newline as a space, so the name stays inside its own line.
    const lines = describeDepartures({ departed: 1, carried: ['dsh-a\n- forged | cell'], deprecated: 0, npmGone: 0 })
    expect(lines).toEqual([
      'npm packages missing from the harvest since the last catalog: 1 (carried 1, deprecated 0, npm-gone 0)',
      'carried, still carrying a harvest keyword that neither npm search nor the change feed returned: dsh-a - forged \\| cell',
    ])
    expect(lines.filter(line => line.includes('\n'))).toEqual([])
    expect(lines[1]).toContain('\\|')
  })

  it('round-trips a summary through the handoff parser', () => {
    const summary = summarizeDepartures(outcomes)
    expect(parseDepartureSummary(JSON.parse(JSON.stringify(summary)), 'test')).toEqual(summary)
  })

  it('accepts any name npm can serve, legacy capitals included', () => {
    // The writer takes carried names off manifest.lock and applies no grammar.
    const legacy = { departed: 1, carried: ['JSONStream'], deprecated: 0, npmGone: 0 }
    expect(parseDepartureSummary(legacy, 'test')).toEqual(legacy)
    // 214 characters, npm's bound: the longest name the gate lets the catalog list.
    const longest = { departed: 1, carried: ['a'.repeat(214)], deprecated: 0, npmGone: 0 }
    expect(parseDepartureSummary(longest, 'test')).toEqual(longest)
  })

  it.each([
    ['counts that do not add up', { departed: 3, carried: ['dsh-a'], deprecated: 1, npmGone: 0 }],
    ['a negative count', { departed: 0, carried: [], deprecated: -1, npmGone: 1 }],
    ['not an object', ['departed']],
  ])('refuses %s', (_what, raw) => {
    expect(() => parseDepartureSummary(raw, '--harvest-from x'))
      .toThrow('--harvest-from x: expected `departures` to be { departed, carried, deprecated, npmGone } with counts that add up')
  })

  // Each summary's counts add up, 1 = 1 + 0 + 0, so only the name can trip.
  it.each([
    ['that is not a string', 1],
    ['that is empty', ''],
    ['longer than 214 characters', 'a'.repeat(215)],
    ['holding a newline', 'dsh-a\n- forged'],
    ['holding a bidi control', 'dsh-\u202ea'],
  ])('refuses a carried name %s, saying the name is wrong rather than the counts', (_what, name) => {
    expect(() => parseDepartureSummary({ departed: 1, carried: [name], deprecated: 0, npmGone: 0 }, '--harvest-from x'))
      .toThrow('--harvest-from x: expected `departures` to carry npm package names, and one in `carried` is not a string of 1 to 214 characters free of whitespace and control characters')
  })
})
