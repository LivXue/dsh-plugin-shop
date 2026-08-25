import { describe, expect, it } from 'vitest'
import {
  ACKNOWLEDGEMENT_EN, INSTALL_POLL_MS, isUnclaimed, reduceInstall, tierKey,
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
    const next = reduceInstall({ kind: 'idle' }, { type: 'rejected', code: 'denied', detail: 'dsh-plugin-store: dsh-blocked is denied: matched the denylist' })
    expect(next).toEqual({ kind: 'rejected', code: 'denied', detail: 'dsh-plugin-store: dsh-blocked is denied: matched the denylist' })
  })

  it('ignores unrelated events', () => {
    expect(reduceInstall({ kind: 'idle' }, { type: 'status', status: { found: true, state: 'running', log: [] } })).toEqual({ kind: 'idle' })
  })
})
