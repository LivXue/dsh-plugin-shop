# GitHub Star Counts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each plugin's GitHub star count on its card and sort the shelf by stars, most-starred first.

**Architecture:** Stars are daily-changing live data, so they never enter `plugins.json` — the build fetches them via batched GitHub GraphQL into a separate content-addressed `stars.<sha>.json`, referenced by an optional pointer in `index.json` (`schemaVersion` stays 2). The host fetches/verifies/caches the sidecar and degrades to an empty map on any failure; the client sorts with pure functions and renders a `★` badge.

**Tech Stack:** Node 24+ `--experimental-strip-types`, TypeScript ESM `.ts` imports, vitest, zod, GitHub GraphQL over `fetch`, the existing host/client package split.

**Spec:** `docs/superpowers/specs/2026-08-26-github-stars-design.md` — the plan argues from the spec; read both.

## Global Constraints

- Stars NEVER enter `plugins.json`, `manifest.lock`, or any plugin entry (spec D3). The sidecar's daily hash churn is quarantined there.
- `schemaVersion` stays 2; the `stars` index key is optional and additive. The host's zod pointer schema is non-strict by default (unknown keys are stripped), which is what keeps old installed shops working — pin that tolerance with a test, do not make the schema strict.
- Stars fetching is advisory: any failure publishes the catalog without stars and retries next build (spec D4). Never a throw out of the stars step in `build.ts`, never a stale/error panel in the host.
- Fixed sort: stars desc → un-starred last → name asc case-insensitive (spec D1). Sorting happens at DISPLAY time in the client; the catalog's emit-time name sort is untouched.
- `GITHUB_TOKEN` comes from the Actions env (`secrets.GITHUB_TOKEN`), empty locally/on forks → the stars step skips entirely. No new secrets, no new dependencies.
- Batching: 50 repositories per GraphQL request via aliases `a0..a49`, sequential requests, bounded retry (4 attempts, honor `Retry-After`, 1/2/4/8s cap — same discipline as `npm-client.ts`/`llm-client.ts`).
- Locale: zh is the key source of truth (`{count} 星`), en is checked by `satisfies` (`{count} stars`).
- The pure core (`gate/tier/emit/pipeline/schema/types`) gains no network surface; `stars` reaches `emit` only as a computed input.

---

### Task 1: pure GitHub repository extraction

**Files:**
- Create: `registry/scripts/src/github-repo.ts`
- Test: `registry/scripts/tests/github-repo.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export function githubOwnerName(repository: string | null): { owner: string; name: string } | null
```

Only `https://github.com/<owner>/<name>` parses; trailing `.git` and `/` stripped; everything else → `null` (spec §2.1). Task 2 and Task 4 consume it.

- [ ] **Step 1: write the failing tests**

Create `registry/scripts/tests/github-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { githubOwnerName } from '../src/github-repo.ts'

describe('githubOwnerName', () => {
  it('parses a plain https github url', () => {
    expect(githubOwnerName('https://github.com/octocat/hello-world')).toEqual({ owner: 'octocat', name: 'hello-world' })
  })

  it('strips a trailing .git and trailing slashes', () => {
    expect(githubOwnerName('https://github.com/octocat/hello-world.git')).toEqual({ owner: 'octocat', name: 'hello-world' })
    expect(githubOwnerName('https://github.com/octocat/hello-world/')).toEqual({ owner: 'octocat', name: 'hello-world' })
  })

  it('parses scoped-style repo names with dots and hyphens', () => {
    expect(githubOwnerName('https://github.com/octo-cat/hello.world')).toEqual({ owner: 'octo-cat', name: 'hello.world' })
  })

  it('rejects non-github hosts and protocols', () => {
    expect(githubOwnerName('https://gitlab.com/user/repo')).toBeNull()
    expect(githubOwnerName('https://www.npmjs.com/package/dsh-x')).toBeNull()
    expect(githubOwnerName('git+ssh://git@github.com:user/repo.git')).toBeNull()
    expect(githubOwnerName('http://github.com/user/repo')).toBeNull()
  })

  it('rejects malformed paths and extra segments', () => {
    expect(githubOwnerName('https://github.com/octocat')).toBeNull()
    expect(githubOwnerName('https://github.com/octocat/hello-world/tree/main')).toBeNull()
    expect(githubOwnerName('https://github.com/octocat/hello-world/issues')).toBeNull()
    expect(githubOwnerName('not a url')).toBeNull()
    expect(githubOwnerName('github.com/octocat/hello-world')).toBeNull()
    expect(githubOwnerName(null)).toBeNull()
  })
})
```

- [ ] **Step 2: run tests, verify they fail**

Run: `pnpm vitest run registry/scripts/tests/github-repo.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: implement**

Create `registry/scripts/src/github-repo.ts`:

```ts
/**
 * Extract `{ owner, name }` from a normalized npm `repository` value, or null
 * when it is not a plain `https://github.com/<owner>/<name>` URL. Pure — the
 * only policy here is "no guesses": a value that merely LOOKS like a repo
 * path (extra segments, ssh spellings, other hosts) yields no stars rather
 * than a wrong repository (spec 2026-08-26-github-stars-design.md §2.1).
 */
