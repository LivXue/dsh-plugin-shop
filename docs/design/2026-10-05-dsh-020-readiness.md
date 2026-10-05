# dsh 0.2 readiness — design

Status: **implemented 2026-10-05 on `feat/dsh-020-readiness`, not
released.** It changes what the host reads — the shop's own harness peer
ranges, which dsh judges at install and at boot — so it ships through
`beta` first. It amends `2026-09-01-harness-compatibility.md` §7, whose
table measures the self-check against the range the shop declared until
now. English only, per convention.

npm moved both `latest` and `next` to dsh 0.2.0-rc.2 on 2026-09-29; `alpha`
is 0.2.1-alpha.1. dsh has never published a version without a prerelease
suffix: all 30 carry one.

## 1. What 0.2 changed under the shop

Measured by diffing the installed 0.1.7-rc.2 and 0.2.0-rc.2 trees, package
by package.

- **Nothing the shop calls.** Every harness package moved to 0.2.0-rc.2 in
  lockstep, and `dsh-plugin-manager`, `dsh-typert-loader`,
  `dsh-typert-registry`, `dsh-typert-protocol`, `dsh-home-paths`,
  `dsh-client-modules`, `dsh-client-ui-settings`, `dsh-client-ui-slots` and
  `dsh-client-locale` are byte-identical apart from the version in their
  manifests. `dsh-app-boot` differs by one line: `OPTIONAL_BUNDLES` gains
  `@deepseek-ai/dsh-experimental-schedule-bundle`; its exports are
  unchanged. `cordis` (4.0.4) and `cordis-plugin-include` (1.0.9) did not
  move.
- **What did change is outside the shop's reach:** the bundles'
  composition (telemetry, Desktop product analytics, and the schedule rows,
  which moved into that optional bundle), the plugin inventory's cards,
  dsh's own Plugins page, and the CLI, which now lets the Desktop app's
  bundled `dsh` manage the desktop profile. 0.2 adds five packages and
  removes none.

So the shop needed no product code change. It needed two other changes,
both found by running its suite on 0.2.0-rc.2.

## 2. dsh skipped the shop

From 0.1.7-rc.1, dsh judges a plugin's `@deepseek-ai/dsh` and
`@deepseek-ai/dsh-*` peers against its runtime version, optional peers
included (`2026-09-26-dsh-017-readiness.md` B1.1). A refused plugin is not
installed. An installed one is skipped at boot: `loadProfile` lists it in
`skippedBundles`, the CLI writes one line to stderr —
`dsh: skipping profile bundle "dsh-plugin-shop": …` — and the web UI simply
has no shop tab.

The shop declared `^0.1.1-rc.2` for `dsh-app-boot`, `dsh-home-paths` and
`dsh-typert-protocol`. On 0.x a caret stops before the next minor, so the
range meant `<0.2.0-0` and refused every 0.2 build. Measured on a real
profile with 0.2.0-rc.2's own `loadProfileDirectory`: it loaded `dsh-base`
and `dsh-web-app` and skipped `dsh-plugin-shop`. Everyone who installed or
upgraded dsh from 2026-09-29 on lost the shop at boot, and a shop that never
loads cannot offer its own update.

**The range is now `>=0.1.1-rc.2 <0.3.0-0`.**

- The floor is unchanged. The workspace still compiles against 0.1.1-rc.2,
  which is the claim the floor makes.
- The ceiling is the next minor line, as the caret's was. On 0.x that is
  semver's breaking move.
- The ceiling reaches past what CI pins, deliberately. A ceiling of
  `<0.2.1-0` would refuse 0.2.1-alpha.1 today, and each later patch build
  the day it ships, and dsh would skip the shop until it was republished.
  Patch builds are not safe by semver alone — 0.2.1-alpha.1's notes list a
  breaking change, the removal of the `./invariant` exports, which the shop
  does not use — so the suite was run on 0.2.1-alpha.1 too. Both exit
  criteria passed.
- The shop's own load-time check (`2026-09-01-harness-compatibility.md` §7)
  reads the same ranges, so it stops warning on 0.2 for the same reason dsh
  stops refusing.

