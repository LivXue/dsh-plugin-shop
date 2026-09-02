/** Settle a set of promises in the order they finish (design §3).
 *
 * Pure and timer-free. `Promise.any` would give only the first success and
 * discard the rest; the origin race needs the losers too, in order, so a
 * winner that fails its bulk fetch can fall through to the runner-up. */

export type Settled<T> = { index: number; value: T } | { index: number; reason: unknown }

/**
 * Yield each promise's outcome as it settles, tagged with its argument index.
 *
 * Every promise is given its handlers immediately, so a rejection that is
 * yielded late is still handled early — the sequence never produces an
 * unhandled rejection warning.
 */
export async function* inCompletionOrder<T>(promises: readonly Promise<T>[]): AsyncGenerator<Settled<T>> {
  const pending = new Map<number, Promise<Settled<T>>>()
  promises.forEach((promise, index) => {
    pending.set(index, promise.then(
      (value): Settled<T> => ({ index, value }),
      (reason: unknown): Settled<T> => ({ index, reason }),
    ))
  })
  while (pending.size > 0) {
    const settled = await Promise.race(pending.values())
    pending.delete(settled.index)
    yield settled
  }
}
