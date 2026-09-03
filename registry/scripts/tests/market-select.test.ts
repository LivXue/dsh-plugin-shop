import { describe, expect, it } from 'vitest'
import { selectMarketPending } from '../src/market-select.ts'

describe('selectMarketPending', () => {
  it('asks only about names the filter catches and markets.yml has not judged', () => {
    // Judged either way — market or not — means never asked again. That is the
    // point of recording both verdicts: without it a genuine market is re-asked
    // every run, and one bad roll writes an exemption nothing takes back.
    const pending = selectMarketPending(
      [{ name: 'dsh-tea-store' }, { name: 'dsh-plugin-market' }, { name: 'dsh-hello-plugin' }],
      new Set(['dsh-tea-store', 'dsh-plugin-market']),
    )
    expect(pending).toEqual([])
  })

  it('catches a name by its repo slug when the package name is innocent', () => {
    // @xiamu-ssr/dsh-wind-aifin, a Wind AIFin MCP plugin, reached the verdict
    // list on its repo Xiamu-ssr/snowmountain-market alone.
    expect(selectMarketPending(
      [{ name: '@xiamu-ssr/dsh-wind-aifin', repo: 'Xiamu-ssr/snowmountain-market' }],
      new Set(),
    )).toEqual(['@xiamu-ssr/dsh-wind-aifin'])
  })

  it('asks once per name however many repos publish it', () => {
    // Seven separate repos publish dsh-plugin-market. markets.yml is keyed by
    // name, so seven questions would write one row.
    expect(selectMarketPending(
      [
        { name: 'dsh-plugin-market', repo: 'a/dsh-plugin-market' },
        { name: 'dsh-plugin-market', repo: 'b/dsh-plugin-market' },
        { name: 'dsh-plugin-market', repo: 'c/dsh-plugin-market' },
      ],
      new Set(),
    )).toEqual(['dsh-plugin-market'])
  })

  it('leaves ordinary plugins alone and returns a sorted list', () => {
    expect(selectMarketPending(
      [{ name: 'dsh-zebra-store' }, { name: 'dsh-restore' }, { name: 'dsh-apple-market' }],
      new Set(),
    )).toEqual(['dsh-apple-market', 'dsh-zebra-store'])
  })
})
