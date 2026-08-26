# LLM-assigned Plugin Categories — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify every derived catalog listing into one of the six categories using the internal LLM gateway, record results in a committed `registry/categories.yml`, and publish them — with failures retried on every build.

**Architecture:** The committed `categories.yml` is a build INPUT (like `verified.yml`), so determinism holds: the LLM never runs inside the pure core. A new shell entry `classify.ts` harvests once, classifies pending derived names, updates the file, and drops the harvest at `dist/harvest.json` for `build.ts` to reuse (`--harvest-from`), halving npm load. Parsing/merging policy lives in two new pure modules (`llm-parse.ts`, `categories.ts`); the HTTP layer is the second network module, `llm-client.ts`.

**Tech Stack:** Node 24+ with `--experimental-strip-types`, TypeScript ESM with `.ts` import extensions, vitest, zod, yaml, OpenAI-compatible chat completions over `fetch`.

**Spec:** `docs/superpowers/specs/2026-08-26-llm-categorization-design.md` — the plan argues from the spec; read both.

## Global Constraints

- Determinism invariant: `categories.yml` is an input; the LLM writes inputs, never runs inside `gate/tier/emit/pipeline/schema/types`.
- Failing loudly: malformed `categories.yml` (bad YAML, unknown category, duplicate name) throws and stops the build; `parseFile`/`setUnique` patterns already exist in `config.ts`.
- LLM output is advisory: a bad classification must never gate, remove, or alter any listing beyond its category; discarded rows keep the entry as `other` and are retried next build (spec D4).
- Fixed vocabulary: `tool | provider | ui | workflow | integration | other` only. The model cannot extend it.
- Batch classification: 20 items per LLM call, `temperature 0`, `max_tokens 4096`, concurrency 4, bounded 429/5xx retry honoring `Retry-After` (mirror `npm-client.ts` discipline).
- Config via env only: `LLM_BASE_URL` (default `http://8.141.31.123:3000/v1`), `LLM_MODEL` (default `deepseek-v4-flash`), `LLM_API_KEY` (GitHub Actions secret; never in any repository file). An empty key skips classification entirely — this is how fork PRs behave.
- Author wins: declared `dsh.catalog.category` is never touched; `categories.yml` rows for declared names are pruned.
- English design docs; bilingual user-facing docs (`schema.md` + `schema.zh.md` update together).

---

### Task 1: categories reach the registry config

**Files:**
- Modify: `registry/scripts/src/types.ts:1-3` (Category union → derive from a const array)
- Modify: `registry/scripts/src/config.ts` (schema, input type, loader, ENOENT handling)
- Test: `registry/scripts/tests/config.test.ts` (update `empty` fixture + new cases)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `types.ts`: `export const CATEGORIES = ['tool', 'provider', 'ui', 'workflow', 'integration', 'other'] as const` and `export type Category = typeof CATEGORIES[number]`.
  - `config.ts`: `RegistryConfig` gains `categories: Map<string, Category>`; `parseRegistryConfig(input: { verified: string; denied: string; allowedSimilar: string; categories: string })`; `loadRegistryConfig(dir: string)` additionally reads `categories.yml`, treating ENOENT as `'[]'`.

- [ ] **Step 1: write the failing tests**

In `registry/scripts/tests/config.test.ts`, change the fixture line 4 to include the new file:

```ts
const empty = { verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]' }
```

`parseRegistryConfig` gains a required input, so every OTHER call site also needs the field (compile errors will name them; fix each by adding `categories: '[]'`):

- `registry/scripts/tests/pipeline.test.ts:11-15` — add `categories: '[]',`
- `registry/scripts/tests/tier.test.ts:6` — add `categories: '[]',`
- `registry/scripts/tests/gate.test.ts:6-9` and `:143` — add `categories: '[]',`

Append these tests (same file, inside the existing describe or a new one):

```ts
describe('parseRegistryConfig categories', () => {
  it('parses assigned categories', () => {
    const config = parseRegistryConfig({
      ...empty,
      categories: '- name: dsh-hello-plugin\n  category: tool\n- name: dsh-open-app\n  category: integration\n',
    })
    expect(config.categories.get('dsh-hello-plugin')).toBe('tool')
    expect(config.categories.get('dsh-open-app')).toBe('integration')
  })

  it('throws on an unknown category value', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      categories: '- name: dsh-hello-plugin\n  category: wizardry\n',
    })).toThrow(/categories\.yml/)
  })

  it('throws on a duplicate name', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      categories: '- name: dsh-hello-plugin\n  category: tool\n- name: dsh-hello-plugin\n  category: ui\n',
    })).toThrow(/duplicate entry for dsh-hello-plugin/)
  })

  it('throws when the file is not a list', () => {
    expect(() => parseRegistryConfig({ ...empty, categories: 'name: x\n' })).toThrow(/list/)
  })
})

describe('loadRegistryConfig', () => {
  it('treats a missing categories.yml as empty', () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'categories-config-'))
    try {
      for (const f of ['verified.yml', 'denied.yml', 'allowed-similar.yml']) writeFileSync(join(dir, f), '[]\n')
      const config = loadRegistryConfig(dir)
      expect(config.categories.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

Note: vitest supports top-level `import`; if the dynamic `await import` above reads awkwardly, move the node imports to the top of the test file with the other imports — the file currently imports only from vitest and `../src/config.ts`, so add `import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'`, `import { tmpdir } from 'node:os'`, `import { join } from 'node:path'` at the top instead.

- [ ] **Step 2: run tests, verify they fail**

Run: `pnpm vitest run registry/scripts/tests/config.test.ts`
Expected: FAIL — the new describe blocks error (`categories` not in `RegistryConfig` / input type; `loadRegistryConfig` fails on the new tests; the existing suite breaks at compile time because `empty` now passes an unknown property).

- [ ] **Step 3: implement**

In `registry/scripts/src/types.ts`, replace the `Category` declaration (line 1):

```ts
/** Closed set of catalog categories. Adding one is a schema change. */
export const CATEGORIES = ['tool', 'provider', 'ui', 'workflow', 'integration', 'other'] as const
export type Category = typeof CATEGORIES[number]
```

In `registry/scripts/src/config.ts`:

