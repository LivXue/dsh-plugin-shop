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
  '.skeletonActions',
  '.skeletonName',
  '.skeletonSummary',
  '.skeletonSummaryShort',
  '.skeletonCard::after',
  '.capabilities li',
]

/** Every class name appearing in a selector, at any nesting depth. The text
 * before each `{` is either a selector or an at-rule prelude; a prelude
 * carries no `.class` token (`47.5em` cannot match — the character after the
 * dot must be a letter), so one pass over those is the whole answer. */
function definedClasses(text: string): Set<string> {
  const out = new Set<string>()
  for (const [, prelude] of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)) {
    for (const [, name] of (prelude ?? '').matchAll(/\.([A-Za-z_][\w-]*)/g)) {
      // noUncheckedIndexedAccess: a capture group is string | undefined, and
      // the guard keeps it honest rather than asserting the group away.
      if (name !== undefined) out.add(name)
    }
  }
  return out
}

describe('class references', () => {
  it('every css.X the component reads has a rule in the stylesheet', () => {
    // The component tests stub the CSS module, so `css.missing` yields
    // undefined there and renders as className="undefined" — invisible to
    // every other lane. This caught `.outdatedVersion`: the markup asked for
    // the singular while the stylesheet defined only the plural
    // `.outdatedVersions`, so the two version labels on an outdated row
    // rendered with no class and therefore no separation between them.
    const tsx = readFileSync(new URL('../../src/client/ShopTab.tsx', import.meta.url), 'utf8')
    const used = new Set([...tsx.matchAll(/\bcss\.([A-Za-z_][\w]*)/g)].map(m => m[1]))
    const defined = definedClasses(css)
    expect([...used].filter(name => name !== undefined && !defined.has(name))).toEqual([])
  })

  it('separates the two version labels on an outdated row', () => {
    // The separation is the user-visible half of that fix, and it lives only
    // in the stylesheet: jsdom applies no layout and the component tests stub
    // the CSS module, so a container that lays its children out in a line
    // with no gap passes every other lane.
    const rule = rulesOf(css).get('.outdatedVersions') ?? ''
    expect(rule).toMatch(/display:\s*(inline-)?flex/)
    expect(rule).toMatch(/gap:\s*\d+px/)
  })
})

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
  // One hue per category, in display order; theme joined in v5 (market
  // borrowings §3.4) as the pink between integration and other.
  const SEVEN_HUES = ['#4C8DFF', '#A78BFA', '#2DD4BF', '#F59E0B', '#34D399', '#F472B6', '#8B8E96']

  it('assigns each category a distinct hue', () => {
    for (const cat of ['tool', 'provider', 'ui', 'workflow', 'integration', 'theme', 'other']) {
      const rule = rules.get(`.card[data-category='${cat}']`)
      expect(rule, `no hue rule for ${cat}`).toBeDefined()
      expect(rule).toMatch(/--spine-hue:\s*(#[0-9A-Fa-f]{6})/)
    }
  })

  it('uses seven distinct hues, one per category', () => {
    const hues = [...rules.entries()]
      .filter(([sel]) => sel.startsWith('.card[data-category='))
      .map(([, body]) => body.match(/--spine-hue:\s*(#[0-9A-Fa-f]{6})/)?.[1])
    expect(hues.every(Boolean)).toBe(true)
    expect(new Set(hues).size).toBe(7)
    for (const hue of SEVEN_HUES) expect(hues).toContain(hue)
  })

  it('spine and category badge draw from the per-category hue, never the brand token', () => {
    // The brand token resolved to near-black in the light theme, which made
    // the six-opacity spine read as six shades of gray ("只有黑白灰").
    // The cover block is gone — the single-line card carries the category
    // in the badge row instead — but the same hue contract holds.
    expect(rules.get('.cardSpine')).toMatch(/var\(--spine-hue/)
    expect(rules.get('.cardSpine')).not.toMatch(/brand-primary/)
    expect(rules.get('.categoryBadge')).toMatch(/var\(--spine-hue/)
    expect(rules.get('.categoryBadge')).not.toMatch(/brand-primary/)
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

describe('skeleton shape', () => {
  it('renders the loading ghost as the same single-column rows as the shelf', () => {
    // The old skeleton was a two-per-row card grid; the shelf is one
    // full-width card per row, and the ghost must match it.
    expect(rules.get('.skeletonGrid')).toMatch(/grid-template-columns:\s*1fr/)
    expect(rules.get('.skeletonCard')).toBeDefined()
    expect(rules.get('.skeletonActions')).toBeDefined()
  })
})
