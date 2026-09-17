/**
 * One keyed registry of install-shaped flows: start, poll to terminal, reset.
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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ShopInstallStatusResult } from '../host/index.ts'
import { INSTALL_POLL_MS, reduceInstall, type InstallEvent, type InstallView } from './present.ts'
import { isTerminalInstallState } from '../shared/install-state.ts'

/** One identity's flow, as the tab hands it to a panel. */
export interface KeyedFlow<TArgs> {
  view: InstallView
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

/** Shared idle view, so every key WITHOUT a flow yields one object rather
 * than a fresh literal per call. That is what lets `flowFor` below answer
 * "did this key change?" by identity. */
const IDLE_VIEW: InstallView = { kind: 'idle' }

/**
 * @param begin the starting RPC and its answer, mapped to the first view.
 *   Never rejects: a transport throw is the caller's to fold into a view,
 *   because only the caller knows which localized line stands in for a detail
 *   too private to render.
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
  const [views, setViews] = useState<ReadonlyMap<string, InstallView>>(() => new Map())
  const settled = useRef(onSettled)
  settled.current = onSettled

  const put = useCallback((key: string, view: InstallView): void => {
    setViews(current => {
      const next = new Map(current)
      next.set(key, view)
      return next
    })
  }, [])

  const apply = useCallback((key: string, event: InstallEvent): void => {
    setViews(current => {
      const before = current.get(key) ?? { kind: 'idle' as const }
      const after = reduceInstall(before, event)
      if (after === before) return current
      const next = new Map(current)
      next.set(key, after)
      return next
    })
  }, [])

  const start = useCallback(async (key: string, args: TArgs): Promise<void> => {
    // `idle` first, so a retry of a settled flow clears the previous outcome
    // before the new request is in flight rather than after it answers.
    put(key, { kind: 'idle' })
    put(key, await begin(args))
  }, [begin, put])

  const reset = useCallback((key: string): void => {
    setViews(current => {
      if (!current.has(key)) return current
      const next = new Map(current)
      next.delete(key)
      return next
    })
  }, [])

  // One interval polls every running identity; duplicate panels never poll
  // the same host record independently.
  useEffect(() => {
    const running: Array<[string, string]> = []
    for (const [key, view] of views) {
      if (view.kind === 'running') running.push([key, view.installId])
    }
    if (running.length === 0) return
    const timer = setInterval(() => {
      for (const [key, installId] of running) {
        void installStatus({ installId }).then(status => {
          apply(key, { type: 'status', status })
          if (status.found && isTerminalInstallState(status.state)) settled.current?.(key, status.state)
        }, () => {
          // Poll failures are transient; the retained host record is retried.
        })
      }
    }, INSTALL_POLL_MS)
    return () => clearInterval(timer)
  }, [views, installStatus, apply])

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
    const cached = flowCache.current.get(key)
    if (cached !== undefined && cached.view === view) return cached
    const flow: KeyedFlow<TArgs> = {
      view,
      start: args => start(key, args),
      reset: () => reset(key),
    }
    flowCache.current.set(key, flow)
    return flow
  }, [views, start, reset])

  return { flowFor, resetFlow: reset, pending }
}
