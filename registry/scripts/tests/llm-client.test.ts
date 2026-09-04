import { describe, expect, it } from 'vitest'
import { classifyPackages, CLASSIFY_BATCH_SIZE, CLASSIFY_BUDGET_MS, GATEWAY_REQUEST_TIMEOUT_MS } from '../src/llm-client.ts'
import { headersThenStalledBody } from './stalling-fetch.ts'

const options = { baseUrl: 'http://gateway.example/v1', model: 'deepseek-v4-flash', apiKey: 'k' }

const item = (i: number) => ({ name: `dsh-pkg-${i}`, description: 'Does things.', keywords: ['dsh-plugin'] })

const okResponse = (names: string[]): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(names.map(n => ({ name: n, category: 'tool' }))) } }] }), { status: 200 })

describe('classifyPackages', () => {
  it('sends the bearer key and the OpenAI-compatible body', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} })
      return okResponse(['dsh-pkg-0'])
    }) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl })
    expect(calls[0]?.url).toBe('http://gateway.example/v1/chat/completions')
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer k')
    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.model).toBe('deepseek-v4-flash')
    expect(body.temperature).toBe(0)
    expect(body.max_tokens).toBe(16384)
    expect(result.classified.get('dsh-pkg-0')).toBe('tool')
  })

  it('splits 25 items into batches of 20 and 5', async () => {
    const fetched: number[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
      const input = JSON.parse(body.messages[1]!.content.match(/\[[\s\S]*\]/)![0]) as { name: string }[]
      fetched.push(input.length)
      return okResponse(input.map(i => i.name))
    }) as unknown as typeof fetch
    await classifyPackages(Array.from({ length: 25 }, (_, i) => item(i)), { ...options, fetchImpl })
    expect(fetched).toEqual([20, 5])
  })

  it('retries a 429 honoring Retry-After and succeeds', async () => {
    const delays: number[] = []
    const sleep = async (ms: number) => { delays.push(ms) }
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls === 1) return new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } })
      return okResponse(['dsh-pkg-0'])
    }) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl, sleep })
    expect(delays).toEqual([2000])
    expect(result.classified.get('dsh-pkg-0')).toBe('tool')
  })

  it('names what made a 200 unusable: truncation, with the token budget it hit', async () => {
    // The 2026-09-01 backfill discarded 1049 names as a bare "unparseable
    // batch" — one constant string covering truncation, an empty body, and a
    // fenced array, so the report could not say which. The gateway returns
    // finish_reason and usage; the discard carries them.
    const truncated = '[{"name":"dsh-pkg-0","category":"to'
    const fetchImpl = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: truncated }, finish_reason: 'length' }],
      usage: { completion_tokens: 16384 },
    }), { status: 200 })) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl })
    expect(result.classified.size).toBe(0)
    const reason = result.discarded.find(d => d.name === 'dsh-pkg-0')?.reason ?? ''
    expect(reason).toContain('unparseable batch')
    expect(reason).toContain('finish_reason=length')
    expect(reason).toContain('16384 completion tokens')
    expect(reason).toContain(`content ${truncated.length} chars`)
    // The head of the content is echoed verbatim, which is how an operator
    // sees that the JSON simply stops mid-token.
    expect(reason).toContain('"name":"dsh-pkg-0"')
  })

  it('distinguishes an empty completion from a garbled one', async () => {
    // A reasoning model that spends its whole budget reasoning returns no
    // content at all: the count alone tells the operator which case it is.
    const fetchImpl = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    }), { status: 200 })) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl })
    const reason = result.discarded.find(d => d.name === 'dsh-pkg-0')?.reason ?? ''
    expect(reason).toContain('content 0 chars')
    expect(reason).not.toContain('completion tokens')  // no usage reported
    expect(reason).not.toMatch(/: "/)                  // nothing to quote
  })

  it('says finish_reason=? when the gateway reports none', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'no json here' } }] }), { status: 200 })) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl })
    const reason = result.discarded.find(d => d.name === 'dsh-pkg-0')?.reason ?? ''
    expect(reason).toContain('finish_reason=?')
    expect(reason).toContain('"no json here"')
  })

  it('keeps the echoed content from disturbing the report table', async () => {
    // The content quotes package descriptions, which are untrusted npm and
    // GitHub input, and the reason is rendered into a markdown table.
    const hostile = 'a | b\nc\r\nd\u0000e'
    const fetchImpl = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: hostile }, finish_reason: 'stop' }],
    }), { status: 200 })) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl })
    const reason = result.discarded.find(d => d.name === 'dsh-pkg-0')?.reason ?? ''
    expect(reason).not.toContain('|')
    expect(reason).not.toMatch(/[\r\n\u0000]/)
    // Replaced, then collapsed: the echo is one clean line, not the original
    // spacing with holes punched in it.
    expect(reason).toContain('a b c d e')
  })

  it('adopts a fenced array instead of discarding the batch', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '```json\n[{"name":"dsh-pkg-0","category":"ui"}]\n```' }, finish_reason: 'stop' }],
    }), { status: 200 })) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl })
    expect(result.classified.get('dsh-pkg-0')).toBe('ui')
    expect(result.discarded).toEqual([])
  })

  it('gives up after bounded retries with the last status', async () => {
    const sleep = async (_ms: number) => {}
    let calls = 0
    const fetchImpl = (async () => { calls += 1; return new Response('nope', { status: 503 }) }) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl, sleep })
    expect(calls).toBe(4)
    expect(result.classified.size).toBe(0)
    expect(result.discarded[0]?.reason).toContain('503')
  })

  it('resolves with gateway-unreachable discards when the gateway rejects', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const result = await classifyPackages([item(0), item(1)], { ...options, fetchImpl })
    expect(result.classified.size).toBe(0)
    expect(result.discarded.map(d => d.name).sort()).toEqual(['dsh-pkg-0', 'dsh-pkg-1'])
    for (const d of result.discarded) expect(d.reason.startsWith('gateway unreachable')).toBe(true)
  })
})

