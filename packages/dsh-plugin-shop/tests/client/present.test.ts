import { describe, expect, it } from 'vitest'
import {
  ACKNOWLEDGEMENT_EN, INSTALL_POLL_MS, SHOP_VISIBLE_BATCH, categoryKey, displayVersion, formatStars, isCustomLicense, isShopLike, nextVisibleCount, reduceInstall, reviewHashPin, sortByStars, tierKey,
} from '../../src/client/present.ts'
import type { CatalogEntry } from '../../src/host/index.ts'

const entry: CatalogEntry = {
  name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null,
  repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm',
  added: '2026-08-25',
}

describe('tierKey', () => {
  it('maps each tier to its locale key', () => {
    expect(tierKey('verified')).toBe('tierVerified')
    expect(tierKey('verified-stale')).toBe('tierVerifiedStale')
    expect(tierKey('community')).toBe('tierCommunity')
  })
})

describe('ACKNOWLEDGEMENT_EN', () => {
  it('is the spec §9.3 wording verbatim', () => {
    expect(ACKNOWLEDGEMENT_EN).toBe(
      'Once installed, this plugin holds the same privileges as a built-in one: reading and writing your files, running shell commands, and reading and modifying the requests sent to the model. It has not been reviewed.',
    )
  })
})

describe('nextVisibleCount', () => {
  it('grows by the batch and clamps at the total', () => {
    expect(SHOP_VISIBLE_BATCH).toBe(48)
    expect(nextVisibleCount(0, 5, 48)).toBe(5)
    expect(nextVisibleCount(48, 100, 48)).toBe(96)
    expect(nextVisibleCount(96, 100, 48)).toBe(100)
    expect(nextVisibleCount(100, 100, 48)).toBe(100)
  })
})

describe('INSTALL_POLL_MS', () => {
  it('polls once per second per §7.2', () => {
    expect(INSTALL_POLL_MS).toBe(1000)
  })
})

describe('reduceInstall', () => {
  it('starts from idle into running with the install id', () => {
    const next = reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'abc' })
    expect(next).toEqual({ kind: 'running', installId: 'abc', log: [] })
  })

  it('carries running status updates with their log', () => {
    const running = reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'abc' })
    const next = reduceInstall(running, { type: 'status', status: { found: true, state: 'running', log: ['a'] } })
    expect(next).toEqual({ kind: 'running', installId: 'abc', log: ['a'] })
  })

  it('reaches done with needsRestart', () => {
    const running = reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'abc' })
    const next = reduceInstall(running, { type: 'status', status: { found: true, state: 'done', log: ['a'], needsRestart: true } })
    expect(next).toEqual({ kind: 'done', needsRestart: true })
    // Without a host reason the done view keeps the old shape: no
    // restartReason key at all (toEqual would ignore an undefined one).
    expect('restartReason' in next).toBe(false)
  })

  it('reaches done carrying the host restart reason code when the hot mount failed', () => {
    const running = reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'abc' })
    const next = reduceInstall(running, { type: 'status', status: { found: true, state: 'done', log: ['a'], needsRestart: true, restartReason: 'mount-failed' } })
    expect(next).toEqual({ kind: 'done', needsRestart: true, restartReason: 'mount-failed' })
  })

  it('reaches done with needsRestart false when the host reports the live outcome', () => {
    // The live install/uninstall outcome: nothing to restart, so the done
    // view says so and the panels branch on it.
    const running = reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'abc' })
    const next = reduceInstall(running, { type: 'status', status: { found: true, state: 'done', log: ['a'], needsRestart: false } })
    expect(next).toEqual({ kind: 'done', needsRestart: false })
  })

  it('reaches failed with the host detail and the log', () => {
    const running = reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'abc' })
    const next = reduceInstall(running, { type: 'status', status: { found: true, state: 'failed', log: ['boom'], detail: 'pnpm failed — run: dsh plugin --profile web install' } })
    expect(next).toEqual({ kind: 'failed', detail: 'pnpm failed — run: dsh plugin --profile web install', log: ['boom'] })
  })

  it('treats a lost install record as failed', () => {
    const running = reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'abc' })
    const next = reduceInstall(running, { type: 'status', status: { found: false, state: 'failed', log: [] } })
    expect(next?.kind).toBe('failed')
  })

  it('records a rejection with its author-readable detail', () => {
    const next = reduceInstall({ kind: 'idle' }, { type: 'rejected', code: 'denied', detail: 'dsh-plugin-shop: dsh-blocked is denied: matched the denylist' })
    expect(next).toEqual({ kind: 'rejected', code: 'denied', detail: 'dsh-plugin-shop: dsh-blocked is denied: matched the denylist' })
  })

  it('ignores unrelated events', () => {
    expect(reduceInstall({ kind: 'idle' }, { type: 'status', status: { found: true, state: 'running', log: [] } })).toEqual({ kind: 'idle' })
  })
})

