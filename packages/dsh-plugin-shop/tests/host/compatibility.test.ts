import { satisfies } from 'semver'
import { describe, expect, it } from 'vitest'
import { compatibilityMap, profileTemplatesOf, type ProfileTemplates } from '../../src/host/compatibility.ts'

/** The harness's own `PROFILE_TEMPLATES` on 0.1.5-rc.3, copied verbatim from
 * `@deepseek-ai/dsh-app-boot/lib/index.js` — five templates, each a
 * `{ bundles, patchReload }`. `profileTemplatesOf` is what turns either live
 * shape into the map below, and using the real bundles is what makes the
 * "is this profile that template" cases mean something: a `web` profile
 * carries `@deepseek-ai/dsh-base` but not `@deepseek-ai/dsh-acp-app`. */
const RC3_TEMPLATES: ProfileTemplates = {
  acp: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  sdk: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  'sdk-minimal': ['@deepseek-ai/dsh-sdk-minimal'],
}

/** The harness this was measured against: `@deepseek-ai/dsh` resolved from a
 * real `web` profile's anchor on 2026-09-24, and that profile's own bundles —
 * the web template's, plus the shop the profile was actually using. */
const RUNNING = {
  dshVersion: '0.1.5-rc.3',
  profile: { name: 'web', bundles: [...RC3_TEMPLATES.web!, 'dsh-plugin-shop'] },
}

const withProfile = (name: string, bundles: readonly string[] | null) => ({
  dshVersion: '0.1.5-rc.3',
  profile: { name, bundles },
})

/** `@xmanrui/dsh-im@4.19.2`'s own `dsh.compatibility.dsh`, verbatim (design
 * 2026-09-01-harness-compatibility §8.2). */
const DSH_IM_RANGE = '0.1.2-alpha.4 || 0.1.2-alpha.5 || 0.1.2-rc.1 || 0.1.3-alpha.1 || 0.1.5-alpha.1'

/** An npm entry declaring `compatibility`, or declaring nothing at all. */
function npm(name: string, compatibility?: { dsh?: string; profiles?: string[] }) {
  return compatibility === undefined
    ? { source: 'npm' as const, name }
    : { source: 'npm' as const, name, compatibility }
}

const map = (
  entries: Parameters<typeof compatibilityMap>[0],
  runtime: Parameters<typeof compatibilityMap>[1] = RUNNING,
  templates: ProfileTemplates = RC3_TEMPLATES,
) => compatibilityMap(entries, runtime, templates)

