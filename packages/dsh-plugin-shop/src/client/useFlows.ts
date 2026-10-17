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
 * codes belong to the install gate. That difference is the `begin` parameter,
 * and it is the whole of it.
 *
 * The two used to be hand-synced copies — 71 of 84 lines identical. The cost
 * was not theoretical: a single review round had to make the same edit twice
 * (the settle signature, and its call), and the `pending` set below was added
 * to one of them and not the other before this module existed.
 *
 * Since 2026-10-16 the registry is its own module, framework-free, and the
 * polling belongs to it: a component's effect stopped the moment the shop left
 * the screen (design 2026-10-16-shop-sidebar-page §5).
 */

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ShopInstallStatusResult } from '../host/index.ts'
import { createFlowRegistry, IDLE_VIEW, type FlowRegistry, type FlowRegistryDeps } from './flow-registry.ts'
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
  /** Return one identity to `idle` without building a flow for it. Stable
   * across renders (unlike `flowFor`, whose identity tracks `views`), so one
   * registry's settle callback can supersede the other's receipt for the same
   * key without taking a dependency on that registry's output. */
  resetFlow: (key: string) => void
  /** Return every identity whose view `predicate` selects to `idle`, and
   * nothing else. Stable across renders like `resetFlow`; a call selecting
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

/** Shared empty set, so an idle registry hands out one stable identity. */
const NO_PENDING: ReadonlySet<string> = new Set()

/**
 * A component's own registry: built once, handed the latest functions on
 * every render, and polling only while the component is mounted —
 * `pollUnwatched` is off, so unmounting stops it, as the effect that used to
 * poll did, and a second mount (React StrictMode's included) resumes it.
 *
 * @param begin the starting RPC and its answer, mapped to the first view.
 *   Never rejects: a transport throw is the caller's to fold into a view,
 *   because only the caller knows which localized line stands in for a
 *   detail too private to render.
 * @param onSettled called once per identity that reaches a terminal state,
 *   with WHICH terminal state. The outcome is load-bearing: a failed flow
 *   changed nothing on the server, so a caller acting on "settled" alone
 *   discards outcomes that are still true.
 */
export function useKeyedFlows<TArgs>(
  begin: (args: TArgs) => Promise<InstallView>,
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>,
  onSettled?: (key: string, outcome: 'done' | 'failed') => void,
): UseKeyedFlows<TArgs> {
  const deps = useRef<FlowRegistryDeps<TArgs>>({ begin, installStatus, onSettled })
  deps.current = { begin, installStatus, onSettled }
  const [registry] = useState(() => createFlowRegistry<TArgs>(() => deps.current, { pollUnwatched: false }))
  return useRegistryFlows(registry)
}

/** The keyed-flow face over any registry: a component's own, or one of the
 * page store's, which outlives the component. */
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
  // whole when `start` or `reset` change identity, because a retained flow
  // would go on calling the superseded closure.
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

  return { flowFor, resetFlow: reset, resetWhere, pending }
}
