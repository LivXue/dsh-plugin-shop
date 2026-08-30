# GitHub direct-install channel — design draft

Status: **draft for decision.** This document proposes listing installable dsh
plugin *repositories* alongside npm packages, using `dsh`'s native
`github:owner/repo` install form. It is not yet part of the authority spec
(`2026-08-18-dsh-plugin-shop-design.md`); if approved, the spec is amended in
the same change that implements it. English only, per convention.

## 1. Why this exists — the measured evidence

The competing hub lists ~7,600 entries by harvesting GitHub repositories that
carry the `dsh-plugin` topic, where we harvest npm packages by keyword. Two
differences drive their count, and only one of them is worth copying:

- **Pool size:** `topic:dsh-plugin` matches 12,704 repos (plus 9,328 for
  `topic:deepseek-harness`) against our 3,170 + 4,486 npm names. The topic pool
  is ~2.6–4× larger.
- **Unit of listing:** they list *repositories* and install via
  `dsh plugin add github:owner/repo`, which `dsh`/pnpm support natively. 60% of
  their "curated" 4,497 entries have no npm package at all — those are
  invisible to our harvest by construction.

Their pool is also heavily polluted. An audit of 90 `topic:dsh-plugin` repos
(2026-08-30) found:

| State | Share | Effect on a github: install |
|---|---|---|
| `package.json` + `dsh.bundle` | 20% | installs and registers as a plugin |
| `package.json`, no `dsh.bundle` | 42% | pnpm installs, exit 0, **but dsh registers no plugin** — silent no-op |
| no usable `package.json` | 38% | pnpm fails |

The 42% row is the dangerous one: the harness itself only emits a warning
(`declares no dsh.bundle — installed as a plain dependency`). A shop that lists
these entries would let a user click install, watch it succeed, restart, and see
nothing. Their "7,621 listed" is, at best, 20% installable. The same gate we
already run on npm candidates, re-expressed for repositories, removes both
failure classes at harvest time.

**The prize is the 20%:** real, installable dsh plugins that never publish to
npm, which our catalog today cannot see at all.

## 2. Goals and non-goals

**Goals**

- List dsh plugin repositories that are installable via `github:owner/repo`,
  with the same honesty guarantees as npm entries: every rejection carries an
  author-readable reason, nothing disappears silently, install targets are
  validated against the catalog snapshot.
- Keep one shelf, one tiering model, one install flow.

**Non-goals**

- Matching their raw count. Gate-first, count second.
- Any arbitrary install form. `github:owner/repo#commit` is built by the Host
  from catalog-validated fields; the "no arbitrary URL install" stance (§7.2 of
  the spec) is unchanged.
- Listing forks, mirrors, demos, or multi-platform projects that merely carry
  the topic — the gate below is the filter.
- Replacing npm entries: when a repository's `package.json` name matches an
  existing npm entry, the npm entry wins (it carries real semver); the
  repository appears only as a fallback when no npm entry exists.

## 3. Harvest

A second, parallel harvest in the daily build, behind the same pure-core /
impure-shell split:

- **Shell** (`github-client.ts`): GitHub search API for
  `topic:dsh-plugin` and `topic:deepseek-harness`, paged (100/page, bounded
  like `MAX_SEARCH_PAGES` — hitting the bound throws, never truncates). For
  each repo: fetch the default-branch `package.json` via
  `raw.githubusercontent.com`, plus the repo metadata the search response
  already carries (description, license, pushed_at, full name).
- **Pure** (`repo-gate.ts`): the gate below.
- **Union:** repo names (owner/slug) and npm names are disjoint keyspaces, but
  entries are deduplicated by *bundle name* (the `name` field of the repo's
  `package.json`), with npm entries winning.
- **Determinism:** same rules as npm — sort by name before emit, no
  clock-dependent fields in the hashed content. Star counts for repos flow
  through the existing `stars` sidecar, keyed by the repo full name.

## 4. Gate — the anti-80%

Every candidate repository passes through, in order, each failure producing an
author-readable rejection (codes reused from the npm gate where they apply):

1. `no-manifest` — default-branch `package.json` missing or unparseable.
2. `no-bundle` — the manifest declares no `dsh.bundle`. **This is the rule
   that eliminates the silent no-op install; it is non-negotiable.**
3. `no-license` / `no-repository` — same auditability rules as npm candidates
   (the repo URL is known, but the *declared* license must exist).
4. `nothing-to-show` — no description from either the repo metadata or the
   manifest.
