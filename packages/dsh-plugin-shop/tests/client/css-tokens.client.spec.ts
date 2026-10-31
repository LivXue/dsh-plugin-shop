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

/** Every style rule at any depth, with the at-rule preludes around it. The
 * flat `rules` map above folds an @media block into one body, which would
 * hide a rule inside one from a per-rule check. */
function everyRule(text: string): Array<{ at: string[]; selector: string; body: string }> {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Array<{ at: string[]; selector: string; body: string }> = []
  const heads: string[] = []
  let start = 0
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (ch === '{') {
      heads.push(clean.slice(start, i).trim())
      start = i + 1
    } else if (ch === '}') {
      const head = heads.pop() ?? ''
      if (!head.startsWith('@')) out.push({ at: heads.filter(h => h.startsWith('@')), selector: head, body: clean.slice(start, i) })
      start = i + 1
    }
  }
  return out
}

/** `prop: value` pairs, in order. A value never holds a `;` in this file. */
function declarationsOf(body: string): Array<{ prop: string; value: string }> {
  const out: Array<{ prop: string; value: string }> = []
  for (const part of body.split(';')) {
    const m = /^\s*([a-z-]+)\s*:\s*([\s\S]*?)\s*$/.exec(part)
    if (m?.[1] !== undefined && m[2] !== undefined) out.push({ prop: m[1], value: m[2] })
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
    const tsx = ['ShopTab.tsx', 'ShopPage.tsx', 'ShopDetailAction.tsx']
      .map(file => readFileSync(new URL(`../../src/client/${file}`, import.meta.url), 'utf8'))
      .join('\n')
    const used = new Set([...tsx.matchAll(/\bcss\.([A-Za-z_][\w]*)/g)].map(m => m[1]))
    const defined = definedClasses(css)
    expect([...used].filter(name => name !== undefined && !defined.has(name))).toEqual([])
  })

  it('frames the page as dsh\'s Plugins page does: one centred column of at most 960px', () => {
    // Read from dsh 0.2.0-rc.2's Plugins page stylesheet (design
    // 2026-10-16-shop-sidebar-page §3.2): the page scrolls, its children
    // share one column, and the head clears the desktop title bar.
    expect(declarationsOf(rules.get('.page') ?? '')).toEqual([
      { prop: 'box-sizing', value: 'border-box' },
      { prop: 'height', value: '100%' },
      { prop: 'overflow', value: 'auto' },
      { prop: 'display', value: 'flex' },
      { prop: 'flex-direction', value: 'column' },
      { prop: 'align-items', value: 'center' },
      { prop: 'gap', value: '32px' },
      { prop: 'padding', value: '0 clamp(24px, 4vw, 48px) 48px' },
      { prop: 'color', value: 'var(--dsw-alias-label-primary)' },
    ])
    expect(declarationsOf(rules.get('.page > *') ?? '')).toEqual([
      { prop: 'width', value: '100%' },
      { prop: 'max-width', value: '960px' },
    ])
    expect(rules.get('.pageHead') ?? '').toMatch(/padding-top:\s*calc\(28px \+ var\(--dsh-frame-top-clearance, 0px\)\)/)
    expect(rules.get('.pageTitle') ?? '').toMatch(/font-size:\s*20px/)
    expect(rules.get('.pageTitle') ?? '').toMatch(/font-weight:\s*500/)
    expect(rules.get('.pageIntro') ?? '').toMatch(/color:\s*var\(--dsw-alias-label-secondary\)/)
  })

  it('draws the Plugins page buttons at the size of that page\'s own small outline buttons', () => {
    // dsh 0.2.0-rc.2's Button, sm + outline (design 2026-10-16-shop-sidebar-page
    // §7): its 0.5px stroke is 1px here, as every border in this stylesheet is.
    const rule = rules.get('.detailAction') ?? ''
    expect(rule).toMatch(/height:\s*28px/)
    expect(rule).toMatch(/padding:\s*0 10px/)
    expect(rule).toMatch(/font-size:\s*12px/)
    expect(rule).toMatch(/border:\s*1px solid var\(--dsw-alias-border-l3\)/)
    expect(rule).toMatch(/border-radius:\s*var\(--dsw-radius-sm\)/)
  })

  it('draws the shop\'s own focus ring on the Plugins page buttons', () => {
    // The ring every other control in this stylesheet draws. dsh's own
    // focus rules there are scoped to its classes, so without this one the
    // buttons fall back to the browser's ring, unlike the rest of the shop.
    // The other controls' focus rules are not pinned rule by rule; this one
    // is, being the only control drawn on a page that is not the shop's.
    expect(declarationsOf(rules.get('.detailAction:focus-visible') ?? '')).toEqual([
      { prop: 'outline', value: '2px solid var(--dsw-alias-brand-primary)' },
      { prop: 'outline-offset', value: '1px' },
    ])
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

  it('lets the stats row wrap rather than overflow once the order control joins it', () => {
    // jsdom applies no layout, so the declaration is the only place a test can
    // see this: the row holds the catalog line, the refresh button and now
    // three pills, and a non-wrapping flex row overflows a narrow window.
    const row = rules.get('.catalogStatsRow') ?? ''
    expect(row, 'no .catalogStatsRow rule').not.toBe('')
    expect(row).toMatch(/display:\s*flex/)
    expect(row).toMatch(/flex-wrap:\s*wrap/)

    const group = rules.get('.sortGroup') ?? ''
    expect(group, 'no .sortGroup rule').not.toBe('')
    expect(group).toMatch(/margin-left:\s*auto/)
  })

  it('ends a long release tag in an ellipsis instead of widening the badge row', () => {
    // A release tag is shown uncut (market borrowings §11), and a tag can run
    // to any length. jsdom lays nothing out, so the declarations are the only
    // place a test can see the cap.
    const rule = rules.get('.cardVersion') ?? ''
    expect(rule, 'no .cardVersion rule').not.toBe('')
    expect(rule).toMatch(/max-width:\s*\d+ch/)
    expect(rule).toMatch(/overflow:\s*hidden/)
    expect(rule).toMatch(/text-overflow:\s*ellipsis/)
    expect(rule).toMatch(/white-space:\s*nowrap/)
  })

  it('lets the shelf\'s grid item shrink, so no card is wider than the column', () => {
    // The grid item is the <li> that carries a card's identity, not the card,
    // and a grid item's min-width is auto: the 1fr track can then never be
    // narrower than the widest item's min-content, and every card widens to
    // it. A card the browser skips (`content-visibility: auto`) keeps the
    // width it last rendered at, so browsing a wide window and narrowing it
    // left every card 960px wide in a 662px column, its right side clipped
    // (measured on dsh 0.2.1-rc.2, 0.2.0-rc.2 and 0.1.7-rc.2, 2026-10-22).
    // The e2e measures the clipping itself; this pins where the fix lives.
    expect(declarationsOf(rules.get('.cards > li') ?? '')).toContainEqual({ prop: 'min-width', value: '0' })
  })

  it('keeps the fold toggle in the Refresh pill\'s shape rather than stretched across the card', () => {
    // The shop design's 2026-10-14 amendment: "the toggle sits under the block
    // in the Refresh pill's shape". It is a flex item of the card body, a
    // column, which stretches every child it does not tell otherwise: 934px
    // against the pill's 59px at a 1440 window (measured 2026-10-22). The
    // rule says why in a comment inside its body, which `declarationsOf`
    // would read as part of the first declaration.
    const body = (rules.get('.foldToggle') ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarationsOf(body)).toContainEqual({ prop: 'align-self', value: 'flex-start' })
  })

  it('stacks a receipt and lines its buttons up in one row', () => {
    // A settled install's or uninstall's receipt is a column, so its log box
    // spans the card as the running and failed views' logs do, rather than
    // being as wide as its longest line, and its sentence never shares a line
    // with a button it sits misaligned beside. The buttons under it, a
    // failure, or a reload or restart note sit in one row: the offer first,
    // the way out beside it.
    const receipt = declarationsOf(rules.get('.receipt') ?? '')
    expect(receipt).toContainEqual({ prop: 'display', value: 'flex' })
    expect(receipt).toContainEqual({ prop: 'flex-direction', value: 'column' })
    const actions = declarationsOf(rules.get('.offerActions') ?? '')
    expect(actions).toContainEqual({ prop: 'display', value: 'flex' })
    expect(actions).toContainEqual({ prop: 'flex-wrap', value: 'wrap' })
    expect(actions).toContainEqual({ prop: 'align-items', value: 'center' })
    // On a card the receipt takes the action row's whole width, as the
    // running and failed views do.
    const fullRow = [...rules].find(([head]) => head.split(',').some(part => part.trim() === '.cardActions > .receipt'))
    expect(fullRow, 'no rule sizes a receipt on the card\'s action row').toBeDefined()
    expect(declarationsOf(fullRow?.[1] ?? '')).toContainEqual({ prop: 'flex-basis', value: '100%' })
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
    // with the theme foreground so these 12px labels remain readable, and so
    // does the border: the raw hue measured 1.86:1 against white for `ui`,
    // under the 3:1 a control's boundary needs, while 70% of the hue against
    // label-primary measured 3.48:1 for the same tab. label-primary is the
    // theme's foreground pole, so one mix darkens the line in light and
    // lightens it in dark (7.01:1 at the worst dark hue).
    const on = rules.get('.categoryButton.categoryButtonOn')
    expect(on, 'no .categoryButton.categoryButtonOn rule').toBeDefined()
    expect(on).toMatch(/border-color:\s*color-mix\(in srgb, var\(--category-hue\) 70%, var\(--dsw-alias-label-primary\)\)/)
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
   * `box-shadow` is out although it costs the pill no metrics: an inset ring
   * is a second line, and every control in this stylesheet draws exactly one
   * (see "every control draws one 1px line" below). `font-weight` is the
   * reason the guard exists — bold metrics are wider than regular, so
   * `font-weight: 600` visibly widened whichever tab was selected. jsdom
   * applies no layout and the component tests stub this module, so the
   * declaration is the only place a test can see this. */
  const COLOUR_ONLY = [
    'color', 'background', 'background-color', 'background-image',
    'border-color', 'outline-color', 'opacity',
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

  it('separates pressed from unpressed by lightness, not by hue alone', () => {
    // Hue alone is not enough, and this bar proves it twice over: `other`'s
    // hue IS the neutral gray used for "no category", so on the light theme a
    // pressed Other tab coloured by its raw hue differs from an unpressed one
    // by almost nothing; and under forced colours the system palette replaces
    // every colour here. The repo's own recorded lesson — a layer fill can
    // never be an element's only affordance — was met first by `font-weight:
    // 600`, removed for reflowing the bar, then by an inset ring, removed for
    // drawing a second line. What meets it now is lightness: the pressed
    // border is mixed toward label-primary, so it clears 3:1 against the bar
    // for every hue (the e2e measures it) where the unpressed border-l2 sits
    // at 1.26:1 on white, and the fill under it is strong enough to see.
    const on = rules.get('.categoryButton.categoryButtonOn') ?? ''
    expect(on, 'no .categoryButton.categoryButtonOn rule').not.toBe('')
    expect(on).toMatch(/border-color:\s*color-mix\([^;]*var\(--dsw-alias-label-primary\)/)
    const fill = /background:\s*color-mix\(in srgb, var\(--category-hue\) (\d+)%, transparent\)/.exec(on)?.[1]
    expect(fill, 'the pressed fill must be a stated share of the hue').toBeDefined()
    expect(Number(fill)).toBeGreaterThanOrEqual(20)
    expect(on, 'a ring is a second line').not.toMatch(/box-shadow/)
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

describe('every control draws one 1px line', () => {
  // A maintainer asked for every button and label border to be thinner. 1px is
  // already the thinnest line the host can draw: Chromium 151 computes and
  // paints a 0.5px border as 1px at device pixel ratios 1, 1.25, 1.5 and 2
  // alike (measured 2026-10-14). So what "thinner" can mean is "never more
  // than one 1px line", and the pressed pill's inset ring, which doubled its
  // border, was the one place the stylesheet broke that. This pins it for
  // every rule, at every nesting depth, so a ring or a 2px border cannot come
  // back on a control nobody re-measured.

  const all = everyRule(css)

  it('finds the rules it guards, so an empty scan cannot pass', () => {
    // A parser that silently matched nothing would make both checks below
    // vacuous. The stylesheet has dozens of bordered rules and one
    // forced-colors block; this asserts the scan reached both.
    const bordered = all.filter(r => declarationsOf(r.body).some(d => /^border(-top|-right|-bottom|-left)?$/.test(d.prop)))
    expect(bordered.length).toBeGreaterThan(20)
    expect(all.some(r => r.at.some(a => a.includes('forced-colors')))).toBe(true)
  })

  it('gives every border a width of 1px, or none at all', () => {
    // A shorthand that names a style but no width draws the initial `medium`
    // width, 3px in every engine, so the width has to be stated, not implied.
    //
    // One rule states 0.5px on purpose: the icon tile copies dsh's own
    // `PackageArtwork` border, which is a hairline (design
    // 2026-10-23-shop-plugin-icons §2.4, decision 4). The width is still
    // EXPLICIT, which is what this guard is for.
    const SHORTHAND = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/
    const WIDTH = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-width$/
    const offenders: string[] = []
    for (const rule of all) {
      for (const { prop, value } of declarationsOf(rule.body)) {
        if (SHORTHAND.test(prop)) {
          if (value === '0' || value === 'none') continue
          // Width tokens: a bare length or a keyword, outside any var() or
          // color-mix() — a `45%` inside a mix is a share, not a width — so
          // the parenthesised groups go first, innermost outward.
          let flat = value
          while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, '')
          const widths = flat.split(/\s+/).filter(t => /^(\d*\.?\d+[a-z%]*|thin|medium|thick)$/.test(t))
          const allowed = rule.selector === '.entryIcon' ? ['1px', '0.5px'] : ['1px']
          if (widths.length !== 1 || !allowed.includes(widths[0] ?? '')) offenders.push(`${rule.selector} { ${prop}: ${value} }`)
        } else if (WIDTH.test(prop)) {
          if (!value.split(/\s+/).every(t => t === '1px' || t === '0')) offenders.push(`${rule.selector} { ${prop}: ${value} }`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('draws no ring or shadow on a control', () => {
    // `box-shadow` stays on one rule, the card's hover lift, which is a
    // shadow under a card rather than a line around a control. An outline is
    // a focus ring, so it lives only where focus is shown, and in the
    // forced-colors block, where it restores the pressed state the system
    // palette erased.
    const shadows: string[] = []
    const outlines: string[] = []
    for (const rule of all) {
      for (const { prop, value } of declarationsOf(rule.body)) {
        if (prop === 'box-shadow' && rule.selector !== '.card:hover') shadows.push(`${rule.selector} { ${prop}: ${value} }`)
        if (prop === 'outline' && value !== 'none' && value !== '0') {
          const focus = rule.selector.split(',').every(part => part.includes(':focus-visible'))
          const forced = rule.at.some(a => a.includes('forced-colors'))
          if (!focus && !forced) outlines.push(`${rule.selector} { ${prop}: ${value} }`)
        }
      }
    }
    expect(shadows).toEqual([])
    expect(outlines).toEqual([])
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

describe('red text clears 4.5:1', () => {
  // Two measured defects, one cause. dsh's error red is #ec1313 in the light
  // theme, which lands at 4.498:1 as text on white — just under the floor —
  // and the badge draws that same red on its OWN 14% red fill, which measures
  // 3.57:1 light and 4.00:1 dark. Mixing the red toward label-primary fixes
  // both, because label-primary is the theme's foreground pole. 90% of the
  // red is 4.69:1 at worst, computed for the dark panel itself (5.29:1
  // measured on the dark card), and 80% measures 4.92:1 at worst, on the
  // badge's own tint on the dark card. jsdom composites nothing, so the two
  // VALUES are pinned here and the e2e measures them live.
  const PANEL = rules.get('.panel') ?? ''

  it('derives both reds from the error token, on the tab root', () => {
    // On `.panel` because every red element sits inside it and custom
    // properties inherit: one declaration reaches all of them.
    expect(PANEL, 'no .panel rule').not.toBe('')
    expect(PANEL).toMatch(/--shop-error:\s*color-mix\(in srgb, var\(--dsw-alias-state-error-primary\) 90%, var\(--dsw-alias-label-primary\)\)/)
    expect(PANEL).toMatch(/--shop-error-on-tint:\s*color-mix\(in srgb, var\(--dsw-alias-state-error-primary\) 80%, var\(--dsw-alias-label-primary\)\)/)
  })

  it('never paints text with the raw error token', () => {
    // The defect class this whole block exists for: a `color` that takes dsh's
    // error red as-is. A mix is fine (the filter blends 45% of it with the
    // foreground); the bare token is not.
    const offenders: string[] = []
    for (const rule of everyRule(css)) {
      for (const { prop, value } of declarationsOf(rule.body)) {
        if (prop !== 'color') continue
        if (/var\(--dsw-alias-state-error-primary\)/.test(value.replace(/color-mix\([^;]*\)/g, ''))) {
          offenders.push(`${rule.selector} { ${prop}: ${value} }`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('takes the on-tint red wherever the text sits on a red tint', () => {
    // The badge's 14% fill and the uninstall button's 10% hover fill are the
    // two surfaces where 90% would land under the floor.
    for (const selector of ['.incompatibleBadge', '.uninstallButton']) {
      expect(rules.get(selector), `${selector} must use the on-tint red`).toMatch(/--shop-error-on-tint/)
    }
    // The rest are read on a plain surface — the card, the panel, the gate.
    for (const selector of ['.incompatibleDetail', '.gateWarning', '.failedHeading', '.rejectedCode']) {
      expect(rules.get(selector), `${selector} must use the plain red`).toMatch(/--shop-error\)/)
    }
  })
})

describe('warn and success text clear 4.5:1', () => {
  // The same defect as the red, much further under. dsh's warn amber
  // (#f59e0b) and success green (#22c55e) are one value in both themes, and
  // as text on white they measure 2.15:1 and 2.28:1 — on their own 14% tints
  // 1.93:1 and 2.02:1. They pass in the dark theme, so the mix toward
  // label-primary that `--shop-error` uses fixes the light theme without
  // spending the dark one: it darkens toward #0f1115 and lightens toward
  // #f9fafb. Each derived colour keeps the largest multiple of ten of its hue
  // that clears every surface it paints, the rule the reds follow. Computed
  // from the live tokens over every bg layer in both themes: amber at 60% is
  // 4.95:1 on a plain surface and 4.44:1 on its 14% tint, so the tint takes
  // 50% (5.66:1); green at 60% is 5.18:1 plain and 4.60:1 on its 14% tint,
  // so one green serves both and there is no on-tint green. jsdom composites
  // nothing, so the VALUES are pinned here and the e2e measures every text
  // live.
  const PANEL = rules.get('.panel') ?? ''

  it('derives the warn and success text colours from their tokens, on the tab root', () => {
    expect(PANEL, 'no .panel rule').not.toBe('')
    expect(PANEL).toContain('--shop-warn: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 60%, var(--dsw-alias-label-primary));')
    expect(PANEL).toContain('--shop-warn-on-tint: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 50%, var(--dsw-alias-label-primary));')
    expect(PANEL).toContain('--shop-success: color-mix(in srgb, var(--dsw-alias-state-success-primary) 60%, var(--dsw-alias-label-primary));')
    // A second green would be the first one again: 60% already clears the tint.
    expect(PANEL).not.toContain('--shop-success-on-tint')
  })

  it('never paints text with the raw warn or success token', () => {
    // Text only: a fill, a border or the switch track wants the hue itself,
    // and keeps the raw token.
    const offenders: string[] = []
    for (const rule of everyRule(css)) {
      for (const { prop, value } of declarationsOf(rule.body)) {
        if (prop !== 'color') continue
        if (/var\(--dsw-alias-state-(warn|success)-primary\)/.test(value.replace(/color-mix\([^;]*\)/g, ''))) {
          offenders.push(`${rule.selector} { ${prop}: ${value} }`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('takes the on-tint amber wherever amber text sits on an amber tint', () => {
    // The badges' 14% fills, the reviewed line's 12% and the restart gate's
    // 8%: the on-tint mix clears all three, so one rule covers them.
    for (const selector of [".tierBadge[data-tier='verified-stale']", '.staleBadge', '.reviewedLine', '.gateTitle']) {
      expect(rules.get(selector), `no rule for ${selector}`).toBeDefined()
      expect(rules.get(selector), `${selector} must use the on-tint amber`).toContain('color: var(--shop-warn-on-tint);')
    }
    // Read on a plain surface: the stats row.
    expect(rules.get('.catalogRefreshFailed'), '.catalogRefreshFailed must use the plain amber').toContain('color: var(--shop-warn);')
  })

  it('takes the one green for every green text, plain or on its tint', () => {
    for (const selector of [".tierBadge[data-tier='verified']", '.notice']) {
      expect(rules.get(selector), `no rule for ${selector}`).toBeDefined()
      expect(rules.get(selector), `${selector} must use the derived green`).toContain('color: var(--shop-success);')
    }
  })
})

describe('incompatibility reads as an error, not a warning', () => {
  // The shop already spends the warn token on things a user can live with: a
  // stale catalog, an unreviewed tier, the restart gate. A plugin whose
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
      // Either spelling of the same family: the derived red `.panel` mixes for
      // text (see "red text clears 4.5:1"), or the raw token where the element
      // only needs the HUE — the filter's switch track.
      expect(body).toMatch(/--shop-error|--dsw-alias-state-error-primary/)
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

  it('leaves the restart gate on the warn token', () => {
    // The gate asks before a restart that disconnects the page: a cost the
    // reader weighs, not a plugin that will not load, so it stays amber while
    // every refusal is red. It was the §9.3 acknowledgement's gate too until
    // that dialog went (2026-10-14).
    expect(rules.get('.gate')).toMatch(/--dsw-alias-state-warn-primary/)
  })
})

describe('the icon tile (design 2026-10-23 §8.3)', () => {
  const cssRules = rulesOf(css)

  it('is a 32px bordered tile with dsh\'s own radius', () => {
    const rule = cssRules.get('.entryIcon') ?? ''
    expect(rule).toMatch(/width:\s*32px/)
    expect(rule).toMatch(/height:\s*32px/)
    expect(rule).toMatch(/box-sizing:\s*border-box/)
    expect(rule).toMatch(/border:\s*0\.5px\s+solid\s+var\(--dsw-alias-border-l3\)/)
    expect(rule).toMatch(/border-radius:\s*var\(--dsw-radius-md\)/)
  })

  it('draws the artwork at 24px without distortion', () => {
    const rule = cssRules.get('.entryIconImage') ?? ''
    expect(rule).toMatch(/width:\s*24px/)
    expect(rule).toMatch(/height:\s*24px/)
    expect(rule).toMatch(/object-fit:\s*contain/)
  })

  it('centres the card header on the tile', () => {
    // The tile is taller than the title text, so the row is aligned on it and
    // padded 2px more above (§8.3).
    const header = cssRules.get('.entryHeader') ?? ''
    expect(header).toMatch(/align-items:\s*center/)
    expect(header).toMatch(/padding:\s*10px 12px 2px/)
  })
})