describe('isShopLike', () => {
  it('matches a segment equal to a shop keyword, qualified as a plugin or by ending the name', () => {
    expect(isShopLike('dsh-plugin-shop')).toBe(true)
    expect(isShopLike('dsh-store')).toBe(true)
    expect(isShopLike('@scope/dsh-plugin-market')).toBe(true)
    expect(isShopLike('dsh-plugin-mall')).toBe(true)
    expect(isShopLike('plugin-shop')).toBe(true)
  })

  it('matches glued dsh-keyword forms', () => {
    // `dshmarket` is one segment — no hyphen to split on — so the segment
    // rule never saw it; these are the unhyphenated spellings of the same
    // competing-market names.
    expect(isShopLike('dshmarket')).toBe(true)
    expect(isShopLike('dshstore')).toBe(true)
    expect(isShopLike('dshmall')).toBe(true)
    expect(isShopLike('dshshop')).toBe(true)
    expect(isShopLike('dshmarketplace')).toBe(true)
  })

  it('matches a dsh-prefixed name whose second segment is a keyword', () => {
    expect(isShopLike('dsh-market-plus')).toBe(true)
    expect(isShopLike('@scope/dsh-market-plus')).toBe(true)
    expect(isShopLike('dsh-store-pro')).toBe(true)
  })

  it('does not match a dsh-prefixed name whose second segment merely starts with a keyword', () => {
    // `marketing` starts with `market` but is not a market.
    expect(isShopLike('dsh-marketing-tool')).toBe(false)
  })

  it('does not match a dsh-keyword name whose third segment is not a store qualifier', () => {
    // The real false positive found in the live catalog: an ecommerce
    // operators' tool, not a competing store.
    expect(isShopLike('dsh-shop-assistant')).toBe(false)
    expect(isShopLike('dsh-market-data')).toBe(false)
    expect(isShopLike('dsh-store-tools')).toBe(false)
  })

  it('does not match a glued keyword with extra letters after it', () => {
    // `dshstorekeeper` is dsh+storekeeper, not dsh+store — the same
    // precision principle as the hyphenated `dsh-storekeeper-tool` case.
    expect(isShopLike('dshstorekeeper-tool')).toBe(false)
    expect(isShopLike('dshrestore')).toBe(false)
  })

  it('matches plugin-keyword concatenations', () => {
    expect(isShopLike('pluginstore')).toBe(true)
    expect(isShopLike('dsh-pluginmarket')).toBe(true)
    expect(isShopLike('storeplugin')).toBe(true)
    expect(isShopLike('market-plugin')).toBe(true)
  })

  it('matches the named competing marketplaces that no pattern catches', () => {
    // Plugin-market packages whose names carry no store/market keyword sit
    // on the explicit list rather than the pattern rules. Only the exact
    // names match — anything else stays listed.
    expect(isShopLike('dsh-plugin')).toBe(true)
    expect(isShopLike('dsh-plugin-hub')).toBe(true)
    expect(isShopLike('@lanbaolu/dsh-plugin-hub')).toBe(true)
    expect(isShopLike('@mutocenew/dsh-plugin-catalog')).toBe(true)
    // Not on the list: other scopes, other spellings, and hub-flavored
    // tools that manage content rather than markets.
    expect(isShopLike('@dshplugin/dsh-plugin')).toBe(false)
    expect(isShopLike('dsh-plugin-tools')).toBe(false)
    expect(isShopLike('@lcthe/dsh-skills-hub')).toBe(false)
    expect(isShopLike('dsh-extension-hub')).toBe(false)
  })

  it('does not match ordinary plugin names', () => {
    // Precision over recall: a name that merely CONTAINS a keyword segment
    // without a plugin qualifier or keyword ending is not a shop plugin.
    expect(isShopLike('dsh-restore')).toBe(false)
    expect(isShopLike('dsh-storekeeper-tool')).toBe(false)
    expect(isShopLike('market-data-provider')).toBe(false)
    expect(isShopLike('marketplace-hub')).toBe(false)
    expect(isShopLike('dsh-shopping-list')).toBe(false)
    expect(isShopLike('dsh-hello-plugin')).toBe(false)
  })
})