5. Denylist by repo full name (`denied.yml` gains a `repo:` form), plus the
   existing typosquatting edit-distance hold, computed on the repo slug.
6. Topic pollution: no additional heuristics. The bundle gate is the filter;
   repos that declare `dsh.bundle` while not being plugins are rare enough to
   leave to denylist and review, and every additional heuristic adds a class of
   wrong rejections.

Repositories that vanish or break between builds surface at install time
through the existing executor failure path (below), not as catalog churn.

## 5. Entry model and schema

Plugin entries gain `source: 'npm' | 'github'`. GitHub entries carry:

- `name`: the manifest's `name` (the bundle name — what dsh registers),
- `repo`: `owner/slug`,
- `commit`: the pinned commit (40-hex, from the default branch at harvest),
- `version`: display value — the short commit (7 hex chars), mono-rendered,
- `publishedAt`: the commit date, `repository`, `license`, `description`:
  same fields as npm entries.

The catalog data schema bumps `schemaVersion` 2 → 3, additively. The client
release supporting source `github` ships before the daily build flips the
flag, so no live catalog ever serves v3 to a client that cannot parse it.

## 6. Install path — the RPC invariant survives

The spec's install invariant is "the Host accepts a name and a version, never
an arbitrary spec". For GitHub entries this reads "the Host accepts a repo and
a commit, never a raw spec":

- `shop/installStart` for a `github` entry takes `{ name: 'owner/slug',
  version: '<40-hex commit>' }`. The Host validates `name` against its catalog
  snapshot's repo entries and `version` as 40 hex chars, then builds
  `github:owner/slug#commit` itself. No string the client sends is ever
  appended to a command line; the argv-smuggling guard keeps applying to the
  whole form.
- **Pre-flight:** before spawning, the Host checks `git --version` (a missing
  git is a pnpm git-install failure) and rejects with `git-missing` detail —
  cheap, and the failure is honest before the click costs anything.
- **Post-flight:** the existing bundle-activation confirmation (`dsh plugin
  list` after zero exit) stays. If the repo changed its manifest between
  snapshot and install (rare), the no-bundle warning becomes the existing
  honest `installed, but the profile did not change` failure instead of a
  silent no-op.
- **Update semantics:** a newer commit at harvest → the existing update button,
  driving `installStart` with the new commit. Uninstall takes
  `{ name: 'owner/slug' }` and validates against the manifest exactly like npm
  names. Restart and self-update are untouched.

## 7. Tiering

`community` by default. `verified` pins a **commit**, not a repo: the review
record for a GitHub entry carries `reviewedCommit` instead of
`reviewedVersion`, and a newer commit downgrades to `verified-stale` exactly as
a newer version does. The core invariant — trust never inherits across
unreviewed code — holds across both sources.

## 8. UI

No new chrome. The single-line row renders a GitHub entry with the same badge
row (category chip, short-commit version, tier, stars), the repository link in
the expanded detail (always present for repo entries), and an octocat chip next
to the version to say "installed from source". The client-side shop-like
filter extends to repo slugs (a marketplace repo named `dsh-market` is filtered
the same way a package named `dsh-store` is).

## 9. Build, tests, rollout

- `repo-gate.ts` and the union logic are pure; fixtures drive them. One test
  file per module, per convention.
- `pnpm build:catalog` grows by the GitHub search pages + one
  `raw.githubusercontent` fetch per new candidate; the page bound keeps it
  finite. GitHub search is unauthenticated rate-limited (~10 req/min for
  search); the daily build budgets for two keyword searches plus the two npm
  keyword searches.
- Rollout order: (1) harvest + gate + emit behind a flag, run locally against
  the live GitHub API to measure the post-gate count; (2) client + host install
  path, released; (3) flip the flag in the daily build.

## 10. Open questions for decision

1. **Commit vs tag pinning.** Commits are exact and always exist; release tags
   read better and move rarely. Recommend commit (the manifest data is the
   same; display can show the tag when the commit is tagged).
2. **First-cut scope.** Recommend phased (flag → measure → install path →
   flip), accepting that repo entries appear on the shelf only at step 3.
3. **Deduplication rule.** Confirm "npm wins by bundle name" (a repo whose
   manifest name already ships as an npm package is not listed separately).
4. **verified.yml for repos.** Ship with the install path (step 2) or later?
5. **Repo freshness.** Should the gate require recent activity (`pushed_at`
   within N months) to keep dead repos off the shelf, or is harvest-time
   404→rejection enough?
