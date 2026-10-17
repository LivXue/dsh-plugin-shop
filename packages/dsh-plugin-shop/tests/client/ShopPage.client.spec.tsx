// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en, zh, type ShopLocaleKey } from '../../src/client/locales.ts'
import { createPageStore, type ShopPageStore } from '../../src/client/page-store.ts'
import { ShopGlyph } from '../../src/client/ShopGlyph.tsx'
import { ShopPage } from '../../src/client/ShopPage.tsx'
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
  denied: [], stars: {}, incompatible: {}, incompatibleHarness: {},
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

describe('the shop page (design 2026-10-16-shop-sidebar-page §4.2)', () => {
  it.each([
    ['en', en, 'Plugin shop', 'Browse, install, and update plugins from the catalog.'],
    ['zh', zh, '插件商店', '浏览、安装和更新目录中的插件。'],
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

describe('the page keeps its scroll position (design §5.7)', () => {
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

describe('the sidebar glyph (design §4.3)', () => {
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