- extend imports: `import type { Category, Review } from './types.ts'` and add `import { CATEGORIES } from './types.ts'` (value import — combine: `import { CATEGORIES, type Category, type Review } from './types.ts'`).
- add the schema after `allowedSimilarSchema`:

```ts
const categoriesSchema = z.array(z.object({
  name: z.string().min(1),
  category: z.enum(CATEGORIES),
}).strict())
```

- add `categories: Map<string, Category>` to `RegistryConfig` with the doc `/** Package name to its LLM-assigned category (spec 2026-08-26-llm-categorization-design.md). */`.
- in `parseRegistryConfig`, extend the input type and add:

```ts
  const categories = new Map<string, Category>()
  for (const row of parseFile('categories.yml', input.categories, categoriesSchema)) {
    setUnique(categories, 'categories.yml', row.name, row.category)
  }
  return { verified, denied, allowedSimilar, categories }
```

- in `loadRegistryConfig`, read the file with ENOENT → `'[]'`:

```ts
import { existsSync, readFileSync } from 'node:fs'
// ...
function readOptional(dir: string, file: string): string {
  const path = join(dir, file)
  return existsSync(path) ? readFileSync(path, 'utf8') : '[]'
}
```

and use `categories: readOptional(dir, 'categories.yml')`. Note: `readOptional` returning `'[]'` for missing files is only used for `categories.yml`; keep the other three reads as-is (they must throw when missing — a missing `verified.yml` is a broken checkout).

- [ ] **Step 4: run tests, verify they pass**

Run: `pnpm vitest run registry/scripts/tests/config.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 5: commit**

```bash
git add registry/scripts/src/types.ts registry/scripts/src/config.ts registry/scripts/tests/config.test.ts
git commit -m "feat(registry): load LLM-assigned categories from categories.yml"
```

---

### Task 2: the gate applies the category map to derived listings

**Files:**
- Modify: `registry/scripts/src/gate.ts:118-127` (the derived branch)
- Test: `registry/scripts/tests/gate.test.ts`, `registry/scripts/tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `RegistryConfig.categories: Map<string, Category>` (Task 1).
- Produces: derived `Accepted.catalog.category` = `config.categories.get(name) ?? 'other'`; declared sections untouched.

- [ ] **Step 1: write the failing tests**

In `registry/scripts/tests/gate.test.ts`, locate the existing helper that builds a `RegistryConfig` (the suite constructs configs for each test; find the minimal one — if none exists, build one):

The file already has a `candidate()` factory (lines 18-34) and a `config` built via `parseRegistryConfig` (lines 6-9, now carrying `categories: '[]'`). Add this helper next to `candidate()`:

```ts
const withCategories = (rows: Record<string, string>): ReturnType<typeof parseRegistryConfig> =>
  parseRegistryConfig({
    verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n',
    denied: '- name: dsh-evil-plugin\n  reason: Exfiltrates credentials.\n',
    allowedSimilar: '- dsh-fs-tools\n',
    categories: rows === undefined ? '[]' : Object.entries(rows).map(([name, category]) => `- name: ${name}\n  category: ${category}\n`).join(''),
  })
```

Then add these three tests (note the derived candidate uses `catalog: undefined` so the derived branch runs):

```ts
  it('fills a derived listing with its LLM-assigned category', () => {
    const result = gate(
      candidate({ catalog: undefined, description: 'Does a helpful thing.' }),
      withCategories({ 'dsh-hello-plugin': 'tool' }),
    )
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.accepted.metadata).toBe('derived')
    expect(result.accepted.catalog.category).toBe('tool')
  })

  it('defaults a derived listing without a row to other', () => {
    const result = gate(candidate({ catalog: undefined, description: 'Does a helpful thing.' }), withCategories({}))
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.accepted.catalog.category).toBe('other')
  })

  it('never overrides a declared category', () => {
    // candidate() declares category: 'tool' (line 22); a provider row must not win
    const result = gate(candidate(), withCategories({ 'dsh-hello-plugin': 'provider' }))
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.accepted.metadata).toBe('declared')
    expect(result.accepted.catalog.category).toBe('tool')
  })
```

