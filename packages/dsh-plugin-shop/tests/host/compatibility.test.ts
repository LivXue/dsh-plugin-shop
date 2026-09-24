import { satisfies } from 'semver'
import { describe, expect, it } from 'vitest'
import { compatibilityMap } from '../../src/host/compatibility.ts'

/** The harness this was measured against: `@deepseek-ai/dsh` resolved from a
 * real `web` profile's anchor on 2026-09-24. */
const RUNNING = { dshVersion: '0.1.5-rc.3', profile: 'web' }

/** `@xmanrui/dsh-im@4.19.2`'s own `dsh.compatibility.dsh`, verbatim (design
 * 2026-09-01-harness-compatibility §8.2). */
const DSH_IM_RANGE = '0.1.2-alpha.4 || 0.1.2-alpha.5 || 0.1.2-rc.1 || 0.1.3-alpha.1 || 0.1.5-alpha.1'

/** An npm entry declaring `compatibility`, or declaring nothing at all. */
function npm(name: string, compatibility?: { dsh?: string; profiles?: string[] }) {
  return compatibility === undefined
    ? { source: 'npm' as const, name }
    : { source: 'npm' as const, name, compatibility }
}

describe('compatibilityMap', () => {
  it('reports a declared range the running harness does not satisfy', () => {
    // The author lists five exact versions; the harness was on none of them
    // when this was reported (0.1.5-rc.1, 2026-09-11) and is on none of them
    // now. The same declaration names `web`, the running profile, so the
    // range is the only half reported.
    expect(compatibilityMap([npm('@xmanrui/dsh-im', { dsh: DSH_IM_RANGE, profiles: ['web'] })], RUNNING)).toEqual({
      'npm:@xmanrui/dsh-im': { dsh: { range: DSH_IM_RANGE, running: '0.1.5-rc.3' } },
    })
  })

  it('says nothing when the running harness satisfies the range', () => {
    expect(compatibilityMap([npm('ok', { dsh: '0.1.5-rc.3 || 0.2.0' })], RUNNING)).toEqual({})
  })

  it('says nothing when the entry declares no compatibility', () => {
    expect(compatibilityMap([npm('plain')], RUNNING)).toEqual({})
  })

  it('reports a profile list that does not name the running profile', () => {
    expect(compatibilityMap([npm('tui-only', { profiles: ['tui'] })], RUNNING)).toEqual({
      'npm:tui-only': { profile: { declared: ['tui'], running: 'web' } },
    })
  })

  it('says nothing when the profile list names the running profile', () => {
    expect(compatibilityMap([npm('web-ok', { profiles: ['web', 'tui'] })], RUNNING)).toEqual({})
  })

  it('treats an empty profile list as no declaration', () => {
    // `[]` names no profile at all, which is not a claim that none is
    // supported. The harvest never publishes one, but the consumer schema
    // parses it, so it must not read as an accusation either.
    expect(compatibilityMap([npm('none', { profiles: [] })], RUNNING)).toEqual({})
  })

  it('reports both halves when an entry fails both', () => {
    // Separate verdicts (design §8.2): the client names which one failed, so
    // one half must never stand in for the other.
    expect(compatibilityMap([npm('x', { dsh: '0.9.0', profiles: ['tui'] })], RUNNING)).toEqual({
      'npm:x': {
        dsh: { range: '0.9.0', running: '0.1.5-rc.3' },
        profile: { declared: ['tui'], running: 'web' },
      },
    })
  })

  it('gives no range verdict when the harness version is unknown, and still judges the profile half', () => {
    // An unavailable fact reads as "unknown", never as an accusation (§3).
    const map = compatibilityMap([npm('x', { dsh: '0.9.0', profiles: ['tui'] })], { dshVersion: null, profile: 'web' })
    expect(map).toEqual({ 'npm:x': { profile: { declared: ['tui'], running: 'web' } } })
  })

  it('gives no range verdict when the running version is not semver', () => {
    // `satisfies` answers false for a version it cannot parse, which would
    // read as an accusation.
    expect(compatibilityMap([npm('x', { dsh: '0.9.0' })], { dshVersion: 'nightly', profile: 'web' })).toEqual({})
  })

  it.each([
    ['prose', 'not a range'],
    ['a dist-tag', 'latest'],
    ['a workspace spec', 'workspace:^0.1.1-rc.2'],
  ])('gives no range verdict for a range semver cannot parse (%s), and still judges the profile half', (_label, range) => {
    expect(compatibilityMap([npm('bad', { dsh: range, profiles: ['tui'] })], RUNNING)).toEqual({
      'npm:bad': { profile: { declared: ['tui'], running: 'web' } },
    })
  })

  it.each(['>=0.1.0', '*'])('meets %s on a prerelease harness, because prereleases are included', range => {
    // The harness ships nothing but prereleases, and strict semver refuses a
    // prerelease against a range whose comparators carry none — even `*`.
    // The premise is asserted rather than assumed: were strict semver ever to
    // accept this pair, the case would stop proving that includePrerelease is
    // what keeps the verdict quiet.
    expect(satisfies(RUNNING.dshVersion, range)).toBe(false)
    expect(compatibilityMap([npm('pre', { dsh: range })], RUNNING)).toEqual({})
  })
})

describe('compatibilityMap identity (G-1)', () => {
  it('keys each verdict by install identity, so same-named entries stay independent', () => {
    const map = compatibilityMap([
      { source: 'github', name: 'dsh-foo', repo: 'alice/dsh-foo', compatibility: { profiles: ['tui'] } },
      { source: 'github', name: 'dsh-foo', repo: 'bob/dsh-foo', compatibility: { profiles: ['web'] } },
      { source: 'npm', name: 'dsh-foo', compatibility: { dsh: '0.9.0' } },
    ], RUNNING)
    expect(map).toEqual({
      'github:alice/dsh-foo#': { profile: { declared: ['tui'], running: 'web' } },
      'npm:dsh-foo': { dsh: { range: '0.9.0', running: '0.1.5-rc.3' } },
    })
  })

  it('keys a subpackage entry by its subdir', () => {
    expect(compatibilityMap(
      [{ source: 'github', name: 'sub', repo: 'someone/mono', subdir: 'packages/a', compatibility: { profiles: ['tui'] } }],
      RUNNING,
    )).toEqual({ 'github:someone/mono#packages/a': { profile: { declared: ['tui'], running: 'web' } } })
  })
})
