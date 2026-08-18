# SDD ledger — plan: docs/plans/2026-08-18-p0-registry.md

Spec: docs/design/2026-08-18-dsh-plugin-store-design.md (read; binding authority)
Branch: feat/p0-registry (merge-base c8250f7 on main)
Toolchain verified: node v22.23.2, pnpm 11.7.0, python3+pyyaml

## Pre-flight scan

### Cross-task pairs sharing a file or interface

| Pair | Produced | Consumed | Finding |
|---|---|---|---|
| T1 -> T3 | `parseCatalogSection(value) => {ok:true,value}\|{ok:false,error}` | gate reads `.ok`, `.error`, `.value` | agree |
| T1 -> T3 | `RejectionCode` union incl. `no-integrity`, `no-publish-time` | gate emits both | agree |
| T1 -> T4/T5 | `Entry`, `Tier`, `Review` | tier builds Entry; emit serializes it | agree |
| T2 -> T3 | `RegistryConfig{verified:Map,denied:Map,allowedSimilar:Set}` | gate uses `.get/.has/.keys()` | agree |
| T2 -> T4 | `config.verified.get(name) => Review` | tier reads `reviewedVersion` | agree |
| T3 -> T4 | `Accepted{candidate,catalog,integrity,publishedAt,repository,license}` | tier copies all six | agree |
| T3/T4 -> T6 | `gate`, `assignTier` | pipeline composes both | agree |
| T5 -> T6 | `emit(entries,rejections,builtAt) => Artifacts` | pipeline returns it | agree |
| T5 -> T7 | `Artifacts.{pluginsFileName,pluginsJson,indexJson,manifestLock,report}` | build.ts writes all five | agree |
| T2 -> T7 | `loadRegistryConfig(dir)` | build.ts passes REGISTRY_DIR | agree |
| T1 -> T7 | `build:catalog` script names `registry/scripts/src/build.ts` | file created in T7 | dangling between T1 and T7; never run before T7. Not a conflict |
| T1 -> T8 | `test`/`typecheck`/`build:catalog` scripts | workflow runs all three | agree |
| T7 -> T8 | `dist/` gitignored, `snapshots/manifest.lock` committed | workflow commits the lock, publishes dist | agree |

### Per-task self-consistency

| Task | Finding |
|---|---|
| T1 | Test compares committed schema to `renderJsonSchema()`; step 8 generates before asserting. Consistent. |
| T2 | Every throw assertion matches a zod path the schema actually produces. Consistent. |
| T3 | Test config omits `notes`; loader defaults it to `''`. Consistent. |
| T4 | Helper builds `catalog: {}` against `Candidate.catalog: unknown`. Consistent. |
| T5 | Manifest-lock expectation matches the join-plus-conditional-newline implementation. Consistent. |
| T6 | Fixture fields match `Candidate` exactly; `dsh-fs-too1` is distance 1 from `dsh-fs-tool`. Consistent. |
| T7 | `structuredClone(packument) as Record<string, never>` plus a second cast to mutate a nested field will not compile under `strict`. **Conflict — ruled below.** |
| T8 | Workflow pins pnpm 9 via `action-setup`; local pnpm is 11.7.0, so CI would resolve a lockfile it did not write. **Conflict — ruled below.** |

## Rulings

Ruling: implement on `feat/p0-registry`, not `main` — the skill forbids starting on main without consent, and the user's stated workflow branches for every change — cost if wrong: a branch to rename or fast-forward.

Ruling: Task 1's package.json gains `"packageManager": "pnpm@11.7.0"` and Task 8's workflow drops `with: { version: 9 }` from `pnpm/action-setup` — the lockfile is written by pnpm 11 locally and pinning CI to 9 makes CI resolve a different tree — cost if wrong: `action-setup` errors on a missing version input, visible on the first CI run.

Ruling: Task 7's deprecated-version test may build a plain object literal instead of `structuredClone` plus two casts, provided the assertion (`toCandidate(...)?.deprecated === true`) is unchanged — the double cast does not compile under `strict` and the test's subject is the projection, not the cloning — cost if wrong: none; the assertion is identical.

## Execution

