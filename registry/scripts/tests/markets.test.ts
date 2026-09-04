import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mergeMarketRows, serializeMarketRows, type MarketRow } from '../src/markets.ts'
import { parseMarketResponse } from '../src/market-judge.ts'
import { parseRegistryConfig } from '../src/config.ts'

const human: MarketRow = { name: 'dsh-tea-store', market: false, by: 'human', reason: '存茶指南' }

describe('mergeMarketRows', () => {
  it('never lets the classifier overwrite a recorded verdict', () => {
    // A human row is authoritative, and an llm row already present means the
    // name was judged — re-answering it is the flip-flop the file prevents.
    const merged = mergeMarketRows([human], new Map([['dsh-tea-store', true]]), new Map())
    expect(merged).toEqual([human])
  })

  it('records a fresh verdict as llm, with its reason', () => {
    const merged = mergeMarketRows([], new Map([['dsh-x-market', true]]), new Map([['dsh-x-market', 'sells plugins']]))
    expect(merged).toEqual([{ name: 'dsh-x-market', market: true, by: 'llm', reason: 'sells plugins' }])
  })

  it('keeps rows for names no longer in the catalog', () => {
    // categories.yml prunes; this must not. A dropped verdict costs a re-ask,
    // and with it the chance of a different answer.
    expect(mergeMarketRows([human], new Map(), new Map())).toHaveLength(1)
  })
})

describe('serializeMarketRows', () => {
  it('round-trips a reason carrying YAML metacharacters', () => {
    // `reason` quotes an untrusted npm description. A colon, a quote or a
    // newline in it would otherwise produce a file the loader cannot read —
    // the failure categories.yml already hit with scoped names.
    const nasty: MarketRow = {
      name: '@scope/dsh-market',
      market: true,
      by: 'llm',
      reason: 'a: b "quoted" \n second line \\ backslash',
    }
    const parsed = parse(serializeMarketRows([nasty])) as MarketRow[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.name).toBe('@scope/dsh-market')
    expect(parsed[0]?.reason).toBe('a: b "quoted" second line \\ backslash')
  })

  it('sorts by name so the file does not churn on input order', () => {
    const rows = serializeMarketRows([
      { name: 'zzz', market: true, by: 'llm', reason: 'z' },
      { name: 'aaa', market: false, by: 'human', reason: 'a' },
    ])
    expect(rows.indexOf('"aaa"')).toBeLessThan(rows.indexOf('"zzz"'))
  })
})

describe('parseMarketResponse', () => {
  const expected = new Set(['a', 'b'])

  it('adopts only booleans for names that were asked about', () => {
    const out = parseMarketResponse(
      '[{"name":"a","market":true},{"name":"b","market":"true"},{"name":"c","market":false}]',
      expected,
    )
    // "true" as a STRING is a guess we refuse to record; c was never asked.
    expect([...out]).toEqual([['a', true]])
  })

  it('treats an omitted name as undecided rather than false', () => {
    // The prompt tells the model to omit what it cannot decide. An omission
    // must become a discard — keeping the heuristic's answer and asking again
    // — not a recorded `false` that shelves a competing market forever.
    expect(parseMarketResponse('[{"name":"a","market":false}]', expected).has('b')).toBe(false)
  })

  it('yields nothing from a truncated or non-JSON completion', () => {
    expect(parseMarketResponse('[{"name":"a","mark', expected).size).toBe(0)
    expect(parseMarketResponse('I cannot help with that.', expected).size).toBe(0)
  })
})

describe('a steered verdict cannot delist a neighbour', () => {
  it('records a neighbour-named true as an llm hold, which hides nothing', () => {
    // The batch asked about dsh-a and its neighbour dsh-b. A hostile
    // description in dsh-a's metadata steers the model into answering `true`
    // for dsh-b. The parser cannot tell that apart from a legitimate answer —
    // batches may be answered in any order — so the defence is downstream:
    // an llm verdict is a hold a human confirms, never a hide.
    const verdicts = parseMarketResponse(
      '[{"name":"dsh-a","market":false},{"name":"dsh-b","market":true}]',
      new Set(['dsh-a', 'dsh-b']),
    )
    const rows = serializeMarketRows(mergeMarketRows([], verdicts, new Map()))
    const config = parseRegistryConfig({
      verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]', firstSeen: '[]',
      markets: rows,
    })
    expect(config.notAShop.has('dsh-b'), 'an llm true must not hide the entry').toBe(true)
    expect([...config.marketHolds]).toEqual(['dsh-b'])
  })

  it('lets a human row confirm the hold', () => {
    const config = parseRegistryConfig({
      verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]', firstSeen: '[]',
      markets: '- name: dsh-b\n  market: true\n  by: human\n  reason: it sells dsh plugins\n',
    })
    expect(config.notAShop.has('dsh-b')).toBe(false)
    expect(config.marketHolds.size).toBe(0)
  })
})
