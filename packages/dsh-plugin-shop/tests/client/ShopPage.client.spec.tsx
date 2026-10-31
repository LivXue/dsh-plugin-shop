// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en, zh, type ShopLocaleKey } from '../../src/client/locales.ts'
import { createPageStore, type ShopPageStore } from '../../src/client/page-store.ts'
import { ShopGlyph } from '../../src/client/ShopGlyph.tsx'
import { HOLD_MS, ShopPage } from '../../src/client/ShopPage.tsx'
import type { ShopTabInjected, ShopTabProps } from '../../src/client/ShopTab.tsx'
import type { ShopCatalogResult, ShopInstalledEntry } from '../../src/host/index.ts'

const restores: Array<() => void> = []
afterEach(() => {
  cleanup()
  for (const restore of restores.splice(0)) restore()
})

/** One listed entry: enough for the shelf to render a card. */
const CATALOG: ShopCatalogResult = {
  schemaVersion: 2, builtAt: '2026-10-16T00:00:00Z', stale: false,
  plugins: [{
    name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null,
    repository: 'https://github.com/you/hello-plugin', license: 'MIT',
    tier: 'community', metadata: 'derived', source: 'npm', added: '2026-10-16',
    catalog: { category: 'tool', summary: { en: 'Says hello.', zh: '打个招呼。' }, capabilities: [] },
  }],
  denied: [], stars: {}, icons: {}, incompatible: {}, incompatibleHarness: {},
}

/** The face with every RPC pending but the catalog, which the test decides. */
function face(catalog: () => Promise<ShopCatalogResult>): ShopTabInjected {
  const never = (): Promise<never> => new Promise<never>(() => {})
  return {
    catalog: vi.fn(catalog), install: vi.fn(never), installStatus: vi.fn(never), setEnabled: vi.fn(never),
    installed: vi.fn(async () => []), installedSpecs: vi.fn(async () => ({})),
    uninstall: vi.fn(never), restart: vi.fn(never), version: vi.fn(never), updateStart: vi.fn(never),
  } as unknown as ShopTabInjected
}
const storeFor = (injected: ShopTabInjected): ShopPageStore =>
  createPageStore(() => ({ install: injected.install, uninstall: injected.uninstall, updateStart: injected.updateStart, installStatus: injected.installStatus }), { pollUnwatched: true })
function renderPage(dict: Record<ShopLocaleKey, string>, injected: ShopTabInjected) {
  const t = ((key: ShopLocaleKey) => dict[key]) as ShopTabProps['t']
  return render(<ShopPage {...({ t, ...injected } as unknown as ShopTabProps)} />)
}
/** jsdom lays nothing out, so `scrollTop` neither scrolls nor clamps here:
 * each element remembers what was set, which is what a restore is read by. */
function rememberScrollTop(): Map<Element, number> {
  const tops = new Map<Element, number>()
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) { return tops.get(this) ?? 0 },
    set(this: Element, value: number) { tops.set(this, value) },
  })
  restores.push(() => { if (original !== undefined) Object.defineProperty(Element.prototype, 'scrollTop', original) })
  return tops
}

/** The layout `layOut` fakes: the page's top edge at 0, the shelf's first card
 * SHELF_TOP below it, and one card per row, GAP apart (`.cards`' grid gap). */
const SHELF_TOP = 200
const GAP = 8

/** jsdom lays nothing out, so each card on the shelf takes its rect from a
 * height table, keyed by the identity the card carries: the cards stand in
 * document order from the table's `top` (SHELF_TOP unless it says), and the
 * page's own `scrollTop` (`rememberScrollTop`) moves them. The table is read
 * on every call, so a case can lay the same shelf out at other heights, or
 * lower on the page, as a remount does. The shelf's list reports `.cards`'
 * gap as its row gap, which jsdom cannot: it loads no stylesheet. Counts the
 * card rects read. */
