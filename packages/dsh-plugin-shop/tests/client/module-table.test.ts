/**
 * The browser half of the peer verdict: a name the host could not resolve is
 * reported missing only when the page's module table does not provide it
 * either. The pure core is driven by plain oracles; the live oracle by a fake
 * `ClientModuleLoader` whose `import` behaves the way the harness's own does
 * for the two branches a probe is allowed to reach — a seed word resolves,
 * anything else rejects with the harness's exact "cannot resolve" message.
 */
import { describe, expect, it, vi } from 'vitest'
import { moduleTableOracle, refineAgainstModuleTable, refineIncompatible, type ModuleOracle } from '../../src/client/module-table.ts'

/** The rejection `ClientModuleSystem.import` throws for a name nothing
 * provides, copied verbatim from @deepseek-ai/dsh-client-modules 0.1.5-rc.3
 * (`lib/client.js`). Verbatim because the oracle keys "absent" on its prefix:
 * a paraphrase written here would agree with whatever prefix the code checks,
 * which is how a fixture ends up passing for the wrong reason. */
const cannotResolve = (specifier: string): Error =>
  new Error(`client-modules: cannot resolve "${specifier}" — not a seed word, not a materialized module, and not a row in the boot graph (the runtime mirror of the bundle purity gate)`)

/** The web shell's module-table seed on 0.1.5-rc.3, read out of
 * dsh-web-frontend's bundle (the `staticModules` it hands the module system).
 * Only `@deepseek-ai/cordis` of these exists as a package on disk. */
const SEED = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]

interface FakeTableOptions {
  /** Graph rows: `dsh.client` packages in this profile's boot graph. */
  rows?: string[]
  /** Ids already materialized into `loadCache`. */
  cached?: string[]
  /** A rejection other than "cannot resolve" for the specs it names. */
  rejectWith?: (specifier: string) => unknown
}

/** A `ClientModuleLoader` with the harness's public shape. Its `import` answers
 * the seed and throws "cannot resolve" for everything else; it deliberately
 * does NOT serve rows or cached records, so an oracle that reached `import`
 * for one of those would read it as absent and the verdict tests would fail —
 * the spy assertions below are the second, direct check of the same rule. */
function fakeTable({ rows = [], cached = [], rejectWith }: FakeTableOptions = {}) {
  const probe = vi.fn(async (specifier: string, _parentURL: string, _attrs: Record<string, unknown>): Promise<unknown> => {
    const failure = rejectWith?.(specifier)
    if (failure !== undefined) throw failure
    if (SEED.includes(specifier)) return { seeded: specifier }
    throw cannotResolve(specifier)
  })
  const table = {
    version: 'client' as const,
    manifest: {
      rev: 'r1',
      modules: rows.map(id => ({ id, url: `/plugin/${id}?rev=r1`, initialUrl: '/batch?rev=r1', rev: 'r1', inject: [], external: [] })),
      plugins: rows.map(id => ({ id, inject: [], immediately: false })),
    },
    loadCache: new Map(cached.map(id => [id, { id, exports: {}, styles: [], edges: new Set<string>() }])),
    import: probe,
    prefetch: vi.fn(async (_id: string) => {}),
    invalidate: vi.fn((_id: string, _rev?: string) => {}),
  }
  return { table, probe }
}

/** The specs `import` was asked about, in call order. */
const asked = (probe: ReturnType<typeof fakeTable>['probe']): string[] => probe.mock.calls.map(call => call[0])

