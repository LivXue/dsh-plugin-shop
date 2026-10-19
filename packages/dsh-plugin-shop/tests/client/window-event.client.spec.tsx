// @vitest-environment jsdom
import { useEffect, useLayoutEffect, useState } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'

afterEach(() => { cleanup() })

/** Hold the thread for `ms`, the way a long commit does. */
function spin(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) { /* a commit's synchronous work */ }
}

describe('window.event in a jsdom spec answers as it does in a browser', () => {
  // React chooses the priority of an update it is not dispatching an event
  // for by reading `window.event`: undefined gives the default lane, a click
  // the sync lane. A spec whose global keeps a stale click schedules every
  // later update as discrete, so no gap between a commit and its effects
  // ever opens, and a case cannot see a bug that lives in one.

  it('reads the click inside the handler React runs for it', () => {
    let seen: string | undefined
    const { getByRole } = render(<button type="button" onClick={() => { seen = window.event?.type }}>go</button>)
    fireEvent.click(getByRole('button'))
    expect(seen).toBe('click')
  })

  it('reads undefined once that click is over', () => {
    const { getByRole } = render(<button type="button" onClick={() => {}}>go</button>)
    fireEvent.click(getByRole('button'))
    expect(window.event).toBeUndefined()
  })

  it('runs the effects of an update made outside any event after its commit, not inside it, once a click has been handled', async () => {
    // A commit that outlasts the scheduler's 5 ms slice makes React yield
    // before a default-lane commit's passive effects, so the commit's own DOM
    // mutation is heard first. A sync-lane commit runs them inside itself.
    const effects: number[] = []
    let set: (value: number) => void = () => {}
    function Probe() {
      const [value, setValue] = useState(0)
      set = setValue
      useLayoutEffect(() => { if (value > 0) spin(10) }, [value])
      useEffect(() => { effects.push(value) }, [value])
      return <button type="button" data-value={value} onClick={() => {}}>go</button>
    }
    const { getByRole } = render(<Probe />)
    fireEvent.click(getByRole('button'))
    expect(effects).toEqual([0])
    // Outside act, so React schedules the update on its own, as in a page.
    const flags = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    const inAct = flags.IS_REACT_ACT_ENVIRONMENT
    onTestFinished(() => { flags.IS_REACT_ACT_ENVIRONMENT = inAct })
    flags.IS_REACT_ACT_ENVIRONMENT = false
    const button = getByRole('button')
    const committed = new Promise<void>(resolve => {
      const observer = new MutationObserver(() => {
        if (button.getAttribute('data-value') !== '1') return
        observer.disconnect()
        resolve()
      })
      observer.observe(button, { attributes: true })
    })
    set(1)
    await committed
    expect(effects, 'the commit ran its passive effects inside itself').toEqual([0])
    await waitFor(() => expect(effects).toEqual([0, 1]))
  })
})
