// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FoldableRedBlock } from '../../src/client/FoldableRedBlock.tsx'
import { en, type ShopLocaleKey } from '../../src/client/locales.ts'
import type { ShopTabProps } from '../../src/client/ShopTab.tsx'
import { installFoldGeometry, StubResizeObserver } from '../fixtures/fold-geometry.ts'

const t = ((key: ShopLocaleKey): string => en[key]) as ShopTabProps['t']

/** A red block of one-line paragraphs, the shape `BlockerLine` renders. */
function Block({ lines }: { lines: string[] }) {
  return (
    <FoldableRedBlock t={t} attrName="data-shop-remedy">
      {lines.map((line, index) => <p key={index}>{line}</p>)}
    </FoldableRedBlock>
  )
}

const toggleOf = (container: HTMLElement): HTMLButtonElement | null => container.querySelector('[data-shop-fold]')
/** The browser's layout pass: resize observations are delivered. */
const settle = async (): Promise<void> => { await act(async () => { StubResizeObserver.settle() }) }
/** A microtask, inside act: what a MutationObserver needs to deliver. */
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

describe('the red fold, measured the way a browser measures it', () => {
  // Every case here runs with a ResizeObserver present, because every engine
  // the shop supports has one. Without it, jsdom would hand the hook a code
  // path no browser takes.
  let uninstall: () => void = () => {}
  beforeEach(() => {
    uninstall = installFoldGeometry()
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
  })
  afterEach(() => {
    cleanup()
    uninstall()
    vi.unstubAllGlobals()
  })

  it('offers the toggle for a block taller than two lines, and none for one that fits', async () => {
    const tall = render(<Block lines={['a', 'b', 'c']} />)
    await settle()
    expect(toggleOf(tall.container), 'three lines under a two-line clamp, and no toggle').not.toBeNull()
    cleanup()
    const fits = render(<Block lines={['a', 'b']} />)
    await settle()
    expect(toggleOf(fits.container), 'two lines fit the clamp, and a toggle anyway').toBeNull()
  })

  it('offers the toggle when a block at exactly two lines grows past them', async () => {
    // The case a ResizeObserver cannot hear: the clamp holds the box at two
    // lines, so the third line changes nothing it observes.
    const { container, rerender } = render(<Block lines={['a', 'b']} />)
    await settle()
    expect(toggleOf(container)).toBeNull()
    rerender(<Block lines={['a', 'b', 'c']} />)
    await flush()
    await settle()
    expect(toggleOf(container), 'a third line arrived and no toggle was offered').not.toBeNull()
  })

  it('withdraws the toggle when the block shrinks back to fit', async () => {
    const { container, rerender } = render(<Block lines={['a', 'b', 'c']} />)
    await settle()
    expect(toggleOf(container)).not.toBeNull()
    rerender(<Block lines={['a']} />)
    await flush()
    await settle()
    expect(toggleOf(container), 'a toggle over a block with nothing to unfold').toBeNull()
  })

  it('keeps the toggle through the press that opened the block', async () => {
    // Open, a block is as tall as its content and fits by construction.
    // Reading that as "nothing to fold" once took the toggle away with the
    // very press that opened it.
    const { container } = render(<Block lines={['a', 'b', 'c']} />)
    await settle()
    fireEvent.click(toggleOf(container) as HTMLButtonElement)
    await flush()
    await settle()
    expect(toggleOf(container), 'the press that opened the fold took its toggle').not.toBeNull()
    expect(toggleOf(container)?.getAttribute('aria-expanded')).toBe('true')
  })

  it('measures again on collapse, so a block that shrank while open loses the toggle then', async () => {
    const { container, rerender } = render(<Block lines={['a', 'b', 'c']} />)
    await settle()
    fireEvent.click(toggleOf(container) as HTMLButtonElement)
    rerender(<Block lines={['a']} />)
    await flush()
    await settle()
    // Still open, so nothing is measured, and the toggle stays to close it.
    expect(toggleOf(container)?.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggleOf(container) as HTMLButtonElement)
    await flush()
    await settle()
    expect(toggleOf(container), 'collapsed onto a block that fits, and kept a toggle').toBeNull()
  })

  it('offers nothing where nothing can be measured', async () => {
    // jsdom's own answer, 0 for every height: no proof of overflow, so no
    // toggle — and the block stays in the DOM, whole.
    uninstall()
    const { container } = render(<Block lines={['a', 'b', 'c']} />)
    await settle()
    expect(toggleOf(container)).toBeNull()
    expect(container.querySelectorAll('[data-shop-remedy] p')).toHaveLength(3)
  })
})
