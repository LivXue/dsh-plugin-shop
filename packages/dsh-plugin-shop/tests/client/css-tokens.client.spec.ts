// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** The shop tab stylesheet, read as text: this suite asserts on the token
 * CHOICE, which is the only layer where this class of defect is visible. The
 * component tests stub the css module, and jsdom composites no colors, so a
 * fill that is invisible against its own ground passes every other test. */
const css = readFileSync(new URL('../../src/client/ShopTab.module.css', import.meta.url), 'utf8')

/** Top-level rules, keyed by selector (a brace-depth scan — the stylesheet
 * nests only inside @media/@keyframes, which this flattens one level). */
function rulesOf(text: string): Map<string, string> {
  const out = new Map<string, string>()
  let depth = 0
  let start = 0
  let head = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      if (depth === 0) {
        head = text.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, '').trim()
        start = i + 1
      }
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        out.set(head, text.slice(start, i))
        start = i + 1
      }
    }
  }
  return out
}

const rules = rulesOf(css)

/** Selectors whose element is made visible by its fill alone — no border, no
 * text, nothing else to see. `bg-layer-*` cannot carry them: the dsw light
 * theme resolves bg-base, bg-layer-1, bg-layer-2 and bg-layer-3 to the SAME
 * white (`--dsw-static-neutral-bluish-00`), so a layer-2 fill on a layer-1
 * card has zero contrast and the element disappears. Only the foreground
 * token inverts with the theme, so these fills derive from label-primary.
 * The loading skeleton shipped invisible in the light theme until this was
 * pinned; measured then: card rgb(255,255,255), bar rgb(255,255,255). */
const FILL_IS_THE_ONLY_AFFORDANCE = [
  '.skeletonCover',
  '.skeletonName',
  '.skeletonSummary',
  '.skeletonSummaryShort',
  '.skeletonCard::after',
  '.capabilities li',
]

describe('summary clamp', () => {
  it('lifts the line clamp in the expanded state and only there', () => {
    const collapsed = rules.get('.summary')
    expect(collapsed).toMatch(/-webkit-line-clamp:\s*2/)
    const expanded = rules.get('.summaryExpanded')
    expect(expanded, 'no .summaryExpanded rule').toBeDefined()
    expect(expanded).not.toMatch(/line-clamp:\s*\d/)
    // The zh summary follows the same contract with its own clamp count.
    expect(rules.get('.summaryZh')).toMatch(/-webkit-line-clamp:\s*1/)
    expect(rules.get('.summaryZhExpanded')).toBeDefined()
    expect(rules.get('.summaryZhExpanded')).not.toMatch(/line-clamp:\s*\d/)
  })
})

describe('category spine hues', () => {
  const SIX_HUES = ['#4C8DFF', '#A78BFA', '#2DD4BF', '#F59E0B', '#34D399', '#8B8E96']

  it('assigns each category a distinct hue', () => {
    for (const cat of ['tool', 'provider', 'ui', 'workflow', 'integration', 'other']) {
      const rule = rules.get(`.card[data-category='${cat}']`)
      expect(rule, `no hue rule for ${cat}`).toBeDefined()
      expect(rule).toMatch(/--spine-hue:\s*(#[0-9A-Fa-f]{6})/)
    }
  })

  it('uses six distinct hues, one per category', () => {
    const hues = [...rules.entries()]
      .filter(([sel]) => sel.startsWith('.card[data-category='))
      .map(([, body]) => body.match(/--spine-hue:\s*(#[0-9A-Fa-f]{6})/)?.[1])
    expect(hues.every(Boolean)).toBe(true)
    expect(new Set(hues).size).toBe(6)
    for (const hue of SIX_HUES) expect(hues).toContain(hue)
  })

  it('spine, cover, and label draw from the per-category hue, never the brand token', () => {
    // The brand token resolved to near-black in the light theme, which made
    // the six-opacity spine read as six shades of gray ("只有黑白灰").
    expect(rules.get('.cardSpine')).toMatch(/var\(--spine-hue/)
    expect(rules.get('.cardSpine')).not.toMatch(/brand-primary/)
    expect(rules.get('.cardCover')).toMatch(/var\(--spine-hue/)
    expect(rules.get('.cardCover')).not.toMatch(/brand-primary/)
    expect(rules.get('.coverLabel')).toMatch(/var\(--spine-hue/)
    expect(rules.get('.coverLabel')).not.toMatch(/brand-primary/)
  })
})

describe('borderless fills', () => {
  for (const selector of FILL_IS_THE_ONLY_AFFORDANCE) {
    it(`${selector} derives its fill from the foreground token, not a background layer`, () => {
      const body = rules.get(selector)
      expect(body, `no rule for ${selector}`).toBeDefined()
      expect(body).not.toMatch(/--dsw-alias-bg-(base|layer-\d)/)
      expect(body).toMatch(/--dsw-alias-label-primary/)
    })
  }
})
