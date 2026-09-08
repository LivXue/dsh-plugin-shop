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

describe('category hues', () => {
  // One hue per category, in display order; theme joined in v5 (market
  // borrowings §3.4) as the pink between integration and other.
  const SEVEN_HUES = ['#4C8DFF', '#A78BFA', '#2DD4BF', '#F59E0B', '#34D399', '#F472B6', '#8B8E96']
  const CATEGORIES = ['tool', 'provider', 'ui', 'workflow', 'integration', 'theme', 'other']

  /** The rule whose selector list contains `sel`, whatever else it contains.
   * The hue table is written as one rule per hue covering BOTH the card and
   * the category tab, so an exact-selector lookup no longer finds it. */
  function ruleContaining(sel: string): string | undefined {
    for (const [head, body] of rules) {
      if (head.split(',').some(part => part.trim() === sel)) return body
    }
    return undefined
  }

  it('assigns each category a distinct hue', () => {
    for (const cat of CATEGORIES) {
      const rule = ruleContaining(`.card[data-category='${cat}']`)
      expect(rule, `no hue rule for ${cat}`).toBeDefined()
      expect(rule).toMatch(/--category-hue:\s*(#[0-9A-Fa-f]{6})/)
    }
  })

  it('uses seven distinct hues, one per category', () => {
    const hues = CATEGORIES
      .map(cat => ruleContaining(`.card[data-category='${cat}']`) ?? '')
      .map(body => body.match(/--category-hue:\s*(#[0-9A-Fa-f]{6})/)?.[1])
    expect(hues.every(Boolean)).toBe(true)
    expect(new Set(hues).size).toBe(7)
    for (const hue of SEVEN_HUES) expect(hues).toContain(hue)
  })

  it('spine and category badge draw from the per-category hue, never the brand token', () => {
    // The brand token resolved to near-black in the light theme, which made
    // the six-opacity spine read as six shades of gray ("只有黑白灰").
    // The cover block is gone — the single-line card carries the category
    // in the badge row instead — but the same hue contract holds.
    expect(rules.get('.cardSpine')).toMatch(/var\(--category-hue/)
    expect(rules.get('.cardSpine')).not.toMatch(/brand-primary/)
    expect(rules.get('.categoryBadge')).toMatch(/var\(--category-hue/)
    expect(rules.get('.categoryBadge')).not.toMatch(/brand-primary/)
  })

  it('gives every category tab the SAME hue as the cards it filters to', () => {
    // The stylesheet writes one rule per hue covering both selectors, so this
    // holds by construction — but it is asserted on the resolved VALUES,
    // because the failure mode is silent: a blue Tool tab over green tool
    // cards is exactly as functional and tells the reader the wrong thing.
    const hueOf = (sel: string): string | undefined =>
      (ruleContaining(sel) ?? '').match(/--category-hue:\s*(#[0-9A-Fa-f]{6})/)?.[1]
    for (const cat of CATEGORIES) {
      const tab = hueOf(`.categoryButton[data-category='${cat}']`)
      expect(tab, `no tab hue for ${cat}`).toBeDefined()
      expect(tab, `tab and card disagree about ${cat}`).toBe(hueOf(`.card[data-category='${cat}']`))
    }
  })

  it('keeps the category hue on the pressed border and fill', () => {
    // Category identity lives on the border and fill. Text blends that hue
    // with the theme foreground so these 12px labels remain readable.
    const on = rules.get('.categoryButton.categoryButtonOn')
    expect(on, 'no .categoryButton.categoryButtonOn rule').toBeDefined()
    expect(on).toMatch(/border-color:\s*var\(--category-hue\)/)
    expect(on).toMatch(/background:\s*color-mix\(in srgb, var\(--category-hue\)/)
    expect(on).not.toMatch(/brand-primary/)
    // The fallback for All/Installed, which have no category and no hue.
    expect(rules.get('.categoryButton')).toMatch(/--category-hue:\s*var\(--dsw-alias-brand-primary\)/)
  })
})

describe('a pressed tab occupies the same box as an unpressed one', () => {
  /** The ONLY properties a pill's state rules may declare. An ALLOWLIST, not a
   * list of what is banned: the stylesheet's contract is "every declaration
   * here is a colour", which is six names and stable, while the set of
   * properties that resolve to a length is open-ended and grows with CSS. As a
   * denylist this guard failed open — it named `border-width` but not
   * `border-left-width`, `padding` but not `padding-inline`, `font-weight` but
   * not the `font` shorthand that sets weight AND size, and nothing at all for
   * `font-variant-numeric`, whose tabular digits change the advance of labels
   * that all end in a count. Every one of those reflows the bar and passed.
   *
   * `box-shadow` is in because it paints outside the layout box: an inset ring
   * is the pressed state's non-colour affordance and costs the pill no
   * metrics. `font-weight` is the reason the guard exists — bold metrics are
   * wider than regular, so `font-weight: 600` visibly widened whichever tab was
   * selected. jsdom applies no layout and the component tests stub this
   * module, so the declaration is the only place a test can see this. */
  const COLOUR_ONLY = [
    'color', 'background', 'background-color', 'background-image',
    'border-color', 'outline-color', 'box-shadow', 'opacity',
  ]

  /** Every state a pill can be in that the base rule does not also apply.
   * The `:hover` rules belong here as much as the pressed ones: they reflow
   * the same wrapping row, and they fire on mere pointer movement, so a
   * geometry declaration there is strictly worse than one on a click. */
  for (const selector of [
    '.categoryButton.categoryButtonOn',
    '.categoryButton:hover',
  ]) {
    it(`${selector} declares colour only`, () => {
      const body = rules.get(selector)
      expect(body, `no rule for ${selector}`).toBeDefined()
      // Declared property names only — `border-color` must stay legal, so a
      // prefix match on `border` would be wrong; this compares whole names.
      const declared = [...(body ?? '').matchAll(/(^|;)\s*([a-z-]+)\s*:/g)].map(m => m[2])
      expect(declared.filter(prop => prop !== undefined && !COLOUR_ONLY.includes(prop))).toEqual([])
    })
  }

  it('lets the pressed rule outrank hover, so a tab under the pointer still reads as selected', () => {
    // Both rules set `border-color` and `color`. `.categoryButton:hover` is
    // two compound units, so a bare `.categoryButtonOn` lost to it for as long
    // as the pointer stayed on the tab that had just been clicked — the
    // pressed border was never visible at the moment it was earned. Matching
    // the specificity and coming later is what fixes it, so both halves are
    // asserted: the two-class form exists, the bare form does not, and the
    // pressed rule is declared after the hover rule.
    const heads = [...rules.keys()]
    expect(heads).toContain('.categoryButton.categoryButtonOn')
    expect(heads, 'a bare .categoryButtonOn would lose to .categoryButton:hover again').not.toContain('.categoryButtonOn')
    expect(heads.indexOf('.categoryButton.categoryButtonOn')).toBeGreaterThan(heads.indexOf('.categoryButton:hover'))
  })

  it('gives the pressed state a signal that is not a colour', () => {
    // Colour alone is not enough, and this bar proves it twice over: `other`'s
    // hue IS the neutral gray used for "no category", so on the light theme a
    // pressed Other tab differs from an unpressed one by almost nothing; and
    // under forced colours the system palette replaces every colour here. The
    // repo's own recorded lesson — a layer fill can never be an element's only
    // affordance — is what `font-weight: 600` used to satisfy before it was
    // removed for reflowing the bar.
    expect(rules.get('.categoryButton.categoryButtonOn')).toMatch(/box-shadow:\s*inset/)
    expect(css, 'no forced-colors fallback for the pressed pill').toMatch(/forced-colors/)
  })

  it('keeps every pill on one geometry, stated once', () => {
    // Equal geometry means the BASE rule carries it and no state rule adds
    // any. Only the eight tabs are pills now — the filter left the group when
    // it became a switch — so this is about `.categoryButton` alone.
    const base = rules.get('.categoryButton') ?? ''
    expect(base, 'no .categoryButton rule').not.toBe('')
    expect(base, '.categoryButton must own the padding, so no state rule restates it').toMatch(/padding:\s*3px 10px/)
    expect(base).toMatch(/border:\s*1px solid/)
  })

  it('keeps the filter out of the pill group it is not a member of', () => {
    // The filter wore `.categoryButton` and so rendered as a ninth tab that
    // happened to be red — the tabs choose one of eight, this one is on or
    // off, and only the shape said otherwise. What replaced it is a switch, so
    // what this pins is that the filter carries no pill chrome of its own:
    // reintroducing a border and a fill here is how it would drift back.
    const filter = rules.get('.incompatibleFilter') ?? ''
    expect(filter, 'no .incompatibleFilter rule').not.toBe('')
    expect(filter).toMatch(/margin-left:\s*auto/)
    expect(filter, 'the filter must not paint a pill').toMatch(/border:\s*0/)
    expect(filter, 'the filter must not paint a pill').toMatch(/background:\s*none/)
    // Its whole statement about the switch is the hue. A width or a height
    // here is a second copy of a geometry `.switch` already owns, and the two
    // would drift the way the pill clone before it did.
    expect(filter).toMatch(/--switch-hue:\s*var\(--dsw-alias-state-error-primary\)/)
    expect(filter, 'the filter must not restate the switch geometry').not.toMatch(/width|height|border-radius:/)
  })

  it('lets the switch take its hue from whoever wears it', () => {
    // Two controls wear `.switch` and mean opposite things — enabled is green,
    // the incompatible filter is red — so the hue has to come from the caller.
    // It arrives by INHERITANCE, which is why the default is a `var()` fallback
    // and not a declaration: an own-element declaration on `.switch` would
    // shadow the value `.incompatibleFilter` sets on the ancestor, and the
    // filter's track would have gone on painting green.
    const track = rules.get('.switch') ?? ''
    expect(track, 'no .switch rule').not.toBe('')
    expect(track).toMatch(/--track-hue:\s*var\(--switch-hue,\s*var\(--dsw-alias-state-success-primary\)\)/)
    expect(track, 'a --switch-hue declared on .switch would shadow the ancestor').not.toMatch(/^\s*--switch-hue:/m)
    // The on state paints from the resolved hue, never from either literal.
    const on = rules.get('.switchOn') ?? ''
    expect(on, 'no .switchOn rule').not.toBe('')
    expect(on).toMatch(/border-color:\s*var\(--track-hue\)/)
    expect(on).toMatch(/background:\s*color-mix\([^;]*var\(--track-hue\)/)
    expect(on, '.switchOn must not hardcode a hue').not.toMatch(/--dsw-alias-state-(success|error)-primary/)
    // One geometry for both callers, and it only holds if the class states the
    // box itself: a `<button>` gets UA padding a `<span>` does not.
    expect(track).toMatch(/box-sizing:\s*border-box/)
    expect(track).toMatch(/padding:\s*0/)
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

describe('focus rings are not clipped by their container', () => {
  /** How far a `:focus-visible` ring paints OUTSIDE its element's border box:
   * the outline width plus a positive offset. A negative offset draws the ring
   * inward and reaches nothing. */
  function outwardReach(selector: string): number {
    const rule = rules.get(`${selector}:focus-visible`) ?? ''
    const width = /outline:\s*(\d+)px/.exec(rule)?.[1]
    const offset = /outline-offset:\s*(-?\d+)px/.exec(rule)?.[1]
    expect(width, `no outline width on ${selector}:focus-visible`).toBeDefined()
    expect(offset, `no outline-offset on ${selector}:focus-visible`).toBeDefined()
    return Math.max(0, Number(width) + Number(offset))
  }

  it('gives the search ring room to paint outside .panel', () => {
    // `.searchInput` is the first child of `.toolbar`, itself the first child
    // of `.panel`, and `.panel` carries no padding — so the input sits at
    // exactly (0, 0) of the panel's content box and its ring paints entirely
    // outside it.
    //
    // The margin is only granted when BOTH axes clip. That is the whole point
    // of this assertion, and the reason the first fix shipped broken: it set
    // `overflow-x: clip` alone in order to keep `overflow-y: visible`, which
    // satisfied a declaration-level check while leaving `overflow-clip-margin`
    // inert. Measured against the live app on 0.7.1 — the ring reached 0 of
    // its 3px on the left at device pixel ratios 1, 1.25, 1.5 and 2; raising
    // the margin to 6px changed nothing; clipping both axes with the same 3px
    // restored the whole ring.
    //
    // The right edge cannot catch this: the input is `min(280px, 100%)` and
    // the panel is far wider, so the ring's right side never meets the clip
    // edge and measures correct however badly the left is failing.
    const panel = rules.get('.panel') ?? ''
    expect(panel, 'no .panel rule').not.toBe('')
    const reach = outwardReach('.searchInput')
    expect(reach).toBeGreaterThan(0)

    // `hidden` may remain only as a pre-`clip` fallback, never as the last
    // word: the cascade takes the final declaration, and the `overflow`
    // shorthand sets both axes.
    const axes: { x?: string; y?: string } = {}
    for (const m of panel.matchAll(/overflow(-x|-y)?:\s*([\w-]+)/g)) {
      const [, prop, value] = m
      if (prop === '-x') axes.x = value
      else if (prop === '-y') axes.y = value
      else { axes.x = value; axes.y = value }
    }
    expect(axes.x, '.panel must not end on overflow-x: hidden').toBe('clip')
    expect(axes.y, '.panel clips one axis only, which makes overflow-clip-margin inert').toBe('clip')

    const margin = /overflow-clip-margin:\s*(\d+)px/.exec(panel)?.[1]
    expect(margin, '.panel clips without granting the ring a margin').toBeDefined()
    expect(Number(margin)).toBeGreaterThanOrEqual(reach)
  })
})

describe('incompatibility reads as an error, not a warning', () => {
  // The shop already spends the warn token on things a user can live with: a
  // stale catalog, an unreviewed tier, the §9.3 acknowledgement. A plugin whose
  // modules are absent will not load at all, so it must not sit in the same
  // colour as "we have not reviewed this". jsdom composites no colours, so the
  // token CHOICE is the only layer where this is visible to a test.
  // `.incompatibleFilter` is the category bar's filter. It is a control rather
  // than a statement about one plugin, but it names exactly this set, so it
  // takes the same token — a filter tinted amber over cards tinted red would
  // read as two different conditions. It carries the token on `--switch-hue`
  // rather than on a colour directly: one declaration then reaches both the
  // track, which inherits it, and the label, which blends it.
  for (const selector of ['.incompatibleBadge', '.incompatibleDetail', '.gateWarning', '.incompatibleFilter']) {
    it(`${selector} draws from the error token, not the warn token`, () => {
      const body = rules.get(selector)
      expect(body, `no rule for ${selector}`).toBeDefined()
      expect(body).toMatch(/--dsw-alias-state-error-primary/)
      expect(body).not.toMatch(/--dsw-alias-state-warn-primary/)
    })
  }

  // The copy carries its own `\n` so the dictionary decides where the line
  // breaks. Without pre-line the browser collapses it and both sentences run
  // together — invisible to every test that reads textContent, which keeps the
  // newline whether or not it renders. The e2e is what proves the effect.
  for (const selector of ['.incompatibleDetail', '.gateWarning']) {
    it(`${selector} renders the newline the copy carries`, () => {
      expect(rules.get(selector)).toMatch(/white-space:\s*pre-line/)
    })
  }

  it('leaves the acknowledgement gate itself on the warn token', () => {
    // .gateWarning turning red inside an amber .gate is the contrast that
    // separates "not reviewed" from "will not load".
    expect(rules.get('.gate')).toMatch(/--dsw-alias-state-warn-primary/)
  })
})