describe('refineIncompatible', () => {
  /** An oracle over a fixed answer table; a name it does not know is unknown. */
  const oracleOf = (answers: Record<string, boolean | null>): ModuleOracle =>
    async spec => (Object.hasOwn(answers, spec) ? answers[spec] ?? null : null)

  it('removes every name the oracle provides and keeps the ones it does not', async () => {
    const refined = await refineIncompatible(
      { 'npm:a': ['react', '@x/absent'] },
      oracleOf({ react: true, '@x/absent': false }),
    )
    expect(refined).toEqual({ 'npm:a': ['@x/absent'] })
  })

  it('drops an entry whose every name turns out to be provided', async () => {
    const refined = await refineIncompatible(
      { 'npm:seed-only': ['react', 'react-dom'], 'npm:real': ['@x/absent'] },
      oracleOf({ react: true, 'react-dom': true, '@x/absent': false }),
    )
    expect(refined).toEqual({ 'npm:real': ['@x/absent'] })
  })

  it('gives NO verdict to an entry any of whose names is unknown, and judges the rest', async () => {
    // The host's own rule, for the host's reason: an unavailable fact must
    // never read as an accusation. Keeping `@x/absent` and dropping the
    // unknown name would publish a partial list as if it were the whole one.
    const refined = await refineIncompatible(
      { 'npm:unknowable': ['@x/unknown', '@x/absent'], 'npm:judged': ['@x/absent'] },
      oracleOf({ '@x/unknown': null, '@x/absent': false }),
    )
    expect(refined).toEqual({ 'npm:judged': ['@x/absent'] })
  })

  it('reads an oracle that throws or rejects as unknown, never as absent', async () => {
    const throwing: ModuleOracle = spec => {
      if (spec === '@x/sync-throw') throw new Error('boom')
      if (spec === '@x/rejects') return Promise.reject(new Error('boom'))
      return Promise.resolve(false)
    }
    const refined = await refineIncompatible(
      { 'npm:sync': ['@x/sync-throw'], 'npm:async': ['@x/rejects'], 'npm:absent': ['@x/absent'] },
      throwing,
    )
    expect(refined).toEqual({ 'npm:absent': ['@x/absent'] })
  })

  it('reads an answer that is neither yes nor no as unknown', async () => {
    // The oracle type rules this out; a wire value or a future oracle is not
    // the type. `undefined` must not slip through as "provided" — the silent
    // direction would be fine, but only by accident — nor as "absent".
    const vague = (async () => undefined) as unknown as ModuleOracle
    expect(await refineIncompatible({ 'npm:a': ['@x/vague'] }, vague)).toEqual({})
  })

  it('asks each distinct name once, however many entries declare it', async () => {
    const oracle = vi.fn<ModuleOracle>(async spec => spec === 'react')
    await refineIncompatible(
      { 'npm:a': ['react', '@x/absent'], 'npm:b': ['react', '@x/absent'], 'npm:c': ['react'] },
      oracle,
    )
    expect(oracle.mock.calls.map(call => call[0]).sort()).toEqual(['@x/absent', 'react'])
  })

  it('asks nothing when the host reported nothing', async () => {
    const oracle = vi.fn<ModuleOracle>(async () => false)
    expect(await refineIncompatible({}, oracle)).toEqual({})
    expect(oracle).not.toHaveBeenCalled()
  })

  it('gives no verdict to a name whose probe never settles, and judges the rest', async () => {
    // `refineAgainstModuleTable` promises a table in any state cannot cost the
    // reader the catalog. An `import()` that never settles would have made
    // that false by leaving the tab with nothing to render, so a probe that
    // outlives its deadline reads as unknown — the same answer as a probe that
    // threw, and the same silence.
    const hanging: ModuleOracle = spec => spec === '@x/hangs' ? new Promise(() => {}) : Promise.resolve(false)
    const refined = await refineIncompatible(
      { 'npm:hung': ['@x/hangs', '@x/absent'], 'npm:judged': ['@x/absent'] },
      hanging,
      20,
    )
    expect(refined).toEqual({ 'npm:judged': ['@x/absent'] })
  })

  it('does not wait on a probe that settles, and leaves no timer behind', async () => {
    // The deadline is a guard, not a delay: a seed-word lookup settles in a
    // microtask, and a settled probe must clear its timer rather than hold the
    // process (or a test) open for the full timeout.
    vi.useFakeTimers()
    try {
      const refined = await refineIncompatible({ 'npm:a': ['react'] }, oracleOf({ react: true }), 60_000)
      expect(refined).toEqual({})
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('refineAgainstModuleTable', () => {
  it('clears the seed words node resolution cannot find, and keeps what nothing provides', async () => {
    // The measured false alarm: the seed is answered from the shell's own
    // instances and never touches node resolution, so the host reports every
    // seed word but `@deepseek-ai/cordis` missing — `react` alone accused 1,177
    // live plugins of lacking a module the page serves to all of them.
    const { table } = fakeTable()
    const refined = await refineAgainstModuleTable({
      'npm:react-only': ['react', 'react-dom'],
      'npm:store': ['@deepseek-ai/dsh-client-store'],
      'npm:truly-missing': ['react', '@dsh-shop-e2e/absent-peer'],
    }, table)
    expect(refined).toEqual({ 'npm:truly-missing': ['@dsh-shop-e2e/absent-peer'] })
  })

  it('counts a graph row as provided WITHOUT importing it', async () => {
    // `import` of a graph row fetches the bundle and runs its module body:
    // a probe must never be the thing that loads a plugin.
    const { table, probe } = fakeTable({ rows: ['@x/row-plugin'] })
    const refined = await refineAgainstModuleTable({ 'npm:a': ['@x/row-plugin', '@x/absent'] }, table)
    expect(refined).toEqual({ 'npm:a': ['@x/absent'] })
    expect(asked(probe)).not.toContain('@x/row-plugin')
  })

  it('counts an already materialized module as provided WITHOUT importing it', async () => {
    const { table, probe } = fakeTable({ cached: ['@x/materialized'] })
    const refined = await refineAgainstModuleTable({ 'npm:a': ['@x/materialized'] }, table)
    expect(refined).toEqual({})
    expect(probe).not.toHaveBeenCalled()
  })

  it('normalizes a trailing /client onto its row or record, but asks the seed by the spec as written', async () => {
    // The table keys rows and records by package name and strips `/client`
    // before looking there — while the seed holds `react-dom/client` itself,
    // so the probe must pass the spec through untouched.
    const { table, probe } = fakeTable({ rows: ['@x/row-plugin'], cached: ['@x/materialized'] })
    const refined = await refineAgainstModuleTable({
      'npm:row': ['@x/row-plugin/client'],
      'npm:cached': ['@x/materialized/client'],
      'npm:seed': ['react-dom/client'],
      'npm:absent': ['@x/absent/client'],
    }, table)
    expect(refined).toEqual({ 'npm:absent': ['@x/absent/client'] })
    expect(asked(probe).sort()).toEqual(['@x/absent/client', 'react-dom/client'])
    expect(probe).toHaveBeenCalledWith('react-dom/client', '', {})
  })

  it('leaves an entry unjudged when the table rejects for any other reason', async () => {
    // Only the harness's own "cannot resolve" means absent. A factory that
    // throws, a require cycle, a failed fetch — each is a fact we do not have.
    const { table } = fakeTable({
      rejectWith: spec => (spec === '@x/broken' ? new Error('client-modules: require cycle through "@x/broken" (factory-form CJS cannot deliver partial exports)') : undefined),
    })
    const refined = await refineAgainstModuleTable({
      'npm:unjudged': ['@x/broken', '@x/absent'],
      'npm:judged': ['@x/absent'],
    }, table)
    expect(refined).toEqual({ 'npm:judged': ['@x/absent'] })
  })

  it.each([
    ['a reworded message', new Error('client-modules: could not resolve "@x/absent"')],
    ['a rejection that is not an Error', 'client-modules: cannot resolve "@x/absent"'],
  ])('degrades to silence, not to an accusation, on %s', async (_what, rejection) => {
    // A harness that rewords its message loses the one signal that means
    // "absent", and every probe then answers unknown. That is the safe
    // direction: the tab says nothing rather than something false.
    const { table } = fakeTable({ rejectWith: () => rejection })
    expect(await refineAgainstModuleTable({ 'npm:a': ['@x/absent'] }, table)).toEqual({})
  })

  it('asks the table about each distinct name once', async () => {
    const { table, probe } = fakeTable()
    await refineAgainstModuleTable({
      'npm:a': ['react', '@x/absent'],
      'npm:b': ['react', '@x/absent'],
    }, table)
    expect(asked(probe).sort()).toEqual(['@x/absent', 'react'])
  })

  it.each([
    ['no modules service at all', undefined],
    ['null', null],
    ['an object with none of the members', {}],
    ['manifest.modules that is not an array', { ...fakeTable().table, manifest: { rev: 'r', modules: 'x', plugins: [] } }],
    ['a manifest that is not an object', { ...fakeTable().table, manifest: null }],
    ['a loadCache that is not a Map', { ...fakeTable().table, loadCache: {} }],
    ['an import that is not a function', { ...fakeTable().table, import: 'nope' }],
    ['a member that throws when read', { get manifest(): never { throw new Error('getter') }, loadCache: new Map(), import: async () => ({}) }],
  ])('gives NO verdict at all when the page has %s', async (_what, service) => {
    // Measured, the host's node-only verdict is majority-false on this harness
    // line, so an unrefined list is known to be unreliable — and silence is the
    // documented degradation, never the host's list as it arrived.
    expect(moduleTableOracle(service)).toBeNull()
    expect(await refineAgainstModuleTable({ 'npm:a': ['@x/absent'], 'npm:b': ['react'] }, service)).toEqual({})
  })

  it('never imports anything through a table it judged unusable', async () => {
    const { table, probe } = fakeTable()
    await refineAgainstModuleTable({ 'npm:a': ['@x/absent'] }, { ...table, loadCache: {} })
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('refineAgainstModuleTable: the page-removed set', () => {
  it('keeps the host verdict for a name this page uninstalled, even though the table still lists it as a row, and never asks the table to import it', async () => {
    // dock-base is a graph row here — modeling either 0.1.5-rc.3, where a row
    // placed at boot stands unchanged for the page's whole life, or the
    // window on 0.1.7-rc.2 before this page's own uninstall has reconciled,
    // when the old row still stands in `manifest.modules`. Either way this is
    // exactly the false "provided" the page-removed set exists to prevent.
    const { table, probe } = fakeTable({ rows: ['dock-base'] })
    const refined = await refineAgainstModuleTable(
      { 'npm:needs-dock-base': ['dock-base', '@x/absent'] },
      table,
      new Set(['dock-base']),
    )
    expect(refined).toEqual({ 'npm:needs-dock-base': ['dock-base', '@x/absent'] })
    expect(asked(probe)).toEqual(['@x/absent'])
  })

  it('never lets the removed override ask the table about a removed name, even one neither a row nor cached that import would resolve', async () => {
    // After 0.1.7-rc.2 reconciles this page's own uninstall,
    // `manifest.modules` no longer lists the removed package at all
    // (module-table.ts's header, step 1) — the genuinely post-reconcile
    // shape, unlike the row-based fixture above which models the
    // pre-reconcile / 0.1.5-rc.3 case. `react` is neither a row nor cached
    // here, and the table's own `import` WOULD resolve it (a seed word) if
    // ever asked — so this is the
    // one shape that tells apart "removed intercepts before the oracle is
    // consulted" from a mutant that asks the oracle FIRST and overrides the
    // answer after: such a mutant still gets `dock-base` right in the test
    // above (a row short-circuits before `import` regardless of ordering) but
    // would call `import('react', ...)` here, which this test forbids.
    const { table, probe } = fakeTable()
    const refined = await refineAgainstModuleTable(
      { 'npm:needs-react': ['react', '@x/absent'] },
      table,
      new Set(['react']),
    )
    expect(refined).toEqual({ 'npm:needs-react': ['react', '@x/absent'] })
    expect(asked(probe)).not.toContain('react')
  })

  it('normalizes a trailing /client before matching the removed set', async () => {
    const { table } = fakeTable({ rows: ['dock-base'] })
    const refined = await refineAgainstModuleTable(
      { 'npm:a': ['dock-base/client'] },
      table,
      new Set(['dock-base']),
    )
    expect(refined).toEqual({ 'npm:a': ['dock-base/client'] })
  })

  it('gives no verdict at all when there is no usable table, not even for a name this page uninstalled, and leaves an unrelated entry equally silent', async () => {
    // An unusable table yields NO peer verdicts, unconditionally: the
    // documented silence (design 2026-09-01-harness-compatibility section
    // 9.1) applies the same way whether or not the page-removed set happens
    // to be non-empty, because with no table nothing can falsely vouch for a
    // removed name in the first place. This replaces a deleted test that
    // asserted the opposite (a removed name surfacing even with no table).
    //
    // Two SEPARATE entries — one naming only the removed name, one naming
    // only an unrelated ordinary name — so a mutant that reinstates the old
    // `oracle === null && removed.size === 0` guard cannot hide behind
    // `refineIncompatible`'s own "an unknown name drops the whole entry"
    // rule: such a mutant wrongly keeps the removed-only entry's verdict (the
    // removed override still fires before ever asking a null oracle), in an
    // entry the unrelated name never shares.
    const refined = await refineAgainstModuleTable(
      { 'npm:removed-only': ['dock-base'], 'npm:ordinary-only': ['@x/ordinary'] },
      undefined,
      new Set(['dock-base']),
    )
    expect(refined).toEqual({})
  })

  it('still judges every other name in the same entry normally', async () => {
    const { table } = fakeTable({ rows: ['dock-base'] })
    const refined = await refineAgainstModuleTable(
      { 'npm:a': ['dock-base', 'react', '@x/absent'] },
      table,
      new Set(['dock-base']),
    )
    expect(refined).toEqual({ 'npm:a': ['dock-base', '@x/absent'] })
  })

  it('does not change behavior when the removed set is empty or omitted', async () => {
    const { table } = fakeTable({ rows: ['@x/row-plugin'] })
    const refined = await refineAgainstModuleTable({ 'npm:a': ['@x/row-plugin', '@x/absent'] }, table)
    expect(refined).toEqual({ 'npm:a': ['@x/absent'] })
  })
})
