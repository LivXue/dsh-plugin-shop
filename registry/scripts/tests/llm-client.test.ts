import { describe, expect, it } from 'vitest'
import { classifyPackages, CLASSIFY_BATCH_SIZE } from '../src/llm-client.ts'

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
    expect(body.max_tokens).toBe(4096)
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

  it('discards with a reason when the whole response is unparseable', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'no json here' } }] }), { status: 200 })) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl })
    expect(result.classified.size).toBe(0)
    expect(result.discarded).toContainEqual({ name: 'dsh-pkg-0', reason: 'unparseable batch' })
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
})
