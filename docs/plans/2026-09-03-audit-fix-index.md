# Audit fixes — the plan of plans

Date: 2026-09-03
Spec: [2026-09-03-debug-audit.md](2026-09-03-debug-audit.md) — 69 findings, 82 finding ids (G-11 and E-13 were both added while these plans were written)
Status: plans written, nothing implemented. Every fix below is a proposal until its failing test exists.

The audit spans five subsystems that do not share state: the harvest's network shell, the gate's trust model, the artifacts and the workflow that publishes them, the host and client that read them, and the test suite that is supposed to hold all of it. Writing one plan for all 69 findings would produce a document nobody can execute a task from. So there are five, each independently shippable, each with its own TDD task list.

## The five plans

| Plan | Scope | Findings | Tasks | Ships as |
|---|---|---|---|---|
| [A — stop the bleeding](2026-09-03-audit-fix-a-urgent.md) | The live and imminent registry defects | 8 | 9 | A daily build; no package release |
| [B — identity and trust](2026-09-03-audit-fix-b-identity-trust.md) | A listing's identity is `(source, name, repo, subdir)`, not `name`; the review model; the LLM's reach | 16 | 17 | A daily build + spec amendments |
| [C — network, artifacts, CI](2026-09-03-audit-fix-c-network-artifacts-ci.md) | Weather in the GitHub client, what Pages serves, the workflow's permissions and pins | 15 | 18 | A daily build + workflow changes |
| [D — host and client](2026-09-03-audit-fix-d-host-client.md) | The RPC boundary, process spawning, body bounds, the client's state and sort | 21 | 28 | An npm release through `beta` first |
| [E — close the test gaps](2026-09-03-audit-fix-e-test-gaps.md) | Tests that pass for the wrong reason, proven by injecting the break | 9 | 11 | Rides along with A–D |

Coverage was checked mechanically, not by eye: all 82 ids appear in exactly one plan, with no orphans and no duplicates.

## One invariant the plans surfaced, which nothing recorded before

Plans B and D each introduce an identity module, because the two halves share no code by design (CLAUDE.md: "The two halves share no code, only the schema"). Written independently, they arrived at byte-identical serialisations:

```ts
source === 'npm' ? `npm:${name}` : `github:${repo ?? name}#${subdir ?? ''}`
```

That agreement is not luck — it is forced by the registry's own uniqueness rule at `registry/scripts/src/emit.ts:107-109`. But it is now duplicated in two packages that cannot import each other, under two different names: `installIdentity` in `registry/scripts/src/identity.ts`, `identityKey` in `packages/dsh-plugin-shop/src/shared/identity.ts`. Nothing in the repository says they must match, and nothing fails if one drifts.

Whoever executes B and D should treat the format as a published contract: it belongs in the design doc beside the uniqueness invariant, and a comment in each module should name the other. The names differing is a readability cost worth accepting — renaming 44 call sites to match 15 buys nothing — but the *format* drifting would silently break the host's ability to recognise what the registry emitted.

## Order, and why

**A first, and this week.** Everything in it is either live today or days away. D-1 is on a clock the repository does not control: the npm search API silently wraps `from > 5000` back to page 0, and `keywords:deepseek-harness` stood at 5,094 names when the audit ran — 156 short of the point where every daily build starts throwing with the wrong diagnosis. Nothing else in the audit has a deadline set by someone else.

**Two fixes inside A must land in one commit.** C-1 stops the bot from re-stamping half the shelf with today's date, which requires committing `registry/first-seen.yml`. A-3 is that a GitHub manifest name containing `"` or `\` breaks the YAML those serialisers write. Ship C-1 alone and the next hostile repo name gets committed into a build input, and every later build throws at load. The plan states this dependency in both tasks.

**B and C can run in parallel** — they touch different modules — but B's identity sort (C-2) and C's pure stars serialiser (C-3) both land in the emit path, and E's single determinism test asserts over both. E's H-6 task therefore comes after both, and says so.

**D is the only plan that needs a release.** G-1 changes an RPC shape, so per CLAUDE.md it goes to `beta`, gets installed on a real profile against a duplicate-name entry and a killed mid-install, and only then moves `latest`. The promotion commit is the one that moves all four README pins.

**E is not a phase.** Most of it lands as the "test first" step of A–D. What remains — H-1, H-3, H-4, H-5, H-8 — is listed on its own because those gaps hide defect classes no other plan touches.

## What the audit found that a plan cannot fix

Three items are decisions, not code:

