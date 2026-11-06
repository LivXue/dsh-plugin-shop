# dsh 0.2.2-rc.1: the profile table moved out of app-boot

Status: **built 2026-11-06.** dsh `0.2.2-rc.1` became npm's `latest` on
2026-11-04; this records what the shop had to change and how the harness was
verified. The previous pin is [2026-10-19-dsh-021-readiness.md](2026-10-19-dsh-021-readiness.md)'s
subject.

## 1. What moved

Through `0.2.1-rc.5`, `@deepseek-ai/dsh-app-boot` exported `PROFILE_TEMPLATES`
— the table naming every profile template's bundles — and the shop read it to
judge an entry's `dsh.compatibility.profiles`.

`0.2.2-rc.1` imports that table from `@deepseek-ai/dsh-official-bundles` and
**exports nothing by that name**. Measured against the installed rc:

```
dsh-app-boot/lib/index.js:15   import { …, PROFILE_TEMPLATES, … } from "@deepseek-ai/dsh-official-bundles";
dsh-official-bundles/lib/index.js:228   export { …, PROFILE_TEMPLATES, … };
```

## 2. What it cost, and why nothing said so

`harness.ts` read only app-boot's exports, so the table came back empty. An
empty table is a deliberate "no verdict" — a dsh whose table cannot be read must
never badge a plugin wrongly — and that is exactly what made the regression
quiet: the shop kept working, installs kept working, and the only loss was the
`harness-profile` badge for a plugin declaring a profile the harness does not
have.

The full-flow e2e caught it: against `0.2.2-rc.1`,
`[data-shop-incompatible-detail="harness-profile"]` never appeared on the peer
fixture (30 s timeout), while all eleven other cases passed.

## 3. The fix

`profileTemplatesExport` reads app-boot's export when it exists — every harness
through `0.2.1-rc.5`, unchanged — and otherwise resolves
`@deepseek-ai/dsh-official-bundles` with the same node_modules walk, starting
from app-boot's own directory, so the copy dsh itself loads is the one read.
A dsh with neither still yields an empty table: no verdict, never a wrong one.

## 4. Verification

- The full e2e suite against the real `0.2.2-rc.1` install: **12 of 12 pass**
  (before the fix, 11 of 12). The affected case is the peer/compatibility one,
  whose two badge assertions are the contract for this table.
- `harness.test.ts`: the fallback reads the bundles package when app-boot
  exports nothing, and app-boot's own export still wins when both exist.
- `repo-guards.test.ts` holds the new matrix entry equal to the e2e contract
  header, which now names `0.2.2-rc.1`.

## 5. The pin

`.github/workflows/plugin.yml` gains a `0.2.2-rc.1` leg on both platforms;
`0.2.1-rc.5` stays, because the e2e was written against it and a harness the
suite still answers for is a regression this matrix can catch. The note that
called `0.2.1-rc.5` npm's `latest` names `0.2.2-rc.1` now.

## 6. What 0.2.2-rc.1 changes for plugin authors, not for the shop

From its release notes: `tools.resolve`/`executable` and prompt-assembly
interfaces migrate; Session Projection registration becomes asynchronous; the
Git-worktree entry folds into "Change requests and worktrees". None of those
touch this package's host or client code — the shop is a page plus RPCs — and
the e2e above is what says so.
