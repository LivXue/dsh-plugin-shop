/**
 * Counterparts that answer with HEADERS and then behave badly — or merely
 * slowly — in the BODY. That is the shape a header-phase deadline cannot see.
 *
 * `fetch` resolves as soon as the response headers arrive, so a wrapper that
 * clears its timer at that point bounds nothing that follows: the body runs
 * against a controller that will never abort, and undici's own `bodyTimeout`
 * is inactivity-based, so a slow trickle never trips it either.
 *
 * Both fixtures model what undici does when a request's signal aborts
 * mid-body: the in-flight stream is errored with `signal.reason`. That is not
 * an assumption. It was measured against a real localhost socket that answered
 * `200 OK` and then stalled, with `controller.abort(<a FetchTimeoutError>)` —
 * the body read rejected with that exact error instance at 153ms, while the
 * identical stall with the timer cleared was still hanging at 1206ms.
 *
 * Not a `.test.ts` file, so vitest does not collect it (see vitest.config.ts).
 * It lives beside the tests rather than inside one because both npm-client's
 * wrapper tests and github-client's tarball tests need it, and two copies of a
 * fixture this subtle would drift.
 * @module stalling-fetch
 */

const CHUNK_BYTES = 1024

/** Wire the request's signal to the body stream, the way a real client does. */
function failOnAbort(
  init: RequestInit | undefined,
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  const signal = init?.signal
  if (signal == null) return
  signal.addEventListener('abort', () => {
    try {
      controller.error(signal.reason)
    } catch {
      // Swallows only "this stream is already closed or errored": the body
      // completed before the deadline, which is the healthy case, and there is
      // nothing left to abort. Nothing else in this block can throw.
    }
  }, { once: true })
}

/** Answers 200 and then never writes a byte of the body: a socket that is
 * open, is not idle in any way a client can see, and never completes. */
export function headersThenStalledBody(): typeof fetch {
  return (async (_input: string | URL, init?: RequestInit) => new Response(
    new ReadableStream<Uint8Array>({
      start: controller => { failOnAbort(init, controller) },
      pull: () => new Promise<void>(() => {}),
    }),
    { status: 200 },
  )) as unknown as typeof fetch
}

/** Answers 200 and then trickles `chunks` kilobytes out, `gapMs` apart, before
 * closing cleanly — a large body that is slow but perfectly healthy. */
export function headersThenSlowBody(chunks: number, gapMs: number): typeof fetch {
  return (async (_input: string | URL, init?: RequestInit) => {
    let remaining = chunks
    return new Response(
      new ReadableStream<Uint8Array>({
        start: controller => { failOnAbort(init, controller) },
        pull: controller => new Promise<void>(resolve => {
          setTimeout(() => {
            if (remaining > 0) {
              remaining -= 1
              controller.enqueue(new Uint8Array(CHUNK_BYTES))
            } else {
              controller.close()
            }
            resolve()
          }, gapMs)
        }),
      }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
}

/** The bytes {@link headersThenSlowBody} produces for `chunks`, so a test can
 * state the digest it expects without restating the fixture's internals. */
export function slowBodyBytes(chunks: number): Uint8Array {
  return new Uint8Array(chunks * CHUNK_BYTES)
}
