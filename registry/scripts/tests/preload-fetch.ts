/**
 * A `globalThis.fetch` replacement installed with Node's `--import`, so an
 * entry point can be run as a real subprocess against fixed responses.
 *
 * Loaded BEFORE the module under test rather than injected into it: `build.ts`
 * and `classify.ts` are top-level-await scripts that pass the global `fetch`
 * down themselves, so there is no seam to inject through and mocking their
 * modules would test a different program than CI runs.
 *
 * Every request is appended to `FETCH_LOG` before it is answered, and a URL no
 * rule matches REJECTS rather than returning an empty result. Both halves
 * matter. The log is how a test asserts which cells were probed — the only
 * observable difference between a seeded vocabulary and an empty one. And an
 * unmatched URL answering `{}` would let a fixture that never covered the path
 * under test pass by enumerating nothing, which is the failure mode
 * `searchByKeywords` exists to refuse.
 *
 * @module preload-fetch
 */
import { appendFileSync, readFileSync } from 'node:fs'

/** One rule: answer `body` for any URL containing `contains`. */
interface FetchRule {
  readonly contains: string
  readonly body: unknown
  /** HTTP status, default 200. */
  readonly status?: number
}

const fixturePath = process.env.FETCH_FIXTURE
if (fixturePath === undefined || fixturePath === '') {
  throw new Error('preload-fetch: FETCH_FIXTURE must name a rules file')
}
const logPath = process.env.FETCH_LOG
const rules = JSON.parse(readFileSync(fixturePath, 'utf8')) as { readonly rules: readonly FetchRule[] }

globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (logPath !== undefined && logPath !== '') appendFileSync(logPath, `${url}\n`)
  // First match wins, so a fixture can put a specific rule ahead of a general
  // one — `maintainer:alice` before `keywords:deepseek-harness`, which is a
  // substring of it.
  for (const rule of rules.rules) {
    if (url.includes(rule.contains)) {
      return new Response(JSON.stringify(rule.body), {
        status: rule.status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    }
  }
  throw new Error(`preload-fetch: no rule for ${url}`)
}) as typeof fetch
