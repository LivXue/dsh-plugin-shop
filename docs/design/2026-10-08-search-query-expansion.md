# Chinese query expansion for the shop's search — design

Status: **decided and built 2026-10-08** (option A of the three the report
proposed: static, curated dictionary, no API). English only, per convention.
The borrowing it implements is C2 of `2026-09-26-market-borrowings.md`);
its reference implementation is `zh-intent.ts` in 2BingLing/dsh-market's
monorepo (read live 2026-10-08). A competitor citation below says where an
idea came from; it is never the evidence. Every claim rests on this
repository, on the published catalog, or on a measurement taken here.

## 1. The defect

The shop's shelf search matches the query, lowercased, against each
entry's `name`, `summary.en` and `summary.zh`. Of the 14,167 entries on
2026-10-08 (catalog `e328a971`, `builtAt` 06:52Z):

- **56.9% (8,075) name no CJK anywhere** — name and both summaries hold
  no Han character.
- **18 carry an author-written `summary.zh`.**
- A Chinese query therefore only sees the 8.7% of the catalog that
  happens to hold a Chinese token. On the live catalog:

  | query | matches today |
  |---|---|
  | 记忆 | 159 |
  | 主题 | 156 |
  | 搜索 | 191 |

  against English queries of the same meaning (`memory` 467, `theme`
  278, `search` 761).

