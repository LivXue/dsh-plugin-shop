// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { classNameFor } from '../../tsdown.client.config.ts'

describe('classNameFor', () => {
  it('never generates a selector that starts with a digit', () => {
    // CSS class selectors must not start with a digit: `.2b743e_x` tokenizes
    // as a number and the browser drops the whole rule. The FNV-1a hex hash
    // prefix can start with 0-9, so the generated name carries a letter
    // prefix. Pin the property across many inputs.
    for (let i = 0; i < 200; i++) {
      const name = classNameFor(`/tmp/sample-${i}.module.css`, `local${i}`)
      expect(name).toMatch(/^s[0-9a-f]{6}_local\d+$/)
      expect(name[0]).toMatch(/[a-z]/)
    }
  })

  it('is deterministic for the same input', () => {
    expect(classNameFor('/a.module.css', 'card')).toBe(classNameFor('/a.module.css', 'card'))
  })
})