export function githubOwnerName(repository: string | null): { owner: string; name: string } | null {
  if (repository === null) return null
  let url: URL
  try {
    url = new URL(repository)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
  const parts = url.pathname.split('/').filter(part => part !== '')
  if (parts.length !== 2) return null
  const owner = parts[0]
  let name = parts[1]
  if (owner === undefined || name === undefined || owner === '' || name === '') return null
  if (name.endsWith('.git')) name = name.slice(0, -4)
  if (name === '') return null
  return { owner, name }
}
```

- [ ] **Step 4: run tests, verify they pass**

Run: `pnpm vitest run registry/scripts/tests/github-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add registry/scripts/src/github-repo.ts registry/scripts/tests/github-repo.test.ts
git commit -m "feat(registry): pure github repository extraction for stars"
```

---

### Task 2: the GitHub GraphQL shell client

**Files:**
- Create: `registry/scripts/src/github-stars.ts`
- Test: `registry/scripts/tests/github-stars.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (it receives `{ owner, name }` values; Task 4 passes Task 1's output in).
- Produces:

```ts
export const STAR_BATCH_SIZE = 50
export function fetchStarCounts(
  repos: { owner: string; name: string }[],
  options: { token: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> },
): Promise<{ stars: Map<string, number>; skipped: string[] }>
```

`stars` keys are `owner/name`. An empty token or empty repo list returns immediately (spec §2.2). Task 4 consumes it.

- [ ] **Step 1: write the failing tests**

Create `registry/scripts/tests/github-stars.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { fetchStarCounts, STAR_BATCH_SIZE } from '../src/github-stars.ts'

const options = { token: 'gh-token' }
const repo = (i: number) => ({ owner: `owner${i}`, name: `repo${i}` })

const okResponse = (counts: Record<string, number | null>): Response => {
  const data = Object.fromEntries(Object.entries(counts).map(([k, n], i) => [`a${i}`, { stargazerCount: n }]))
  return new Response(JSON.stringify({ data }), { status: 200 })
}

describe('fetchStarCounts', () => {
  it('returns immediately for an empty token', async () => {
    const fetchImpl = (async () => { throw new Error('must not be called') }) as unknown as typeof fetch
    const result = await fetchStarCounts([{ owner: 'a', name: 'b' }], { token: '', fetchImpl })
    expect(result.stars.size).toBe(0)
    expect(result.skipped).toEqual([])
  })

  it('returns immediately for an empty repo list', async () => {
    const fetchImpl = (async () => { throw new Error('must not be called') }) as unknown as typeof fetch
    const result = await fetchStarCounts([], { ...options, fetchImpl })
    expect(result.stars.size).toBe(0)
  })

  it('batches 120 repos into 50/50/20 queries with aliases and a bearer header', async () => {
    const bodies: { aliases: number; auth: string }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables?: unknown }
      bodies.push({
        aliases: (body.query.match(/a\d+:/g) ?? []).length,
        auth: String((init?.headers as Record<string, string>).Authorization),
      })
      return new Response(JSON.stringify({ data: {} }), { status: 200 })
    }) as unknown as typeof fetch
    await fetchStarCounts(Array.from({ length: 120 }, (_, i) => repo(i)), { ...options, fetchImpl })
    expect(bodies.map(b => b.aliases)).toEqual([50, 50, 20])
    expect(bodies.every(b => b.auth === 'Bearer gh-token')).toBe(true)
  })

  it('records a null stargazerCount as skipped', async () => {
    const fetchImpl = (async () => okResponse({ 'owner0/repo0': null, 'owner1/repo1': 42 })) as unknown as typeof fetch
    const result = await fetchStarCounts([repo(0), repo(1)], { ...options, fetchImpl })
    expect(result.stars.get('owner1/repo1')).toBe(42)
    expect(result.stars.has('owner0/repo0')).toBe(false)
    expect(result.skipped).toContain('owner0/repo0')
  })

  it('discards a whole batch when the response carries an errors field', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ errors: [{ message: 'rate limit' }] }), { status: 200 })) as unknown as typeof fetch
    const result = await fetchStarCounts([repo(0), repo(1)], { ...options, fetchImpl })
    expect(result.stars.size).toBe(0)
    expect(result.skipped.length).toBe(2)
  })

  it('retries a 429 honoring Retry-After and succeeds', async () => {
    const delays: number[] = []
    const sleep = async (ms: number) => { delays.push(ms) }
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls === 1) return new Response('slow', { status: 429, headers: { 'Retry-After': '2' } })
      return okResponse({ 'owner0/repo0': 7 })
    }) as unknown as typeof fetch
    const result = await fetchStarCounts([repo(0)], { ...options, fetchImpl, sleep })
    expect(delays).toEqual([2000])
    expect(result.stars.get('owner0/repo0')).toBe(7)
  })

  it('gives up after bounded retries and skips the batch', async () => {
    const sleep = async (_ms: number) => {}
    let calls = 0
    const fetchImpl = (async () => { calls += 1; return new Response('nope', { status: 503 }) }) as unknown as typeof fetch
    const result = await fetchStarCounts([repo(0)], { ...options, fetchImpl, sleep })
    expect(calls).toBe(4)
    expect(result.stars.size).toBe(0)
    expect(result.skipped[0]).toContain('503')
  })
})
```

- [ ] **Step 2: run tests, verify they fail**

Run: `pnpm vitest run registry/scripts/tests/github-stars.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: implement**

Create `registry/scripts/src/github-stars.ts`:

```ts
/**
 * GitHub star fetching — the THIRD network module (npm-client, llm-client,
 * this). Batched GraphQL: 50 repositories per request via aliases, requests
 * run sequentially. Every failure mode ends in `skipped` entries, never a
 * throw — stars are advisory and a failed fetch publishes without them
 * (spec 2026-08-26-github-stars-design.md §2.2, D4).
 * @module github-stars
 */

export const STAR_BATCH_SIZE = 50

const RETRY_LIMIT = 4
const RETRY_BASE_DELAY_MS = 1000
const RETRY_MAX_DELAY_MS = 8000
const ENDPOINT = 'https://api.github.com/graphql'

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface StarFetchResult {
  /** Keyed `owner/name`. */
  stars: Map<string, number>
  /** `owner/name` entries that ended without a count, with a reason. */
  skipped: string[]
}

export async function fetchStarCounts(
  repos: { owner: string; name: string }[],
  options: { token: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> },
): Promise<StarFetchResult> {
  const { token, fetchImpl = fetch, sleep = defaultSleep } = options
  const stars = new Map<string, number>()
  const skipped: string[] = []
  if (token === '' || repos.length === 0) return { stars, skipped }

  const batches: { owner: string; name: string }[][] = []
  for (let i = 0; i < repos.length; i += STAR_BATCH_SIZE) batches.push(repos.slice(i, i + STAR_BATCH_SIZE))

  for (const batch of batches) {
    const aliases = batch.map((r, i) => `a${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.name)}) { stargazerCount }`).join('\n')
    const query = `query {\n${aliases}\n}`
    const request = (): Promise<Response> => fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    let response = await request()
    for (let attempt = 0; (response.status === 429 || response.status >= 500) && attempt < RETRY_LIMIT - 1; attempt += 1) {
      const retryAfter = Number(response.headers.get('retry-after'))
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS)
        : Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS)
      await sleep(delay)
      response = await request()
    }
    if (!response.ok) {
      for (const r of batch) skipped.push(`${r.owner}/${r.name}: gateway ${response.status}`)
      continue
    }
    let body: { data?: Record<string, { stargazerCount?: unknown }>; errors?: unknown[] }
    try {
      body = await response.json() as typeof body
    } catch {
      // A 200 whose body is not JSON: the batch has no readable counts.
      for (const r of batch) skipped.push(`${r.owner}/${r.name}: unreadable body`)
      continue
    }
    if (body.errors !== undefined) {
      for (const r of batch) skipped.push(`${r.owner}/${r.name}: graphql errors`)
      continue
    }
    for (let i = 0; i < batch.length; i++) {
      const r = batch[i]
      const count = body.data?.[`a${i}`]?.stargazerCount
      const key = `${r.owner}/${r.name}`
      if (typeof count === 'number') stars.set(key, count)
      else skipped.push(`${key}: no count`)
    }
  }
  return { stars, skipped }
}
```

- [ ] **Step 4: run tests, verify they pass**

Run: `pnpm vitest run registry/scripts/tests/github-stars.test.ts`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add registry/scripts/src/github-stars.ts registry/scripts/tests/github-stars.test.ts
git commit -m "feat(registry): batched GitHub GraphQL star client"
```

