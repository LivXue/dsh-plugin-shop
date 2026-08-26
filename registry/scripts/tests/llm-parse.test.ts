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

  it('returns an empty map for non-JSON output', () => {
    expect(parseClassificationResponse('Sure! Here are the categories:', names).size).toBe(0)
    expect(parseClassificationResponse('', names).size).toBe(0)
  })

  it('returns an empty map when the JSON is not an array', () => {
    expect(parseClassificationResponse('{"name":"dsh-alpha","category":"tool"}', names).size).toBe(0)
  })
})
