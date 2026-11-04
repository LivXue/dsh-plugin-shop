# Market borrowings, fourth review — design

Status: **specified and built 2026-11-04** (branch `feat/spawn-scripts-batch`).
A fourth look at the three dsh plugin markets — with
[dsh-market/dsh-market](https://github.com/dsh-market/dsh-market)'s open
issues as the evidence — produced four items. The competitor citation says
where an idea came from; it is never the evidence. English only, per
convention.

The previous round is [2026-11-02-market-borrowings.md](2026-11-02-market-borrowings.md);
the items it declined (a permission verdict) stay declined, and the ones it
built (prepurchase facts, what-changed, rollback, favorites) are the baseline
this round starts from.

## 1. A spawn has no console and no one to answer a prompt

dsh can be started from a desktop launcher, where a console child paints a
window over the app — the class dsh-market's own bug #1094 reports from their
backup flow ("取 gh token 时弹出可见终端窗口"). Our two package-manager spawns,
`executor.ts` (the install CLI) and `prefetch.ts` (the download lane), passed
neither `windowsHide` nor a non-interactive git setting.

Two consequences, one visible and one silent:

- a console window can flash over the page on Windows;
- a dependency fetched from a private git remote stops at a username prompt,
  which no console is showing. The install then hangs until
  `INSTALL_TIMEOUT_MS` (15 minutes) and reports a **timeout** — the wrong
  cause, and the most expensive kind of wrong report.

`child-env.ts` owns the environment both spawns use: the caller's environment
with `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`. The second is the one
Windows needs — Git Credential Manager ships as Git for Windows' default helper
and ignores `GIT_TERMINAL_PROMPT`, opening its own window on a cache miss;
`never` still resolves a stored credential and fails fast instead of prompting.
Neither is a preference a caller may override — no prompt on this path can be
answered — and `CI=1` is deliberately NOT set, because pnpm's behaviour under it
differs and dsh's own manager already computes what it wants for its children.

Every spawn in the two modules passes `windowsHide: true`, the timeout path's
`taskkill` included: it runs from the same console-less dsh. The structural test
counts them per CALL, not once per file — the first version matched
`windowsHide: true` anywhere in the file, so `taskkill` sat through it.

## 2. An install-time script is a fact the sheet can state

pnpm 10 and newer refuse to run `preinstall` / `install` / `postinstall` unless
the profile allows it. A plugin that needs a build step therefore installs and
then does nothing — the npm twin of the github channel's `requires-build`
refusal, and a question a reader should be able to answer before installing.

The catalog carries `installScripts: true` when the manifest declares any of
the three, on both channels, from the same manifest the other declarations are
read from. It is a declaration, never a verdict: the row says the package asks
to run code at install time and that pnpm does not run it by default; nothing
here judges what the script does. `DECLARATIONS_RULE` goes to 5, so every
carried repository is re-read once.

The field is a registry-written boolean, so it is not counted in the payload
probe — the same reasoning `dependencies` records.

## 3. One press updates every row

dsh-market's issue #1074 asks for batch operations. A profile with forty
plugins otherwise needs forty presses. The Updatable section gains one action
that starts every row it can:

- a row already running, or whose uninstall is running or has landed, is
  skipped;
- a row that has already settled `done` is skipped: it can stay in `outdated`
  until the settle's re-read lands, and a second press in that window would
  re-send an install that completed;
- a row whose install the host would refuse (`refusesInstall`: a taken name,
  or harness peers dsh rejects) is skipped — pressing it could only produce the
  refusal the row already explains. This read the name-taken holder as absent
  until the review asked for the skip rules to be tested: the batch action
  passed `undefined` for it, so a name-conflicted row was started anyway;
- the rest are started together. The host serialises installs per profile
  (`executor.ts`'s profile queue), so starting them together queues rather than
  races; each row keeps its own record, so one failure leaves the others
  running.

The action is drawn only when there is more than one row.

## 4. The filter reads a deferred query

One filter pass over the live catalog's 14,167 entries costs 2–8 ms (measured
2026-11-04, this machine) — inside a frame today. The item is therefore not
about a fixed delay: the input paints from the immediate value, and the filter
and list read a deferred one, so React can interrupt them and drop intermediate
values when typing outruns the render. A fast machine sees results at once; a
slow one keeps a responsive field. No timer, so no latency floor.

## 5. Testing

- `child-env.test.ts`: the environment merge and the override; a structural
  guard that both spawn sites carry `windowsHide: true` and build their
  environment through `installEnv`.
- `npm-client.test.ts`: each of the three script names, a non-string value, a
  malformed `scripts`, an inherited key, and the candidate wiring.
- `repo-state.test.ts`: the round trip and the `true`-only shape;
  `repo-gate.test.ts`: not counted against the payload budget.
- `ShopTab.client.spec.tsx`: the detail row and its copy, its absence, the
  batch action starting every eligible row and offering nothing for one row.

## 6. Release

`installScripts` is a catalog field, so the shop's next version goes to `beta`
first; the other three items are host-internal or client-only and ride the same
release.