describe('request deadlines', () => {
  it('has a per-request deadline sized for a whole non-streaming completion', () => {
    // A literal, not a re-export of the constant. 120s was the wrong number
    // and could fire on a HEALTHY run: nothing sets `stream: true`, so the
    // headers do not arrive until the completion is finished, and the deadline
    // therefore bounds total generation of up to MAX_TOKENS = 16384 tokens
    // with CONCURRENCY = 4 streams sharing one self-hosted reasoning model.
    // 120s demanded 137 tok/s sustained; 600s asks for 27 tok/s.
    expect(GATEWAY_REQUEST_TIMEOUT_MS).toBe(600_000)
  })

  it('retries a timeout the way it retries a 429, instead of discarding twenty names at once', async () => {
    // A timeout used to skip the ladder entirely: the loop matches on STATUS,
    // and a throw went straight to the catch that discards every name in the
    // batch. A timeout is transient in exactly the way a 429 is, and because a
    // slow gateway is systematic the same batches were discarded again on
    // every build — the "retried on the next build" that the discard reason
    // promises never arrived. MAX_TOKENS' own comment records this project
    // making the identical unmeasured-bound mistake once, at a cost of 1049
    // names out of 2724.
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls <= 2) return new Promise<Response>(() => {})
      return okResponse(['dsh-pkg-0'])
    }) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], {
      ...options, fetchImpl, sleep: async (_ms: number) => {}, timeoutMs: 50,
    })
    expect(calls).toBe(3)
    expect(result.classified.get('dsh-pkg-0')).toBe('tool')
    expect(result.discarded).toEqual([])
  })

  it('discards a batch whose gateway request never answers', async () => {
    // The classifier is advisory, so a stall must degrade to a discard the
    // next build retries — not to the six-hour Actions kill. The gateway is
    // plaintext to a bare IP, so an on-path stall is not hypothetical.
    let calls = 0
    const fetchImpl = (async () => { calls += 1; return new Promise<Response>(() => {}) }) as unknown as typeof fetch
    const started = Date.now()
    const result = await classifyPackages([item(0)], {
      ...options, fetchImpl, sleep: async (_ms: number) => {}, timeoutMs: 50,
    })
    // The whole ladder runs first — a gateway that never answers is given the
    // same four chances a 429 gets — and only then does the batch discard.
    expect(calls).toBe(4)
    expect(result.classified.size).toBe(0)
    expect(result.discarded).toHaveLength(1)
    expect(result.discarded[0]?.name).toBe('dsh-pkg-0')
    expect(result.discarded[0]?.reason).toContain('gateway unreachable')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('calls a stalled completion BODY unreachable, not unparseable', async () => {
    // The gateway answers 200 and then stalls the body. Reporting that as
    // "unparseable batch (finish_reason=?, content 0 chars)" would put a
    // statement that is simply untrue under each of the batch's package names,
    // in the table an operator reads to find out what went wrong.
    const started = Date.now()
    const result = await classifyPackages([item(0)], {
      ...options, fetchImpl: headersThenStalledBody(), sleep: async (_ms: number) => {}, timeoutMs: 50,
    })
    expect(result.classified.size).toBe(0)
    expect(result.discarded[0]?.reason).toContain('gateway unreachable')
    expect(result.discarded[0]?.reason).not.toContain('unparseable')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('does not fire early: a slow but healthy completion is still adopted', async () => {
    // The other side of the bound. A reasoning model spends seconds per batch;
    // a deadline wired to the wrong number passes the stall test above and
    // then discards the entire ecosystem every single build.
    // Under 10x on purpose: at the 50x this started with, `ms / 10` survived
    // green — and `ms / 10` in production is this gateway at 12s.
    const SLOW_MS = 50
    const DEADLINE_MS = 400
    const fetchImpl = (async () => {
      await new Promise(resolve => setTimeout(resolve, SLOW_MS))
      return okResponse(['dsh-pkg-0'])
    }) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl, timeoutMs: DEADLINE_MS })
    expect(result.classified.get('dsh-pkg-0')).toBe('tool')
    expect(result.discarded).toEqual([])
  })
})