---

### Task 3: the optional stars pointer flows through emit and pipeline

**Files:**
- Modify: `registry/scripts/src/emit.ts` (`emit` signature + index construction)
- Modify: `registry/scripts/src/pipeline.ts` (`runPipeline` passthrough)
- Test: `registry/scripts/tests/emit.test.ts`, `registry/scripts/tests/pipeline.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:

```ts
export type StarsPointer = { url: string; sha256: string }
emit(entries: Entry[], rejections: Rejection[], builtAt: string, stars?: StarsPointer | null): Artifacts
runPipeline(candidates, config, builtAt, preexistingRejections = [], stars: StarsPointer | null = null): Artifacts
```

Task 4 passes `stars` in; the index gains a `stars` key only when non-null (spec §4.1).

- [ ] **Step 1: write the failing tests**

In `registry/scripts/tests/emit.test.ts`, add:

```ts
it('emits a stars pointer when one is supplied and omits it when null', () => {
  const entries: Entry[] = []
  const withStars = emit(entries, [], '2026-08-26T00:00:00.000Z', { url: 'stars.abc.json', sha256: 'abc' })
  const parsed = JSON.parse(withStars.indexJson) as { stars?: { url: string; sha256: string } }
  expect(parsed.stars).toEqual({ url: 'stars.abc.json', sha256: 'abc' })

  const without = emit(entries, [], '2026-08-26T00:00:00.000Z', null)
  expect('stars' in (JSON.parse(without.indexJson) as object)).toBe(false)

  const omitted = emit(entries, [], '2026-08-26T00:00:00.000Z')
  expect('stars' in (JSON.parse(omitted.indexJson) as object)).toBe(false)
})
```

(If the file's existing tests construct `Entry` arrays with fixtures, reuse them — the empty array works because `emit` sorts and serializes it.)

In `registry/scripts/tests/pipeline.test.ts`, add a determinism case:

```ts
it('produces byte-identical artifacts with a stars pointer across runs', () => {
  const stars = { url: 'stars.deadbeef.json', sha256: 'deadbeef' }
  const first = runPipeline(candidates, config, BUILT_AT, [], stars)
  const second = runPipeline(candidates, config, BUILT_AT, [], stars)
  expect(first.indexJson).toBe(second.indexJson)
  expect(first.pluginsJson).toBe(second.pluginsJson)
  expect(JSON.parse(first.indexJson).stars).toEqual(stars)
})
```

- [ ] **Step 2: run tests, verify they fail**

Run: `pnpm vitest run registry/scripts/tests/emit.test.ts registry/scripts/tests/pipeline.test.ts`
Expected: FAIL — extra arguments are type errors at compile, and `stars` is absent from the index.

- [ ] **Step 3: implement**

In `registry/scripts/src/emit.ts`:

```ts
/** The stars sidecar pointer the index may carry (spec 2026-08-26-github-stars-design.md §4.1). */
export interface StarsPointer { url: string; sha256: string }