describe('categoryKey', () => {
  it('maps a declared category and falls back to other for derived entries', () => {
    expect(categoryKey({ ...entry, catalog: { category: 'provider', summary: { en: 'x' }, capabilities: [] } })).toBe('categoryProvider')
    expect(categoryKey({ ...entry, catalog: { category: 'theme', summary: { en: 'x' }, capabilities: [] } })).toBe('categoryTheme')
    expect(categoryKey(entry)).toBe('categoryOther')
  })
})

describe('reviewHashPin', () => {
  const review = { reviewer: 'someone', reviewCommit: 'abc123', notes: 'x' }

  it('shortens the reviewed commit to the 7-char card form', () => {
    expect(reviewHashPin({ ...review, reviewedCommit: 'b'.repeat(40) })).toBe('bbbbbbb')
  })

  it('names the reviewed release tarball sha256 for release-rescued entries', () => {
    expect(reviewHashPin({ ...review, reviewedSha256: 'a'.repeat(64) })).toBe('aaaaaaa')
  })

  it('prefers the commit pin when both hashes are present', () => {
    expect(reviewHashPin({ ...review, reviewedCommit: 'c'.repeat(40), reviewedSha256: 'a'.repeat(64) })).toBe('ccccccc')
  })

  it('returns an empty string when no hash pin exists', () => {
    expect(reviewHashPin(review)).toBe('')
  })
})

describe('sortByStars', () => {
  const make = (name: string): CatalogEntry => ({ ...entry, name })

  it('sorts by stars descending, unstarred last, name asc on ties', () => {
    const entries = [make('dsh-alpha'), make('dsh-mid'), make('dsh-top'), make('dsh-nostar'), make('dsh-mid-tie')]
    const stars = { 'dsh-mid': 5, 'dsh-top': 100, 'dsh-mid-tie': 5 }
    expect(sortByStars(entries, stars).map(e => e.name)).toEqual([
      'dsh-top', 'dsh-mid', 'dsh-mid-tie', 'dsh-alpha', 'dsh-nostar',
    ])
  })

  it('is case-insensitive on the name tiebreak', () => {
    const a = make('dsh-Beta')
    const b = make('dsh-alpha')
    expect(sortByStars([a, b], {}).map(e => e.name)).toEqual(['dsh-alpha', 'dsh-Beta'])
  })

  it('keeps pure name order when stars is empty', () => {
    const entries = [make('dsh-zebra'), make('dsh-alpha')]
    expect(sortByStars(entries, {}).map(e => e.name)).toEqual(['dsh-alpha', 'dsh-zebra'])
  })
})

describe('formatStars', () => {
  it('formats the magnitude boundaries', () => {
    expect(formatStars(0)).toBe('0')
    expect(formatStars(999)).toBe('999')
    expect(formatStars(1000)).toBe('1k')
    expect(formatStars(1234)).toBe('1.2k')
    expect(formatStars(1500)).toBe('1.5k')
    expect(formatStars(99999)).toBe('100k')
  })
})

describe('displayVersion', () => {
  it('shows npm versions in full and github commits short', () => {
    expect(displayVersion({ source: 'npm', version: '1.2.3' })).toBe('1.2.3')
    expect(displayVersion({ source: 'github', version: 'd'.repeat(40) })).toBe('ddddddd')
  })
})

describe('isCustomLicense', () => {
  it('matches the npm SEE LICENSE IN idiom and nothing else', () => {
    expect(isCustomLicense('SEE LICENSE IN LICENSE')).toBe(true)
    expect(isCustomLicense('SEE LICENSE IN LICENSE.md')).toBe(true)
    expect(isCustomLicense('MIT')).toBe(false)
    expect(isCustomLicense('NOASSERTION')).toBe(false)
    expect(isCustomLicense(null)).toBe(false)
  })
})