In `registry/scripts/tests/pipeline.test.ts`, the existing determinism test is at line 68. Add a categories-populated variant right after it, same shape, with a config built by adding `categories: '- name: dsh-derived-plugin\n  category: tool\n'` to the file's `parseRegistryConfig` call and asserting the derived plugin's published `catalog.category` is `tool`; then run `runPipeline` twice with identical inputs and assert `toBe` equality of both `pluginsJson` (the file's existing determinism test shows the exact assertion style).

- [ ] **Step 2: run tests, verify they fail**

Run: `pnpm vitest run registry/scripts/tests/gate.test.ts registry/scripts/tests/pipeline.test.ts`
Expected: FAIL — derived category is still `'other'` (and the pipeline determinism variant fails at compile time until configs are updated).

- [ ] **Step 3: implement**

In `registry/scripts/src/gate.ts`, in the derived branch, change:

```ts
    catalog = {
      category: 'other',
      summary: { en: description.slice(0, DERIVED_SUMMARY_MAX_LENGTH) },
      capabilities: [],
    }
```

to:

```ts
    catalog = {
      // LLM-assigned when the classifier has a row for this name (spec
      // 2026-08-26-llm-categorization-design.md); `other` until it does.
      category: config.categories.get(name) ?? 'other',
      summary: { en: description.slice(0, DERIVED_SUMMARY_MAX_LENGTH) },
      capabilities: [],
    }
```

No change to the declared branch.

- [ ] **Step 4: run tests, verify they pass**

Run: `pnpm vitest run registry/scripts/tests/gate.test.ts registry/scripts/tests/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add registry/scripts/src/gate.ts registry/scripts/tests/gate.test.ts registry/scripts/tests/pipeline.test.ts
git commit -m "feat(registry): derived listings take their category from categories.yml"
```

---

### Task 3: candidates carry keywords

**Files:**
- Modify: `registry/scripts/src/types.ts` (`Candidate`)
- Modify: `registry/scripts/src/npm-client.ts:99-130` (`toCandidate`)
- Test: `registry/scripts/tests/npm-client.test.ts` (toCandidate expectations), plus any fixture that constructs a full `Candidate` literal — search with `rg "Candidate" registry/scripts/tests` and update each literal to include `keywords: []`.

**Interfaces:**
- Consumes: nothing.
- Produces: `Candidate.keywords: string[]` — the npm manifest's `keywords`, filtered to strings, `[]` when absent. Classify input uses it (Task 7).

- [ ] **Step 1: write the failing tests**

In `registry/scripts/tests/npm-client.test.ts`, find the `toCandidate` tests (they feed a packument object and assert the projected candidate). Add:

```ts
it('extracts keywords from the manifest', () => {
  const doc = { /* reuse the existing happy-path packument fixture, plus */ }
  doc.versions[doc['dist-tags'].latest].keywords = ['dsh-plugin', 'files', 'git']
  const candidate = toCandidate(doc)
  expect(candidate?.keywords).toEqual(['dsh-plugin', 'files', 'git'])
})

it('uses an empty keyword list when the manifest has none', () => {
  const doc = { /* the same happy-path fixture WITHOUT a keywords key */ }
  const candidate = toCandidate(doc)
  expect(candidate?.keywords).toEqual([])
})

it('keeps only string keywords', () => {
  const doc = { /* happy-path fixture */ }
  doc.versions[doc['dist-tags'].latest].keywords = ['ok', 42, null, 'also-ok']
  const candidate = toCandidate(doc)
  expect(candidate?.keywords).toEqual(['ok', 'also-ok'])
})
```

Add `keywords: []` to every `Candidate` object literal the test suite builds for `gate`/`pipeline` fixtures (compile errors after Step 3 will name them; fix each by adding the field — no behavior assertions change).

- [ ] **Step 2: run tests, verify they fail**

Run: `pnpm vitest run registry/scripts/tests/npm-client.test.ts`
Expected: FAIL — `candidate?.keywords` is `undefined`, not `[]`.

- [ ] **Step 3: implement**

In `registry/scripts/src/types.ts`, add to `Candidate` after `description`:

```ts
  /** npm manifest `keywords`, strings only, `[]` when absent. Classify input. */
  keywords: string[]
```

In `registry/scripts/src/npm-client.ts`, extend the `manifest` shape in `toCandidate`:

```ts
      description?: unknown
      keywords?: unknown
```

and the return object:

```ts
    description: typeof manifest.description === 'string' ? manifest.description : null,
    keywords: Array.isArray(manifest.keywords)
      ? manifest.keywords.filter((k): k is string => typeof k === 'string')
      : [],
```

- [ ] **Step 4: run tests, verify they pass**

Run: `pnpm test`
Expected: PASS — the three new cases green; every suite compiles with the updated fixtures.

- [ ] **Step 5: commit**

```bash
git add registry/scripts/src/types.ts registry/scripts/src/npm-client.ts registry/scripts/tests/npm-client.test.ts
# plus any fixture files Step 1 touched
git commit -m "feat(registry): candidates carry npm keywords for the classifier"
```

---

### Task 4: pure LLM-response parser

**Files:**
- Create: `registry/scripts/src/llm-parse.ts`
- Test: `registry/scripts/tests/llm-parse.test.ts`

**Interfaces:**
- Consumes: `CATEGORIES`, `Category` from `./types.ts` (Task 1).
- Produces:

```ts
export function parseClassificationResponse(text: string, expectedNames: ReadonlySet<string>): Map<string, Category>
```

Adopts rows whose `name` is in `expectedNames` AND whose `category` is in `CATEGORIES`; everything else is dropped (the caller records the discard reason — this function only returns the valid map).

- [ ] **Step 1: write the failing tests**

Create `registry/scripts/tests/llm-parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseClassificationResponse } from '../src/llm-parse.ts'

const names = new Set(['dsh-alpha', 'dsh-beta', 'dsh-gamma'])

describe('parseClassificationResponse', () => {
  it('adopts every valid row', () => {
    const map = parseClassificationResponse(
      '[{"name":"dsh-alpha","category":"tool"},{"name":"dsh-beta","category":"provider"}]',
      names,
    )
    expect(map.get('dsh-alpha')).toBe('tool')
    expect(map.get('dsh-beta')).toBe('provider')
  })

  it('drops rows with an invented category', () => {
    const map = parseClassificationResponse(
      '[{"name":"dsh-alpha","category":"wizardry"},{"name":"dsh-beta","category":"ui"}]',
      names,
    )
    expect(map.has('dsh-alpha')).toBe(false)
    expect(map.get('dsh-beta')).toBe('ui')
  })

  it('drops rows naming a package outside the batch', () => {
    const map = parseClassificationResponse(
      '[{"name":"dsh-intruder","category":"tool"},{"name":"dsh-alpha","category":"ui"}]',
      names,
    )
    expect(map.has('dsh-intruder')).toBe(false)
    expect(map.get('dsh-alpha')).toBe('ui')
  })

  it('returns an empty map for non-JSON output', () => {
    expect(parseClassificationResponse('Sure! Here are the categories:', names).size).toBe(0)
    expect(parseClassificationResponse('', names).size).toBe(0)
  })

  it('returns an empty map when the JSON is not an array', () => {
    expect(parseClassificationResponse('{"name":"dsh-alpha","category":"tool"}', names).size).toBe(0)
  })
})
```

- [ ] **Step 2: run tests, verify they fail**

Run: `pnpm vitest run registry/scripts/tests/llm-parse.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: implement**

Create `registry/scripts/src/llm-parse.ts`:

```ts
import { CATEGORIES, type Category } from './types.ts'

/** A validated classification row. */
interface RawRow {
  name?: unknown
  category?: unknown
}

/**
 * Parse one LLM batch response into the rows worth adopting.
 *
 * The model's output is advisory (spec 2026-08-26-llm-categorization-design.md
 * D4/§5): rows with an unknown name or a category outside the fixed
 * vocabulary are dropped, and a response that is not a JSON array yields
 * nothing. Dropped rows leave the entry unclassified, which the next build
 * retries. Purity: no network, no clock, no filesystem.
 * @param text - the raw completion content.
 * @param expectedNames - the names this batch asked about; anything else is
 *   not evidence about the batch.
 * @returns the valid name→category assignments.
 */
export function parseClassificationResponse(text: string, expectedNames: ReadonlySet<string>): Map<string, Category> {
  const adopted = new Map<string, Category>()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // Not JSON: adopt nothing; the caller records the discard.
    return adopted
  }
  if (!Array.isArray(raw)) return adopted
  for (const row of raw as RawRow[]) {
    if (typeof row !== 'object' || row === null) continue
    if (typeof row.name !== 'string' || !expectedNames.has(row.name)) continue
    if (typeof row.category !== 'string') continue
    if (!(CATEGORIES as readonly string[]).includes(row.category)) continue
    adopted.set(row.name, row.category)
  }
  return adopted
}
```

- [ ] **Step 4: run tests, verify they pass**

Run: `pnpm vitest run registry/scripts/tests/llm-parse.test.ts`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add registry/scripts/src/llm-parse.ts registry/scripts/tests/llm-parse.test.ts
git commit -m "feat(registry): pure parser for LLM classification responses"
```

