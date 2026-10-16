/**
 * React's view of a keyed registry of install-shaped flows (flow-registry.ts):
 * start, poll to terminal, reset.
 *
 * Install and uninstall are the same machine. Both fold a
 * `ShopInstallStatusResult` through `reduceInstall` into an `InstallView`,
 * both poll every running identity from one interval, and both must keep a
 * settled outcome after the installed projection that follows it drops the
 * row the panel was mounted on (I-1, §7.2) — which is why the state is keyed
 * by identity here rather than held by the card.
 *
 * They differ in exactly one place: what the STARTING RPC's answer means. An
 * install refusal is a `rejected` view carrying the gate's code; an uninstall
 * refusal is a `failed` view carrying the host's published detail, because
 * `ShopUninstallResult`'s failure variant has no code to populate and those
 * codes belong to the install gate. That difference is the registry's
 * `begin`, and it is the whole of it.
 *
 * The two used to be hand-synced copies — 71 of 84 lines identical. The cost
 * was not theoretical: a single review round had to make the same edit twice
 * (the settle signature, and its call), and the `pending` set below was added
 * to one of them and not the other before this module existed.
 *
 * Since 2026-10-16 the registry is its own module, framework-free, and the
 * polling belongs to it: a component's effect stopped the moment the shop left
 * the screen (design 2026-10-16-shop-sidebar-page §5). This module only
 * renders one, through `useRegistryFlows`.
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import type { InstallArgs } from '../host/index.ts'
import { IDLE_VIEW, type FlowRegistry } from './flow-registry.ts'
import type { InstallView } from './present.ts'

/** One identity's flow, as the tab hands it to a panel. */
export interface KeyedFlow<TArgs> {
  view: InstallView
  /** A start for THIS key is in flight and unanswered. The button that
   * offered it renders disabled with a wait cursor while this holds, and a
   * second `start` for the same key is ignored rather than sent. */
  starting: boolean
  start: (args: TArgs) => Promise<void>
  reset: () => void
}

export interface UseKeyedFlows<TArgs> {
  /** Two panels asking for the same identity receive one flow — the SAME
   * object, for as long as that identity's view is unchanged, so a
   * memoized consumer handed the result re-renders only when its own flow
   * moves. The accessor's identity still tracks `views`; the result's does
   * not, and the result is what a card should be given. */
  flowFor: (key: string) => KeyedFlow<TArgs>
  /** Return every identity whose view `predicate` selects to `idle`, and
   * nothing else. Stable across renders, unlike `flowFor`; a call selecting
   * nothing leaves the registry — and so every flow and `pending` — exactly
   * as it was. The receipts dsh restarting under the page settled are
   * cleared the same way at the store, through each registry's own
   * `resetWhere` (page-store.ts `noteRestarted`; design §8, 2026-10-06
   * amendment). */
  resetWhere: (predicate: (view: InstallView) => boolean) => void
  /**
   * The identities whose flow is not `idle` — asked by the shelf, which has
   * to keep a settled uninstall's row in the Installed view after the
   * installed projection drops it.
   *
   * A membership test rather than a flow, and its IDENTITY changes only when
   * that membership does. Both matter to the same caller: `flowFor` builds a
   * fresh object and two closures per call, so asking it inside a filter
   * allocated three objects for every entry on the shelf; and it tracks
   * `views`, which changes on every poll RESPONSE, because `reduceInstall`
   * returns a new `running` view for each status. A filter depending on that
   * re-ran over the whole catalog once a second for a log line nobody read.
   */
  pending: ReadonlySet<string>
}

/** One entry's install flow, as the tab hands it to a panel: the page
 * store's install registry (page-store.ts), begun through flow-registry.ts's
 * `beginInstall`. */
export type InstallFlow = KeyedFlow<InstallArgs>

/** One entry's uninstall flow, as the tab hands it to a panel: the page
 * store's uninstall registry, begun through `beginUninstall`. */