describe('compatibilityMap', () => {
  it('reports a declared range the running harness does not satisfy', () => {
    // The author lists five exact versions; the harness was on none of them
    // when this was reported (0.1.5-rc.1, 2026-09-11) and is on none of them
    // now. The same declaration names `web`, the running profile's template,
    // so the range is the only half reported.
    expect(map([npm('@xmanrui/dsh-im', { dsh: DSH_IM_RANGE, profiles: ['web'] })])).toEqual({
      'npm:@xmanrui/dsh-im': { dsh: { range: DSH_IM_RANGE, running: '0.1.5-rc.3' } },
    })
  })

  it('says nothing when the running harness satisfies the range', () => {
    expect(map([npm('ok', { dsh: '0.1.5-rc.3 || 0.2.0' })])).toEqual({})
  })

  it('says nothing when the entry declares no compatibility', () => {
    expect(map([npm('plain')])).toEqual({})
  })

  it('reports a declared template this profile does not compose', () => {
    // `acp` is a real template, and a web profile lacks its `dsh-acp-app`.
    expect(map([npm('acp-only', { profiles: ['acp'] })])).toEqual({
      'npm:acp-only': { profile: { declared: ['acp'], running: 'web' } },
    })
  })

  it('says nothing when the profile composes a declared template', () => {
    expect(map([npm('web-ok', { profiles: ['web', 'acp'] })])).toEqual({})
  })

  it('judges by what the profile IS, not by the name it was given', () => {
    // The defect this rule exists for: `dsh --profile rescue
    // --from-default-profile web` builds a profile called `rescue` out of the
    // web bundles, and dsh records nothing about which template it came from.
    // Comparing names would badge every plugin declaring `profiles: ["web"]`.
    const rescue = withProfile('rescue', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(map([npm('declares-web', { profiles: ['web'] })], rescue)).toEqual({})
    // And the same profile still fails a template it genuinely lacks.
    expect(map([npm('declares-acp', { profiles: ['acp'] })], rescue)).toEqual({
      'npm:declares-acp': { profile: { declared: ['acp'], running: 'rescue' } },
    })
  })

  it('says nothing for a declared name no harness ships', () => {
    // There is nothing to compare `tui` or `desktop` against. A name that is
    // no template is an unknown, and an unknown is never an accusation (§3).
    for (const name of ['tui', 'desktop']) {
      expect(map([npm('not-a-template', { profiles: [name] })]), name).toEqual({})
    }
  })

  it('says nothing when one declared name is no template and no other is met', () => {
    // The list as a whole is unknown: one name nobody can judge must not be
    // read as "the rest failed", which would accuse on a partial comparison.
    expect(map([npm('mixed', { profiles: ['acp', 'nonexistent'] })])).toEqual({})
  })

  it('reports the list when every declared name is a template this profile lacks', () => {
    expect(map([npm('two-templates', { profiles: ['acp', 'sdk'] })])).toEqual({
      'npm:two-templates': { profile: { declared: ['acp', 'sdk'], running: 'web' } },
    })
  })

  it('says nothing about profiles when the running bundles cannot be read', () => {
    // An unreadable profile manifest is a fact nobody established — and the
    // range half is still judged, because it does not depend on the profile.
    expect(map([npm('x', { dsh: '0.9.0', profiles: ['acp'] })], withProfile('web', null))).toEqual({
      'npm:x': { dsh: { range: '0.9.0', running: '0.1.5-rc.3' } },
    })
  })

  it('says nothing about profiles when the harness exports no template table', () => {
    // An app-boot that never grew the export, or a shape this build does not
    // know: no verdict, never a guess.
    expect(map([npm('x', { profiles: ['acp'] })], RUNNING, {})).toEqual({})
  })

  it('treats an empty profile list as no declaration', () => {
    // `[]` names no profile at all, which is not a claim that none is
    // supported. The harvest never publishes one, but the consumer schema
    // parses it, so it must not read as an accusation either.
    expect(map([npm('none', { profiles: [] })])).toEqual({})
  })

  it('reports both halves when an entry fails both', () => {
    // Separate verdicts (design §8.2): the client names which one failed, so
    // one half must never stand in for the other.
    expect(map([npm('x', { dsh: '0.9.0', profiles: ['acp'] })])).toEqual({
      'npm:x': {
        dsh: { range: '0.9.0', running: '0.1.5-rc.3' },
        profile: { declared: ['acp'], running: 'web' },
      },
    })
  })

  it('gives no range verdict when the harness version is unknown, and still judges the profile half', () => {
    // An unavailable fact reads as "unknown", never as an accusation (§3).
    const map = compatibilityMap(
      [npm('x', { dsh: '0.9.0', profiles: ['acp'] })],
      { dshVersion: null, profile: { name: 'web', bundles: RUNNING.profile.bundles } },
      RC3_TEMPLATES,
    )
    expect(map).toEqual({ 'npm:x': { profile: { declared: ['acp'], running: 'web' } } })
  })

  it('gives no range verdict when the running version is not semver', () => {
    // `satisfies` answers false for a version it cannot parse, which would
    // read as an accusation.
    expect(compatibilityMap(
      [npm('x', { dsh: '0.9.0' })],
      { dshVersion: 'nightly', profile: { name: 'web', bundles: RUNNING.profile.bundles } },
      RC3_TEMPLATES,
    )).toEqual({})
  })

  it.each([
    ['prose', 'not a range'],
    ['a dist-tag', 'latest'],
    ['a workspace spec', 'workspace:^0.1.1-rc.2'],
  ])('gives no range verdict for a range semver cannot parse (%s), and still judges the profile half', (_label, range) => {
    expect(map([npm('bad', { dsh: range, profiles: ['acp'] })])).toEqual({
      'npm:bad': { profile: { declared: ['acp'], running: 'web' } },
    })
  })

  it.each(['>=0.1.0', '*'])('meets %s on a prerelease harness, because prereleases are included', range => {
    // The harness ships nothing but prereleases, and strict semver refuses a
    // prerelease against a range whose comparators carry none — even `*`.
    // The premise is asserted rather than assumed: were strict semver ever to
    // accept this pair, the case would stop proving that includePrerelease is
    // what keeps the verdict quiet.
    expect(satisfies(RUNNING.dshVersion, range)).toBe(false)
    expect(map([npm('pre', { dsh: range })])).toEqual({})
  })
})

describe('compatibilityMap identity (G-1)', () => {
  it('keys each verdict by install identity, so same-named entries stay independent', () => {
    const map = compatibilityMap([
      { source: 'github', name: 'dsh-foo', repo: 'alice/dsh-foo', compatibility: { profiles: ['acp'] } },
      { source: 'github', name: 'dsh-foo', repo: 'bob/dsh-foo', compatibility: { profiles: ['web'] } },
      { source: 'npm', name: 'dsh-foo', compatibility: { dsh: '0.9.0' } },
    ], RUNNING, RC3_TEMPLATES)
    expect(map).toEqual({
      'github:alice/dsh-foo#': { profile: { declared: ['acp'], running: 'web' } },
      'npm:dsh-foo': { dsh: { range: '0.9.0', running: '0.1.5-rc.3' } },
    })
  })

  it('keys a subpackage entry by its subdir', () => {
    expect(compatibilityMap(
      [{ source: 'github', name: 'sub', repo: 'someone/mono', subdir: 'packages/a', compatibility: { profiles: ['acp'] } }],
      RUNNING,
      RC3_TEMPLATES,
    )).toEqual({ 'github:someone/mono#packages/a': { profile: { declared: ['acp'], running: 'web' } } })
  })
})

describe('profileTemplatesOf', () => {
  it('reads the 0.1.5 shape, where a template is an object carrying bundles', () => {
    expect(profileTemplatesOf({
      web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' },
      'sdk-minimal': { bundles: ['@deepseek-ai/dsh-sdk-minimal'], patchReload: 'startup' },
    })).toEqual({
      web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      'sdk-minimal': ['@deepseek-ai/dsh-sdk-minimal'],
    })
  })

  it('reads the older shape, where a template IS its bundle list', () => {
    // The version this package pins as a devDependency (0.1.1-rc.2) exports
    // exactly this, with two templates. Both shapes are live, so both are read.
    expect(profileTemplatesOf({
      web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
    })).toEqual({
      web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
    })
  })

  it('drops a template it cannot read, keeping the rest', () => {
    // A shape this build does not know is one template lost, not a table lost.
    expect(profileTemplatesOf({
      good: ['@deepseek-ai/dsh-base'],
      odd: { bundles: 'not-an-array' },
      hostile: { bundles: ['ok', 7] },
      empty: [],
      nulled: null,
    })).toEqual({ good: ['@deepseek-ai/dsh-base'], empty: [] })
  })

  it('answers an empty table for anything that is not an export table', () => {
    for (const value of [null, undefined, 'web', 42, ['web']]) {
      expect(profileTemplatesOf(value), String(value)).toEqual({})
    }
  })
})