Task 1: complete (commits c8250f7..7b21258, review clean)
Task 1: minor (deferred): catalogSectionSchema carries no explicit z.ZodType<CatalogSection> annotation; shape drift would surface at the consumer, not the declaration. Originates in the brief's own code.
Task 1: minor (deferred): pnpm-lock.yaml committed beyond the brief's git add list — reviewer confirmed this was correct.
Task 2: BASE=7b2125879558ccc2defb68001681e33b4c4c7e7f
Task 2: complete (commits 7b21258..a60a48f, review clean)
Task 2: minor (deferred): only the first zod issue is surfaced on a malformed registry file; two missing fields need two fix-and-rerun cycles.
Task 2: minor (deferred): a duplicate name in verified.yml/denied.yml silently last-one-wins instead of failing loudly. Adjacent to the loud-failure principle — flag to final review.
Task 2: minor (deferred): reviewedVersion is validated as a non-empty string, not as semver; a non-semver value is caught only downstream in tier comparison.
Task 3: BASE=a60a48ff9160b433ef77b003117540971aaa8ef0
Task 3: review found 1 Important — test fixture dsh-fs-abcd labeled distance 3 is actually distance 4, leaving distance 3 (first admitted value) untested.
Task 3: Ruling: the plan mislabeled BOTH similarity fixtures (dsh-fs-t001 labeled 2 is actually 3; dsh-fs-abcd labeled 3 is actually 4). The reviewer is right and the plan is wrong. Fix the test, never gate.ts: keep the implementer's dsh-fs-t00l for distance 2, and use dsh-fs-t001 for distance 3, giving exact coverage at 0/1/2/3 around the threshold — cost if wrong: a test asserts a distance it does not have, which is the defect being fixed.
Task 3: fix round 1/5 (1 addressed, 0 open — distance-3 boundary fixture; commits 89e64da..ffe9216)
Task 3: complete (commits a60a48f..ffe9216, review clean)
Task 4: BASE=ffe92165526eeabb49d16d4c359e154573ccd480
Task 4: complete (commits ffe9216..fb8b8b2, review clean, no findings)
Task 5: BASE=fb8b8b2957d0f2f862a03c0f9245d0e27ac478f7
Task 5: complete (commits fb8b8b2..f0af6f5, review clean)
Task 5: minor (deferred): the empty-catalog manifestLock === '' carve-out is verified manually but not asserted in the suite.
Task 5: minor (deferred): Artifacts documents only pluginsFileName; the other four fields have no per-field doc.
Task 5: minor (deferred): report renders rejection details into a markdown table without escaping '|'. Latent — no current gate reason contains one.
Task 6: BASE=f0af6f59209e44e7e00bc057b07648dc21a25744
Task 6: review found 1 Important (plan-mandated) — the clock-invariance test asserts only pluginsJson stability, leaving pluginsFileName/manifestLock/report unchecked against a builtAt leak.
Task 6: Ruling: the finding is right and the plan's test was incomplete. This test carries P0's headline acceptance criterion; asserting it on one of four stable artifacts does not establish it. Fix the test, never emit.ts — cost if wrong: three extra assertions on a property that already holds.
Task 6: minor (deferred): the order-shuffle test uses .reverse() rather than a true shuffle. Sufficient for a broken sort; would miss an order-dependent bug symmetric under reversal.
Task 6: fix round 1/5 (1 addressed, 0 open — clock-invariance assertions; commits 9ea2a85..c880655)
Task 6: complete (commits f0af6f5..c880655, review clean)
Task 7: BASE=c880655b27a40d0a243fcd8b4e409ba4a4fb3c7c
Task 7: LIVE-RUN DISCOVERY — the dsh-plugin keyword already has 1390 real npm packages. Sampled 100 directly: 100/100 carry the exact keyword (npm search is not fuzzy here), 94/100 declare dsh.bundle, 99/100 have a license, 89/100 have a repository, and 0/100 declare dsh.catalog. A real ecosystem of roughly 1300 installable dsh plugins exists today and this design's gate rejects every one of them, because dsh.catalog is a field this project invented and nobody has adopted.
Task 7: Ruling: P0 ships the gate exactly as specified — the implementation is correct against the spec, and the defect is in the spec's own premise (D2 claims frictionless listing, but requiring dsh.catalog makes listing require an author action). Amending it is a product decision with real trade-offs between coverage and metadata quality, so it is surfaced to the user with the sampled data rather than decided mid-execution. Nothing downstream in P0 depends on it — cost if wrong: the catalog is empty at launch until either authors adopt the field or the spec is amended; no code is wasted either way, since the rule is one branch in gate.ts.
Task 7: review found 1 Important (plan-mandated) — fetchCandidate collapses every failure to null and fetchAll drops nulls silently; the live run lost 1 of 1389 candidates with no trace.
Task 7: Ruling: the finding is right and the plan mandated it. It contradicts the spec's requirement that every rejection leave an author-readable reason, and at ~1390 fetches a rate limit could drop dozens while the report looked normal. Route fetch failures into the same report as every other exclusion via a new fetch-failed rejection code and an optional priorRejections parameter on runPipeline — cost if wrong: one extra union member and one optional parameter on a function with a single caller.
Task 7: minor (deferred): normalizeRepository's plain-string repository form has no test; only the { url } object form is exercised.
Task 7: minor (deferred): CONCURRENCY = 8 is a hardcoded constant in build.ts. Acceptable for a standalone build script; noted for when it needs tuning.
Task 7: minor (deferred): this repo configures no coverage gate, so untested branches are not caught by CI.
Task 7: fix round 1/5 (1 addressed, 0 open — fetch failures now audited as fetch-failed rejections; commits a70f769..e0d68ee)
Task 7: complete (commits c880655..e0d68ee, review clean)
Task 7: minor (deferred): build.ts's fetchAll wiring that shapes a CandidateResult failure into a fetch-failed Rejection has no test; build.ts is a top-level-await entry point with no exports and zero coverage before or after.
Task 7: minor (deferred): npm-client.ts's await response.json() can throw on a malformed body, propagating through Promise.all as an unhandled exception instead of becoming a recorded rejection. Pre-existing, unchanged by the fix.
Task 8: BASE=e0d68eebcf4db24a53b4f25337ef1956e9c36bd9
Task 8: review found 3 Important (all plan-mandated) — workflow-level permissions over-grant both jobs; the concurrency group is a bare literal serializing every unrelated run; a failed snapshot commit fails the build job and blocks the Pages publish.
Task 8: Ruling: all three are correct and all three are defects I wrote into the plan. Scope permissions per job (contents:write on build, pages/id-token:write on deploy); scope the concurrency group by github.ref with cancel-in-progress only for pull_request, which keeps the serialization the snapshot push needs while giving each PR its own lane; and both reorder the Pages upload ahead of the snapshot commit AND mark that commit continue-on-error, so a refused push stays visibly failed without taking down the publish — cost if wrong: a CI config change with no product surface, correctable on the first real run.
Task 8: minor (deferred): the github-pages environment has no url: wired to the deployment output, so the deployed URL does not surface in the GitHub UI.
Task 8: minor (deferred): the step named "Publish to Pages" only uploads the artifact; the actual publish is the deploy job's step. Misleading when debugging a failed publish.
Task 8: OPEN for final review: the Pages URL https://dsh-plugin-store.github.io/v1/index.json in both READMEs is only correct if the GitHub owner is itself named dsh-plugin-store and Pages serves from root; no origin remote is configured yet, so it is unverified. Also unverified: whether Pages is configured with Source = GitHub Actions, without which deploy-pages fails on the first run.
Task 8: fix round 1/5 (3 addressed, 0 open — per-job permissions, ref-scoped concurrency, publish-before-commit + continue-on-error; commits 3f63a9c..f94380a)
Task 8: complete (commits e0d68ee..f94380a, review clean)
ALL TASKS COMPLETE. Final whole-branch review next. Merge base: c8250f72c2dfee6ab4d5bb3731a82e3df351da59
FINAL REVIEW (run by the controller, not dispatched): 66/66 then 72/72 tests, typecheck clean, no nondeterminism source outside build.ts.
Final: 5 Important findings fixed in one wave (commits f94380a..c647e4b); scoped re-review done by reading the fix diff — all five verified present and correct.
Final: Ruling: deferred minors triaged — three promoted to must-fix (duplicate registry names, unescaped author-controlled text in the report, malformed body aborting the build); the rest stay deferred as polish — cost if wrong: the deferred items are documentation and test-coverage polish with no behavior impact.