export type UninstallFlow = KeyedFlow<{ name: string }>

/** The uninstall flows as the tab hands them to the shadowed rows. */
export type UseUninstallFlows = UseKeyedFlows<{ name: string }>

/** Shared empty set, so an idle registry hands out one stable identity. */
const NO_PENDING: ReadonlySet<string> = new Set()

/** The keyed-flow face over any registry: one of the page store's, which
 * outlives the component, or one of the store a tab builds for itself when
 * none is handed over (ShopTab). */
export function useRegistryFlows<TArgs>(registry: FlowRegistry<TArgs>): UseKeyedFlows<TArgs> {
  const { views, starting } = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const start = useCallback((key: string, args: TArgs) => registry.start(key, args), [registry])
  const reset = useCallback((key: string): void => { registry.reset(key) }, [registry])
  const resetWhere = useCallback((predicate: (view: InstallView) => boolean): void => { registry.resetWhere(predicate) }, [registry])

  const pendingRef = useRef<ReadonlySet<string>>(NO_PENDING)
  const pending = useMemo(() => {
    const next = new Set<string>()
    for (const [key, view] of views) if (view.kind !== 'idle') next.add(key)
    // Keep the previous instance when the membership is unchanged: that is
    // the whole point of this value, and a fresh Set per poll response would
    // invalidate every memo depending on it exactly as `views` does.
    const previous = pendingRef.current
    if (previous.size === next.size && [...next].every(key => previous.has(key))) return previous
    pendingRef.current = next
    return next
  }, [views])

  // One flow object per key, rebuilt only when THAT key's view changes.
  //
  // `flowFor` itself cannot be frozen: a caller holding a stale accessor
  // would never learn that the install it is showing has moved on. What has
  // to be stable is the RESULT per key, because that is what a memoized card
  // compares. `views` is replaced wholesale on every poll RESPONSE, but
  // `reduceInstall` returns the same view object when a key's state did not
  // change, and a key with no flow yields the shared `IDLE_VIEW` — so
  // comparing views by identity is exactly the question being asked.
  //
  // Without this the accessor was the prop, so every mounted card failed
  // `memo`'s shallow compare once a second for the whole duration of any one
  // install anywhere: a shelf of visible cards rebuilding their badge rows,
  // two inline SVGs each and their blocker paragraphs, for an install none of
  // them were party to.
  //
  // The cache holds one small object per key ever asked — bounded by how far
  // the reader scrolls, since `visibleCount` only grows — and is dropped
  // whole when `start` or `reset` change identity, which is the hook being
  // handed another registry: a retained flow would go on calling the
  // superseded registry. An idle key's view is the one shared `IDLE_VIEW` in
  // every registry, so the view alone cannot tell the two flows apart.
  const flowCache = useRef(new Map<string, KeyedFlow<TArgs>>())
  const flowClosures = useRef({ start, reset })
  const flowFor = useCallback((key: string): KeyedFlow<TArgs> => {
    if (flowClosures.current.start !== start || flowClosures.current.reset !== reset) {
      flowCache.current = new Map()
      flowClosures.current = { start, reset }
    }
    const view = views.get(key) ?? IDLE_VIEW
    // `starting` is part of the identity for the reason `view` is: it is a
    // fact the consumer renders from — the button is disabled and its cursor
    // waits while it holds — so a flow that kept the old object would leave
    // the button live through the whole in-flight window.
    const isStarting = starting.has(key)
    const cached = flowCache.current.get(key)
    if (cached !== undefined && cached.view === view && cached.starting === isStarting) return cached
    const flow: KeyedFlow<TArgs> = {
      view,
      starting: isStarting,
      start: args => start(key, args),
      reset: () => reset(key),
    }
    flowCache.current.set(key, flow)
    return flow
  }, [views, starting, start, reset])

  return { flowFor, resetWhere, pending }
}
