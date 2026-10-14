/**
 * Just enough of a rendering engine for the red fold to be measured in jsdom,
 * which lays nothing out: every element answers 0 for `scrollHeight` and
 * `clientHeight`, so a block can never be shown to overflow there.
 *
 * The model is the fold's own: inside a fold block (the CSS module stub names
 * it `_foldBlock` collapsed and `_foldBlockExpanded` open) every `<p>` and
 * `<code>` is one line per line of its text, `LINE_PX` tall. The block's
 * content is the sum, and a collapsed block's box is clamped at two lines the
 * way `-webkit-line-clamp: 2` clamps it; an open one is as tall as its
 * content. Every other element keeps jsdom's 0.
 *
 * `StubResizeObserver` reports the way a browser's does: an element only when
 * its box changed size. So a block already clamped at two lines whose content
 * grows is never reported — which is the case the fold has to hear some other
 * way. `settle()` is the layout pass that delivers.
 */

export const LINE_PX = 18

const CLAMP_LINES = 2

// The stubbed module class is `_<key>`, with or without a hash suffix.
const FOLD_BLOCK = /(^|\s)_foldBlock(Expanded)?(_\S*)?(\s|$)/
const OPEN = /(^|\s)_foldBlockExpanded(_\S*)?(\s|$)/

function isFoldBlock(el: Element): boolean {
  return FOLD_BLOCK.test(el.className)
}

function contentPx(el: Element): number {
  let lines = 0
  for (const node of el.querySelectorAll('p, code')) lines += (node.textContent ?? '').split('\n').length
  return lines * LINE_PX
}

/** Install the model on HTMLElement; the returned function takes it off. */
export function installFoldGeometry(): () => void {
  const proto = HTMLElement.prototype
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isFoldBlock(this) ? contentPx(this) : 0
    },
  })
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (!isFoldBlock(this)) return 0
      const content = contentPx(this)
      return OPEN.test(this.className) ? content : Math.min(content, CLAMP_LINES * LINE_PX)
    },
  })
  // Own properties shadow the Element.prototype getters jsdom defines;
  // deleting them puts those back.
  return () => {
    delete (proto as { scrollHeight?: number }).scrollHeight
    delete (proto as { clientHeight?: number }).clientHeight
  }
}

export class StubResizeObserver {
  private static readonly live = new Set<StubResizeObserver>()
  private readonly sizes = new Map<Element, number>()

  constructor(private readonly callback: ResizeObserverCallback) {
    StubResizeObserver.live.add(this)
  }

  observe(el: Element): void {
    // A browser reports every element once when observation starts; -1 is a
    // size no box has, so the first settle reports it.
    this.sizes.set(el, -1)
  }

  unobserve(el: Element): void {
    this.sizes.delete(el)
  }

  disconnect(): void {
    this.sizes.clear()
    StubResizeObserver.live.delete(this)
  }

  /** Deliver to each observer the elements whose box height changed since it
   * last reported them, as a browser's layout pass does. */
  static settle(): void {
    for (const observer of [...StubResizeObserver.live]) {
      const changed: Element[] = []
      for (const [el, last] of observer.sizes) {
        const now = (el as HTMLElement).clientHeight
        if (now !== last) {
          observer.sizes.set(el, now)
          changed.push(el)
        }
      }
      if (changed.length > 0) {
        observer.callback(changed.map(target => ({ target }) as ResizeObserverEntry), observer as unknown as ResizeObserver)
      }
    }
  }
}
