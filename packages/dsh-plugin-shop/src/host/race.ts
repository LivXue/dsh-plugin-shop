/** Settle a set of promises in the order they finish (design §3).
 *
 * Pure and timer-free. `Promise.any` would give only the first success and
 * discard the rest; the origin race needs the losers too, in order, so a
 * probe that "won" but then fails to produce a pointer can fall through to
 * the next-finishing probe instead of failing the whole load — this is how
 * an npm origin's bulk tarball download, which happens inside `pointer()`,
 * gets a fall-through on failure.
 *
 * That is deliberately narrower than "any bulk fetch falls through to
 * another origin." This module only ever wraps `probe()` promises; once
 * `catalog.ts` has committed to a handle and calls `file()` for the data
 * file, that call happens outside this generator entirely, and a
 * TransportError there falls back to the disk cache instead (see
 * `catalog.ts`'s `cachedOrThrow`), never back into a race. Do not "fix"
 * that path to match this comment — the split is intentional. */

export type Settled<T> = { index: number; value: T } | { index: number; reason: unknown }

/**
 * Yield each promise's outcome as it settles, tagged with its argument index.
 *
 * Deliberately NOT an `async function*`. Two properties depend on that:
 *
 * 1. **Handlers attach synchronously, at call time.** An async generator's
 *    body does not run until its first `next()`, so wiring the handlers
 *    inside one would leave a rejection unhandled for as long as the caller
 *    waits before iterating — which crashes the process under Node's default
 *    unhandled-rejection policy.
 * 2. **Order is recorded when each promise settles**, not when a consumer
 *    asks. Re-racing the survivors on every turn tie-breaks on argument
 *    order instead: `Promise.race` over promises that are ALREADY settled
 *    resolves with the first in iteration order, not the first to have
 *    settled — and a consumer doing any work between yields, which is
 *    exactly this module's use case, is what lets two settle inside one turn.
 */
export function inCompletionOrder<T>(promises: readonly Promise<T>[]): AsyncGenerator<Settled<T>> {
  const settled: Settled<T>[] = []
  let wake: (() => void) | null = null
  const record = (outcome: Settled<T>): void => {
    settled.push(outcome)
    const resume = wake
    wake = null
    resume?.()
  }
  for (const [index, promise] of promises.entries()) {
    void promise.then(
      value => { record({ index, value }) },
      (reason: unknown) => { record({ index, reason }) },
    )
  }

  return (async function* () {
    for (let delivered = 0; delivered < promises.length; delivered += 1) {
      if (settled.length === delivered) {
        await new Promise<void>(resolve => { wake = resolve })
      }
      const outcome = settled[delivered]
      // Unreachable: the loop only waits when nothing new has arrived, and
      // `record` is the sole waker and always pushes before waking. Guarded
      // rather than asserted because `noUncheckedIndexedAccess` is on and a
      // silent `undefined` here would be a yielded hole.
      if (outcome === undefined) throw new Error('inCompletionOrder: woke with nothing settled')
      yield outcome
    }
  })()
}
