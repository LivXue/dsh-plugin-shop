# LLM-assigned plugin categories

Date: 2026-08-26
Status: design, pending implementation plan
Author: LivXue, Claude

The catalog's category spine is invisible in practice: no plugin author declares
`dsh.catalog.category`, so every derived listing renders as `other` and the
six-color design carries no information. This design adds automated
categorization: an LLM classifies derived listings, results land in a committed
file, and the catalog publishes them.

## 1. Decisions a human made

| # | Decision |
|---|---|
| D1 | The LLM writes **directly** into the committed list; the daily diff is the audit surface. No human gate per entry. |
| D2 | **One-time backfill** of every existing derived listing, then daily increments. The backfill is not a separate script — the first build run after this lands IS the backfill (§4). |
| D3 | The LLM is an internal OpenAI-compatible gateway: base URL `http://8.141.31.123:3000/v1`, model `deepseek-v4-flash`, key in a GitHub Actions secret. (Probed live: the model classifies correctly and is a reasoning model — 171 of 174 completion tokens were reasoning, so classification is batched to amortize it.) |
| D4 | Classification failures are **retried forever**: a failed entry is simply absent from the file, and the build re-attempts every derived listing not in it. No failure counters, no giving up, no "permanently other" state. |

## 2. The categories file

`registry/categories.yml`, same discipline as `verified.yml`:

```yaml
# LLM-assigned categories for derived listings (§6.1 dual-track).
# A declared `dsh.catalog.category` ALWAYS wins; this file only ever covers
# entries without one. Rows are appended by the classifier; the daily diff of
# this file is the audit surface for every assignment the model ever made.
# A name absent from this file is simply "not yet classified" — the build
# retries it on the next run (D4).
- name: dsh-hello-plugin
  category: tool
```

Shape decisions:

- **A list of rows, not a map.** YAML maps silently last-win on duplicate
  keys; a row list lets the loader throw on a duplicate name, matching the
  `verified.yml`/`denied.yml` discipline.
- **No timestamps in the file.** git history is the audit trail; a date column
  would duplicate it and add diff noise.

Loader rules (in `config.ts`, failing loudly):

| Case | Behavior |
|---|---|
| File missing | Treated as an empty list — legal before the backfill lands |
| Malformed YAML, unknown category value, duplicate name | **Throw**; the build stops |
| Name has a declared `dsh.catalog.category` | The row is ignored at emit (author wins) and **pruned** from the file at build time |
| Name no longer in the catalog | **Pruned** at build time (dead rows are noise) |

**One step owns the file.** The classify step alone reads and writes it: after
classifying, it appends the new rows, prunes rows whose name has left the
catalog or gained a declared category, sorts by name, writes, and commits. The
pipeline step that follows only READS it, exactly like `verified.yml`. The
file therefore obeys the sort-before-emit invariant and no two steps race over
it.

## 3. What the LLM sees

Input per package: `name`, npm `description` (the derived summary source), and
`keywords` when present. The harvest's `fetchCandidate` already downloads the
full packument for every candidate, so extracting `keywords` there is a small
shell-only addition to the candidate shape — no extra network requests. The
classifier never receives anything but public npm metadata, so sending it to
the gateway crosses no data boundary.

Vocabulary is **fixed**: `tool | provider | ui | workflow | integration |
other` — the six the schema and UI already know. The model may not invent
categories; an invented one is an invalid row.

Prompt contract (system message):

- one sentence per category, with the disambiguation rule that `provider` is a
  generic capability and `integration` is a named third-party product, and the
  tie-break "genuinely unsure → `other`"
- input as a JSON array of `{ name, description, keywords }`
- output as a **strict JSON array** `[{"name": "...", "category": "..."}]`
  with names echoed back verbatim, nothing outside the JSON

Parameters: `temperature 0`, `max_tokens 4096`, **20 packages per call**.
Batching is load-bearing: the model spends ~171 tokens on reasoning regardless
of batch size, so 20 per call divides that cost by 20 (probe evidence, D3).

## 4. Where it runs

The classification step lives in the daily build, between harvest and the
pipeline run:

