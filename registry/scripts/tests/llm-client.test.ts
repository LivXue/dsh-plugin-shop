import { describe, expect, it } from 'vitest'
import { classifyPackages, CLASSIFY_BATCH_SIZE, GATEWAY_REQUEST_TIMEOUT_MS } from '../src/llm-client.ts'

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
  it('has a per-request deadline at all', () => {
    // A literal, not a re-export of the constant: a fixture computed from the
    // value it tests can never detect that value moving. Generous next to the
    // other two clients because a batch completion genuinely takes seconds.
    expect(GATEWAY_REQUEST_TIMEOUT_MS).toBe(120_000)
  })

  it('discards a batch whose gateway request never answers', async () => {
    // The classifier is advisory, so a stall must degrade to a discard the
    // next build retries — not to the six-hour Actions kill. The gateway is
    // plaintext to a bare IP, so an on-path stall is not hypothetical.
    const fetchImpl = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch
    const started = Date.now()
    const result = await classifyPackages([item(0)], {
      ...options, fetchImpl, sleep: async (_ms: number) => {}, timeoutMs: 50,
    })
    expect(result.classified.size).toBe(0)
    expect(result.discarded).toHaveLength(1)
    expect(result.discarded[0]?.name).toBe('dsh-pkg-0')
    expect(result.discarded[0]?.reason).toContain('gateway unreachable')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('does not fire early: a slow but healthy completion is still adopted', async () => {
    // The other side of the bound. A reasoning model spends seconds per batch;
    // a deadline wired to the wrong number passes the stall test above and
    // then discards the entire ecosystem every single build.
    const SLOW_MS = 40
    const DEADLINE_MS = 2000
    const fetchImpl = (async () => {
      await new Promise(resolve => setTimeout(resolve, SLOW_MS))
      return okResponse(['dsh-pkg-0'])
    }) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl, timeoutMs: DEADLINE_MS })
    expect(result.classified.get('dsh-pkg-0')).toBe('tool')
    expect(result.discarded).toEqual([])
  })
})