1. **The LLM gateway is plaintext to a bare IP** (`http://8.141.31.123:3000/v1`). An on-path party can read `LLM_API_KEY` and forge the verdicts that get committed. Plan B makes the verdict non-load-bearing, which limits the damage; the transport itself is an operational fix outside this repository.
2. **`verified.yml` and `denied.yml` are both empty.** Every entry on the shelf is community-tier, so every install asks for the acknowledgement, and every trust-model defect in plan B is dormant until the first review is recorded. That is the moment to have fixed them, which is the argument for doing B before the first review, not after.
3. **A published rejection reason that is wrong is a defect, not a wording nit** (CLAUDE.md). Five findings are exactly that — B-5, B-7, D-3, D-4, and the `shadowed-by-npm` unit in C-6. Their fixes change strings a plugin author reads to find out why their package is not listed, so the new wording is in the plans verbatim rather than left to the implementer.

## What writing the plans changed in the audit

Planning found five things the audit got wrong or missed. The audit doc has been amended in place, so it now carries 69 findings rather than 67:

1. **D-1's fix direction was not achievable.** The audit said "partition the query so the window is never needed". The live API was probed before plan A was written: a `text` term added to `keywords:<k>` leaves `total` unchanged and only re-ranks, `keywords:a,-b` returns 0 (no negation), and `size=1000` still returns 250. The only filtering dimension is the `keywords:a,b` intersection, and without negation a cell's complement is inexpressible — **no covering partition exists**. Plan A partitions on intersections and then measures coverage against the answered `total`, throwing on a shortfall: safe by check, not by construction.
2. **The packument count was double-counted.** "~8,800 packuments" was the sum of two overlapping keyword totals. The harvest fetches the union: 5,095 + 3,699 − 3,178 ≈ 5,600 today.
3. **G-6's version grammar as written would have rejected live entries.** The audit said "40-hex for GitHub `version`". 162 of the 5,908 GitHub entries in today's catalog are release-rescued and carry a release tag (`@ablemind/dsh-plugin-tui` → `v0.2.1`). The grammar is 40-hex **or** a release tag, and plan D's release task parses the whole live catalog with the new schema before publishing — a too-strict schema would dark the shelf, which is the 0.5.0 failure mode.
4. **A new finding, G-11.** `installStart` writes a GitHub pin as `{ name: version }`, but `readRepoPins` keeps only a 40-hex value, so for those same 162 release-rescued entries the pin is written and dropped on every read and `installed()` can never report `outdated`. `tests/host/index.test.ts:1000` asserts the tag is *written* and passes, hiding it — a test passing for the wrong reason, in the same class as H-1 to H-3.

5. **A second new finding, E-13.** `packages/dsh-typert-protocol/package.json` exports `./typert` to `lib/typert.host.js` and `.d.ts`, lists both in `files`, and neither exists — `lib/` holds only `index.js`, `invariant.js` and `types/`. Nothing imports it, so it is inert, but it is a false statement in a manifest that survived because nothing exercises it. Audit E read this manifest and missed it.

Two cross-plan inconsistencies were also resolved rather than left for the implementer. Plans C and E both described the pure stars serialiser and disagreed on its module, function shape and field name; C is the producer, so C's `serializeStars(assembled) → SerializedStars { fileName, json, sha256 }` in `stars-assemble.ts` won, and plan E's Task 10 and 11 were rewritten to consume it. Plan B replacing `pipeline.ts` wholesale collides with plan C's Task 9 extraction; both plans now state the ordering.

H-7 also moved from *Plausible* to *Confirmed*: run from `registry/`, `pipeline.test.ts` fails to collect and all 20 of its cases vanish.

## Executing these

Each plan carries the standard header pointing at `superpowers:subagent-driven-development` (a fresh subagent per task with review between) or `superpowers:executing-plans` (batch with checkpoints). The choice is per plan, not global — A is small and urgent enough to run inline; D is large enough to want a fresh reviewer per task.

Two habits apply to every task in all five plans:

**Reproduce before fixing.** Four findings are marked *Plausible* rather than *Confirmed* — B-11, F-7, H-7, and the LLM-echo leg of A-3. Their first step is a reproduction that either confirms the finding or closes it with a note. A fix built on an unreproduced hypothesis is how a plan invents work.

**Mutation-check every new test.** Copy the module to `/tmp`, inject the bug the test claims to catch, point the test at the copy, and watch it fail. The audit's own H-1, H-2 and H-3 exist because three tests did not survive that check — and while writing this, one of my own mutation checks silently matched the wrong anchor and proved nothing until it was re-run with the indentation pinned. A test that stays green under its own mutation is not a test, and a mutation check that does not apply is not a check.