function layOut(table: { heights: (key: string) => number; top?: number }): { reads: number } {
  const counter = { reads: 0 }
  const original = Element.prototype.getBoundingClientRect
  const box = (top: number, height: number): DOMRect =>
    ({ x: 0, y: top, left: 0, right: 960, width: 960, top, bottom: top + height, height, toJSON: () => ({}) })
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this.hasAttribute('data-shop-page')) return box(0, 900)
    const page = this.closest('[data-shop-page]')
    if (page === null || !this.hasAttribute('data-shop-identity')) return original.call(this)
    counter.reads += 1
    let top = (table.top ?? SHELF_TOP) - page.scrollTop
    for (const card of page.querySelectorAll('[data-shop-identity]')) {
      const height = table.heights(card.getAttribute('data-shop-identity') ?? '')
      if (card === this) return box(top, height)
      top += height + GAP
    }
    throw new Error('a card outside the shelf it was found on')
  }
  const originalStyle = globalThis.getComputedStyle
  globalThis.getComputedStyle = ((element: Element, pseudo?: string | null): CSSStyleDeclaration => {
    const style = originalStyle.call(globalThis, element, pseudo)
    if (element.firstElementChild?.hasAttribute('data-shop-identity') !== true) return style
    return new Proxy(style, {
      get: (target, property) => {
        if (property === 'rowGap') return `${GAP}px`
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }) as typeof getComputedStyle
  restores.push(() => {
    Element.prototype.getBoundingClientRect = original
    globalThis.getComputedStyle = originalStyle
  })
  return counter
}

/** The identities on the shelf, in document order. */
const identitiesOf = (container: Element): string[] =>
  [...container.querySelectorAll('[data-shop-identity]')].map(card => card.getAttribute('data-shop-identity') ?? '')

/** A card's top in the page's content, in the layout `layOut` fakes. */
function contentTopOf(container: Element, key: string, heights: (key: string) => number): number {
  let top = SHELF_TOP
  for (const identity of identitiesOf(container)) {
    if (identity === key) return top
    top += heights(identity) + GAP
  }
  throw new Error(`no card ${key} on the shelf`)
}

/** A card's top relative to the page's top edge, as the page reads it. */
function offsetOf(container: Element, key: string): number {
  const root = container.querySelector('[data-shop-page]')
  const card = [...container.querySelectorAll('[data-shop-identity]')].find(node => node.getAttribute('data-shop-identity') === key)
  if (root === null || card === undefined) throw new Error(`no card ${key} on the page`)
  return card.getBoundingClientRect().top - root.getBoundingClientRect().top
}

function pageOf(container: Element): HTMLElement {
  const root = container.querySelector<HTMLElement>('[data-shop-page]')
  if (root === null) throw new Error('no page')
  return root
}

describe('the shop page (design 2026-10-16-shop-sidebar-page §4.2)', () => {
  it.each([
    ['en', en, 'Plugin shop', 'Browse, install, and update plugins.'],
    ['zh', zh, '插件商店', '浏览、安装和更新插件。'],
  ] as const)('titles the page with an h1 and states its intro above the shop body, in %s', (_lang, dict, title, intro) => {
    const { container } = renderPage(dict, face(() => new Promise(() => {})))
    const heading = container.querySelector('[data-shop-page-title]')
    const lead = container.querySelector('[data-shop-page-intro]')
    const body = container.querySelector('[data-shop-tab]')
    if (heading === null || lead === null || body === null) throw new Error('the page did not render its three parts')
    expect(heading.tagName).toBe('H1')
    expect(heading.textContent).toBe(title)
    expect(lead.textContent).toBe(intro)
    expect(heading.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(lead.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('is its own scroll container, untranslatable, under a head that drags the desktop window', () => {
    const { container } = renderPage(en, face(() => new Promise(() => {})))
    const root = container.querySelector('[data-shop-page]')
    expect(root?.tagName).toBe('SECTION')
    expect(root?.getAttribute('translate')).toBe('no')
    expect(root?.classList.contains('notranslate')).toBe(true)
    expect(container.querySelector('[data-shop-page-head]')?.hasAttribute('data-window-drag')).toBe(true)
  })

  it('tells the store it is on screen while it is mounted, and no longer once it unmounts', () => {
    const injected = face(() => new Promise(() => {}))
    const page = storeFor(injected)
    // Calls through: the store still records what the page reports.
    const noted = vi.spyOn(page, 'notePageMounted')
    const { unmount } = renderPage(en, { ...injected, page } as ShopTabInjected)
    expect(noted.mock.calls).toEqual([[true]])
    unmount()
    expect(noted.mock.calls).toEqual([[true], [false]])
    page.dispose()
  })
})

describe('the page keeps its scroll position (design 2026-10-16-shop-sidebar-page §5.7)', () => {
  it('restores the position the store recorded, once the shelf is on screen', async () => {
    const tops = rememberScrollTop()
    const injected = face(async () => CATALOG)
    const page = storeFor(injected)
    page.recordScroll(420)
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    await waitFor(() => expect(container.querySelector('[data-shop-entry]')).toBeTruthy())
    const root = container.querySelector('[data-shop-page]')
    if (root === null) throw new Error('no page')
    expect(tops.get(root)).toBe(420)
    page.dispose()
  })

  it('restores only once: a refresh that redraws the shelf leaves the page where the browser put it', async () => {
    const tops = rememberScrollTop()
    const injected = face(async () => CATALOG)
    const page = storeFor(injected)
    page.recordScroll(420)
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    await waitFor(() => expect(container.querySelector('[data-shop-entry]')).toBeTruthy())
    const root = container.querySelector('[data-shop-page]')
    const refresh = container.querySelector('[data-shop-catalog-refresh]')
    if (root === null || refresh === null) throw new Error('no page')
    expect(tops.get(root)).toBe(420)
    // The browser moves the page by no wheel, touch or key (a scrollbar
    // drag, scroll anchoring), and the scroll event for it has not landed.
    root.scrollTop = 120
    fireEvent.click(refresh)
    expect(refresh.hasAttribute('disabled')).toBe(true)
    await waitFor(() => expect(refresh.hasAttribute('disabled')).toBe(false))
    expect(injected.catalog).toHaveBeenCalledTimes(2)
    expect(tops.get(root)).toBe(120)
    page.dispose()
  })

  it('waits for the installed list as well as the catalog before it restores', async () => {
    const tops = rememberScrollTop()
    let answerInstalled: (entries: ShopInstalledEntry[]) => void = () => {}
    const injected: ShopTabInjected = {
      ...face(async () => CATALOG),
      installed: vi.fn(() => new Promise<ShopInstalledEntry[]>(resolve => { answerInstalled = resolve })),
    }
    const page = storeFor(injected)
    page.recordScroll(420)
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    await waitFor(() => expect(container.querySelector('[data-shop-entry]')).toBeTruthy())
    const root = container.querySelector('[data-shop-page]')
    if (root === null) throw new Error('no page')
    // The Updatable section and the Installed view are drawn from that list,
    // so restored on the catalog alone the position would clamp to a page
    // that is shorter only until the list answers.
    expect(tops.get(root)).toBeUndefined()
    await act(async () => { answerInstalled([]) })
    await waitFor(() => expect(tops.get(root)).toBe(420))
    page.dispose()
  })

  it('restores once the installed list has failed, too: an error is an answer', async () => {
    const tops = rememberScrollTop()
    const injected: ShopTabInjected = {
      ...face(async () => CATALOG),
      installed: vi.fn(async () => { throw new Error('the profile could not be read') }),
    }
    const page = storeFor(injected)
    page.recordScroll(420)
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    await waitFor(() => expect(container.querySelector('[data-shop-entry]')).toBeTruthy())
    const root = container.querySelector('[data-shop-page]')
    if (root === null) throw new Error('no page')
    await waitFor(() => expect(tops.get(root)).toBe(420))
    page.dispose()
  })

  it.each([
    ['a wheel', (node: Element) => { fireEvent.wheel(node) }],
    ['a touch', (node: Element) => { fireEvent.touchStart(node) }],
    ['a key', (node: Element) => { fireEvent.keyDown(node, { key: 'PageDown' }) }],
  ] as const)('does not restore once the reader has moved, by %s', async (_how, move) => {
    const tops = rememberScrollTop()
    let answer: (value: ShopCatalogResult) => void = () => {}
    const injected = face(() => new Promise(resolve => { answer = resolve }))
    const page = storeFor(injected)
    page.recordScroll(420)
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    const root = container.querySelector('[data-shop-page]')
    if (root === null) throw new Error('no page')
    move(root)
    await act(async () => { answer(CATALOG) })
    await waitFor(() => expect(container.querySelector('[data-shop-entry]')).toBeTruthy())
    expect(tops.get(root)).toBeUndefined()
    page.dispose()
  })

  it('records the position as the reader scrolls', () => {
    rememberScrollTop()
    const injected = face(async () => CATALOG)
    const page = storeFor(injected)
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    const root = container.querySelector('[data-shop-page]')
    if (root === null) throw new Error('no page')
    root.scrollTop = 310
    fireEvent.scroll(root)
    expect(page.readScroll()).toBe(310)
    page.dispose()
  })
})

describe('the page returns the reader to the card they left (design 2026-10-16-shop-sidebar-page §5.7)', () => {
  type Entry = ShopCatalogResult['plugins'][number]
  const listing = (name: string, extra: Partial<Entry> = {}): Entry => ({
    name, version: '1.0.0', integrity: null, publishedAt: null,
    repository: 'https://github.com/you/plugin', license: 'MIT',
    tier: 'community', metadata: 'derived', source: 'npm', added: '2026-10-16',
    catalog: { category: 'tool', summary: { en: 'A plugin.', zh: '一个插件。' }, capabilities: [] },
    ...extra,
  })
  const THEME: Partial<Entry> = { catalog: { category: 'theme', summary: { en: 'A theme.', zh: '一个主题。' }, capabilities: [] } }
  /** The twin the cases leave at the page's top edge: a repository listed
   * under the name an npm package lists too. Their names collide, and the npm
   * one comes first; their identities do not collide. */
  const TWIN = 'github:you/dsh-twin#'
  /** No stars, so the names order the shelf, and the twins keep the
   * catalog's order. */
  const SHELF: ShopCatalogResult = {
    ...CATALOG,
    plugins: [
      listing('dsh-a-plugin'),
      listing('dsh-b-plugin', THEME),
      listing('dsh-c-plugin', THEME),
      listing('dsh-twin'),
      listing('dsh-twin', { source: 'github', repo: 'you/dsh-twin' }),
      listing('dsh-z-plugin'),
    ],
  }
  /** The heights the reader scrolled past. */
  const READ: Record<string, number> = {
    'npm:dsh-a-plugin': 100, 'npm:dsh-b-plugin': 180, 'npm:dsh-c-plugin': 90, 'npm:dsh-twin': 120, [TWIN]: 110, 'npm:dsh-z-plugin': 130,
  }
  const read = (key: string): number => READ[key] ?? 0
  /** What a remount lays every card out at until it renders: new elements
   * remember no size, so `contain-intrinsic-size: auto 140px` holds. */
  const placeholder = (): number => 140
  const shelfShown = (container: Element) => waitFor(() => expect(container.querySelector('[data-shop-identity]')).toBeTruthy())

  /** The reader's first visit: the twin left `into` px above the top edge,
   * then the page left. Returns the position it was left at. */
  async function leaveAtTwin(page: ShopPageStore, injected: ShopTabInjected, into: number): Promise<number> {
    const { container, unmount } = renderPage(en, { ...injected, page } as ShopTabInjected)
    await shelfShown(container)
    const root = pageOf(container)
    root.scrollTop = contentTopOf(container, TWIN, read) + into
    fireEvent.scroll(root)
    expect(page.readAnchor()).toEqual({ key: TWIN, offset: -into })
    const left = root.scrollTop
    unmount()
    return left
  }

  it.each([
    ['inside it', 30, -30],
    ['in the gap above it', -4, 4],
  ] as const)('records the first card whose bottom lies below the top edge, and its offset, with the edge %s', async (_where, into, offset) => {
    rememberScrollTop()
    layOut({ heights: read })
    const injected = face(async () => SHELF)
    const page = storeFor(injected)
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    await shelfShown(container)
    const root = pageOf(container)
    root.scrollTop = contentTopOf(container, TWIN, read) + into
    fireEvent.scroll(root)
    expect(page.readAnchor()).toEqual({ key: TWIN, offset })
    expect(page.readScroll()).toBe(root.scrollTop)
    page.dispose()
  })

  it('records no card for a reader above the shelf, who comes back to the top though the content above the shelf grew', async () => {
    const tops = rememberScrollTop()
    const table: { heights: (key: string) => number; top?: number } = { heights: read }
    layOut(table)
    const injected = face(async () => SHELF)
    const page = storeFor(injected)
    const first = renderPage(en, { ...injected, page } as ShopTabInjected)
    await shelfShown(first.container)
    // Back at the top, in the head: the first card stands SHELF_TOP below the
    // edge, far past the shelf's gap between cards.
    const firstRoot = pageOf(first.container)
    firstRoot.scrollTop = 0
    fireEvent.scroll(firstRoot)
    first.unmount()
    // While the reader was away, the content above the shelf grew, as a
    // self-update's log does.
    table.top = SHELF_TOP + 60
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    await shelfShown(container)
    await waitFor(() => expect(tops.get(pageOf(container))).toBe(0))
    expect(page.readAnchor()).toBeNull()
    page.dispose()
  })

  it('finds that card with a handful of rect reads on each scroll, never one per card', async () => {
    rememberScrollTop()
    const shelf: ShopCatalogResult = { ...CATALOG, plugins: Array.from({ length: 40 }, (_, i) => listing(`dsh-plugin-${String(i).padStart(2, '0')}`)) }
    const even = (): number => 100
    const layout = layOut({ heights: even })
    const injected = face(async () => shelf)
    const page = storeFor(injected)
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    await shelfShown(container)
    expect(identitiesOf(container)).toHaveLength(40)
    const root = pageOf(container)
    root.scrollTop = contentTopOf(container, 'npm:dsh-plugin-30', even) + 10
    layout.reads = 0
    fireEvent.scroll(root)
    expect(page.readAnchor()).toEqual({ key: 'npm:dsh-plugin-30', offset: -10 })
    // A binary search over 40 cards probes at most ceil(log2(41)) of them,
    // and the card it lands on is read once more for its top.
    expect(layout.reads).toBeLessThanOrEqual(Math.ceil(Math.log2(41)) + 1)
    page.dispose()
  })

  it('puts that card back at the same height, though every card above it lays out at its placeholder height', async () => {
    rememberScrollTop()
    const table = { heights: read }
    layOut(table)
    const injected = face(async () => SHELF)
    const page = storeFor(injected)
    const left = await leaveAtTwin(page, injected, 30)
    table.heights = placeholder
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    await shelfShown(container)
    // The npm twin stands first, so a card found by its name would be the
    // wrong one.
    expect(identitiesOf(container).indexOf('npm:dsh-twin')).toBeLessThan(identitiesOf(container).indexOf(TWIN))
    await waitFor(() => expect(offsetOf(container, TWIN)).toBe(-30))
    // The position the reader left would have put another card there.
    expect(pageOf(container).scrollTop).not.toBe(left)
    page.dispose()
  })

  it('sets the recorded position when that card is no longer on the shelf', async () => {
    const tops = rememberScrollTop()
    const table = { heights: read }
    layOut(table)
    // A refresh between the two visits took the twin off the shelf.
    const without: ShopCatalogResult = { ...SHELF, plugins: SHELF.plugins.filter(entry => entry.source === 'npm') }
    const injected = face(vi.fn<() => Promise<ShopCatalogResult>>().mockResolvedValueOnce(SHELF).mockResolvedValue(without))
    const page = storeFor(injected)
    const left = await leaveAtTwin(page, injected, 30)
    table.heights = placeholder
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    await shelfShown(container)
    expect(identitiesOf(container)).not.toContain(TWIN)
    await waitFor(() => expect(tops.get(pageOf(container))).toBe(left))
    page.dispose()
  })

  it('puts the card back only once: a refresh that redraws the shelf leaves the page where the browser put it', async () => {
    const tops = rememberScrollTop()
    const table = { heights: read }
    layOut(table)
    const injected = face(async () => SHELF)
    const page = storeFor(injected)
    await leaveAtTwin(page, injected, 30)
    table.heights = placeholder
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    await shelfShown(container)
    await waitFor(() => expect(offsetOf(container, TWIN)).toBe(-30))
    const root = pageOf(container)
    const refresh = container.querySelector('[data-shop-catalog-refresh]')
    if (refresh === null) throw new Error('no refresh')
    // The browser moves the page by no wheel, touch or key, and the scroll
    // event for it has not landed.
    root.scrollTop = 120
    fireEvent.click(refresh)
    expect(refresh.hasAttribute('disabled')).toBe(true)
    await waitFor(() => expect(refresh.hasAttribute('disabled')).toBe(false))
    expect(injected.catalog).toHaveBeenCalledTimes(3)
    expect(tops.get(root)).toBe(120)
    page.dispose()
  })

  it.each([
    ['a wheel', (node: Element) => { fireEvent.wheel(node) }],
    ['a touch', (node: Element) => { fireEvent.touchStart(node) }],
    ['a key', (node: Element) => { fireEvent.keyDown(node, { key: 'PageDown' }) }],
  ] as const)('does not put the card back once the reader has moved, by %s', async (_how, move) => {
    const tops = rememberScrollTop()
    const table = { heights: read }
    layOut(table)
    let answer: (value: ShopCatalogResult) => void = () => {}
    const injected = face(vi.fn<() => Promise<ShopCatalogResult>>()
      .mockResolvedValueOnce(SHELF)
      .mockImplementation(() => new Promise(resolve => { answer = resolve })))
    const page = storeFor(injected)
    await leaveAtTwin(page, injected, 30)
    table.heights = placeholder
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    const root = pageOf(container)
    move(root)
    await act(async () => { answer(SHELF) })
    await shelfShown(container)
    expect(tops.get(root)).toBeUndefined()
    page.dispose()
  })

  it('sets the recorded position when the reader refiltered the shelf and left without scrolling', async () => {
    const tops = rememberScrollTop()
    const table = { heights: read }
    layOut(table)
    const injected = face(async () => SHELF)
    const page = storeFor(injected)
    const first = renderPage(en, { ...injected, page } as ShopTabInjected)
    await shelfShown(first.container)
    const firstRoot = pageOf(first.container)
    firstRoot.scrollTop = contentTopOf(first.container, TWIN, read) + 30
    fireEvent.scroll(firstRoot)
    expect(page.readAnchor()).toEqual({ key: TWIN, offset: -30 })
    const left = firstRoot.scrollTop
    // The tools alone: the two themes above the twin leave the shelf, and no
    // scroll event follows to write the card the reader now sees.
    const tools = first.container.querySelector('[data-shop-category-tab="tool"]')
    if (tools === null) throw new Error('no tool category')
    fireEvent.click(tools)
    first.unmount()
    table.heights = placeholder
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    await shelfShown(container)
    // The twin is still on the shelf: only the forgotten card sends the page
    // to the position, which is what the reader last saw.
    expect(identitiesOf(container)).toContain(TWIN)
    expect(identitiesOf(container)).not.toContain('npm:dsh-b-plugin')
    await waitFor(() => expect(tops.get(pageOf(container))).toBe(left))
    page.dispose()
  })

  /** `n` animation frames, as jsdom paces them. */
  const frames = (n: number): Promise<void> => new Promise(resolve => {
    let left = n
    const step = (): void => { if (--left <= 0) resolve(); else requestAnimationFrame(step) }
    requestAnimationFrame(step)
  })
  /** The second visit, with the twin put back under placeholder heights. */
  async function returnToTwin(table: { heights: (key: string) => number }) {
    const injected = face(async () => SHELF)
    const page = storeFor(injected)
    await leaveAtTwin(page, injected, 30)
    table.heights = placeholder
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    await shelfShown(container)
    await waitFor(() => expect(offsetOf(container, TWIN)).toBe(-30))
    return { page, container, root: pageOf(container) }
  }
  /** The browser's own scroll anchoring, which jsdom does not have: when the
   * cards above the twin change height in a layout it may adjust, it moves
   * the page by as much, so the twin stays where it stands, unless the page
   * has turned it off (`overflow-anchor: none`). A case lays out through this
   * the layouts the anchoring may adjust; any other layout it leaves alone,
   * as the shelf's entry animation makes it leave those it runs through
   * (design 2026-10-16-shop-sidebar-page §5.7). */
  function anchoringLaysOut(root: HTMLElement, container: Element, change: () => void): void {
    const before = offsetOf(container, TWIN)
    change()
    if (getComputedStyle(root).overflowAnchor === 'none') return
    root.scrollTop += offsetOf(container, TWIN) - before
  }

  it('holds the card at its height while the cards above it render at their real heights', async () => {
    rememberScrollTop()
    const table = { heights: read }
    layOut(table)
    // The hold's frames and the clock it reads run on the case's own clock,
    // which moves only when the case moves it: no load on the machine can
    // push the hold's step past `HOLD_MS`.
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    restores.push(() => { vi.useRealTimers() })
    const { page, container } = await returnToTwin(table)
    // The cards around the twin render and drop their placeholder height,
    // which moves every card below them up the page.
    table.heights = read
    expect(offsetOf(container, TWIN)).toBe(-100)
    vi.advanceTimersToNextFrame()
    expect(offsetOf(container, TWIN)).toBe(-30)
    page.dispose()
  })

  it('holds the card through every step, though the browser\'s own anchoring would take one of them', async () => {
    rememberScrollTop()
    const table = { heights: read }
    layOut(table)
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    restores.push(() => { vi.useRealTimers() })
    const { page, container, root } = await returnToTwin(table)
    // The card just above the twin renders first, in a layout the anchoring
    // may adjust: one the shelf's entry animation did not move the cards in.
    anchoringLaysOut(root, container, () => { table.heights = key => key === 'npm:dsh-twin' ? read(key) : placeholder() })
    vi.advanceTimersToNextFrame()
    // The rest render in a frame of that animation, which keeps the
    // anchoring out: no hand but the page's takes this step.
    table.heights = read
    vi.advanceTimersToNextFrame()
    expect(offsetOf(container, TWIN)).toBe(-30)
    page.dispose()
  })

  it.each([
    ['a wheel', (node: Element) => { fireEvent.wheel(node) }],
    ['a touch', (node: Element) => { fireEvent.touchStart(node) }],
    ['a key', (node: Element) => { fireEvent.keyDown(node, { key: 'PageDown' }) }],
  ] as const)('stops holding the card once the reader moves, by %s', async (_how, move) => {
    rememberScrollTop()
    const table = { heights: read }
    layOut(table)
    const { page, container, root } = await returnToTwin(table)
    move(root)
    table.heights = read
    await frames(3)
    // Where the cards' real heights put it, with the page where it was.
    expect(offsetOf(container, TWIN)).toBe(-100)
    page.dispose()
  })

  it('keeps holding the card when the browser rounds the position the page wrote', async () => {
    const tops = rememberScrollTop()
    const table = { heights: read }
    layOut(table)
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    restores.push(() => { vi.useRealTimers() })
    // Left half a pixel into the twin, so the restore writes a fraction.
    const injected = face(async () => SHELF)
    const page = storeFor(injected)
    await leaveAtTwin(page, injected, 30.5)
    table.heights = placeholder
    const { container } = renderPage(en, { ...injected, page } as ShopTabInjected)
    await shelfShown(container)
    await waitFor(() => expect(offsetOf(container, TWIN)).toBe(-30.5))
    // The browser keeps whole pixels: the position it holds is not quite the
    // one the page wrote, and no other hand moved it.
    const root = pageOf(container)
    tops.set(root, Math.round(tops.get(root) ?? 0))
    table.heights = read
    vi.advanceTimersToNextFrame()
    expect(offsetOf(container, TWIN)).toBe(-30.5)
    page.dispose()
  })

  it('stops holding the card once the page is scrolled by any other hand, such as a dragged scrollbar', async () => {
    const tops = rememberScrollTop()
    const table = { heights: read }
    layOut(table)
    const { page, root } = await returnToTwin(table)
    root.scrollTop = 500
    table.heights = read
    await frames(3)
    expect(tops.get(root)).toBe(500)
    page.dispose()
  })

  it('holds the card for a moment only', async () => {
    const tops = rememberScrollTop()
    const table = { heights: read }
    layOut(table)
    const { page, container, root } = await returnToTwin(table)
    const restored = tops.get(root)
    await new Promise(resolve => { setTimeout(resolve, HOLD_MS + 100) })
    table.heights = read
    await frames(3)
    expect(tops.get(root)).toBe(restored)
    expect(offsetOf(container, TWIN)).toBe(-100)
    page.dispose()
  })

  it.each([
    ['its moment runs out', (_root: HTMLElement) => { vi.advanceTimersByTime(HOLD_MS + 100) }],
    ['the reader moves', (root: HTMLElement) => { fireEvent.wheel(root); vi.advanceTimersToNextFrame() }],
    ['another hand scrolls the page', (root: HTMLElement) => { root.scrollTop = 500; vi.advanceTimersToNextFrame() }],
  ] as const)('gives the page back to the browser\'s own anchoring once the hold ends, as when %s', async (_how, end) => {
    rememberScrollTop()
    const table = { heights: read }
    layOut(table)
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    restores.push(() => { vi.useRealTimers() })
    const { page, container, root } = await returnToTwin(table)
    end(root)
    // The cards above render with no hold left, as they do when the reader
    // scrolls up past cards that never rendered: the anchoring keeps the card
    // where it stands.
    const standing = offsetOf(container, TWIN)
    anchoringLaysOut(root, container, () => { table.heights = read })
    expect(offsetOf(container, TWIN)).toBe(standing)
    page.dispose()
  })
})

describe('the sidebar glyph (design 2026-10-16-shop-sidebar-page §4.3)', () => {
  it('draws glyph B the way dsh draws its own glyphs, whatever the selection', () => {
    const idle = render(<ShopGlyph size={18} active={false} />).container.querySelector('svg')
    if (idle === null) throw new Error('no glyph')
    expect(idle.getAttribute('width')).toBe('18')
    expect(idle.getAttribute('height')).toBe('18')
    expect(idle.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(idle.getAttribute('fill')).toBe('none')
    expect(idle.getAttribute('stroke')).toBe('currentColor')
    expect(idle.getAttribute('stroke-width')).toBe('1')
    expect(idle.getAttribute('aria-hidden')).toBe('true')
    expect([...idle.querySelectorAll('path')].map(path => path.getAttribute('d'))).toEqual([
      'M4.7 5.5H11.3Q12.5 5.5 12.632 6.693L13.368 13.307Q13.5 14.5 12.3 14.5H3.7Q2.5 14.5 2.632 13.307L3.368 6.693Q3.5 5.5 4.7 5.5Z',
      'M5.75 5.5V4.25a2.25 2.25 0 0 1 4.5 0V5.5',
      'M8 12.75V11.25',
      'M8 11.25C7.4 10.2 6.6 9.8 5.75 9.75',
      'M8 11.25C8.6 10.2 9.4 9.8 10.25 9.75',
    ])
    // The row draws the selection; the glyph is the same either way.
    const active = render(<ShopGlyph size={18} active />).container.querySelector('svg')
    expect(active?.outerHTML).toBe(idle.outerHTML)
  })
})
