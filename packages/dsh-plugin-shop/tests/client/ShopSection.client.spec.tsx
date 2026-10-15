// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en, zh, type ShopLocaleKey } from '../../src/client/locales.ts'
import { ShopSection } from '../../src/client/ShopSection.tsx'
import type { ShopTabInjected, ShopTabProps } from '../../src/client/ShopTab.tsx'

afterEach(() => { cleanup() })

/** Every injected method left pending: the body stays in its loading state,
 * which is all the header needs beside it. */
function pending(): ShopTabInjected {
  const never = (): Promise<never> => new Promise<never>(() => {})
  return {
    catalog: vi.fn(never),
    install: vi.fn(never),
    installStatus: vi.fn(never),
    setEnabled: vi.fn(never),
    installed: vi.fn(never),
    installedSpecs: vi.fn(never),
    uninstall: vi.fn(never),
    restart: vi.fn(never),
    version: vi.fn(never),
    updateStart: vi.fn(never),
  } as unknown as ShopTabInjected
}

function renderSection(dict: Record<ShopLocaleKey, string>) {
  const t = ((key: ShopLocaleKey) => dict[key]) as ShopTabProps['t']
  return render(<ShopSection {...({ t, close: vi.fn(), ...pending() } as unknown as ShopTabProps)} />)
}

describe('the shop Settings section (design §5.1, amended 2026-10-15)', () => {
  it.each([
    ['en', en, 'Plugin shop', 'Browse, install, and update plugins from the catalog.'],
    ['zh', zh, '插件商店', '浏览、安装和更新目录中的插件。'],
  ] as const)('titles the page and states its intro line in %s, above the shop body', (_lang, dict, title, intro) => {
    const { container } = renderSection(dict)
    const heading = container.querySelector('[data-shop-section-title]')
    const lead = container.querySelector('[data-shop-section-intro]')
    const body = container.querySelector('[data-shop-tab]')
    if (heading === null || lead === null || body === null) throw new Error('the section did not render its three parts')
    expect(heading.tagName).toBe('H2')
    expect(heading.textContent).toBe(title)
    expect(lead.textContent).toBe(intro)
    expect(heading.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(lead.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
