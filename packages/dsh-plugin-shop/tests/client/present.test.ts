import { describe, expect, it } from 'vitest'
import {
  ACKNOWLEDGEMENT_EN, INSTALL_POLL_MS, SHOP_VISIBLE_BATCH, categoryKey, isShopLike, isUnclaimed, nextVisibleCount, reduceInstall, tierKey,
} from '../../src/client/present.ts'
import type { CatalogEntry } from '../../src/host/index.ts'

const entry: CatalogEntry = {
  name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null,
  repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
}

describe('tierKey', () => {
  it('maps each tier to its locale key', () => {
    expect(tierKey('verified')).toBe('tierVerified')
    expect(tierKey('verified-stale')).toBe('tierVerifiedStale')
    expect(tierKey('community')).toBe('tierCommunity')
  })
})

describe('isUnclaimed', () => {
  it('marks a derived listing as unclaimed and a declared one as claimed', () => {
    expect(isUnclaimed(entry)).toBe(true)
    expect(isUnclaimed({ ...entry, metadata: 'declared' })).toBe(false)
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

  it('matches plugin-keyword concatenations', () => {
    expect(isShopLike('pluginstore')).toBe(true)
    expect(isShopLike('dsh-pluginmarket')).toBe(true)
    expect(isShopLike('storeplugin')).toBe(true)
    expect(isShopLike('market-plugin')).toBe(true)
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
    expect(categoryKey(entry)).toBe('categoryOther')
  })
})