---

### Task 5: the LLM HTTP client

**Files:**
- Create: `registry/scripts/src/llm-client.ts`
- Test: `registry/scripts/tests/llm-client.test.ts`

**Interfaces:**
- Consumes: `parseClassificationResponse` (Task 4), `ClassifyItem` shape below.
- Produces:

```ts
export interface ClassifyItem { name: string; description: string | null; keywords: string[] }
export interface ClassifyBatchResult {
  classified: Map<string, Category>
  discarded: { name: string; reason: string }[]
}
export const CLASSIFY_BATCH_SIZE = 20
export async function classifyPackages(
  items: ClassifyItem[],
  options: {
    baseUrl: string
    model: string
    apiKey: string
    fetchImpl?: typeof fetch
    sleep?: (ms: number) => Promise<void>
  },
): Promise<ClassifyBatchResult>
```

Behavior: chunks `items` into `CLASSIFY_BATCH_SIZE`-sized batches, calls `POST {baseUrl}/chat/completions` (Bearer `apiKey`, `temperature 0`, `max_tokens 4096`) per batch with concurrency 4, retries 429/5xx up to 4 attempts honoring `Retry-After` (clamped 1s–8s, exponential 1/2/4/8s otherwise — mirror `npm-client.ts`), adopts rows via the parser, and records one discard reason per adopted-invalid item plus `whole-batch-unparseable` for the batch's remaining expected names.

- [ ] **Step 1: write the failing tests**

Create `registry/scripts/tests/llm-client.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { classifyPackages, CLASSIFY_BATCH_SIZE } from '../src/llm-client.ts'

const options = { baseUrl: 'http://gateway.example/v1', model: 'deepseek-v4-flash', apiKey: 'k' }

const item = (i: number) => ({ name: `dsh-pkg-${i}`, description: 'Does things.', keywords: ['dsh-plugin'] })

const okResponse = (names: string[]): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(names.map(n => ({ name: n, category: 'tool' }))) } }] }), { status: 200 })

describe('classifyPackages', () => {
  it('sends the bearer key and the OpenAI-compatible body', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} })
      return okResponse(['dsh-pkg-0'])
    }) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl })
    expect(calls[0]?.url).toBe('http://gateway.example/v1/chat/completions')
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer k')
    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.model).toBe('deepseek-v4-flash')
    expect(body.temperature).toBe(0)
    expect(body.max_tokens).toBe(4096)
    expect(result.classified.get('dsh-pkg-0')).toBe('tool')
  })

  it('splits 25 items into batches of 20 and 5', async () => {
    const fetched: number[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
      const input = JSON.parse(body.messages[0]!.content.match(/\[[\s\S]*\]/)![0]) as { name: string }[]
      fetched.push(input.length)
      return okResponse(input.map(i => i.name))
    }) as unknown as typeof fetch
    await classifyPackages(Array.from({ length: 25 }, (_, i) => item(i)), { ...options, fetchImpl })
    expect(fetched).toEqual([20, 5])
  })

  it('retries a 429 honoring Retry-After and succeeds', async () => {
    const delays: number[] = []
    const sleep = async (ms: number) => { delays.push(ms) }
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls === 1) return new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } })
      return okResponse(['dsh-pkg-0'])
    }) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl, sleep })
    expect(delays).toEqual([2000])
    expect(result.classified.get('dsh-pkg-0')).toBe('tool')
  })

  it('discards with a reason when the whole response is unparseable', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'no json here' } }] }), { status: 200 })) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl })
    expect(result.classified.size).toBe(0)
    expect(result.discarded).toContainEqual({ name: 'dsh-pkg-0', reason: 'unparseable batch' })
  })

  it('gives up after bounded retries with the last status', async () => {
    const sleep = async (_ms: number) => {}
    let calls = 0
    const fetchImpl = (async () => { calls += 1; return new Response('nope', { status: 503 }) }) as unknown as typeof fetch
    const result = await classifyPackages([item(0)], { ...options, fetchImpl, sleep })
    expect(calls).toBe(4)
    expect(result.classified.size).toBe(0)
    expect(result.discarded[0]?.reason).toContain('503')
  })
})
```

