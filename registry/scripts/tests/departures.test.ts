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

  it('round-trips a summary through the handoff parser', () => {
    const summary = summarizeDepartures(outcomes)
    expect(parseDepartureSummary(JSON.parse(JSON.stringify(summary)), 'test')).toEqual(summary)
  })

  it.each([
    ['counts that do not add up', { departed: 3, carried: ['dsh-a'], deprecated: 1, npmGone: 0 }],
    ['a negative count', { departed: 0, carried: [], deprecated: -1, npmGone: 1 }],
    ['a carried name that is not a string', { departed: 1, carried: [1], deprecated: 0, npmGone: 0 }],
    ['not an object', ['departed']],
  ])('refuses %s', (_what, raw) => {
    expect(() => parseDepartureSummary(raw, '--harvest-from x')).toThrow(/--harvest-from x: expected `departures`/)
  })
})
