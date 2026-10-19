/**
 * `window.event` in a jsdom spec, shaped as a browser shapes it.
 *
 * React chooses the priority of an update it is not dispatching an event for
 * by reading `window.event`: undefined gives the default lane, a click the
 * sync lane, which renders in a microtask and runs the commit's passive
 * effects inside the commit.
 *
 * vitest's jsdom environment copies the window's members onto the test global
 * as accessors whose setter keeps what is written, ahead of jsdom's getter,
 * for the rest of the file (`populateGlobal`, vitest 2.1.9). React's
 * development build writes `window.event` back after each event it dispatches
 * through its fake-event wrapper (`restoreAfterDispatch` in
 * `invokeGuardedCallbackDev`, react-dom 18.3.1). So a spec read its first
 * handled click from then on, every later update counted as discrete, and no
 * gap between a commit and its effects ever opened.
 *
 * The DOM declares `event` [Replaceable], and jsdom's own window keeps that
 * shape: a getter for the current event, and a write that replaces the
 * accessor with a plain data property, which React's wrapper takes away again
 * by putting the accessor back once its dispatch is over. This gives the test
 * global the same shape. It runs before every spec; a spec in the node
 * environment has no `jsdom` and is left alone.
 */
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom
if (dom !== undefined) {
  Object.defineProperty(globalThis, 'event', {
    configurable: true,
    enumerable: true,
    get: () => dom.window.event,
    set(value: unknown) {
      Object.defineProperty(globalThis, 'event', { configurable: true, enumerable: true, writable: true, value })
    },
  })
}