The build is forbidden from synthesizing translations (CLAUDE.md,
"Catalog summaries carry the author's `en` and `zh`. The build never
synthesizes a translation"), so the fix cannot enrich the data. The
reader's own query is not data: expanding it is the only compliant
direction.

## 2. The rule

A curated Chinese → English query dictionary, matched on word
boundaries where it must, sits beside the existing matcher in the
client. Expanding is a union, never a substitution: the query as typed
always stays in the term set, so the 18 entries with an author Chinese
summary cannot regress.

- **A `ZhIntent` is `{ words, terms }`.** `words` are Chinese triggers:
  any appearing in the query (substring, lowercased) selects the
  intent. `terms` are the recall vocabulary scanned against every
  entry's `name`, `summary.en`, `summary.zh` and category key.
- **A term prefixed with `#` matches on a word boundary**, not as a
  substring: `#ai` matches `ai-chat` and `AI聊天` and not `email`,
  `main` or `pipeline`. The 2BingLing audit that motivated the marker
  measured 713 such false hits on 9,145 entries; on today's catalog
  the unmarked form would have broken the `AI大模型` intent the same
  way. The boundary regex is `(?:^|[^a-z0-9])${escaped}(?![a-z0-9])`,
  case-insensitive.
- **The dictionary is a data table**, not code: curated, ordered, each
  row carrying a one-line reason in a comment. It ships inside the
  shop's client. No network, no LLM, no storage beyond the bundle.
- **The user's original query is always kept.** Expanded terms are
  added to the filter's disjunction, not swapped in for the query.
  Whether the intent row's own `words` still appear in the query is
  not tracked — the row either fires per word-boundary or not.

## 3. The dictionary

**Eighty intents.** Trimmed from 2BingLing's eighty-four by removing
```农历节日```, ```Twitter```, ```微博``` and ```Notion``` — measured
2026-10-08 against today's catalog (script `/tmp/c2compete/scripts/measure2.py`):
their marginal recall (`terms` − Chinese-trigger hits) is 3 to 7, while
every retained intent contributes at least 10. The dictionary-skimming
line came from the data, not from taste: it is where the marginal
drops a full order of magnitude below the median intent.

On the same script:

- Union of the intents' `terms` over the catalog: 9,953 listings
  (70.2% of 14,167), against 1,236 (8.7%) reachable by Chinese triggers
  alone — a **8.05× marginal recall** for a Chinese query whose words
  are in the dictionary.
- Every sub-100-marginal intent is one the dictionary can still help;
  a user typing `飞书` (feishu) gets a meaningful recall, not the zero
  or one the raw query yields today.

Not every intent is safe in every locale. `words` are matched on Han
substrings, so a Chinese UI reader whose query includes `日历` fires
the `日历` intent. `terms` are only matched against catalog text.
The dictionary is one file: `ZH_INTENTS`, ordered. A maintainer
adding a row writes the intent's key, its triggers, its recall terms,
and a comment naming which row of this document's measured table
justifies it.

## 4. Where it runs

In the client, inside the existing `matched` memo
(`ShopTab.tsx:1675-1717`). The path today is a single
`q.toLowerCase()` `includes` against three strings per entry; the
rule becomes a disjunction over the expanded term set, with the
existing three strings per entry and the same lowercase folding.
`expandZhQuery` is a pure exported function in `present.ts`, so it is
fixture-driven: input is a query string, output is the expanded term
list, in dictionary order, deduplicated, with the query first.

**No debounce, no persistence.** The client's existing 5.45 ms median
keystroke cost (measured 2026-09-26 on a 13,950-entry catalog) grows by
one `includes` per expanded term, at most ~20 ms at our dictionary's
width. The expansion itself is O(query length × intent count), hashless
and allocationless, so a query of ten words evaluates every intent's
`words` once each. Word-boundary regexes are compiled lazily and cached
per term, as the reference does.

**No false-positive opacity.** When a query was expanded, the shelf
shows one subdued line under the search box naming the expansions that
fired — `Also matching: memory, notes` in English, `同时匹配：memory, notes`
in the Chinese UI — localized through the existing `t()` and locale
strings. Without it, a user looking at `memory`-tagged cards after
typing `记忆` has no idea why they appear.

## 5. What is not built (and why)

- **Word segmentation** of the query: Chinese has no spaces, and the
  dictionary deliberately matches Han *substrings*, not tokenized
  tokens — `记忆` firing for `AI记忆`, the same choice the reference
  makes.
- **Synonym expansion** beyond the curated `terms` (no
  `memory → recall/cache/remind` chains): every term has a measured
  marginal; unmeasured ones would chain into entries the dsh plugin
  ecosystem does not have.
- **A translation API.** The user ruled it out for the first version
  on three grounds: latency, determinism, and the API key question
  (the shop has no LLM configuration today). A later `v1` could swap
  the dictionary's `terms` for whatever an API returns,
  cached client-side — the interface in §4 is already the seam.
- **Tag/category weighting.** The shop's catalog does not carry
  per-entry tags, only a coarse category. 2BingLing's marker `#`
  boundary is precisely because `tag`-matched `AI` would have been
  safe there but name-and-summary substrings were not.

## 6. Testing

- **`expandZhQuery`/`:data fixtures`**: query triggers a row, several
  rows, no rows; an expanded term is deduplicated; the query as typed
  is the returned list's first element; the `#` boundary marker
  rejects `email`/`main`/`pipeline` and accepts `ai-chat`/`AI聊天`.
- **`matched`-memo behaviour**: an entry with an all-English name and
  summary becomes visible when a Chinese trigger maps to its terms;
  the same entry stays invisible to a Chinese query outside the
  dictionary; an entry carrying an author `summary.zh` is visible to
  the Chinese query with or without expansion.
- **The dictionary's own consistency**: every `term` is non-empty,
  lowercase-folded, and either Han or within `[a-z0-9.#-]`; every
  intent's `terms` have at least one measured entry in today's
  catalog (a fixture that loads the published catalog's table
  snapshot as data, as `emit.test.ts` does for the lock — and if the
  fixture someday drops to zero, the intent's row earns a comment
  saying why it stays).
- **UI surface**: the "Also matching" line renders only when the term
  set differs from the query, carries the current locale, and lists
  each expansion exactly once in dictionary order.

## 7. Release

This changes the shop's client behaviour, so it goes out with the
shop's normal channel: the `dsh-plugin-shop` package bumps a minor
version, `CHANGELOG.md` carries one entry, the release goes to `beta`
first for a day, then `latest`. The README screenshots are regenerated
in the promotion commit, never in the beta.