(If the batch-splitting test's regex over `content` is brittle in practice, replace it by passing the input through a helper the test can read — but keep the assertion on batch sizes 20 and 5.)

- [ ] **Step 2: run tests, verify they fail**

Run: `pnpm vitest run registry/scripts/tests/llm-client.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: implement**

Create `registry/scripts/src/llm-client.ts`:

```ts
/**
 * LLM classification client — the second module that reaches the network.
 *
 * Thin OpenAI-compatible layer over `POST {baseUrl}/chat/completions` with a
 * Bearer key. The model is a reasoning model (probe: 171 of 174 completion
 * tokens were reasoning), so items are classified in batches of
 * {@link CLASSIFY_BATCH_SIZE} to amortize that cost (spec
 * 2026-08-26-llm-categorization-design.md §3).
 * @module llm-client
 */

import { parseClassificationResponse } from './llm-parse.ts'
import type { Category } from './types.ts'

/** One package to classify: public npm metadata only (spec §3). */
export interface ClassifyItem {
  name: string
  description: string | null
  keywords: string[]
}

export interface ClassifyBatchResult {
  classified: Map<string, Category>
  /** Every expected name that ended the run without an adopted category, with why. */
  discarded: { name: string; reason: string }[]
}

export const CLASSIFY_BATCH_SIZE = 20

const CONCURRENCY = 4
const RETRY_LIMIT = 4
const RETRY_BASE_DELAY_MS = 1000
const RETRY_MAX_DELAY_MS = 8000

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The system prompt: the fixed vocabulary with the provider/integration tiebreak. */
const SYSTEM_PROMPT = [
  'You classify dsh plugin packages into exactly one of:',
  'tool — extends what the agent can do: commands, functions, utilities',
  'provider — connects to a service/API backend: model services, search APIs, cloud services',
  'ui — changes the interface: themes, widgets, panels',
  'workflow — orchestrates multi-step processes: pipelines, schedulers',
  'integration — bridges a specific third-party product (Slack, GitHub, Notion, and the like)',
  'other — none of the above fits',
  'Disambiguation: provider is a generic capability; integration is a named product.',
  'Genuinely unsure means other.',
  'Input: a JSON array of { name, description, keywords }.',
  'Output: ONLY a JSON array [{"name":"...","category":"..."}], names echoed verbatim, nothing else.',
].join('\n')

const USER_TEMPLATE = (items: ClassifyItem[]): string =>
  JSON.stringify(items.map(i => ({ name: i.name, description: i.description, keywords: i.keywords })))

Then implement `classifyPackages` concretely:

```ts
interface Options {
  baseUrl: string
  model: string
  apiKey: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export async function classifyPackages(items: ClassifyItem[], options: Options): Promise<ClassifyBatchResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? defaultSleep
  const classified = new Map<string, Category>()
  const discarded: ClassifyBatchResult['discarded'] = []
  const batches: ClassifyItem[][] = []
  for (let i = 0; i < items.length; i += CLASSIFY_BATCH_SIZE) batches.push(items.slice(i, i + CLASSIFY_BATCH_SIZE))

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY)
    await Promise.all(slice.map(async batch => {
      const expected = new Set(batch.map(b => b.name))
      let response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          temperature: 0,
          max_tokens: 4096,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: USER_TEMPLATE(batch) }],
        }),
      })
      for (let attempt = 0; (response.status === 429 || response.status >= 500) && attempt < RETRY_LIMIT - 1; attempt += 1) {
        const retryAfter = Number(response.headers.get('retry-after'))
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS)
          : Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS)
        await sleep(delay)
        response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: options.model,
            temperature: 0,
            max_tokens: 4096,
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: USER_TEMPLATE(batch) }],
          }),
        })
      }
      if (!response.ok) {
        for (const b of batch) discarded.push({ name: b.name, reason: `gateway ${response.status}` })
        return
      }
      let text = ''
      try {
        const body = await response.json() as { choices?: { message?: { content?: unknown } }[] }
        text = typeof body.choices?.[0]?.message?.content === 'string' ? body.choices[0].message.content : ''
      } catch {
        text = ''
      }
      const adopted = parseClassificationResponse(text, expected)
      for (const b of batch) {
        const category = adopted.get(b.name)
        if (category !== undefined) classified.set(b.name, category)
        else discarded.push({ name: b.name, reason: 'unparseable batch' })
      }
    }))
  }
  return { classified, discarded }
}
```

The duplicate fetch call inside the retry loop is deliberate (the response variable is rebound). If lint flags the repeated body literal, hoist it into a local `const body = () => JSON.stringify({...})` — behavior identical.

- [ ] **Step 4: run tests, verify they pass**

Run: `pnpm vitest run registry/scripts/tests/llm-client.test.ts`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add registry/scripts/src/llm-client.ts registry/scripts/tests/llm-client.test.ts
git commit -m "feat(registry): OpenAI-compatible LLM client with batched classification"
```

---

### Task 6: pure category-row merge and serialization

**Files:**
- Create: `registry/scripts/src/categories.ts`
- Test: `registry/scripts/tests/categories.test.ts`

**Interfaces:**
- Consumes: `Category` (Task 1).
- Produces:

```ts
export function mergeCategoryRows(
  existing: ReadonlyMap<string, Category>,
  fresh: ReadonlyMap<string, Category>,
  liveNames: ReadonlySet<string>,
): Map<string, Category>
export function serializeCategoryRows(rows: ReadonlyMap<string, Category>): string
```

`mergeCategoryRows` = existing ∪ fresh, minus any name not in `liveNames` (the pruned set), sorted by name. `serializeCategoryRows` = the `categories.yml` text, rows sorted, `\n` after the last row, with the standing file header comment.

- [ ] **Step 1: write the failing tests**

Create `registry/scripts/tests/categories.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mergeCategoryRows, serializeCategoryRows } from '../src/categories.ts'

describe('mergeCategoryRows', () => {
  it('keeps existing rows, adds fresh ones, and prunes dead names', () => {
    const merged = mergeCategoryRows(
      new Map([['dsh-old', 'tool'], ['dsh-gone', 'ui']]),
      new Map([['dsh-new', 'provider']]),
      new Set(['dsh-old', 'dsh-new']),
    )
    expect(merged.get('dsh-old')).toBe('tool')
    expect(merged.get('dsh-new')).toBe('provider')
    expect(merged.has('dsh-gone')).toBe(false)
  })

  it('sorts rows by name', () => {
    const merged = mergeCategoryRows(
      new Map([['dsh-zebra', 'ui']]),
      new Map([['dsh-alpha', 'tool']]),
      new Set(['dsh-zebra', 'dsh-alpha']),
    )
    expect([...merged.keys()]).toEqual(['dsh-alpha', 'dsh-zebra'])
  })
})

describe('serializeCategoryRows', () => {
  it('writes sorted rows with the standing header', () => {
    const text = serializeCategoryRows(new Map([['dsh-beta', 'ui'], ['dsh-alpha', 'tool']]))
    expect(text).toBe(
      '# LLM-assigned categories for derived listings (design 2026-08-26-llm-categorization-design.md).\n'
      + '# A declared `dsh.catalog.category` always wins; a name absent from this file is simply\n'
      + '# "not yet classified" and is retried on the next build.\n'
      + '- name: dsh-alpha\n'
      + '  category: tool\n'
      + '- name: dsh-beta\n'
      + '  category: ui\n',
    )
  })
})
```

- [ ] **Step 2: run tests, verify they fail**

Run: `pnpm vitest run registry/scripts/tests/categories.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: implement**

