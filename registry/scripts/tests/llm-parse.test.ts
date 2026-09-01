import { describe, expect, it } from 'vitest'
import { parseClassificationResponse } from '../src/llm-parse.ts'

const names = new Set(['dsh-alpha', 'dsh-beta', 'dsh-gamma'])

describe('parseClassificationResponse', () => {
  it('adopts every valid row', () => {
    const map = parseClassificationResponse(
      '[{"name":"dsh-alpha","category":"tool"},{"name":"dsh-beta","category":"provider"}]',
      names,
    )
    expect(map.get('dsh-alpha')).toBe('tool')
    expect(map.get('dsh-beta')).toBe('provider')
  })

  it('drops rows with an invented category', () => {
    const map = parseClassificationResponse(
      '[{"name":"dsh-alpha","category":"wizardry"},{"name":"dsh-beta","category":"ui"}]',
      names,
    )
    expect(map.has('dsh-alpha')).toBe(false)
    expect(map.get('dsh-beta')).toBe('ui')
  })

  it('drops rows naming a package outside the batch', () => {
    const map = parseClassificationResponse(
      '[{"name":"dsh-intruder","category":"tool"},{"name":"dsh-alpha","category":"ui"}]',
      names,
    )
    expect(map.has('dsh-intruder')).toBe(false)
    expect(map.get('dsh-alpha')).toBe('ui')
  })

  it('adopts rows from an array the model wrapped in a ```json fence', () => {
    // Observed 2026-09-01: 1049 names were discarded as "unparseable batch"
    // with the gateway answering 200 every time. A fence is one of the three
    // shapes that reaches JSON.parse as invalid and loses the whole batch.
    const adopted = parseClassificationResponse(
      '```json\n[{"name":"dsh-a","category":"tool"}]\n```',
      new Set(['dsh-a']),
    )
    expect(adopted.get('dsh-a')).toBe('tool')
  })

  it('adopts rows from a bare ``` fence, trailing newline or not', () => {
    const withNewline = parseClassificationResponse('```\n[{"name":"dsh-a","category":"ui"}]\n```\n', new Set(['dsh-a']))
    const without = parseClassificationResponse('```[{"name":"dsh-a","category":"ui"}]```', new Set(['dsh-a']))
    expect(withNewline.get('dsh-a')).toBe('ui')
    expect(without.get('dsh-a')).toBe('ui')
  })

  it('returns an empty map for output that is fenced but still not JSON', () => {
    expect(parseClassificationResponse('```json\nI think dsh-a is a tool.\n```', new Set(['dsh-a'])).size).toBe(0)
  })

  it('returns an empty map for non-JSON output', () => {
    expect(parseClassificationResponse('Sure! Here are the categories:', names).size).toBe(0)
    expect(parseClassificationResponse('', names).size).toBe(0)
  })

  it('returns an empty map when the JSON is not an array', () => {
    expect(parseClassificationResponse('{"name":"dsh-alpha","category":"tool"}', names).size).toBe(0)
  })
})
