# GitHub star counts on the shelf

Date: 2026-08-26
Status: design, pending implementation plan
Author: LivXue, Claude

Every catalog listing shows the GitHub star count of its repository, and the
shelf sorts by stars, most-starred first. Stars are live daily data; they
change every day even when no plugin changes. The determinism rules of this
repository therefore place them in their own content-addressed sidecar file,
so the plugin data file keeps its cache-stable hash.

## 1. Decisions a human made

| # | Decision |
|---|---|
| D1 | Fixed sort: stars descending, un-starred entries last, ties by name (ascending, case-insensitive). No sort toggle. |
| D2 | Data source: the GitHub GraphQL API, batched 50 repositories per request via aliases, using the workflow's existing `GITHUB_TOKEN`. No new secret. |
| D3 | Stars live in a sidecar file `stars.<sha256>.json`, referenced by an OPTIONAL `stars` pointer in `index.json`. `schemaVersion` stays 2: an optional additive key must not brick every installed shop with a loud version refusal. |
| D4 | Star fetching follows the advisory-source philosophy: any failure (rate limit, down API, bad token) publishes the catalog without stars and retries on the next build. Stars never block a publish. |

## 2. Data fetching

### 2.1 Repository extraction (pure)

`githubOwnerName(repository: string | null): { owner: string; name: string } | null`

- Only `https://github.com/<owner>/<name>` parses; a trailing `.git` or `/`
  is stripped.
- GitLab, npm pages, bare strings, extra path segments (`/tree/main`), and
  malformed values return `null` — no stars, never a guess.

### 2.2 The shell module (third network module)

`registry/scripts/src/github-stars.ts`:

```ts
fetchStarCounts(
  repos: { owner: string; name: string }[],
  options: { token: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> },
): Promise<{ stars: Map<string, number>; skipped: string[] }>
```

- **Batching**: GraphQL aliases `a0..a49: repository(owner: ..., name: ...) {
  stargazerCount }`, 50 per request, requests run sequentially (~40 requests
  for the catalog; no concurrency complexity needed).
- The map key is `owner/name`.
- `data.aN.stargazerCount === null` (renamed/deleted repo) → recorded in
  `skipped`, not an error.
- An `errors` field in the response discards the whole batch with its
  message recorded in `skipped`.
- HTTP 429/5xx: bounded retry, 4 total attempts, honoring `Retry-After`,
  same discipline as the other two network modules.
- An empty token skips everything and returns empty results — the local and
  fork-PR path.

## 3. Where the fetch runs

Inside `build.ts`, after harvest and before the pipeline:

```
harvest → fetchStarCounts(candidates' github repos) → write dist/v1/stars.<sha>.json
        → runPipeline(..., starsInfo) → emit → write index + plugins
```

- `runPipeline` and `emit` stay PURE: they gain an optional input
  `stars: { url: string; sha256: string } | null`. Non-null → the index gains
  the `stars` pointer. Same inputs → byte-identical outputs; the determinism
  test gains a stars-carrying case.
- Fetch failure → `starsInfo = null` → the index carries no `stars` key and
  the build report records why. The build succeeds.
- `manifest.lock` is never touched by stars (D3).

## 4. Published shapes

### 4.1 index.json (optional additive key, schemaVersion stays 2)

```json
{
  "schemaVersion": 2,
  "builtAt": "...",
  "count": 1926,
  "plugins": { "url": "plugins.<sha>.json", "sha256": "..." },
  "stars":    { "url": "stars.<sha>.json", "sha256": "..." }
}
```

- The host's index parser must tolerate UNKNOWN keys so an installed shop of
  any prior version keeps working when the new key appears. Verify the
  parser's strictness during implementation; if it is strict, relax it
  explicitly and pin the tolerance with a test.
- `plugins.json` shape is unchanged. Stars never enter a plugin entry.

### 4.2 stars.json

```json
{ "stars": { "dsh-hello-plugin": 1234, "@scope/dsh-tool": 42 } }
```

- Content-addressed, names sorted (the sort-before-emit invariant extends to
  this file), no embedded schema version (the index's schemaVersion pins the
  sidecar's shape).
- Expected to change hash daily; that churn is quarantined in this one file.

## 5. Host consumption

`catalog.ts` reads the `stars` pointer when present: same-origin URL
resolution, sha256 verification, cached alongside the catalog. Failure to
fetch or verify the sidecar degrades to `stars = {}` — the catalog works, the
sort degrades to name order, no error panel. `ShopCatalogResult` gains
`stars: Record<string, number>`.

## 6. Client

### 6.1 Pure functions (present.ts)

```ts
sortByStars(entries: CatalogEntry[], stars: Record<string, number>): CatalogEntry[]
// stars desc → un-starred last → name asc (case-insensitive) tiebreak

formatStars(n: number): string
// 999 → "999"; 1000 → "1k"; 1234 → "1.2k"; 1500 → "1.5k"; 99999 → "100k"
```

### 6.2 Rendering

- `ShopTab`: `filtered → sortByStars → A1 window slice → render`. The first
  batch always shows the most-starred.
- `EntryCard` gains `stars?: number`; when present it renders a text badge
  `★ <formatted>` in the badges row, with `aria-label` from the locale
  (`{count} stars` / `{count} 星`). Un-starred cards show nothing.
- The memo props change accordingly.

## 7. Amendments this change makes elsewhere

| Document | Change |
|---|---|
| CLAUDE.md | Network modules: add `github-stars.ts` as the third |
| CLAUDE.md invariants | New, beside the `builtAt` rule: live daily data (stars) lives only in its own sidecar; the plugin data hash must not churn daily |
| spec §6.2 | Optional `stars` pointer + `stars.json` shape + isolation rationale |
| spec §7.1 | The stars step, its placement, its never-block-publish failure semantics, and the determinism statement |
| schema.md + schema.zh.md | Author-facing note: GitHub stars show automatically for github.com repositories; nothing to declare; other hosts show none |
| README.md + README.zh.md | The catalog section's index shape gains the stars pointer |

## 8. Testing

- `githubOwnerName`: github/gitlab/`.git`/path segments/case/malformed —
  pure fixtures.
- `github-stars.ts`: mocked fetch — 50-alias batch structure, Bearer header,
  429 backoff, `errors` body discards the batch, null repos go to `skipped`,
  empty token skips.
- Build integration: `starsInfo` null/non-null determinism cases; the report
  line on fetch failure.
- Host loader: fixture server — stars present/absent/corrupt/wrong-hash;
  index parser tolerance of unknown keys (pinned).
- Client: `sortByStars` matrix, `formatStars` boundaries, badge present/absent
  and aria-label, first-batch-is-hottest A1 extension.

## 9. Non-goals

- No sort toggle (D1).
- No stars for non-GitHub repositories; no alternative signals (downloads,
  ratings) in this change.
- No per-entry stars inside `plugins.json`; no `manifest.lock` involvement.
- No new secrets; `GITHUB_TOKEN` reused.