Create `registry/scripts/src/categories.ts`:

```ts
import type { Category } from './types.ts'

/**
 * The category file's standing header. The file is regenerated on every
 * classify run, so the header lives in exactly one place.
 */
const HEADER = [
  '# LLM-assigned categories for derived listings (design 2026-08-26-llm-categorization-design.md).',
  '# A declared `dsh.catalog.category` always wins; a name absent from this file is simply',
  '# "not yet classified" and is retried on the next build.',
].join('\n')

/**
 * Merge the committed rows with a fresh classification pass, pruning rows
 * whose name no longer lives in the catalog, sorted by name. Pure: the
 * classifier's only write policy, fully fixture-driven (spec §2).
 */
export function mergeCategoryRows(
  existing: ReadonlyMap<string, Category>,
  fresh: ReadonlyMap<string, Category>,
  liveNames: ReadonlySet<string>,
): Map<string, Category> {
  const merged = new Map<string, Category>(existing)
  for (const [name, category] of fresh) merged.set(name, category)
  for (const name of merged.keys()) if (!liveNames.has(name)) merged.delete(name)
  return new Map([...merged].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
}

/** Serialize rows to the file text: header, sorted rows, trailing newline. */
export function serializeCategoryRows(rows: ReadonlyMap<string, Category>): string {
  const lines = [HEADER, ...[...rows].map(([name, category]) => `- name: ${name}\n  category: ${category}`)]
  return `${lines.join('\n')}\n`
}
```

- [ ] **Step 4: run tests, verify they pass**

Run: `pnpm vitest run registry/scripts/tests/categories.test.ts`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add registry/scripts/src/categories.ts registry/scripts/tests/categories.test.ts
git commit -m "feat(registry): pure merge and serialization for categories.yml"
```

---

### Task 7: the classify entry point

**Files:**
- Modify: `registry/scripts/src/npm-client.ts` (export a shared harvest helper)
- Modify: `registry/scripts/src/build.ts` (use the shared helper — behavior identical)
- Create: `registry/scripts/src/classify.ts`
- Test: none new (the entry is a thin shell over Task 1–6 modules; verification below)

**Interfaces:**
- Consumes: `searchByKeyword`, `fetchCandidate` (npm-client), `loadRegistryConfig` + `parseRegistryConfig` (Task 1), `gate` (Task 2), `classifyPackages` (Task 5), `mergeCategoryRows`/`serializeCategoryRows` (Task 6).
- Produces: on success writes `registry/categories.yml` (sorted, pruned), `dist/harvest.json` (`{ candidates, rejections }`), `dist/classification-report.md`; exits 0 even when the LLM is skipped or fully fails; exits 1 on harvest or config failure.

- [ ] **Step 1: extract the shared harvest helper**

In `registry/scripts/src/npm-client.ts`, add (reusing its existing `CONCURRENCY`-style imports — the module already imports `Candidate`, `Rejection` from types):

```ts
export const HARVEST_CONCURRENCY = 8

/**
 * Fetch every name into a candidate, turning un-fetchable names into
 * `fetch-failed` rejections rather than dropping them (build.ts rationale).
 */
