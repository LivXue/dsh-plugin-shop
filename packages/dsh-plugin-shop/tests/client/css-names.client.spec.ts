// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classNameFor, localClassNames, rewriteLocalClassNames } from '../../tsdown.client.config.ts'

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

describe('the class-name rewrite leaves url() values alone', () => {
  it('rewrites no dotted token inside a url() value', () => {
    // The rewrite is a blind regex over the whole stylesheet, so a `url()`
    // value is not exempt: a data URI carrying `http://www.w3.org/2000/svg`
    // had `w3` and `org` collected as class names and replaced inside the
    // URI, shipping `www.s..._w3.s..._org` — an SVG namespace Chromium
    // refuses, and a search field that drew no glyph (review, 2026-11-11).
    // Run the build's own transform over the real stylesheet and fail on the
    // corruption before it can ship.
    const urlCarriesDot = (rewritten: string): boolean =>
      [...rewritten.matchAll(/url\(([^)]*)\)/g)].some(match => /\.[a-zA-Z_][\w-]*/.test(match[1] ?? ''))
    // The scan must be able to see the failure it guards against, or an
    // empty result proves nothing.
    const syntheticNames = new Map([['w3', 's0_w3'], ['org', 's0_org'], ['svg', 's0_svg']])
    expect(urlCarriesDot(rewriteLocalClassNames('x{background:url("http://www.w3.org/a.svg")}', syntheticNames))).toBe(true)
    const css = readFileSync(new URL('../../src/client/ShopTab.module.css', import.meta.url), 'utf8')
    const names = new Map([...localClassNames(css)].map(local => [local, classNameFor('ShopTab.module.css', local)]))
    expect(urlCarriesDot(rewriteLocalClassNames(css, names))).toBe(false)
  })
})