describe('the classification step is bounded in aggregate', () => {
  const MINUTE = 60_000

  /** A gateway that stalls, and a clock that says each attempt cost `costMs`.
   * The fake clock is what makes this deterministic: the real deadline stays
   * at 20ms so the suite runs in milliseconds, while the budget sees minutes. */
  function stalledAt(costMs: number): { fetchImpl: typeof fetch; now: () => number; calls: () => number } {
    let clock = 0
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      clock += costMs
      return new Promise<Response>(() => {})
    }) as unknown as typeof fetch
    return { fetchImpl, now: () => clock, calls: () => calls }
  }

  it('has an aggregate budget at all', () => {
    // Per runBatches CALL, and classify.ts makes two of them, so the step caps
    // at twice this. A literal, so the constant cannot move unnoticed.
    expect(CLASSIFY_BUDGET_MS).toBe(900_000)
  })

  it('stops retrying a stalled gateway once the budget is spent', () => {
    // Deterministic because one batch cannot interleave with itself: the
    // ladder would otherwise run RETRY_LIMIT = 4 attempts at 600s each.
    const { fetchImpl, now, calls } = stalledAt(8 * MINUTE)
    return classifyPackages([item(0)], {
      ...options, fetchImpl, now, sleep: async (_ms: number) => {}, timeoutMs: 20, budgetMs: 15 * MINUTE,
    }).then(result => {
      expect(calls()).toBe(2)
      expect(result.discarded).toHaveLength(1)
    })
  })

  it('discards the batches it never reaches rather than spending the whole job on them', async () => {
    // The finding this exists for. Adding the timeout retry multiplied a
    // stalled gateway by RETRY_LIMIT: for the 2724-name backfill that is
    // 137 batches / CONCURRENCY 4 x 4 attempts x 600s ~= 1400 minutes, inside
    // a 120-minute job, in a step that runs BEFORE build:catalog — so
    // classification alone would consume the run and the catalog would never
    // be built. Losing 20 names to a discard is the supported outcome; losing
    // the day's catalog is not.
    // 260 names is 13 batches, so CONCURRENCY = 4 leaves at least two waves
    // entirely past the budget. That is what pins the `break`: `continue`
    // re-pushes every remaining batch once per skipped wave, and the exact
    // count below is what catches the duplicate rows.
    const NAMES = 260
    const { fetchImpl, now, calls } = stalledAt(8 * MINUTE)
    const items = Array.from({ length: NAMES }, (_, i) => item(i))
    const result = await classifyPackages(items, {
      ...options, fetchImpl, now, sleep: async (_ms: number) => {}, timeoutMs: 20, budgetMs: 15 * MINUTE,
    })
    // Every name is still accounted for — the budget skips work, never names.
    // EXACTLY the input, counted once each: no name lost, and none duplicated.
    expect(result.classified.size + result.discarded.length).toBe(NAMES)
    expect(new Set(result.discarded.map(d => d.name)).size).toBe(result.discarded.length)
    expect(result.discarded.some(d => d.reason.includes('budget'))).toBe(true)
    // Unbudgeted this would be 13 batches x 4 attempts = 52 requests.
    expect(calls()).toBeLessThan(52)
  })

  it('overruns its budget by at most one request deadline, which is the cap that counts', async () => {
    // The check runs at the top of a wave and in the retry condition, never
    // during an in-flight attempt — so a wave admitted with a sliver of budget
    // left still runs one whole deadline past it. The true cap is therefore
    // budgetMs + GATEWAY_REQUEST_TIMEOUT_MS, and THAT is the number the
    // comments have to state, because it is the one to check against the job.
    //
    // Subtracting a deadline at the gate instead would be worse than the
    // overrun: the deadline is two thirds of the budget, so no wave could
    // start after 5 of the 15 minutes and a healthy backfill would be
    // truncated every build. One batch here, so the fake clock is faithful —
    // it advances per call, which would over-count a concurrent wave.
    const COST = 4 * MINUTE
    const BUDGET = 15 * MINUTE
    const { fetchImpl, now } = stalledAt(COST)
    await classifyPackages([item(0)], {
      ...options, fetchImpl, now, sleep: async (_ms: number) => {}, timeoutMs: 20, budgetMs: BUDGET,
    })
    // It really does overrun — that is the fact being pinned, not wished away.
    expect(now()).toBeGreaterThan(BUDGET)
    expect(now()).toBeLessThanOrEqual(BUDGET + COST)
  })

  it('uses CLASSIFY_BUDGET_MS when no budget is handed in', async () => {
    // Every other budget test injects BOTH `now` and `budgetMs`, so none of
    // them touches the production wiring: `budgetMs ?? Number.POSITIVE_INFINITY`
    // left all 486 green. As tested, the budget H-1 exists to enforce was a
    // constant and a comment. This one injects only the clock, so the default
    // is what does the bounding.
    const { fetchImpl, now, calls } = stalledAt(20 * MINUTE)
    const items = Array.from({ length: 100 }, (_, i) => item(i))
    const result = await classifyPackages(items, {
      ...options, fetchImpl, now, sleep: async (_ms: number) => {}, timeoutMs: 20,
    })
    // One attempt per batch of the first wave, then the default 15-minute
    // budget is spent: no retries, and the fifth batch is never asked.
    expect(calls()).toBe(4)
    expect(result.discarded.some(d => d.reason.includes('budget'))).toBe(true)
    expect(result.classified.size + result.discarded.length).toBe(100)
  })

  it('uses a real clock when none is handed in', async () => {
    // The other default. A frozen `now` would make every budget above pass and
    // bound nothing in production, so this one spends a real budget in real
    // milliseconds: 40ms attempts against a 60ms budget stop short of the
    // four RETRY_LIMIT attempts an unbounded ladder would make.
    let calls = 0
    const fetchImpl = (async () => { calls += 1; return new Promise<Response>(() => {}) }) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], {
      ...options, fetchImpl, sleep: async (_ms: number) => {}, timeoutMs: 40, budgetMs: 60,
    })
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(calls).toBeLessThan(4)
    expect(result.discarded).toHaveLength(1)
  })

  it('leaves a healthy run untouched, however many batches it has', async () => {
    // The other side. A budget that fires on a healthy backfill would discard
    // the tail of the ecosystem every build, which is the silent loss the
    // retry was added to prevent, reintroduced from the other end.
    let clock = 0
    let calls = 0
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls += 1
      clock += 1 * MINUTE
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
      const input = JSON.parse(body.messages[1]!.content.match(/\[[\s\S]*\]/)![0]) as { name: string }[]
      return okResponse(input.map(i => i.name))
    }) as unknown as typeof fetch
    const items = Array.from({ length: 100 }, (_, i) => item(i))
    const result = await classifyPackages(items, {
      ...options, fetchImpl, now: () => clock, budgetMs: 15 * MINUTE,
    })
    expect(calls).toBe(5)
    expect(result.classified.size).toBe(100)
    expect(result.discarded).toEqual([])
  })
})
