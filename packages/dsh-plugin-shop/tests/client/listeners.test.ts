/**
 * The listener plumbing the client's three external stores share
 * (listeners.ts): the page store, the flow registries and the restart
 * monitor. One place for what a subscribe returns and for whom a change
 * reaches, which three copies could each have drifted on.
 */
import { describe, expect, it, vi } from 'vitest'
import { forget, listen, notify } from '../../src/client/listeners.ts'

describe('a store\'s listeners', () => {
  it('adds a listener, and hands back what removes it, once or twice alike', () => {
    const listeners = new Set<() => void>()
    const heard = vi.fn()
    const unlisten = listen(listeners, heard)
    notify(listeners)
    unlisten()
    unlisten()
    notify(listeners)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })

  it('tells every listener as the set stood when the change began, whatever one of them subscribes meanwhile', () => {
    // React re-subscribes in the render a change causes; a listener added
    // during a notify hears the next change, not this one.
    const listeners = new Set<() => void>()
    const late = vi.fn()
    const first = vi.fn(() => { listen(listeners, late) })
    listen(listeners, first)
    notify(listeners)
    expect(first).toHaveBeenCalledTimes(1)
    expect(late).not.toHaveBeenCalled()
    notify(listeners)
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('tells nobody once forgotten', () => {
    const listeners = new Set<() => void>()
    const heard = vi.fn()
    listen(listeners, heard)
    forget(listeners)
    notify(listeners)
    expect(heard).not.toHaveBeenCalled()
  })

  it('takes no listener once forgotten, and hands back what removes nothing', () => {
    // A disposed store keeps nobody: a React tree that subscribes in a hot
    // swap's window would only be held by it.
    const listeners = new Set<() => void>()
    forget(listeners)
    const heard = vi.fn()
    const unlisten = listen(listeners, heard)
    expect(listeners.size).toBe(0)
    unlisten()
    notify(listeners)
    expect(heard).not.toHaveBeenCalled()
  })
})
