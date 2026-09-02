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

  // The case above settles its tail in ascending argument order, which is
  // also what an argument-order tie-break would produce — so on its own it
  // cannot tell the two apart. This one can: the consumer does real work
  // between yields (a macrotask, as the origin race's bulk fetch does),
  // letting two promises settle inside one turn, and the true settle order
  // runs DOWN the argument list.
  it('preserves settle order when the consumer works between yields', async () => {
    const order: string[] = []
    const make = (label: string) => {
      const d = deferred<string>()
      return { promise: d.promise, fire: () => { order.push(label); d.resolve(label) } }
    }
    const a = make('arg0')
    const b = make('arg1')
    const c = make('arg2')
    const seen: string[] = []
    const drain = (async () => {
      for await (const settled of inCompletionOrder([a.promise, b.promise, c.promise])) {
        if ('value' in settled) seen.push(settled.value)
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    })()
    c.fire()
    await new Promise(resolve => setTimeout(resolve, 1))
    b.fire()
    a.fire()
    await drain
    expect(seen).toEqual(order)
    expect(seen).toEqual(['arg2', 'arg1', 'arg0'])
  })

  // Handlers must be attached at call time, not at first iteration: an
  // `async function*` body is lazy, and a rejection left unhandled while the
  // caller does something else first crashes the process by default.
  it('handles a rejection even when construction and iteration are separated', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const sequence = inCompletionOrder([Promise.reject(new Error('boom'))])
      await new Promise(resolve => setTimeout(resolve, 20))
      const seen: string[] = []
      for await (const settled of sequence) seen.push('value' in settled ? 'ok' : 'err')
      expect(seen).toEqual(['err'])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })

  it('delivers every outcome when all promises settled before the first read', async () => {
    const sequence = inCompletionOrder([Promise.resolve('a'), Promise.resolve('b'), Promise.resolve('c')])
    await new Promise(resolve => setTimeout(resolve, 10))
    const seen: string[] = []
    for await (const settled of sequence) if ('value' in settled) seen.push(settled.value)
    expect(seen).toEqual(['a', 'b', 'c'])
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
