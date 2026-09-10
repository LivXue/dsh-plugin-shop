import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPrefetcher, isPrefetchableSpec } from '../../src/host/prefetch.ts'
import { fakePnpm } from '../fixtures/fake-pnpm.ts'
import { fileTempRoot } from './temp-root.ts'

const TEMP_ROOT = fileTempRoot('prefetch')

const temp = () => mkdtempSync(join(TEMP_ROOT, 'dsh-prefetch-'))
const batches = (dir: string): string[] => {
  const log = join(dir, 'pnpm.log')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(line => line !== '')
}
const settle = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))

describe('isPrefetchableSpec', () => {
  it('accepts the npm and github forms', () => {
    expect(isPrefetchableSpec('dsh-hello@1.2.0')).toBe(true)
    expect(isPrefetchableSpec('github:owner/slug#0123456789abcdef0123456789abcdef01234567')).toBe(true)
    expect(isPrefetchableSpec('github:owner/slug#0123456789abcdef0123456789abcdef01234567&path:packages/a')).toBe(true)
  })

  // Measured 2026-09-10: pnpm re-fetches a raw tarball URL on every install
  // even when the store holds that exact tarball, and `store add` on a URL
  // resolves no dependency closure. Prefetching one is a full extra download
  // for no saving. Design doc §3.
  it('refuses a raw https tarball URL, which a prefetch cannot help', () => {
    expect(isPrefetchableSpec('https://github.com/o/s/releases/download/v1/a.tgz')).toBe(false)
    expect(isPrefetchableSpec('http://example.test/a.tgz')).toBe(false)
  })
})

describe('the prefetch pump', () => {
  it('sends one batch carrying every pending spec', async () => {
    const dir = temp()
    const prefetcher = createPrefetcher({ pnpmBin: fakePnpm(dir, { delayMs: 30 }) })
    expect(prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir })).toEqual({ started: true })
    expect(prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir })).toEqual({ started: true })
    await settle(200)
    expect(batches(dir)).toEqual(['store add a@1 b@1'])
  })

  it('holds a late arrival for the next batch rather than a second child', async () => {
    const dir = temp()
    const prefetcher = createPrefetcher({ pnpmBin: fakePnpm(dir, { delayMs: 120 }) })
    prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir })
    await settle(40)
    prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir })
    // Measured 2026-09-10 in this sandbox: spawning node for the fixture and
    // reaching its first `fs.appendFileSync` (module load + ESM import) takes
    // ~89-96ms on its own, before the fixture's own `delayMs` even starts
    // counting — so the original 40ms here left no room for that startup cost
    // and failed deterministically (5/5 runs), not just under load. 110ms
    // clears the measured latency with margin and still lands well before
    // this batch's own exit at delayMs(120) + startup (~210-225ms).
    await settle(110)
    expect(batches(dir)).toEqual(['store add a@1'])
    await settle(300)
    expect(batches(dir)).toEqual(['store add a@1', 'store add b@1'])
  })

  it('refuses a tarball spec by name, without spawning anything', async () => {
    const dir = temp()
    const prefetcher = createPrefetcher({ pnpmBin: fakePnpm(dir) })
    expect(prefetcher.request({
      profile: 'web', spec: 'https://github.com/o/s/releases/download/v1/a.tgz', cwd: dir,
    })).toEqual({ started: false, reason: 'unsupported-spec' })
    await settle(120)
    expect(batches(dir)).toEqual([])
  })

  it('reports pnpm absent to the install it was serving, and refuses the next by name', async () => {
    const dir = temp()
    const lines: string[] = []
    const prefetcher = createPrefetcher({ pnpmBin: join(dir, 'definitely-not-here') })
    expect(prefetcher.request({
      profile: 'web', spec: 'a@1', cwd: dir, log: line => lines.push(line),
    })).toEqual({ started: true })
    await settle(200)
    expect(lines.filter(line => line.includes('pnpm not found'))).toHaveLength(1)
    expect(prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir })).toEqual({
      started: false, reason: 'no-pnpm',
    })
    await settle(120)
    expect(batches(dir)).toEqual([])
  })

  it('tells every install a failed batch served, and installs anyway', async () => {
    const dir = temp()
    const a: string[] = []
    const b: string[] = []
    const prefetcher = createPrefetcher({ pnpmBin: fakePnpm(dir, { exitCode: 1 }) })
    prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir, log: line => a.push(line) })
    prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir, log: line => b.push(line) })
    await settle(250)
    expect(batches(dir)).toEqual(['store add a@1 b@1'])
    expect(a.some(line => line.includes('exit 1'))).toBe(true)
    expect(b.some(line => line.includes('exit 1'))).toBe(true)
  })

  it('kills a batch that outruns its bound', async () => {
    const dir = temp()
    const killed: number[] = []
    const prefetcher = createPrefetcher({
      pnpmBin: fakePnpm(dir, { hang: true }),
      timeoutMs: 60,
      kills: { killGroup: pid => killed.push(pid), killPid: pid => killed.push(pid), taskkill: pid => killed.push(pid) },
    })
    prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir })
    await settle(300)
    expect(killed).toHaveLength(1)
  })

  it('kills a batch once nothing needs it', async () => {
    const dir = temp()
    const killed: number[] = []
    const prefetcher = createPrefetcher({
      pnpmBin: fakePnpm(dir, { hang: true }),
      kills: { killGroup: pid => killed.push(pid), killPid: pid => killed.push(pid), taskkill: pid => killed.push(pid) },
    })
    prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir })
    await settle(80)
    prefetcher.release('web', 'a@1')
    await settle(80)
    expect(killed).toHaveLength(1)
  })
})