It is spelled as one comparator set rather than `^0.1.1-rc.2 || ^0.2.0-0`.
Both admit the same versions under `includePrerelease`, but the second
also admits 0.2.0 prereleases in strict mode, through its own comparator.
The self-check's test against a regression to strict mode reads its
installed versions — 0.2.0-rc.2 now — against these ranges, and would stop
discriminating.

`repo-guards.test.ts` now holds the shop's harness peers to admitting every
harness `plugin.yml` pins, by dsh's rule. A pinned harness the shop refuses
fails there, naming the peer, instead of failing that leg's `beforeAll` on
dsh's refusal.

## 3. A new first-run notice covered the page

With the range widened, eight of the e2e's nine cases still failed on
0.2.0-rc.2, all behind one dialog, which `expectNoDialog` named: 预览版说明.
0.2.0-rc.1 replaced the 内测声明 notice with it and moved its
acknowledgement from `2026-08-13.1` to `2026-09-28.1`. dsh raises the notice
unless `settings.yaml` holds exactly the version its build carries, and the
e2e and the README screenshot script both seeded 0.1's.

No single value serves every harness: 0.1.7-rc.2 and 0.2.0-rc.2 read the
same section and compare different versions. So the value follows the
harness. `welcomeNoticeVersion` (`tests/fixtures/onboarding.ts`) maps a dsh
version to the one its build compares, read from each build's own
constant, and both callers ask the dsh they are about to boot. The section
itself moved at 0.1.7, from `ui-onboarding` to `ui-settings-general`, and
needs no branch: dsh-settings maps the removed section onto the new entry.

The next bump will be caught the way this one was: `expectNoDialog` names
the dialog instead of letting a click time out.

## 4. What dsh 0.2 refuses in the catalog

Measured on the live catalog built 2026-10-05T07:04Z, with 0.2.0-rc.2's own
rule: of the 3,244 npm entries that declare harness peers, dsh refuses
1,425 (43.9%), against 647 (19.9%) on 0.1.7-rc.2. The shop already disables
Install on those cards and shows the exemption command beside the button
(B1.3 of the 0.1.7 readiness design), and nothing here changes that. The
figure is recorded because it is the shelf a 0.2 reader sees.

## Testing

- **Unit.** `peers.test.ts`: `DECLARED` follows the manifest, `INSTALLED`
  is re-measured on 0.2.0-rc.2, the floor the build compiles against stays
  admitted, and the minor-line move is now 0.3. `onboarding.test.ts`: the
  notice version for each harness, with 0.2.0-rc.1 as the boundary.
- **repo-guards.** The e2e header names the three pinned harnesses, and the
  shop's harness peers admit each of them by dsh's rule.
- **The package suite on every pinned harness,** both exit criteria
  required, and the harness each run booted checked from inside the run by
  `DSH_SHOP_EXPECT_DSH`: 0.1.5-rc.3, 0.1.7-rc.2 and 0.2.0-rc.2, each from a
  private prefix.

## Release

`plugin.yml` gains `0.2.0-rc.2` as a third harness, so each platform runs
three. 0.1.5-rc.3, `latest` until 0.2, is the only leg left on the CLI path.
0.1.7-rc.2 runs the same plugin-manager code as 0.2.0-rc.2 behind the older
settings UI, and stays because readers are still on it.

The version goes through `beta` (`0.8.5-beta.0`) and is installed by hand
on a 0.2.0-rc.2 profile before promotion. Three things wait for the
promotion commit, because each needs a published shop that 0.2 loads:

- the README install pins;
- the six screenshots, which the script shoots from the published build on
  the dsh on PATH — 0.2.0-rc.2 today, which skips 0.8.4;
- the READMEs' "Settings → Plugins → Plugin shop". 0.1.7 renamed that
  section 内置插件 / Built-in plugins, and 0.2.0-rc.2 keeps the name. B0.2 of
  `2026-09-26-dsh-017-readiness.md` deferred the change until such a dsh
  reached `latest`, to land together with the screenshots.

A reader already on 0.2 has a shop that dsh skips, and a skipped shop cannot
offer its own update. They have to reinstall it once, with
`dsh plugin --profile web add dsh-plugin-shop@<version>`, and the release
notes must say so.

Not taken here: 0.2's Desktop-bundled `dsh` can manage the desktop profile,
which may let B3's desktop refusals relax where dsh offers no plugin
manager service. That is a separate change.
