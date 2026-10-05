import { describe, expect, it } from 'vitest'
import { welcomeNoticeVersion } from '../fixtures/onboarding.ts'

describe('welcomeNoticeVersion', () => {
  // Each row is the constant that harness's own build compares, read out of
  // its dsh-client-ui-settings-models. 0.2.0-rc.1 is the first build that
  // carries the new one, and it is the row a boundary written as `0.2.0`
  // would get wrong: every 0.2.0 prerelease sorts below 0.2.0, so the seed
  // would carry the old version on exactly the builds that changed it.
  it.each([
    ['0.1.5-rc.3', '2026-08-13.1'],
    ['0.1.7-rc.2', '2026-08-13.1'],
    ['0.2.0-rc.1', '2026-09-28.1'],
    ['0.2.0-rc.2', '2026-09-28.1'],
    ['0.2.1-alpha.1', '2026-09-28.1'],
  ])('is what dsh %s compares: %s', (dsh, notice) => {
    expect(welcomeNoticeVersion(dsh)).toBe(notice)
  })
})
