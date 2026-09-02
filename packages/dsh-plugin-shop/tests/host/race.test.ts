import { describe, expect, it } from 'vitest'
import { inCompletionOrder } from '../../src/host/race.ts'

/** A promise that settles when the returned trigger is called — real timers
 * would make the ordering assertions racy. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('inCompletionOrder', () => {
  it('yields in finish order, not argument order', async () => {
    const a = deferred<string>()
    const b = deferred<string>()
    const c = deferred<string>()
    const seen: string[] = []
    const drain = (async () => {
      for await (const settled of inCompletionOrder([a.promise, b.promise, c.promise])) {
        if ('value' in settled) seen.push(settled.value)
      }
    })()
    c.resolve('third-arg')
    await Promise.resolve()
    a.resolve('first-arg')
    await Promise.resolve()
    b.resolve('second-arg')
    await drain
    expect(seen).toEqual(['third-arg', 'first-arg', 'second-arg'])
  })

  it('yields rejections in place rather than aborting the sequence', async () => {
    const bad = Promise.reject(new Error('boom'))
    const good = Promise.resolve('ok')
    const results: string[] = []
    for await (const settled of inCompletionOrder([bad, good])) {
      results.push('value' in settled ? `ok:${settled.value}` : `err:${String(settled.reason)}`)
    }
    expect(results).toHaveLength(2)
    expect(results.filter(r => r.startsWith('ok:'))).toEqual(['ok:ok'])
  })

  it('carries the argument index so a caller can identify the origin', async () => {
    const indices: number[] = []
    for await (const settled of inCompletionOrder([Promise.resolve('x'), Promise.resolve('y')])) {
      indices.push(settled.index)
    }
    expect(indices.sort()).toEqual([0, 1])
  })

  it('completes immediately on an empty list', async () => {
    const seen: unknown[] = []
    for await (const settled of inCompletionOrder([])) seen.push(settled)
    expect(seen).toEqual([])
  })
})