export async function fetchCandidates(
  names: string[],
  fetchImpl: typeof fetch = fetch,
  token: string | undefined = undefined,
): Promise<{ candidates: Candidate[]; rejections: Rejection[] }> {
  const candidates: Candidate[] = []
  const rejections: Rejection[] = []
  for (let i = 0; i < names.length; i += HARVEST_CONCURRENCY) {
    const batch = names.slice(i, i + HARVEST_CONCURRENCY)
    const results = await Promise.all(batch.map(async name => ({ name, result: await fetchCandidate(name, fetchImpl, undefined, token) })))
    for (const { name, result } of results) {
      if (result.ok) candidates.push(result.candidate)
      else rejections.push({ name, code: 'fetch-failed', detail: result.detail })
    }
  }
  return { candidates, rejections }
}
```

In `registry/scripts/src/build.ts`, delete the local `fetchAll` (and its `CONCURRENCY` const) and replace the call:

```ts
import { fetchCandidates, searchByKeyword } from './npm-client.ts'
// ...
const { candidates, rejections } = await fetchCandidates(names, fetch, npmToken)
```

Run `pnpm test` — everything must stay green (pure refactor).

- [ ] **Step 2: create classify.ts**

Create `registry/scripts/src/classify.ts`:

```ts
/**
 * Classification entry point: the daily step that keeps categories.yml
 * current (spec 2026-08-26-llm-categorization-design.md §4).
 *
 * One run: harvest the ecosystem once, classify every gate-accepted derived
 * listing without a row, write the merged/pruned/sorted categories.yml, and
 * drop the harvest at dist/harvest.json so `build.ts --harvest-from` reuses
 * it without a second pass over npm.
 *
 * The LLM is advisory: no key, a down gateway, or garbage output never fails
 * this step — the affected entries stay unclassified and the next build
 * retries them (D4). A harvest or registry-file failure IS fatal: those are
 * the same loud failures the build would have raised.
 * @module classify
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeCategoryRows, serializeCategoryRows } from './categories.ts'
import { gate } from './gate.ts'
import { loadRegistryConfig } from './config.ts'
import { classifyPackages, type ClassifyItem } from './llm-client.ts'
import { fetchCandidates, searchByKeyword } from './npm-client.ts'

const REGISTRY_DIR = 'registry'
const OUT_DIR = 'dist/v1'

const baseUrl = process.env.LLM_BASE_URL ?? 'http://8.141.31.123:3000/v1'
const model = process.env.LLM_MODEL ?? 'deepseek-v4-flash'
const apiKey = process.env.LLM_API_KEY ?? ''
const npmToken = process.env.NPM_TOKEN

const config = loadRegistryConfig(REGISTRY_DIR)
const names = await searchByKeyword(fetch, undefined, npmToken)
process.stderr.write(`classify: harvested ${names.length} candidate(s)\n`)
const { candidates, rejections } = await fetchCandidates(names, fetch, npmToken)

// pending = derived listings the gate accepts, minus what the file already has
const pending: ClassifyItem[] = []
const liveNames = new Set<string>()
for (const candidate of candidates) {
  const result = gate(candidate, config)
  if (!result.ok) continue
  liveNames.add(candidate.name)
  if (result.accepted.metadata !== 'derived') continue
  if (config.categories.has(candidate.name)) continue
  pending.push({ name: candidate.name, description: candidate.description, keywords: candidate.keywords })
}
process.stderr.write(`classify: ${pending.length} pending name(s)\n`)

let discarded: { name: string; reason: string }[] = []
let fresh = new Map<string, string>()
if (apiKey === '') {
  discarded = pending.map(p => ({ name: p.name, reason: 'no LLM_API_KEY (skipped)' }))
} else {
  const result = await classifyPackages(pending, { baseUrl, model, apiKey })
  fresh = result.classified
  discarded = result.discarded
}

**Existing rows need no second read:** `loadRegistryConfig` already parsed the committed file through the same schema, so `config.categories` IS the existing map — and a malformed committed file has already thrown. The tail of the script is:

```ts
const merged = mergeCategoryRows(config.categories, fresh, liveNames)
mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(join(REGISTRY_DIR), { recursive: true })
writeFileSync(join(REGISTRY_DIR, 'categories.yml'), serializeCategoryRows(merged))
writeFileSync(join(OUT_DIR, 'harvest.json'), `${JSON.stringify({ candidates, rejections })}\n`)
const sortedDiscards = [...discarded].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
const reportLines = [
  '# Classification report',
  '',
  `Classified: ${merged.size}`,
  `Discarded: ${sortedDiscards.length}`,
  '',
  '| Package | Reason |',
  '|---|---|',
  ...sortedDiscards.map(d => `| ${d.name} | ${d.reason.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ')} |`),
]
writeFileSync(join(OUT_DIR, 'classification-report.md'), `${reportLines.join('\n')}\n`)
process.stderr.write(`classify: ${merged.size} rows, ${sortedDiscards.length} discarded\n`)
```

Drop the `existingText`/`parseRegistryConfig` re-read entirely — the committed file is already in `config.categories` via `loadRegistryConfig`. Remove the unused `readFileSync`/`parseRegistryConfig` imports accordingly (final imports: `mkdirSync, writeFileSync` from fs; `join`; `mergeCategoryRows, serializeCategoryRows`; `gate`; `loadRegistryConfig`; `classifyPackages` + `ClassifyItem`; `fetchCandidates, searchByKeyword`).

- [ ] **Step 3: verify — dry run without a key**

Run: `node --experimental-strip-types registry/scripts/src/classify.ts`
Expected: harvests (~1390 npm requests, several minutes), then exits 0 with `no LLM_API_KEY (skipped)` discards for the pending names, writes `dist/harvest.json`, `dist/classification-report.md`, and a `registry/categories.yml` that is EMPTY of rows (nothing classified, nothing to merge) — check `git status` shows `registry/categories.yml` as untracked-but-empty-of-rows (header only).

- [ ] **Step 4: verify — live classification smoke**

Run: `env LLM_API_KEY=<the key from the spec> LLM_BASE_URL=http://8.141.31.123:3000/v1 node --experimental-strip-types registry/scripts/src/classify.ts`
Expected: pending names classified; `registry/categories.yml` gains rows sorted by name; `dist/classification-report.md` reports few or zero discards. This is also the BACKFILL run.

- [ ] **Step 5: commit**

```bash
git add registry/scripts/src/classify.ts registry/scripts/src/npm-client.ts registry/scripts/src/build.ts
git commit -m "feat(registry): classification entry point that owns categories.yml"
```

---

### Task 8: reuse the harvest in the build, and wire the workflow

**Files:**
- Modify: `registry/scripts/src/build.ts` (add `--harvest-from`)
- Modify: `.github/workflows/daily.yml` (classify step, categories commit, build arg, second artifact)
- Test: none new — verification below.

**Interfaces:**
- Consumes: `dist/harvest.json` shape from Task 7: `{ candidates: Candidate[]; rejections: Rejection[] }`.
- Produces: `build.ts` accepts `--harvest-from <path>`; the workflow runs classify → commit categories.yml → build with the reused harvest → existing snapshot commit.

- [ ] **Step 1: add the flag to build.ts**

At the top of `registry/scripts/src/build.ts`, after the imports:

```ts
// `classify.ts` writes the harvest it already paid for; the workflow passes it
// here so the daily run does not fetch the ecosystem twice.
const harvestFromIndex = process.argv.indexOf('--harvest-from')
const harvestFrom = harvestFromIndex === -1 ? undefined : process.argv[harvestFromIndex + 1]
```

Replace the harvest section:

```ts
const config = loadRegistryConfig(REGISTRY_DIR)
const names = await searchByKeyword(fetch, undefined, npmToken)
process.stderr.write(`harvested ${names.length} candidate(s)\n`)

const { candidates, rejections } = await fetchAll(names)
```

with:

```ts
const config = loadRegistryConfig(REGISTRY_DIR)
let candidates: Candidate[]
let rejections: Rejection[]
if (harvestFrom === undefined) {
  const names = await searchByKeyword(fetch, undefined, npmToken)
  process.stderr.write(`harvested ${names.length} candidate(s)\n`)
  const harvested = await fetchCandidates(names, fetch, npmToken)
  candidates = harvested.candidates
  rejections = harvested.rejections
} else {
  const parsed = JSON.parse(readFileSync(harvestFrom, 'utf8')) as { candidates?: unknown; rejections?: unknown }
  if (!Array.isArray(parsed.candidates) || !Array.isArray(parsed.rejections)) {
    throw new Error(`--harvest-from ${harvestFrom}: expected { candidates, rejections } arrays`)
  }
  candidates = parsed.candidates as Candidate[]
  rejections = parsed.rejections as Rejection[]
  process.stderr.write(`reusing harvest: ${candidates.length} candidate(s)\n`)
}
```

Update imports: add `readFileSync` to the `node:fs` import, add `Candidate`, `Rejection` to the type import, drop the local `fetchAll`/`CONCURRENCY` if Task 7 left them (Task 7 already deleted them).

- [ ] **Step 2: wire daily.yml**

In `.github/workflows/daily.yml`, the `build` job's `env:` gains:

```yaml
      # LLM classifier (categories.yml). The key is a secret; an empty value
      # (fork PRs) skips classification — the classify step is designed for it.
      LLM_BASE_URL: http://8.141.31.123:3000/v1
      LLM_MODEL: deepseek-v4-flash
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
```

Between the `typecheck` and `build:catalog` steps, insert:

```yaml
      - name: Classify new listings
        run: node --experimental-strip-types registry/scripts/src/classify.ts
      - name: Commit the category list
        if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
        run: |
          git config user.name 'dsh-plugin-shop bot'
          git config user.email 'bot@users.noreply.github.com'
          git add registry/categories.yml
          git diff --cached --quiet && exit 0
          git commit -m "chore(registry): llm category update"
          git push
```

and change the build step to:

```yaml
      - run: pnpm build:catalog -- --harvest-from dist/v1/harvest.json
```

and the report upload to carry both reports:

```yaml
      - name: Upload build report
        uses: actions/upload-artifact@v4
        with:
          name: catalog-report
          path: |
            dist/v1/report.md
            dist/v1/classification-report.md
```

- [ ] **Step 3: verify locally, end to end, LLM-less**

Run: `node --experimental-strip-types registry/scripts/src/classify.ts && pnpm build:catalog -- --harvest-from dist/v1/harvest.json`
Expected: classify exits 0 (no key → skipped); the build reuses the harvest (log line `reusing harvest: N candidate(s)`) and writes the same four artifacts; `git status` shows only `registry/categories.yml` as untracked. Then `pnpm test` and `pnpm typecheck` stay green.

- [ ] **Step 4: verify in CI**

Commit this task (Step 5), push — `daily.yml` matches the new `paths` filter (it is IN the filter), so the workflow runs: expect the classify step to succeed with the real secret, a `chore(registry): llm category update` bot commit, and a green catalog job. This run is also the real backfill: after it, `registry/categories.yml` carries ~1900 rows.

- [ ] **Step 5: commit**

```bash
git add registry/scripts/src/build.ts .github/workflows/daily.yml
git commit -m "feat(ci): classify before build, reuse the harvest, publish the categories"
```

---

### Task 9: amend the spec, CLAUDE.md, and author docs in the same change

**Files:**
- Modify: `docs/design/2026-08-18-dsh-plugin-shop-design.md` (§6.2, §7.1)
- Modify: `CLAUDE.md` (network-module rule, invariants)
- Modify: `docs/schema.md`, `docs/schema.zh.md`
- Modify: `docs/superpowers/specs/2026-08-26-llm-categorization-design.md` (two wording alignments from implementation: category fill happens in `gate.ts`, not `emit.ts`; the classification report is its own `classification-report.md` artifact)

- [ ] **Step 1: edit the design spec**

In `docs/design/2026-08-18-dsh-plugin-shop-design.md`:

- §6.2: add one sentence after the derived-listing description: "A derived listing may carry an LLM-assigned `catalog.category` sourced from `registry/categories.yml`; the assignment is advisory and never gates a listing."
- §7.1: add a step to the pipeline list: "classify — derived listings without a declared category and without a row in `categories.yml` are classified in batches by the LLM gateway (`classify.ts`, shell); failures leave the entry as `other` and are retried next build."

- [ ] **Step 2: amend CLAUDE.md**

- In the "One architectural rule" section, change "Impure: `npm-client.ts` (the only module that reaches the network)" to "Impure: `npm-client.ts` and `llm-client.ts` (the only modules that reach the network)".
- Under "Invariants worth breaking a build over", add: "**LLM output is advisory.** The classifier may change a category, never gate a listing, never remove an entry, and never block a publish. A failed classification leaves the entry unclassified and is retried on the next build; `categories.yml` is a build input like `verified.yml`."

- [ ] **Step 3: amend the author-facing docs**

In `docs/schema.md` and `docs/schema.zh.md`, in the `dsh.catalog` section, add one sentence each (English doc in English, Chinese doc in Chinese — the zh file states the same fact in its own register):

EN: "If you do not declare `category`, the shop may assign one by automated review; declare it to stay in control."
ZH: "如果你不声明 `category`，商店可能通过自动评审为你分配一个分类；想自己掌控就声明它。"

- [ ] **Step 4: align the categorization spec with implementation**

In `docs/superpowers/specs/2026-08-26-llm-categorization-design.md` §4, change "Emit fills `catalog.category`" to "`gate.ts` fills `catalog.category` for derived entries with a row (the derived section is built there)"; in §5, change "recorded in the build report" to "recorded in the classification report (`dist/v1/classification-report.md`, uploaded as an artifact alongside the build report)".

- [ ] **Step 5: run the suites and commit**

Run: `pnpm test && pnpm typecheck`
Expected: all green (docs-only change; the run confirms nothing drifted).

```bash
git add docs/design/2026-08-18-dsh-plugin-shop-design.md CLAUDE.md docs/schema.md docs/schema.zh.md docs/superpowers/specs/2026-08-26-llm-categorization-design.md
git commit -m "docs: spec, CLAUDE.md, and author docs for LLM-assigned categories"
```

---

## Preconditions only a human can provide

1. **`LLM_API_KEY` repository secret** on https://github.com/LivXue/dsh-plugin-shop/settings/secrets/actions (the key from the spec). Without it, classification silently skips — the pipeline works, the categories stay empty.
2. **Runner reachability**: the gateway `http://8.141.31.123:3000` must be reachable from GitHub's runners (no IP allowlist). If it is not, the classify step runs locally instead: `LLM_API_KEY=... node --experimental-strip-types registry/scripts/src/classify.ts` then commit the file by hand.

## After the implementation

- Merge to main, then run the workflow once via `workflow_dispatch` — that run IS the backfill (D2). The categories commit lands before the catalog commit; the next shop UI load shows the six-color distribution.
- Publish a release only when the author confirms (standing rule).