export function emit(entries: Entry[], rejections: Rejection[], builtAt: string, stars?: StarsPointer | null): Artifacts {
  // ...existing body unchanged except the indexJson construction:
  const indexJson = `${JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    builtAt,
    count: sorted.length,
    plugins: { url: pluginsFileName, sha256 },
    ...(stars == null ? {} : { stars }),
  }, null, 2)}\n`
```

In `registry/scripts/src/pipeline.ts`, extend the signature and pass through:

```ts
import { emit, type Artifacts, type StarsPointer } from './emit.ts'

export function runPipeline(
  candidates: Candidate[],
  config: RegistryConfig,
  builtAt: string,
  preexistingRejections: Rejection[] = [],
  stars: StarsPointer | null = null,
): Artifacts {
  // ...loop unchanged...
  return emit(entries, rejections, builtAt, stars)
}
```

- [ ] **Step 4: run tests, verify they pass**

Run: `pnpm test`
Expected: PASS — including the two new cases; the determinism guarantee now covers the stars input.

- [ ] **Step 5: commit**

```bash
git add registry/scripts/src/emit.ts registry/scripts/src/pipeline.ts registry/scripts/tests/emit.test.ts registry/scripts/tests/pipeline.test.ts
git commit -m "feat(registry): optional stars pointer through emit and pipeline"
```

---

### Task 4: build.ts fetches stars and writes the sidecar

**Files:**
- Modify: `registry/scripts/src/build.ts` (stars step between harvest and pipeline)
- Modify: `.github/workflows/daily.yml` (env: `GITHUB_TOKEN`)

**Interfaces:**
- Consumes: `githubOwnerName` (Task 1), `fetchStarCounts` (Task 2), `runPipeline(..., stars)` (Task 3).
- Produces: `dist/v1/stars.<sha>.json` and the index's `stars` pointer; a `Stars:` report line on skip.

- [ ] **Step 1: implement the stars step**

In `registry/scripts/src/build.ts`, after the harvest branch resolves `candidates`/`rejections` and before `const artifacts = runPipeline(...)`, insert:

```ts
// Stars are daily-changing live data: they are quarantined in their own
// content-addressed sidecar so plugins.json keeps its cache-stable hash
// (spec 2026-08-26-github-stars-design.md D3). Advisory: any failure — no
// token, rate limit, down API — publishes without stars and retries next
// build. The step never throws.
const ghToken = process.env.GITHUB_TOKEN ?? ''
let starsInfo: { url: string; sha256: string } | null = null
let starsNote = ''
if (ghToken === '') {
  starsNote = 'no GITHUB_TOKEN'
} else {
  const repos = new Map<string, { owner: string; name: string }>()
  for (const candidate of candidates) {
    const parsed = githubOwnerName(candidate.repository)
    if (parsed !== null) repos.set(`${parsed.owner}/${parsed.name}`, parsed)
  }
  if (repos.size === 0) {
    starsNote = 'no github.com repositories in the catalog'
  } else {
    try {
      const { stars: repoStars, skipped } = await fetchStarCounts([...repos.values()], { token: ghToken })
      const starsByPackage: Record<string, number> = {}
      for (const candidate of candidates) {
        const parsed = githubOwnerName(candidate.repository)
        if (parsed === null) continue
        const count = repoStars.get(`${parsed.owner}/${parsed.name}`)
        if (count !== undefined) starsByPackage[candidate.name] = count
      }
      const starsJson = `${JSON.stringify({ stars: Object.fromEntries(Object.entries(starsByPackage).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }, null, 2)}\n`
      const starsSha = createHash('sha256').update(starsJson).digest('hex')
      writeFileSync(join(OUT_DIR, `stars.${starsSha}.json`), starsJson)
      starsInfo = { url: `stars.${starsSha}.json`, sha256: starsSha }
      starsNote = skipped.length === 0 ? `${Object.keys(starsByPackage).length} starred` : `${Object.keys(starsByPackage).length} starred, ${skipped.length} skipped`
      process.stderr.write(`stars: ${starsNote}\n`)
    } catch (error) {
      starsNote = `skipped: ${error instanceof Error ? error.message : String(error)}`
      process.stderr.write(`stars: ${starsNote}\n`)
    }
  }
}
```

Update the imports at the top: add `createHash` to the `node:crypto` import, `githubOwnerName` from `./github-repo.ts`, `fetchStarCounts` from `./github-stars.ts`, and `type StarsPointer` is not needed (the object literal type checks structurally).

Change the pipeline call and the report write:

```ts
const artifacts = runPipeline(candidates, config, new Date().toISOString(), rejections, starsInfo)
// ...
writeFileSync(join(OUT_DIR, 'report.md'), starsNote === '' ? artifacts.report : `${artifacts.report}\nStars: ${starsNote}\n`)
```

In `.github/workflows/daily.yml`, the `build` job's `env:` gains one line:

```yaml
      # GitHub star counts (public GraphQL). Empty on forks/local runs; the
      # stars step skips and the catalog publishes without them.
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: verify LLM-less end to end**

Run: `env -u LLM_API_KEY -u GITHUB_TOKEN node --experimental-strip-types registry/scripts/src/classify.ts && pnpm build:catalog -- --harvest-from dist/v1/harvest.json`
Expected: classify skips the LLM (no key); the build logs `stars: no GITHUB_TOKEN`, writes the four artifacts, and `dist/v1/report.md` ends with `Stars: no GITHUB_TOKEN`. `pnpm test` and `pnpm typecheck` stay green.

- [ ] **Step 3: verify with a token, live**

Run: `env GITHUB_TOKEN=$(gh auth token) node --experimental-strip-types registry/scripts/src/classify.ts && pnpm build:catalog -- --harvest-from dist/v1/harvest.json`
Expected: `stars: N starred, M skipped`; `dist/v1/stars.<sha>.json` exists and the fresh `dist/v1/index.json` carries the `stars` pointer with a matching sha256.

- [ ] **Step 4: commit**

```bash
git add registry/scripts/src/build.ts .github/workflows/daily.yml
git commit -m "feat(ci): fetch github stars into the sidecar before emit"
```

---

### Task 5: the host fetches, verifies, and degrades the stars sidecar

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/catalog.ts` (pointer schema, snapshot, loader)
- Modify: `packages/dsh-plugin-shop/src/host/index.ts` (`ShopCatalogResult` + `catalog()`)
- Test: `packages/dsh-plugin-shop/tests/host/catalog.test.ts`

**Interfaces:**
- Consumes: the published index shape from Task 3/4.
- Produces: `CatalogSnapshot.stars: Record<string, number>`; `ShopCatalogResult.stars: Record<string, number>`. Task 6 consumes the latter through the client's props.

- [ ] **Step 1: write the failing tests**

In `packages/dsh-plugin-shop/tests/host/catalog.test.ts` (read the file first — it drives `loadCatalog` against a fixture server or `fsImpl` mocks; mirror its existing helper style), add:

```ts
it('loads the stars sidecar when the pointer names one', async () => {
  // Serve an index whose pointer carries stars: { url, sha256 } naming a
  // stars file the server also serves with matching bytes.
  // Assert result.snapshot.stars equals the parsed map.
})

it('degrades to an empty stars map when the sidecar fetch fails', async () => {
  // Pointer names a stars file the server does NOT serve (404).
  // Assert result.snapshot.stars equals {} and stale is false (the catalog
  // itself is fine).
})

it('degrades to an empty stars map on a sha256 mismatch', async () => {
  // Server serves a stars file whose bytes do not match the pointer's sha.
  // Assert stars {} and the catalog snapshot is otherwise intact.
})

it('ignores unknown pointer keys so old hosts keep working', async () => {
  // Serve a pointer with an extra key (e.g. `"futureField": true`) and no
  // stars key. Assert the load succeeds — the zod schema must not be strict.
})
```

Implement them against the file's existing fixture infrastructure (the suite already serves pointer/data pairs with real sha256s; add a stars file the same way).

- [ ] **Step 2: run tests, verify they fail**

Run: `pnpm vitest run tests/host/catalog.test.ts`
Expected: FAIL — `stars` is absent from the snapshot and the pointer schema ignores the new key (the stars assertions fail; the unknown-key test passes already, pinning the non-strict default).

- [ ] **Step 3: implement**

In `packages/dsh-plugin-shop/src/host/catalog.ts`:

- pointer schema:

```ts
const pointerSchema = z.object({
  schemaVersion: z.number(),
  builtAt: z.string(),
  count: z.number(),
  plugins: z.object({ url: z.string(), sha256: z.string() }),
  stars: z.object({ url: z.string(), sha256: z.string() }).optional(),
})
```

- snapshot interface:

```ts
export interface CatalogSnapshot {
  schemaVersion: number
  builtAt: string
  entries: CatalogEntry[]
  denied: DeniedEntry[]
  /** GitHub star counts by package name; {} when the pointer names no
   * sidecar or the sidecar could not be fetched/verified (spec §5). */
  stars: Record<string, number>
}
```

- a shared reader used by both the cached and fresh paths:

```ts
/** Read and verify a cached/fetched stars sidecar; ANY irregularity degrades
 * to an empty map — stars are advisory (spec §5). */
function parseStarsText(text: string): Record<string, number> {
  try {
    const parsed = JSON.parse(text) as { stars?: unknown }
    if (typeof parsed.stars !== 'object' || parsed.stars === null) return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed.stars)) {
      if (typeof value === 'number') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}
```

- cached path: after the data hash check in `readCached`, when `pointer.stars` exists, read `join(cacheDir, basename(pointer.stars.url))`, verify its sha256 against `pointer.stars.sha256`, and on success include `stars: parseStarsText(text)`; on ANY failure use `stars: {}` (do not invalidate the catalog cache).

- fresh path: after the data fetch/hash/parse, when `pointer.stars` exists:

```ts
  let stars: Record<string, number> = {}
  if (pointer.stars !== undefined) {
    const starsUrl = resolveDataUrl(baseUrl, pointer.stars.url)
    try {
      const starsResponse = await fetchImpl(starsUrl)
      if (starsResponse.ok) {
        const starsText = await starsResponse.text()
        const starsActual = createHash('sha256').update(starsText).digest('hex')
        if (starsActual === pointer.stars.sha256) {
          stars = parseStarsText(starsText)
          fsImpl.write(join(cacheDir, basename(pointer.stars.url)), starsText)
        }
      }
    } catch {
      // Advisory: an unreachable sidecar means no stars this run (spec §5).
    }
  }
```

- both snapshot constructions gain `stars` (cached: the value read above; fresh: the local `stars`).

In `packages/dsh-plugin-shop/src/host/index.ts`:

- `ShopCatalogResult` gains `stars: Record<string, number>` (doc: the sidecar counts by package name, `{}` when unavailable).
- `catalog()` adds `stars: snapshot.stars` to the returned object.

- [ ] **Step 4: run tests, verify they pass**

Run: `pnpm vitest run tests/host/catalog.test.ts tests/host/index.test.ts` then `pnpm test`
Expected: PASS — including the four new cases. (Existing `index.test.ts` fixtures that build `ShopCatalogResult` will need `stars: {}` added — compile errors name them; fix mechanically.)

- [ ] **Step 5: commit**

```bash
git add packages/dsh-plugin-shop/src/host/catalog.ts packages/dsh-plugin-shop/src/host/index.ts packages/dsh-plugin-shop/tests/host/catalog.test.ts packages/dsh-plugin-shop/tests/host/index.test.ts
git commit -m "feat(host): fetch, verify, and degrade the stars sidecar"
```

---

### Task 6: pure sort and formatting on the client

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/present.ts`
- Test: `packages/dsh-plugin-shop/tests/client/present.test.ts`

**Interfaces:**
- Consumes: `CatalogEntry` type from `../host/index.ts` (already imported by present.ts).
- Produces:

```ts
export function sortByStars(entries: CatalogEntry[], stars: Record<string, number>): CatalogEntry[]
export function formatStars(n: number): string
```

Task 7 consumes both.

- [ ] **Step 1: write the failing tests**

In `packages/dsh-plugin-shop/tests/client/present.test.ts`, add:

```ts
describe('sortByStars', () => {
  const make = (name: string): CatalogEntry => ({ ...entry, name })

  it('sorts by stars descending, unstarred last, name asc on ties', () => {
    const entries = [make('dsh-alpha'), make('dsh-mid'), make('dsh-top'), make('dsh-nostar'), make('dsh-mid-tie')]
    const stars = { 'dsh-mid': 5, 'dsh-top': 100, 'dsh-mid-tie': 5 }
    expect(sortByStars(entries, stars).map(e => e.name)).toEqual([
      'dsh-top', 'dsh-mid', 'dsh-mid-tie', 'dsh-alpha', 'dsh-nostar',
    ])
  })

  it('is case-insensitive on the name tiebreak', () => {
    const a = make('dsh-Beta')
    const b = make('dsh-alpha')
    expect(sortByStars([a, b], {}).map(e => e.name)).toEqual(['dsh-alpha', 'dsh-Beta'])
  })

  it('keeps pure name order when stars is empty', () => {
    const entries = [make('dsh-zebra'), make('dsh-alpha')]
    expect(sortByStars(entries, {}).map(e => e.name)).toEqual(['dsh-alpha', 'dsh-zebra'])
  })
})

describe('formatStars', () => {
  it('formats the magnitude boundaries', () => {
    expect(formatStars(0)).toBe('0')
    expect(formatStars(999)).toBe('999')
    expect(formatStars(1000)).toBe('1k')
    expect(formatStars(1234)).toBe('1.2k')
    expect(formatStars(1500)).toBe('1.5k')
    expect(formatStars(99999)).toBe('100k')
  })
})
```

- [ ] **Step 2: run tests, verify they fail**

Run: `pnpm vitest run tests/client/present.test.ts`
Expected: FAIL — the functions do not exist.

- [ ] **Step 3: implement**

In `packages/dsh-plugin-shop/src/client/present.ts`:

```ts
/** Sort the shelf: stars descending, un-starred entries last, name ascending
 * (case-insensitive) on ties (spec 2026-08-26-github-stars-design.md D1).
 * Display-time only — the catalog's own name sort is untouched. */
export function sortByStars(entries: CatalogEntry[], stars: Record<string, number>): CatalogEntry[] {
  const count = (e: CatalogEntry): number => stars[e.name] ?? -1
  return [...entries].sort((a, b) => {
    const byStars = count(b) - count(a)
    if (byStars !== 0) return byStars
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/** 999 → "999"; 1000 → "1k"; 1234 → "1.2k"; 1500 → "1.5k"; 99999 → "100k". */
export function formatStars(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}
```

- [ ] **Step 4: run tests, verify they pass**

Run: `pnpm vitest run tests/client/present.test.ts`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add packages/dsh-plugin-shop/src/client/present.ts packages/dsh-plugin-shop/tests/client/present.test.ts
git commit -m "feat(client): pure star sort and formatting"
```

---

### Task 7: the shelf sorts by stars and cards show the badge

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.tsx` (sort in the memo chain, EntryCard prop, badge)
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.module.css` (`.starsBadge`)
- Modify: `packages/dsh-plugin-shop/src/client/locales.ts` (`stars` key)
- Test: `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`

**Interfaces:**
- Consumes: `sortByStars`/`formatStars` (Task 6), `ShopCatalogResult.stars` (Task 5).
- Produces: the visible UI order and the `★ <formatted>` badge with `aria-label` from `t('stars', { count })`.

- [ ] **Step 1: write the failing tests**

In `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`:

- the `snapshot()` helper's `ShopCatalogResult` gains `stars: {}` (compile fix — the type gained a required field in Task 5).
- new tests (the file already has the IntersectionObserver stub for windowing — these run under the same harness; keep fixtures small so everything renders):

```tsx
it('sorts the shelf by stars and renders the badge on starred entries', async () => {
  const result = snapshot()
  result.plugins = [
    { ...result.plugins[0]!, name: 'dsh-nostar' },
    { ...result.plugins[0]!, name: 'dsh-top' },
  ]
  result.stars = { 'dsh-top': 1234 }
  const { injected } = bench(result)
  renderTab(injected)
  await waitFor(() => expect(screen.getByText('dsh-top')).toBeTruthy())
  const names = [...document.querySelectorAll('[class*="_name"]')].map(el => el.textContent)
  expect(names).toEqual(['dsh-top', 'dsh-nostar'])
  expect(screen.getByLabelText('1.2k stars')).toBeTruthy()
  expect(screen.getByText('★ 1.2k')).toBeTruthy()
})

it('shows no badge for an unstarred entry', async () => {
  const result = snapshot()
  result.stars = {}
  const { injected } = bench(result)
  renderTab(injected)
  await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
  expect(screen.queryByLabelText(/stars/)).toBeNull()
})
```



- [ ] **Step 2: run tests, verify they fail**

Run: `pnpm vitest run tests/client/ShopTab.client.spec.tsx`
Expected: FAIL — no badge, name order is catalog order.

- [ ] **Step 3: implement**

In `packages/dsh-plugin-shop/src/client/ShopTab.tsx`:

- import `formatStars, sortByStars` from `./present.ts`.
- in the ready branch, after `filtered` and before `visible`, add:

```ts
  const stars = catalogState.kind === 'ready' ? catalogState.result.stars : {}
  const sorted = useMemo(() => sortByStars(filtered, stars), [filtered, stars])
```

- `const visible = incremental ? sorted.slice(0, visibleCount) : sorted`.
- `EntryCard` props gain `stars: number | undefined` — pass `stars={stars[entry.name]}` from the list map; memo props include it (memo compares shallowly; the number is primitive).
- in the badges row, before the chevron:

```tsx
          {stars !== undefined && (
            <span className={css.starsBadge} aria-label={t('stars', { count: formatStars(stars) })}>★ {formatStars(stars)}</span>
          )}
```

In `packages/dsh-plugin-shop/src/client/locales.ts`, zh gains:

```ts
  stars: '{count} 星',
```

en gains:

```ts
  stars: '{count} stars',
```

In `packages/dsh-plugin-shop/src/client/ShopTab.module.css`, add:

```css
.starsBadge {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
```

- [ ] **Step 4: run tests, verify they pass**

Run: `pnpm vitest run tests/client/ShopTab.client.spec.tsx` then `pnpm test` and `pnpm typecheck`
Expected: PASS — including the sort/badge cases; the existing 31 ShopTab tests stay green (their fixtures are unstarred).

- [ ] **Step 5: commit**

```bash
git add packages/dsh-plugin-shop/src/client/ShopTab.tsx packages/dsh-plugin-shop/src/client/ShopTab.module.css packages/dsh-plugin-shop/src/client/locales.ts packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx
git commit -m "feat(client): sort the shelf by stars and show the star badge"
```

---

### Task 8: web e2e exercises the starred fixture

**Files:**
- Modify: `packages/dsh-plugin-shop/tests/fixtures/catalog-server.ts`
- Modify: `packages/dsh-plugin-shop/tests/client/web-full-flow.e2e.ts`

- [ ] **Step 1: give the fixture a github repository and a stars sidecar**

In `packages/dsh-plugin-shop/tests/fixtures/catalog-server.ts`:

- change `FIXTURE_ENTRY.repository` from `null` to `'https://github.com/octocat/dsh-e2e-fixture'`.
- in `startCatalogServer`, build the sidecar next to the data file:

```ts
  const stars = JSON.stringify({ stars: { 'dsh-e2e-fixture-plugin': 4321 } })
  const starsSha = createHash('sha256').update(stars).digest('hex')
  const starsName = `stars.${starsSha}.json`
```

- add `stars: { url: starsName, sha256: starsSha }` to the pointer JSON and `[`/v1/${starsName}`, stars]` to the routes map.

- [ ] **Step 2: extend the e2e assertion**

In `packages/dsh-plugin-shop/tests/client/web-full-flow.e2e.ts`, after the existing browse assertions (find the step that asserts the entry card renders), add:

```ts
  // The starred fixture renders its badge through the real wire → host →
  // client path.
  await expect(dialog.getByText('★ 4.3k')).toBeVisible()
```

(`4321` formats as `4.3k`.)

- [ ] **Step 3: run the e2e**

Run: `pnpm vitest run tests/client/web-full-flow.e2e.ts`
Expected: PASS — the full stack now proves the sidecar wire shape end to end.

- [ ] **Step 4: commit**

```bash
git add packages/dsh-plugin-shop/tests/fixtures/catalog-server.ts packages/dsh-plugin-shop/tests/client/web-full-flow.e2e.ts
git commit -m "test(plugin): the web e2e exercises the starred wire shape"
```

---

### Task 9: amend the spec, CLAUDE.md, and author docs in the same change

**Files:**
- Modify: `docs/design/2026-08-18-dsh-plugin-shop-design.md` (§6.2, §7.1)
- Modify: `CLAUDE.md` (network-module list, new invariant)
- Modify: `docs/schema.md`, `docs/schema.zh.md`
- Modify: `README.md`, `README.zh.md`

- [ ] **Step 1: edit the design spec**

§6.2: after the pointer description, add: "The pointer may carry an optional `stars` object naming a content-addressed sidecar of GitHub star counts keyed by package name; stars are live daily data and are quarantined there so the plugin data hash stays cache-stable. `schemaVersion` remains 2."

§7.1: add to the pipeline list: "stars — GitHub GraphQL fetches star counts for github.com repositories into `dist/v1/stars.<sha>.json`; failures publish without stars and retry next build (`github-stars.ts`, shell)."

- [ ] **Step 2: amend CLAUDE.md**

- Network-module sentence: "Impure: `npm-client.ts`, `llm-client.ts`, and `github-stars.ts` (the only modules that reach the network)".
- Invariants, beside the `builtAt` rule: "**Live daily data stays in its own sidecar.** Star counts change every day; they live in a separate content-addressed `stars.<sha>.json` so the plugin data hash never churns daily. The same rule as `builtAt`, applied to data."

- [ ] **Step 3: amend the author-facing docs**

In `docs/schema.md` (English) and `docs/schema.zh.md` (Chinese, same fact in its own register): add one sentence to the catalog section —

EN: "If your repository is on GitHub, its star count is shown automatically — there is nothing to declare; repositories on other hosts show none."
ZH: "如果你的仓库在 GitHub 上，star 数会自动显示——无需任何声明；其他托管平台的仓库不显示。"

- [ ] **Step 4: amend the repository READMEs**

Both `README.md` and `README.zh.md`, in the catalog section listing the artifacts, add a row for the sidecar:

EN: "`/v1/stars.<sha256>.json` — GitHub star counts by package name, when the daily build could fetch them"
ZH: "`/v1/stars.<sha256>.json` —— 按包名的 GitHub star 数（每日构建成功获取时）"

- [ ] **Step 5: run the suites and commit**

Run: `pnpm test && pnpm typecheck`
Expected: all green (docs-only).

```bash
git add docs/design/2026-08-18-dsh-plugin-shop-design.md CLAUDE.md docs/schema.md docs/schema.zh.md README.md README.zh.md
git commit -m "docs: spec, CLAUDE.md, and author docs for github stars"
```

---

## Preconditions only a human can provide

1. **None new.** `GITHUB_TOKEN` is provided automatically by Actions; local runs use `gh auth token` or skip stars entirely. The workflow already has `contents: write`.

## After the implementation

- Merge to main; the next daily run publishes the first stars sidecar (local first run: `GITHUB_TOKEN=$(gh auth token) node --experimental-strip-types registry/scripts/src/build.ts` or the normal workflow run).
- Publish a release only when the author confirms (standing rule).