```
harvest → classify(pending derived names) → append categories.yml
        → commit categories.yml (separate commit)
        → pipeline (categories.yml as INPUT) → commit lock + artifacts → publish
```

- **Pending** = every derived listing (no declared category) whose name is not
  in `categories.yml`. On the first run after this lands, that is the entire
  catalog — the backfill is this step, not a separate script (D2).
- The categories commit happens **before** the pipeline runs, so a later
  failure does not lose classification progress; re-runs only classify what is
  still absent.
- The pipeline's pure core takes `categories.yml` as an input, exactly like
  `verified.yml`/`denied.yml`. Emit fills `catalog.category` for derived
  entries that have a row. The client already reads that field
  (`categoryKey`), so the UI changes not at all.

New shell module: `registry/scripts/src/llm-client.ts` — the second module that
touches the network. Thin OpenAI-compatible HTTP layer
(`POST {LLM_BASE_URL}/chat/completions`, Bearer `LLM_API_KEY`), bounded retry
on 429/5xx with the same backoff discipline `npm-client` uses, concurrency 4.
Configuration is environment-only: `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`;
the key appears in no repository file.

Parsing is a **pure** function, `parseClassificationResponse(text,
expectedNames)`, so every policy rule is fixture-testable:

| Input | Behavior |
|---|---|
| Valid rows, names in the expected set, categories in the vocabulary | All adopted |
| Individual bad rows (invented category, name not expected) | Row discarded → stays unclassified → retried next build (D4) |
| Whole response unparseable / not JSON / no output | Batch discarded → all stay unclassified → retried (D4) |

## 5. Failure semantics

Classification can never block a publish. When the gateway is down, the rate
limit is exhausted, or the output is garbage, the build publishes the affected
entries as `other` and keeps them absent from the file — which means the next
build tries them again (D4). A permanently unclassifiable name costs one small
batch per day, forever, until a human pins a category by hand-editing the file;
that manual edit is the correction path, mirroring `verified.yml`/`denied.yml`.

Every discarded classification is recorded in the build report with a reason —
nothing disappears without one, per the standing rule.

## 6. Determinism

The categories file is a **build input**, not a build-time random step. The LLM
writes the input; the pure core never calls it. Given the same catalog and the
same `categories.yml`, the pipeline output is byte-identical — the content hash
does not churn, and the sort-before-emit invariant extends to the file itself.

## 7. Amendments this change makes elsewhere

| Document | Change |
|---|---|
| spec §6.2 | Published catalog: a derived listing may carry an LLM-assigned `catalog.category` whose source is `categories.yml` |
| spec §7.1 | The classification step, its placement, the determinism statement of §6 here, and the never-block-publish failure semantics |
| CLAUDE.md | The "npm-client is the only network module" rule gains `llm-client.ts` as the second |
| CLAUDE.md invariants | New: LLM output is advisory — it may change a category, never gate a listing, never remove an entry; a bad classification must never make an entry disappear |
| schema.md + schema.zh.md | Author-facing note: without a declared category, the shop may assign one by automated review; declare `dsh.catalog.category` to control it |

## 8. Testing

- `parseClassificationResponse`: valid batch; mixed valid/invalid rows; invented
  category; unexpected name; non-JSON; empty output — all fixtures, no network.
- `llm-client`: mocked fetch — Bearer header present, batch splitting (25 names
  → two calls of 20 and 5), 429 backoff honors Retry-After and gives up loudly.
- Loader: duplicate name throws; unknown category throws; missing file is empty.
- Determinism: same catalog + same categories input → identical artifacts
  (extended from the existing determinism test's assertion surface).
- The daily workflow path: categories commit lands before the pipeline commit
  (workflow-level test or at minimum a documented check in CI logs).

## 9. Non-goals

- No failure counters, no retry backoff per entry, no giving up on a name (D4).
- No new categories beyond the six; the model cannot extend the vocabulary.
- No human approval gate per assignment (D1); humans correct after the fact by
  editing the file.
- No reclassification of entries that already have a declared category.
- No change to the client half; `categoryKey` already renders whatever category
  the catalog carries.
