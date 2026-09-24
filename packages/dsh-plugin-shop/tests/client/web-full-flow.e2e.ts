// @vitest-environment node
/**
 * The P2 exit criterion (spec §12): the full flow in a web profile. A REAL
 * `dsh --profile web` boots against a temporary DSH_HOME, the shop package
 * and the hello fixture are installed with the REAL `dsh plugin --profile web
 * add file:…` path, and a real chromium walks the settings modal to the shop
 * tab: the fixture entry renders unclaimed, the §9.3 acknowledgement gate
 * shows the spec text, and the install runs to its terminal state through the
 * once-per-second status poll.
 *
 * Install-target decision (documented in the task report): no usable
 * dsh.bundle-declaring package exists on npm for a REAL successful install —
 * the only candidate, dsh-plugin-shop@0.1.0, is a stale pre-tab artifact.
 * The fixture entry therefore names `dsh-e2e-fixture-plugin@1.0.0`, which
 * does NOT exist on npm: the browser install fails with REAL pnpm stderr, and
 * the failed view's recovery hint (`pnpm failed in the profile. Run: …`) is
 * what proves the installStatus poll ran to a terminal state end to end. The
 * "a bundle actually lands" half of the flow is proven at the manifest level
 * with the file:-installed hello fixture (the P1 pattern) — both bundles are
 * asserted below, and the failed fixture name is asserted absent.
 *
 * The hot-mount scenarios (market borrowings §4, Task 18) ride the same
 * composition: a local npm registry (tests/fixtures/local-registry.ts) serves
 * four live fixtures — `dsh-shop-e2e-live` (a plain `- id:` / `name:` patch,
 * the only form the hot tree can mount), `dsh-shop-e2e-config` (a config-row
 * patch, valid for the bundle layer but not hot-mountable), `dsh-shop-e2e-peer`
 * (the same hot-mountable patch as the live fixture, plus peers and a
 * `dsh.compatibility` declaration this harness does not meet — see
 * tests/fixtures/catalog-server.ts for the exact split), and
 * `dsh-shop-e2e-client` (the same hot-mountable patch again, plus a
 * `dsh.client` declaration — the other three are host-only, so none of them
 * can prove the reload path, which is exactly the blind spot the 2026-09-11
 * activation-model reports came through). The profile's .npmrc points at the
 * registry once the profile exists (pnpm, unlike npm, never reads the
 * registry from env vars), so gateway-spawned pnpm resolves those installs
 * locally while the beforeAll `file:` installs keep the real registry. The
 * live install must report done with activation `live` and the entry must
 * appear in the loader inventory (the strict liveness read — a route-based
 * probe is unavailable, see the fixture's index.js comment); the config
 * install must report done with the localized restart reason and the §8
 * restart offer instead; the peer install proves the harness-compatibility
 * badge renders for a genuinely absent declared peer and for both halves of
 * an unmet `dsh.compatibility`, that a peer the browser's module table seeds
 * is never named — on that card, or as a badge on the seed-only live card —
 * and that the install, warn never block, still reaches done; the client install must
 * report done with activation `restart` and the client-half reason, and must
 * NOT offer the reload button — a hot mount puts no client half in the boot
 * graph, so a reload would fetch nothing. (That last sentence read the other
 * way round until the 2026-09-11 activation model measured it; the reload
 * path it described is the one this fixture disproved.)
 *
 * Both restart-offering flows above go through `expectRestartOffer`, which
 * reads the offer the HOST allows rather than assuming the POSIX one: on
 * Windows `shop/restart` is refused before anything is torn down, so the card
 * carries that refusal's notice in the button's place.
 *
 * Skipped unless the machine has both the real `dsh` CLI on PATH and a
 * playwright chromium installed (CI installs both; see .github/workflows).
 *
 * plugin.yml runs this on BOTH ubuntu-latest and windows-latest (its `test`
 * job is a matrix over the two), with `DSH_SHOP_REQUIRE_E2E` set on each, so
 * every platform branch below is executed by CI rather than by hand. It was
 * not always: until 2026-09-14 the only automated leg was ubuntu, the win32
 * arms were asserted by nothing, and the divergence they now pin was found
 * as an opaque 10s timeout on a host behaving exactly as designed.
 *
 * Written against harness 0.1.5-rc.3 — the version `.github/workflows/plugin.yml`
 * installs globally, and therefore the one every selector below was measured
 * on. The two are held together mechanically: `repo-guards.test.ts` fails the
 * build if this line and that pin name different versions — the pin has moved
 * twice already, and both times the mismatch surfaced as an opaque timeout
 * rather than as a diff someone could read.
 *
 * Pinned selectors (all verified against the live app, zh-CN):
 * - the app root frame: `[class*="frame"]` — the frame class is CSS-module
 *   hashed, and the live app's root element carries a class containing `frame`
 * - the two first-run dialogs (内测声明, then 添加一个 API Key 开始使用) are NOT
 *   selectors this suite uses any more: `seedOnboarding` turns both off before
 *   dsh boots, because they mask the page until dismissed and dismissing them
 *   is a race no timeout wins reliably. `expectNoDialog` is the tripwire.
 * - settings trigger: `page.getByRole('button', { name: '设置', exact: true })`
 * - settings modal: `page.getByRole('dialog', { name: '设置' })`
 * - plugins section: `dialog.getByRole('button', { name: '插件', exact: true })`
 * - shop tab: `dialog.getByRole('tab', { name: '插件商店' })` — the panel
 *   renders lazily, only after the tab is activated
 * - shop panel + entry: `[data-shop-tab]`, `[data-shop-entry=<name>]`
 * - install gate: `[data-shop-confirm]`; failure view: 安装失败 + the detail
 *   paragraph; state lines are plain text (no data attributes)
 * - harness compatibility: `[data-shop-blocker]` (badge, on both the
 *   catalog card and the installed row) and one
 *   `[data-shop-incompatible-detail="<kind>"]` line per blocker —
 *   `missing-peers` (a declared peer neither the host nor the browser's
 *   module table provides), `harness-range` and `harness-profile` (an unmet
 *   half of `dsh.compatibility`); there is no `[data-shop-install-done]` —
 *   the done view below is the only terminal signal
 * - install done view: `[data-shop-restart-notice]` always renders (the
 *   no-restart copy for activation `live`, the reload copy for `reload`, or
 *   the host's reason code localized under `restart`), alongside the offer
 *   that matches the activation: the §4 reload panel `[data-shop-reload]`,
 *   whose value names which change made the page stale (a boot-composition
 *   change only — a hot mount reports `restart`, see the client-half spec),
 *   (activation `reload`), the §8 offer `[data-shop-restart]` (activation
 *   `restart` && the host can restart), or `[data-shop-restart-disabled]`
 *   (activation `restart` && the host cannot restart); `live` offers neither
 * - uninstall: `[data-shop-uninstall]`; done view `[data-shop-uninstall-done]`
 * - loader inventory tab: `dialog.getByRole('tab', { name: '插件列表' })`, then
 *   `expandGlobalPlane` — the tab splits into 会话插件 (the selected agent
 *   preset's composition rows) and 全局插件 (the Loader entries), and the second
 *   is COLLAPSED whenever a preset roster exists. The `include:` prefix on the
 *   entry id is what separates the two planes, and it is the ONLY thing that
 *   does: a preset row's id comes from `compositionInventory()` rather than
 *   `pluginEntryId()`, but it renders the same card through the same
 *   `PluginCard`, phase dot included once its roster is mounted. So a Loader
 *   card is ABSENT rather than hidden while the plane is shut — but the preset
 *   plane above it stays open, and its cards keep answering an unprefixed
 *   `[data-plugin-entry]` and every dot selector.
 *   Each Loader card is `[data-plugin-entry=<entryId>]`, and its enabled tag
 *   and phase dot are read through the ACCESSIBILITY contract: the tag through
 *   the card button's `aria-label` (`<title>, <entryId>, 已启用`) and the dot
 *   through `role=img` named by the localized phase (运行中 for active; the
 *   inner `StateDot` is `aria-hidden` and contributes nothing).
 *   NOT through the tag's and dot's own data attributes. Those belong to the
 *   design system rather than to the inventory, and they have now moved twice
 *   underneath this file — `data-enabled=true`, then `data-kind=enabled` and
 *   `data-phase=active` at 0.1.2-rc.1, then `data-tone=success` and
 *   `data-state=done` at 0.1.5-rc.1, when `StateTag`/`PhaseDot` were refactored
 *   onto the shared `Tag`/`StateDot` primitives — each move costing a debugging
 *   round for a rename that changed nothing a user can see. The accessible
 *   names are also the sharper read of the two: `PHASE_DOT_STATES` folds
 *   `loading` and `unloading` onto one `data-state=ongoing`, and it is emitted
 *   by a `StateDot` that eleven harness packages render (measured 2026-09-10,
 *   this one among them), where the label is 1:1 with the phase and is the
 *   inventory's own.
 * - settings modal close: `.VOzbGW_close` (visually-hidden label 关闭)
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshCommand, resolveDshScript } from '../../src/host/dsh-cli.ts'
import { startInstall } from '../../src/host/executor.ts'

/** Expand the 插件列表 tab's 全局插件 section, which holds the Loader entries.
 *
 * Harness 0.1.2-rc.1 split that tab in two — agent presets first, then the
 * global plane — and collapses the global plane whenever a preset roster is
 * composed, which the `web` profile always has. Both halves survive unchanged
 * into 0.1.5-rc.1. A collapsed section renders no `<li>`, so a Loader card is
 * absent rather than hidden: every assertion below this point either times out
 * or, worse, passes vacuously. The two dialog-scoped `count()).toBe(0)`
 * "nothing is live" checks are exactly that hazard — an empty collapsed
 * section satisfies them for free. (The other `count()).toBe(0)` assertions in
 * this file are scoped to a shop card, which this disclosure cannot empty.)
 *
 * What it must NOT be guarded with is a bare dot or entry selector: the preset
 * plane is open by default and renders both, so `[data-plugin-entry]` and
 * `[data-state]` are satisfied with the Loader plane still shut. Anything
 * downstream that needs "the Loader snapshot rendered" already has it from
 * this helper's postcondition and must not re-derive it more weakly.
 *
 * Expanded through its own disclosure and NOT the 搜索插件 box: search also
 * FILTERS the list, which would make those same "nothing is live" assertions
 * vacuous in the other direction.
 *
 * The postcondition waits for an `include:`-prefixed entry rather than for
 * `aria-expanded`, because that prefix is what distinguishes a Loader entry
 * from a preset composition row — it proves the right section rendered, not
 * merely that a button was clicked. The disclosure itself is waited for
 * explicitly: it renders after the tab's content, and Playwright's implicit
 * wait on `click()` would hide that ordering from a reader.
 */
async function expandGlobalPlane(dialog: Locator): Promise<void> {
  const disclosure = dialog.getByRole('button', { name: /全局插件/ }).first()
  await disclosure.waitFor({ state: 'visible', timeout: 15_000 })
  if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click()
  await dialog.locator('[data-plugin-entry^="include:"]').first()
    .waitFor({ state: 'visible', timeout: 15_000 })
}
import { zh } from '../../src/client/locales.ts'
import { startCatalogServer, type CatalogServer } from '../fixtures/catalog-server.ts'
import { startLocalRegistry, type LocalRegistry } from '../fixtures/local-registry.ts'

/**
 * Stop dsh and everything it spawned.
 *
 * Two mechanisms, because a process group is a POSIX idea. On POSIX the spawn
 * is `detached`, so a negative pid signals the whole group and the gateway's
 * pnpm children go with it. Windows has no group to signal: `process.kill`
 * with a negative pid throws there, and the fallback this used to carry —
 * `child.kill()` — terminates dsh alone and orphans the node and pnpm
 * processes it started. Those orphans hold handles under `tmpHome`, which is
 * what turns the `rmSync` in `afterAll` into an EBUSY that fails a file whose
 * every assertion passed. `taskkill /T` is the Windows spelling of "and its
 * descendants", and `/F` because a console application that is not pumping
 * messages will not answer the polite request.
 *
 * Neither call is allowed to throw: teardown runs after a failure too, and a
 * dead pid must not replace the real failure with a confusing one.
 */
function stopProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM') // the whole process group
  } catch {
    // No group (dsh already exited, or never started one): fall back to the
    // process itself, and accept that it too may already be reaped.
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone. Nothing to stop, and nothing to report.
    }
  }
}

/**
 * Turn both onboarding dialogs off before dsh boots, rather than clicking
 * through them.
 *
 * The same recipe `scripts/shoot-readme-screenshots.ts` uses, and for a reason
 * this file learned the hard way: a configured provider suppresses "add an API
 * key to get started", and `welcomeNoticeVersion` suppresses the 内测声明
 * notice. The key is an obvious placeholder — nothing here ever sends a model
 * request, and the profile is a temp directory removed in `afterAll`.
 *
 * What this replaces is what made CI red on 2026-09-14 (run 34858951558, five
 * of six cases): the first case used to dismiss the API-key dialog behind a 5s
 * `waitFor` whose `catch` read a timeout as "the prompt is not present". That
 * cannot be told apart from "the prompt has not rendered yet", and on a loaded
 * runner it is the second: the escape hatch gives up, the mask arrives a moment
 * later, and the next click on 设置 spends its full 15s being intercepted by an
 * `aria-hidden` overlay. Every later case then fails too, because the dialog
 * each one reopens was never opened. The screenshot script's docblock records
 * the identical lesson from the identical mistake.
 *
 * Both halves of this are load-bearing, and both were measured rather than
 * assumed (2026-09-14, dsh 0.1.5-rc.1):
 *
 * - The credentials file is REQUIRED, not decoration. The screenshot script's
 *   comment attributes the suppression to "a configured provider"; that is
 *   incomplete. Removing this write and keeping `agent-default-model` raises
 *   添加一个 API Key 开始使用 anyway — what suppresses the dialog is a provider
 *   whose credential reference RESOLVES. `expectNoDialog` is how that was
 *   measured: it named the dialog instead of leaving a timeout to interpret.
 * - 0600, and a chmod AFTER the write, because `writeFileSync`'s `mode`
 *   applies only when it CREATES the file. At 0644 dsh does not merely warn:
 *   `assertOwnerOnly` fails the whole plugin tree — "credentials-local: … is
 *   readable beyond its owner (mode 644)" — and nothing boots.
 *
 * On Windows the mode is moot and the chmod is a no-op there: dsh's own check
 * opens with `if (process.platform === "win32") return`. Left unconditional
 * anyway, because a POSIX-only `if` here would be a second platform branch
 * guarding something Windows already ignores.
 */
function seedOnboarding(home: string): void {
  writeFileSync(join(home, 'settings.yaml'), [
    'agent-default-model:',
    '  provider: deepseek-official',
    '  model: deepseek-v4-pro',
    'ui-onboarding:',
    '  welcomeNoticeVersion: 2026-08-13.1',
    '',
  ].join('\n'))
  const credentials = join(home, '.credentials.yaml')
  writeFileSync(credentials,
    'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-e2e-placeholder-not-a-key\n', { mode: 0o600 })
  chmodSync(credentials, 0o600)
}

/**
 * Refuse to continue while any dialog covers the page.
 *
 * The tripwire for `seedOnboarding`: a seed that stops working (a dsh release
 * renaming a settings key, say) fails HERE, naming the dialog, instead of as an
 * opaque click timeout in whichever case happens to run first. Checked once the
 * app's own chrome is up, which is when a boot-raised dialog is up too.
 *
 * It is a tripwire and not a guarantee — a dialog raised after an async check
 * could still arrive later — so the seed, not this, is what makes the suite
 * deterministic. Nothing here dismisses anything: a dismissal is per page load
 * and would quietly re-introduce the race it exists to remove.
 */
async function expectNoDialog(app: Page): Promise<void> {
  const dialogs = app.locator('[role="dialog"]')
  for (let i = 0; i < await dialogs.count(); i += 1) {
    const one = dialogs.nth(i)
    if (!await one.isVisible().catch(() => false)) continue
    const label = (await one.getAttribute('aria-label'))
      ?? ((await one.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 80)
    throw new Error(`a dialog is covering the page before the flow starts: ${JSON.stringify(label)}`)
  }
}

/**
 * A port to boot the web profile on, held only long enough to learn its
 * number.
 *
 * `--port 0` would be simpler and is what this suite used to pass, but the
 * shop refuses a restart under it — the OS hands the NEW process a different
 * port and the browser would be stranded on a dead origin — and the host now
 * ADVERTISES that refusal in `version().restartBlocked` rather than raising it
 * only when the button is pressed. Booting that way would therefore make every
 * restart-required install below render the port-zero notice, and the suite
 * would stop exercising the restart offer altogether. It would also be the
 * wrong thing to assert: the offer this file used to wait for was one this
 * very composition guaranteed the host would refuse.
 *
 * Bound on the unspecified address, not loopback, so the reservation covers
 * the interfaces dsh may bind. A collision in the gap between close and dsh's
 * own bind fails at boot, loudly, with dsh's stdout and stderr attached.
 */
async function reservePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, resolve)
  })
  const address = probe.address()
  await new Promise<void>(resolve => { probe.close(() => { resolve() }) })
  if (address === null || typeof address === 'string') {
    throw new Error('could not reserve a port for the dsh web profile')
  }
  return address.port
}

/**
 * The §8 activation offer for a restart-required install, as the HOST's own
 * contract decides it.
 *
 * Written once and called from both flows that reach it. Two copies of this
 * branch existed and had already drifted on the single fact they both explain
 * — one named the composition that makes it safe, the other claimed the
 * platform decides alone — which is the defect `ActivationOffer`'s own
 * docblock describes on the product side of the same rule.
 *
 * The version gate is load-bearing and is why this takes the dialog as well as
 * the card. The client treats the advisory version check as fail-open
 * (`selfVersion?.restartBlocked ?? null`), so a bare wait for
 * `[data-shop-restart]` is satisfied by that default whether the host answered
 * `null`, answered nothing, or threw. `[data-shop-version]` renders if and
 * only if the check RESOLVED, so waiting on it first makes both branches
 * claims about the host rather than about a default.
 *
 * The win32 branch asserts the notice's TEXT, not merely its presence. Asking
 * only "did some notice render" is what let the shop tell every Windows reader
 * that dsh runs as a systemd service and to set an override the platform gate
 * — first of the three and the only one with no override — could never reach.
 */
async function expectRestartOffer(dialog: Locator, card: Locator): Promise<void> {
  await dialog.locator('[data-shop-version]').waitFor({ state: 'visible', timeout: 30_000 })
  if (process.platform === 'win32') {
    const blocked = card.locator('[data-shop-restart-disabled]')
    await blocked.waitFor({ state: 'visible', timeout: 10_000 })
    expect(await blocked.textContent()).toBe(zh.restartBlockedWindowsNotice)
    expect(await card.locator('[data-shop-restart]').count()).toBe(0)
  } else {
    await card.locator('[data-shop-restart]').waitFor({ state: 'visible', timeout: 10_000 })
    // The other direction, which only this branch can check and which CI is
    // the sole runner of: a regression rendering both the offer and a notice
    // would otherwise pass on the one platform every merge goes through.
    expect(await card.locator('[data-shop-restart-disabled]').count()).toBe(0)
  }
}

/** Read the browser's colours, including colour-mix and translucent ancestor
 * backgrounds. These controls use solid fills; stop at the first opaque one. */
async function readPill(pill: Locator) {
  return pill.evaluate(el => {
    type Rgba = [number, number, number, number]
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('Canvas is required to resolve CSS colours')
    const rgba = (value: string): Rgba => {
      if (!CSS.supports('color', value)) throw new Error(`Unresolved colour: ${value}`)
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      if (r === undefined || g === undefined || b === undefined || a === undefined) throw new Error('Missing pixel')
      return [r / 255, g / 255, b / 255, a / 255]
    }
    const over = (fg: Rgba, bg: Rgba): Rgba => [
      fg[0] * fg[3] + bg[0] * (1 - fg[3]),
      fg[1] * fg[3] + bg[1] * (1 - fg[3]),
      fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1,
    ]
    const luminance = ([r, g, b]: Rgba): number => {
      const linear = (v: number): number => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      return linear(r) * 0.2126 + linear(g) * 0.7152 + linear(b) * 0.0722
    }
    const layers: Rgba[] = []
    for (let node: Element | null = el; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.backgroundImage !== 'none') throw new Error('Contrast measurement requires a solid background')
      const colour = rgba(style.backgroundColor)
      layers.push(colour)
      if (colour[3] === 1) break
    }
    let background: Rgba = [1, 1, 1, 1]
    for (const layer of layers.reverse()) background = over(layer, background)
    const style = getComputedStyle(el)
    const fg = luminance(over(rgba(style.color), background))
    const bg = luminance(background)
    const read = (name: string): Rgba | null => {
      const value = style.getPropertyValue(name).trim()
      return value === '' ? null : rgba(value)
    }
    // The incompatible filter holds a switch track (and the track a knob);
    // the eight pills hold neither. Found by structure rather than class:
    // class names are content-hashed at bundle time.
    const trackEl = el.firstElementChild
    const knobEl = trackEl?.firstElementChild ?? null
    const trackStyle = trackEl === null ? null : getComputedStyle(trackEl)
    return {
      contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
      width: el.getBoundingClientRect().width,
      border: rgba(style.borderTopColor),
      ring: style.boxShadow,
      // Each is null on the control that does not set it — the pills have no
      // `--switch-hue`, the filter left the hue table when it stopped being a
      // pill — and a custom property has no inherited value to fall back on
      // here, so an unguarded read hands rgba() the empty string and throws.
      hue: read('--category-hue'),
      switchHue: read('--switch-hue'),
      track: trackStyle === null ? null : {
        border: rgba(trackStyle.borderTopColor),
        width: trackEl?.getBoundingClientRect().width ?? 0,
        height: trackEl?.getBoundingClientRect().height ?? 0,
      },
      // 'none' while off; a matrix once the knob has slid.
      knob: knobEl === null ? null : getComputedStyle(knobEl).transform,
    }
  })
}

/** Exercise real hover/click states under both harness theme palettes. */
async function checkCategoryBar(app: Page, dialog: Locator): Promise<void> {
  const all = dialog.locator('[data-shop-category-all]')
  const tool = dialog.locator('[data-shop-category-tab="tool"]')
  const categories = ['tool', 'provider', 'ui', 'workflow', 'integration', 'theme', 'other']
  const tabs = [
    { name: 'all', locator: all },
    ...categories.map(name => ({ name, locator: dialog.locator(`[data-shop-category-tab="${name}"]`) })),
    { name: 'installed', locator: dialog.locator('[data-shop-category-installed]') },
  ]
  const originalTheme = await app.evaluate(() => document.body.getAttribute('data-ds-dark-theme'))
  const check = async (pill: Locator, label: string, selected: boolean, width?: number): Promise<void> => {
    const measured = await readPill(pill)
    expect(measured.contrast, `${label}: text contrast`).toBeGreaterThanOrEqual(4.5)
    if (width !== undefined) expect(measured.width, `${label}: width changed`).toBe(width)
    if (selected) {
      // The border carries category identity; text may blend with the theme.
      expect(measured.border, `${label}: selected border lost its hue`).toEqual(measured.hue)
      expect(measured.ring, `${label}: selected ring missing`).toContain('inset')
    }
  }
  try {
    for (const theme of ['light', 'dark']) {
      await app.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), theme === 'dark')
      for (const { name, locator } of tabs) {
        await (name === 'all' ? tool : all).click()
        await app.mouse.move(0, 0)
        const { width } = await readPill(locator)
        await locator.hover()
        await check(locator, `${theme}/${name}/hover`, false, width)
        await locator.click()
        expect(await locator.getAttribute('aria-pressed')).toBe('true')
        await check(locator, `${theme}/${name}/selected-hover`, true, width)
        await app.mouse.move(0, 0)
        await check(locator, `${theme}/${name}/selected`, true, width)
      }
      // Installed intentionally omits this modifier. Return to the shelf and
      // restore its off state afterwards. This one is a switch, not a pill, so
      // `check` does not apply: it has no border to carry a hue and no inset
      // ring. What it has instead is a track, and a label that no longer
      // changes — so width invariance becomes assertable here, where the old
      // flipping label made it a documented exception.
      await all.click()
      const filter = dialog.locator('[data-shop-hide-incompatible]')
      // `.switch` transitions its fill and border over 120ms and a click
      // returns long before that lands, so a read taken at t=0 still carries
      // the colour the track is LEAVING — for the on-hover read below, the
      // hover mix, which is indistinguishable from the scoping defect that
      // assertion exists to catch. Waiting on the animations themselves is
      // exact where a slept millisecond count is a guess that gets loosened
      // the first time CI is slow.
      const settled = async () => {
        await filter.evaluate(async el => {
          await Promise.all(el.getAnimations({ subtree: true })
            .map(animation => animation.finished.catch(() => undefined)))
        })
        return readPill(filter)
      }
      await app.mouse.move(0, 0)
      const off = await settled()
      expect(off.contrast, `${theme}/filter/off: text contrast`).toBeGreaterThanOrEqual(4.5)
      expect(off.knob, `${theme}/filter/off: knob has already slid`).toBe('none')
      expect(off.track, `${theme}/filter: no switch track`).not.toBeNull()
      expect(off.switchHue, `${theme}/filter: no --switch-hue`).not.toBeNull()
      expect(off.track?.border, `${theme}/filter/off: an off track wearing the hue`).not.toEqual(off.switchHue)

      await filter.hover()
      const hovered = await settled()
      expect(hovered.contrast, `${theme}/filter/hover: text contrast`).toBeGreaterThanOrEqual(4.5)
      expect(hovered.width, `${theme}/filter/hover: width changed`).toBe(off.width)

      await filter.click()
      const onHovered = await settled()
      expect(onHovered.contrast, `${theme}/filter/on-hover: text contrast`).toBeGreaterThanOrEqual(4.5)
      expect(onHovered.width, `${theme}/filter/on-hover: width changed`).toBe(off.width)
      // The pointer has not moved since the click, which is exactly when a
      // reader looks for confirmation — and `:hover .switch` outranks
      // `.switchOn` by a class, so an unscoped hover rule would take the hue
      // straight back off the border at that moment.
      expect(onHovered.track?.border, `${theme}/filter/on-hover: hover stripped the hue`).toEqual(onHovered.switchHue)

      await app.mouse.move(0, 0)
      const on = await settled()
      expect(on.contrast, `${theme}/filter/on: text contrast`).toBeGreaterThanOrEqual(4.5)
      expect(on.width, `${theme}/filter/on: width changed`).toBe(off.width)
      expect(on.knob, `${theme}/filter/on: knob did not slide`).not.toBe('none')
      expect(on.track?.border, `${theme}/filter/on: track lost its hue`).toEqual(on.switchHue)
      // One geometry for both wearers of `.switch`, whatever element it is on.
      expect(on.track?.width, `${theme}/filter/on: track width`).toBe(32)
      expect(on.track?.height, `${theme}/filter/on: track height`).toBe(18)

      await filter.click()
    }
  } finally {
    await app.evaluate(value => {
      if (value === null) document.body.removeAttribute('data-ds-dark-theme')
      else document.body.setAttribute('data-ds-dark-theme', value)
    }, originalTheme)
    await all.click()
    await app.mouse.move(0, 0)
  }
}

// The test needs the real dsh executable on PATH and a playwright chromium.
// CI installs both (the dsh CLI in the workflow, chromium by the
// `playwright install chromium` step); the skip fires only on machines that
// never set them up, so the P2 exit criterion still gates the CI run.
// The probe goes through the SAME resolution the executor uses rather than
// `spawnSync('dsh', …)` directly — the identical correction `real-install.ts`
// already carries, which this file was missed by. npm installs the CLI as
// `dsh`, `dsh.cmd` and `dsh.ps1` with no `.exe`, and libuv resolves a bare
// name against `.com`/`.exe` only, so `spawnSync('dsh', …)` is ENOENT on every
// Windows machine. Measured 2026-09-07 on Windows 11 with a working
// `dsh 0.1.2-rc.1`: the bare form reports `status: null, error: ENOENT` while
// the resolved form reports `status: 0`. `hasDsh` was therefore false there
// and the P2 exit criterion — the one test that walks the real shop UI —
// skipped itself on the only platform whose bugs CI cannot see.
const hasDsh = (() => {
  const { command, args } = dshCommand({
    dshBin: 'dsh',
    args: ['--version'],
    platform: process.platform,
    execPath: process.execPath,
    script: resolveDshScript(
      { exists: path => existsSync(path), read: path => readFileSync(path, 'utf8') },
      { argv1: process.argv[1], path: process.env.PATH },
    ),
  })
  try {
    return spawnSync(command, args, { stdio: 'ignore' }).status === 0
  } catch {
    // spawnSync throws rather than reporting when the binary cannot be started
    // at all (a Windows .cmd shim throws EINVAL); either way the CLI is
    // unusable from here and the case skips.
    return false
  }
})()

const hasChromium = existsSync(chromium.executablePath())

/** Keep fixture traffic local even on builders that route every HTTP request
 * through a corporate proxy. pnpm honours both spellings depending on its
 * transport; preserve the builder's existing bypass list alongside ours. */
function localRegistryEnv(): NodeJS.ProcessEnv {
  const noProxy = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost']
    .filter((value): value is string => value !== undefined && value !== '')
    .join(',')
  return { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy }
}

/**
 * When set, a skipped exit-criterion case is a FAILURE rather than a silent
 * pass.
 *
 * Both this file and web-full-flow.e2e.ts probe for a working `dsh` and skip
 * when they cannot find one. That is right locally — not every machine has the
 * harness installed — and wrong in CI, where these two files ARE the P1 and P2
 * exit criteria. Reproduced 2026-09-05: with `dsh` hidden from PATH the run
 * reported `1 skipped` and **exited 0**, so a green CI run was not evidence
 * that either criterion had executed.
 *
 * plugin.yml sets it, because that workflow installs the harness precisely so
 * these can run. A machine without `dsh` still skips.
 */
const requireE2E = process.env.DSH_SHOP_REQUIRE_E2E === '1'

describe('the P2 exit criterion is allowed to skip only where that is honest', () => {
  it('has the harness and the browser it needs, when the environment says it must', () => {
    expect(
      !requireE2E || (hasDsh && hasChromium),
      `DSH_SHOP_REQUIRE_E2E=1 but the web flow cannot run (dsh: ${hasDsh}, chromium: `
        + `${hasChromium}), so the P2 exit criterion would have skipped and the run would `
        + 'still have exited 0.',
    ).toBe(true)
  })
})

describe.skipIf(!hasDsh || !hasChromium)('web full flow', () => {
  let catalogServer: CatalogServer | undefined
  let localRegistry: LocalRegistry | undefined
  let tmpHome = ''
  let webUrl = ''
  let dshProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let page: Page | undefined

  const shopPackageDir = fileURLToPath(new URL('../../', import.meta.url))
  const helloFixtureDir = fileURLToPath(
    new URL('../fixtures/hello-packages/dsh-plugin-shop', import.meta.url),
  )
  const liveFixtureDir = fileURLToPath(
    new URL('../fixtures/live-packages/dsh-shop-e2e-live', import.meta.url),
  )
  const configFixtureDir = fileURLToPath(
    new URL('../fixtures/live-packages/dsh-shop-e2e-config', import.meta.url),
  )
  const peerFixtureDir = fileURLToPath(
    new URL('../fixtures/live-packages/dsh-shop-e2e-peer', import.meta.url),
  )
  const clientFixtureDir = fileURLToPath(
    new URL('../fixtures/live-packages/dsh-shop-e2e-client', import.meta.url),
  )

  beforeAll(async () => {
    catalogServer = await startCatalogServer()
    // The hot-mount installs resolve through this registry — the profile's
    // .npmrc points at it (written below, once the profile exists), so the
    // gateway's `dsh plugin add <name>@<version>` finds the fixtures locally
    // (and the failed-install name still 404s here, like it does on npm).
    localRegistry = await startLocalRegistry([liveFixtureDir, configFixtureDir, peerFixtureDir, clientFixtureDir])
    tmpHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))

    // The REAL install path: the same executor the gateway runs, spawning
    // `dsh plugin --profile web add file:<…>` in the profile.
    for (const [spec, expectedName] of [
      [pathToFileURL(shopPackageDir).href, 'dsh-plugin-shop'],
      [pathToFileURL(helloFixtureDir).href, 'dsh-hello-fixture'],
    ] as const) {
      const install = startInstall({
        profile: 'web',
        spec,
        env: { ...process.env, DSH_HOME: tmpHome },
        expectedName,
      })
      const status = await install.finished
      // The log carries the dsh/pnpm stderr verbatim; surface it when the
      // install itself failed so the failure is actionable.
      expect(status.state, status.log.join('\n')).toBe('done')
    }

    // pnpm (unlike npm) does not read the registry from npm_config_* env
    // vars — the project .npmrc is the lever. Point the profile's .npmrc at
    // the local registry so the gateway's pnpm runs resolve the fixture
    // installs locally; the file: installs above never needed a registry,
    // and the user .npmrc's npmjs token stays scoped to npmjs hosts.
    writeFileSync(
      join(tmpHome, 'profiles', 'web', '.npmrc'),
      `registry=${localRegistry.baseUrl}\n`,
    )

    // The other pre-boot seed: neither onboarding dialog is ever raised, so no
    // case has to click one away and none can be blocked by one.
    seedOnboarding(tmpHome)

    // Boot the real web profile against the fixture catalog on a port
    // reserved up front (see `reservePort`: `--port 0` is itself a restart
    // refusal the host advertises, and booting under it would cost this file
    // its restart-offer coverage). dsh prints the BOUND port in
    // `dsh web: <url>` once the Loader tree settles (the web-app bundle
    // announces readiness), so the URL is still parsed from stdout rather than
    // assumed to be the one we asked for.
    // Through the same resolution as `hasDsh` above: a bare `dsh` is ENOENT on
    // Windows, and this spawn is what boots the harness the whole flow drives.
    const web = dshCommand({
      dshBin: 'dsh',
      args: ['--profile', 'web', '--no-open', '--port', String(await reservePort())],
      platform: process.platform,
      execPath: process.execPath,
      script: resolveDshScript(
        { exists: path => existsSync(path), read: path => readFileSync(path, 'utf8') },
        { argv1: process.argv[1], path: process.env.PATH },
      ),
    })
    dshProcess = spawn(web.command, web.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...localRegistryEnv(),
        DSH_HOME: tmpHome,
        DSH_SHOP_CATALOG_URL: catalogServer.baseUrl,
        // `detectSupervisor` reads these two plus ppid 1. The ppid half is
        // already unreachable (dsh is a child of the vitest worker), but the
        // markers are inherited, and a runner started as a systemd unit
        // exports them into every descendant. Dropping them makes the
        // platform the only restart reason this composition can produce —
        // which is what `expectRestartOffer`'s branch claims, now enforced
        // rather than assumed.
        INVOCATION_ID: undefined,
        JOURNAL_STREAM: undefined,
      },
      detached: true, // its own process group, so teardown kills the whole tree
    })
    const stdout: string[] = []
    const stderr: string[] = []
    webUrl = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(
          `dsh web did not print its URL in time.\nstdout:\n${stdout.join('\n')}\nstderr:\n${stderr.join('\n')}`,
        ))
      }, 90_000)
      dshProcess?.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line === '') continue
          stdout.push(line)
          const match = /dsh web: (http:\/\/\S+)/.exec(line)
          if (match?.[1] !== undefined) {
            clearTimeout(timeout)
            resolve(match[1])
          }
        }
      })
      dshProcess?.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) if (line !== '') stderr.push(line)
      })
      dshProcess?.on('exit', code => {
        clearTimeout(timeout)
        reject(new Error(
          `dsh web exited (code ${String(code)}) before printing its URL.\nstdout:\n${stdout.join('\n')}\nstderr:\n${stderr.join('\n')}`,
        ))
      })
    })

    browser = await chromium.launch()
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } })
  }, 180_000)

  afterAll(async () => {
    await browser?.close().catch(() => {})
    if (dshProcess !== undefined && dshProcess.pid !== undefined) {
      stopProcessTree(dshProcess.pid)
    }
    await catalogServer?.close().catch(() => {})
    await localRegistry?.close().catch(() => {})
    // `maxRetries`, not just `force`: `force` suppresses ENOENT and nothing
    // else, and on Windows a file another process still holds cannot be
    // unlinked at all. The gateway's pnpm children can outlive the kill above
    // by a moment, and an EBUSY here fails the whole FILE after every
    // assertion in it has passed — a red run that says nothing about the
    // product.
    if (tmpHome !== '') rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }, 30_000)

  it(
    'browses the shop, installs with the §9.3 acknowledgement, sees the real failure and the recovery hint, and the manifest reflects the file: installs',
    async () => {
      expect(page).toBeDefined()
      const app = page!

      // Onboarding is seeded OFF rather than clicked through (`seedOnboarding`),
      // so nothing is dismissed here — only checked.
      await app.goto(webUrl, { waitUntil: 'load' })
      await app.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await app.getByRole('button', { name: '设置', exact: true })
        .waitFor({ state: 'visible', timeout: 30_000 })
      await expectNoDialog(app)

      // Settings → 插件 → 插件商店: the pinned live-app selectors.
      await app.getByRole('button', { name: '设置', exact: true }).click({ timeout: 15_000 })
      const dialog = app.getByRole('dialog', { name: '设置' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      await dialog.getByRole('button', { name: '插件', exact: true }).click()
      await dialog.getByRole('tab', { name: '插件商店' }).click() // panel renders lazily
      await dialog.locator('[data-shop-tab]').waitFor({ state: 'visible', timeout: 15_000 })

      // The fixture entry renders with the community tier badge (§6.1).
      const card = dialog.locator('[data-shop-entry="dsh-e2e-fixture-plugin"]')
      await card.waitFor({ state: 'visible', timeout: 15_000 })
      // The community tier is NOT badged: every entry in the live catalog
      // carries it, so the label was on every card and said nothing. This
      // fixture is community tier, so its absence is the assertion.
      expect(await card.textContent()).not.toContain('社区')
      // Both source marks, in a real browser: this fixture installs from npm
      // and its repository is on GitHub — the ordinary shape, 4892 of the
      // live catalog's 4915 entries.
      await card.locator('[data-shop-source-npm]').waitFor({ state: 'visible', timeout: 10_000 })
      await card.locator('[data-shop-source-github]').waitFor({ state: 'visible', timeout: 10_000 })

      // The author, in a real browser, on the COLLAPSED card's action row —
      // the shop asserts nothing about who is genuine, but a person comparing
      // two listings that look alike should not have to open each one to see
      // who published it.
      const author = card.locator('[data-shop-author]')
      await author.waitFor({ state: 'visible', timeout: 10_000 })
      expect(await author.textContent()).toContain('octocat')
      // "Same row as the install button, right-aligned" is the requirement, and
      // the action row is a WRAPPING flex — so assert the geometry a real
      // browser produced, not just that both elements exist. Vertical centres
      // within a few pixels means one row; a left edge past the button's right
      // edge means it is the row's right-hand end.
      const authorBox = await author.boundingBox()
      const installBox = await card.locator('[data-shop-install]').boundingBox()
      expect(authorBox).not.toBeNull()
      expect(installBox).not.toBeNull()
      if (authorBox !== null && installBox !== null) {
        const authorMid = authorBox.y + authorBox.height / 2
        const installMid = installBox.y + installBox.height / 2
        expect(Math.abs(authorMid - installMid)).toBeLessThan(6)
        expect(authorBox.x).toBeGreaterThan(installBox.x + installBox.width)
      }

      // The size, left of the author on the same collapsed row. Only this
      // lane proves the whole chain: the catalog server serves
      // `unpackedSize: 847407`, the host's zod has to keep the key rather than
      // strip it (a non-strict schema strips what it does not declare — the
      // silent failure mode for a new field), and the client has to format it
      // decimally. jsdom sees the format; nothing but a browser sees the other
      // two links of that chain.
      //
      // That failure mode is not hypothetical: `installSize` spent from 0.8.1
      // to 0.8.2 being published for every github entry and stripped by every
      // client, because no lane asserted a size that came in under a key only
      // the host's zod could admit. The `dsh-shop-e2e-live` assertion further
      // down is that lane; this one holds the OLD key, so the pair pins both
      // sides of the parse-boundary merge — the client reads `installSize`
      // alone, and `catalog.ts`'s transform is what makes this older row
      // render at all.
      const size = card.locator('[data-shop-size]')
      await size.waitFor({ state: 'visible', timeout: 10_000 })
      expect(await size.textContent()).toBe('847.4 kB')
      // Left of the author, on one row — the geometry, not just the DOM order,
      // because `.cardMeta` owns the `margin-left: auto` that puts the pair at
      // the row's right end and a wrapping flex is free to break it.
      const sizeBox = await size.boundingBox()
      if (sizeBox !== null && authorBox !== null) {
        expect(Math.abs((sizeBox.y + sizeBox.height / 2) - (authorBox.y + authorBox.height / 2))).toBeLessThan(6)
        expect(sizeBox.x + sizeBox.width).toBeLessThanOrEqual(authorBox.x + 1)
      }
      // And it says WHICH size, for anyone who might read it as the download.
      // "磁盘占用" and not "解包后" since `installSize`: a commit-pinned github
      // entry unpacks nothing, its figure being the sum of its git tree's
      // blobs, so one phrase has to hold for both sources. The number is
      // unchanged, so the shelf and npmjs.com still agree.
      //
      // Through the dictionary, not the interpolated string: this file already
      // asserts templated copy that way (`zh.hideIncompatible.replace(...)`
      // below), and a copy change must not red the slowest lane in the suite
      // for a reason that has nothing to do with sizes.
      expect(await size.getAttribute('title')).toBe(zh.sizeLabel.replace('{size}', '847.4 kB'))

      // The other half of the pair: a size that arrives ONLY as `installSize`.
      // Not "the shape every github entry has" — this row declares no
      // `source`, so the parse defaults it to `npm`; what it proves is the
      // KEY, which was undeclared yesterday, surviving a real host zod and
      // reaching a real card. If the host does not declare it, a non-strict
      // schema drops it in silence and this card shows nothing — which is
      // exactly what shipped in 0.8.1 and 0.8.2. The github SHAPE is covered
      // where it can be: the parse in `tests/host/catalog.test.ts`, the render
      // in `tests/client/ShopTab.client.spec.tsx`; this name cannot carry it,
      // because the hot-mount spec below installs it from the local npm
      // registry (see `liveFixtureDir`).
      //
      // Card first, then the size inside it — the idiom the hot-mount spec
      // uses, and here it is load-bearing. `.card` carries
      // `content-visibility: auto` (ShopTab.module.css), so a card below the
      // fold has a render-skipped subtree whose children report a 0x0 rect and
      // never become "visible", while the card itself always has a box —
      // that is what `contain-intrinsic-size` is for — and `waitFor` does not
      // scroll. So each of the three things that can break says so on its own:
      // a missing card fails as a missing CARD, a stripped key fails the
      // `attached` wait (the DOM question this actually asks), and a
      // mis-formatted figure fails one of the two assertions below.
      const liveCard = dialog.locator('[data-shop-entry="dsh-shop-e2e-live"]')
      await liveCard.waitFor({ state: 'visible', timeout: 15_000 })
      const liveSize = liveCard.locator('[data-shop-size]')
      await liveSize.waitFor({ state: 'attached', timeout: 10_000 })
      expect(await liveSize.textContent()).toBe('4.1 MB')
      expect(await liveSize.getAttribute('title')).toBe(zh.sizeLabel.replace('{size}', '4.1 MB'))

      // Both themes and all three active states: readable text, the shared
      // category hue on the selected border, and exact category-tab widths.
      await checkCategoryBar(app, dialog)

      // The expanded detail's npm row: the link to the package's own npm page,
      // the other half of that same comparison.
      await card.locator('button[aria-expanded]').click()
      const npmRow = card.locator('[data-shop-npm]')
      await npmRow.waitFor({ state: 'visible', timeout: 10_000 })
      expect(await npmRow.locator('a').getAttribute('href'))
        .toBe('https://www.npmjs.com/package/dsh-e2e-fixture-plugin')
      // Collapse again so the install flow below starts from the same state
      // the rest of this walk-through assumes.
      await card.locator('button[aria-expanded]').click()

      // The starred fixture renders its badge through the real wire → host →
      // client path.
      await dialog.getByText('★ 4.3k').waitFor({ state: 'visible', timeout: 15_000 })

      // Install → the §9.3 acknowledgement gate: the confirm button marks the
      // gate, and the body is the spec text verbatim (zh register).
      await card.locator('[data-shop-install]').click()
      await card.locator('[data-shop-confirm]').waitFor({ state: 'visible', timeout: 10_000 })
      expect(await card.textContent()).toContain('需要确认')
      expect(await card.textContent()).toContain(
        '安装后，此插件将拥有与内置插件相同的权限：读写你的文件、执行 shell 命令，以及读取和修改发送给模型的请求。它未经审核。',
      )

      // Confirm → the install runs (正在安装…) and the once-per-second poll
      // reaches the terminal state: pnpm fails in the profile (the name is
      // not on npm and the fixture registry 404s it too), and the failed view
      // renders the heading plus the §10 recovery hint with the last pnpm
      // stderr line.
      await card.locator('[data-shop-confirm]').click()
      await card.getByText('安装失败').waitFor({ timeout: 60_000 })
      await card
        .getByText(/pnpm failed in the profile\. Run: dsh plugin --profile web install —/)
        .waitFor({ timeout: 15_000 })

      // The manifest-level half of the flow (the P1 pattern): both file:
      // installs landed in `dsh.profile.bundles`; the failed fixture name did
      // not. The brief's original restart-notice assertion is replaced by
      // this — the fixture install fails by design (see the file header).
      const manifest = JSON.parse(
        readFileSync(join(tmpHome, 'profiles', 'web', 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
      expect(manifest.dsh?.profile?.bundles).toContain('dsh-plugin-shop')
      expect(manifest.dsh?.profile?.bundles).toContain('dsh-hello-fixture')
      expect(manifest.dsh?.profile?.bundles).not.toContain('dsh-e2e-fixture-plugin')
      // pnpm records the spec under the package's true name; the value is
      // the normalized file: spec (a file:///… URL is written as file:/…).
      expect(manifest.dependencies?.['dsh-plugin-shop']).toMatch(/^file:/)
      expect(manifest.dependencies?.['dsh-hello-fixture']).toMatch(/^file:/)
    },
    120_000,
  )

  it(
    'hot-mounts a simple-patch fixture: install done without a restart, the loader inventory lists it live, uninstall stops it immediately',
    async () => {
      expect(page).toBeDefined()
      const app = page!

      // The settings dialog from the first spec is still open on the 插件商店
      // tab; the live fixture card renders alongside the failed-install card.
      const dialog = app.getByRole('dialog', { name: '设置' })
      const card = dialog.locator('[data-shop-entry="dsh-shop-e2e-live"]')
      await card.waitFor({ state: 'visible', timeout: 15_000 })

      // Install through the real wire: the §9.3 gate, then the poll to done.
      await card.locator('[data-shop-install]').click()
      await card.locator('[data-shop-confirm]').waitFor({ state: 'visible', timeout: 10_000 })
      await card.locator('[data-shop-confirm]').click()

      // activation `live`: the done view renders the no-restart notice
      // (never a restart reason) and offers no restart. A hot-mount failure
      // would surface the host's localized reason here instead (under
      // activation `restart`), failing this.
      const notice = card.locator('[data-shop-restart-notice]')
      await notice.waitFor({ state: 'visible', timeout: 60_000 })
      expect(await notice.textContent()).toContain('已安装并热挂载')
      // Both offers, not just the enabled one: under activation `restart` a
      // host that cannot restart renders `[data-shop-restart-disabled]`
      // instead, so counting `[data-shop-restart]` alone would be satisfied by
      // exactly the regression this line refuses — on Windows, silently.
      expect(await card.locator('[data-shop-restart], [data-shop-restart-disabled]').count()).toBe(0)

      // Liveness through the loader inventory — the strict read of what is
      // actually mounted. A route-based probe is unavailable: the harness
      // bundles no plugin-side HTTP router for the fixture to register on
      // (see the fixture's index.js comment). The hot entry carries the
      // mkt- prefixed row id at the end of its inventory id chain — the shop
      // registers the hot tree with its own ctx, a subtree of the gateway
      // include, so the loader lists it as `include:typert-gateway:mkt-e2e-live`
      // — plus the enabled tag and the active phase dot.
      await dialog.getByRole('tab', { name: '插件列表' }).click()
      await expandGlobalPlane(dialog)
      const liveEntry = dialog.locator('[data-plugin-entry="include:typert-gateway:mkt-e2e-live"]')
      await liveEntry.waitFor({ state: 'visible', timeout: 15_000 })
      await liveEntry.getByRole('button', { name: /已启用/ }).waitFor({ state: 'visible', timeout: 15_000 })
      await liveEntry.getByRole('img', { name: '运行中' }).waitFor({ state: 'visible', timeout: 15_000 })

      // The settled mutation re-reads installed() in place. Switching back
      // to the already-mounted shop must expose the installed actions without
      // closing Settings or pressing Refresh (G-9).
      await dialog.getByRole('tab', { name: '插件商店' }).click()
      await dialog.locator('[data-shop-tab]').waitFor({ state: 'visible', timeout: 15_000 })
      const card2 = dialog.locator('[data-shop-entry="dsh-shop-e2e-live"]')
      await card2.waitFor({ state: 'visible', timeout: 15_000 })
      await card2.locator('[data-shop-uninstall]').waitFor({ state: 'visible', timeout: 15_000 })

      // Toggle: the REAL pluginInventory returns a snapshot object, not a
      // bare array — a click that fails here means the host misread the
      // service shape again (the 0.5.2 regression pin).
      const toggle = card2.locator('[data-shop-toggle]')
      await toggle.waitFor({ state: 'visible', timeout: 15_000 })
      const ariaBefore = await toggle.getAttribute('aria-checked')
      await toggle.click()
      let ariaAfter: string | null = ariaBefore
      for (let i = 0; i < 40 && ariaAfter === ariaBefore; i++) {
        await app.waitForTimeout(250)
        ariaAfter = await toggle.getAttribute('aria-checked')
      }
      expect(ariaAfter).not.toBe(ariaBefore)
      // The row names the CONFIG id the fixture's bundle patch inserts, never
      // the live id the entry was found by. This test used to assert
      // `mkt-e2e-live`, the ephemeral hot spelling — and agreed with the host
      // that wrote it, which is why both stayed green while no toggle in a
      // real profile did anything. The harness applies this file with
      // applyEntryPatches, which looks each row's id up among the ids the
      // bundle patches declared: `mkt-e2e-live` exists in no such list, and
      // the restart that would compose this plugin brings it up as `e2e-live`.
      const userLayer = readFileSync(join(tmpHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
      expect(userLayer).toContain('e2e-live')
      expect(userLayer).not.toContain('mkt-')
      // Re-enable so the uninstall below starts from the enabled state.
      await toggle.click()
      let ariaRestored: string | null = null
      for (let i = 0; i < 40; i++) {
        ariaRestored = await toggle.getAttribute('aria-checked')
        if (ariaRestored === ariaBefore) break
        await app.waitForTimeout(250)
      }
      expect(ariaRestored).toBe(ariaBefore)

      // Uninstall: no gate. Once the poll reaches done, installed() runs
      // again and the card immediately returns to the Install action.
      await card2.locator('[data-shop-uninstall]').click()
      await card2.locator('[data-shop-install]').waitFor({ state: 'visible', timeout: 60_000 })
      expect(await card2.locator('[data-shop-uninstall]').count()).toBe(0)
      // Both offers, for the reason the install-side twin above states: this
      // is the only assertion that an uninstall did not report `restart`.
      expect(await card2.locator('[data-shop-restart], [data-shop-restart-disabled]').count()).toBe(0)

      // The hot fiber is gone: a fresh settings mount takes a fresh inventory
      // snapshot (the tab's list() runs per mount), which no longer lists the
      // entry. What proves the snapshot rendered is `expandGlobalPlane`'s own
      // postcondition, a visible card whose id carries the `include:` prefix,
      // so the absence below is an absence and not an unrendered list.
      await dialog.locator('.VOzbGW_close').click()
      await app.getByRole('button', { name: '设置', exact: true }).click({ timeout: 15_000 })
      const dialog3 = app.getByRole('dialog', { name: '设置' })
      await dialog3.waitFor({ state: 'visible', timeout: 10_000 })
      await dialog3.getByRole('button', { name: '插件', exact: true }).click()
      await dialog3.getByRole('tab', { name: '插件列表' }).click()
      await expandGlobalPlane(dialog3)
      expect(await dialog3.locator('[data-plugin-entry="include:typert-gateway:mkt-e2e-live"]').count()).toBe(0)
    },
    120_000,
  )

  it(
    'falls back to a restart for a fixture whose patch carries a config row: the localized reason and the restart offer, nothing live',
    async () => {
      expect(page).toBeDefined()
      const app = page!

      // Close the dialog left open by the previous spec, then reopen on the
      // shop tab for the config fixture's card.
      const dialog0 = app.getByRole('dialog', { name: '设置' })
      await dialog0.locator('.VOzbGW_close').click()
      await app.getByRole('button', { name: '设置', exact: true }).click({ timeout: 15_000 })
      const dialog = app.getByRole('dialog', { name: '设置' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      await dialog.getByRole('button', { name: '插件', exact: true }).click()
      await dialog.getByRole('tab', { name: '插件商店' }).click()
      await dialog.locator('[data-shop-tab]').waitFor({ state: 'visible', timeout: 15_000 })
      const card = dialog.locator('[data-shop-entry="dsh-shop-e2e-config"]')
      await card.waitFor({ state: 'visible', timeout: 15_000 })

      // Install: the same gate and poll. The config-row patch is a valid
      // bundle-layer patch the hot tree cannot replicate, so the install
      // reports done with activation `restart` and the host's published
      // localized reason (parseSimplePatch rejects the row; the reason
      // renders verbatim on the notice).
      await card.locator('[data-shop-install]').click()
      await card.locator('[data-shop-confirm]').waitFor({ state: 'visible', timeout: 10_000 })
      await card.locator('[data-shop-confirm]').click()
      const notice = card.locator('[data-shop-restart-notice]')
      await notice.waitFor({ state: 'visible', timeout: 60_000 })
      expect(await notice.textContent()).toContain('该插件的补丁包含无法热挂载的配置；重启 dsh 后生效')
      // The §8 restart offer for a restart-required install, as the host
      // allows it on THIS platform — see `expectRestartOffer`.
      await expectRestartOffer(dialog, card)

      // Nothing is live: a fresh settings mount takes a fresh inventory
      // snapshot, and the config fixture has no hot entry in it.
      // `expandGlobalPlane`'s postcondition is again what separates that from
      // a Loader plane that simply has not rendered.
      await dialog.locator('.VOzbGW_close').click()
      await app.getByRole('button', { name: '设置', exact: true }).click({ timeout: 15_000 })
      const dialog2 = app.getByRole('dialog', { name: '设置' })
      await dialog2.waitFor({ state: 'visible', timeout: 10_000 })
      await dialog2.getByRole('button', { name: '插件', exact: true }).click()
      await dialog2.getByRole('tab', { name: '插件列表' }).click()
      await expandGlobalPlane(dialog2)
      expect(await dialog2.locator('[data-plugin-entry="include:typert-gateway:mkt-e2e-config"]').count()).toBe(0)
    },
    120_000,
  )

  it(
    'badges a peer nothing provides and an unmet dsh.compatibility, never a seeded module, and still installs on confirm',
    async () => {
      expect(page).toBeDefined()
      const app = page!

      // Close the dialog left open by the previous spec, then reopen on the
      // shop tab for the peer fixture's card (same reopen sequence as the
      // previous spec's start: the settings modal was left on 插件列表).
      const dialog0 = app.getByRole('dialog', { name: '设置' })
      await dialog0.locator('.VOzbGW_close').click()
      await app.getByRole('button', { name: '设置', exact: true }).click({ timeout: 15_000 })
      const dialog = app.getByRole('dialog', { name: '设置' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      await dialog.getByRole('button', { name: '插件', exact: true }).click()
      await dialog.getByRole('tab', { name: '插件商店' }).click()
      await dialog.locator('[data-shop-tab]').waitFor({ state: 'visible', timeout: 15_000 })
      const card = dialog.locator('[data-shop-entry="dsh-shop-e2e-peer"]')
      await card.waitFor({ state: 'visible', timeout: 15_000 })

      // The catalog entry declares two peers, and the verdict takes both stages
      // (design 2026-09-01 §9.1). `@dsh-shop-e2e/absent-peer` is provided by
      // nothing: node resolution from the profile finds no package, and the
      // browser's module table has no such word, so it is named — in the
      // card's visible text, via the always-rendered detail line, not just the
      // badge's title attribute. `@deepseek-ai/dsh-client-store` — the module
      // whose absence broke a real user's harness on the 0.1.1-rc.2 line — has
      // no package on disk either, so the host still lists it; but on this
      // harness it is a platform seed word, the client's module table serves
      // it, and it must NOT be named. Until 2026-09-24 this spec asserted the
      // opposite, and so asserted a false alarm as the correct answer.
      await card.locator('[data-shop-blocker]').waitFor({ state: 'visible', timeout: 15_000 })
      expect(await card.textContent()).toContain('@dsh-shop-e2e/absent-peer')
      expect(await card.textContent(), 'a peer the module table seeds was reported missing').not.toContain('@deepseek-ai/dsh-client-store')
      expect(await card.locator('[data-shop-blocker]').textContent()).toBe(zh.incompatibleBadge)

      // The same entry declares a `dsh.compatibility` that fails both halves.
      // Only a real host parse can carry the key to here — the jsdom specs
      // build their snapshot directly and never cross the host zod, which is
      // how `installSize` was published for weeks and shown nowhere — and only
      // the real harness can say what is running. The expected running
      // version is read where the host's resolver finds it: the link farm the
      // harness heals into this profile's DSH_HOME.
      const running = (JSON.parse(readFileSync(
        join(tmpHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8',
      )) as { version: string }).version
      expect(await card.locator('[data-shop-incompatible-detail="harness-range"]').textContent())
        .toBe(zh.harnessRangeDetail.replace('{range}', '0.1.2-rc.1').replace('{running}', running))
      expect(await card.locator('[data-shop-incompatible-detail="harness-profile"]').textContent())
        .toBe(zh.harnessProfileDetail.replace('{declared}', 'acp').replace('{running}', 'web'))

      // And the seed-only card says nothing at all. Its two peers, `react` and
      // `react-dom`, have no package on disk, so node resolution alone would
      // badge it — the false alarm 755 live entries carried. The peer card's
      // badge above is rendered, so the refined verdict has arrived and this
      // count is final.
      const liveCard = dialog.locator('[data-shop-entry="dsh-shop-e2e-live"]')
      expect(await liveCard.count()).toBe(1)
      expect(await liveCard.locator('[data-shop-blocker]').count(), 'a seed-only card was badged').toBe(0)

      // The copy is two sentences separated by a `\n` it carries itself, and
      // NOTHING else in this suite can prove that renders. The component tests
      // stub `t` with a hand-rolled dictionary lookup, so they establish only
      // that the dictionary holds a newline — whether the harness's own i18n
      // passes it through untouched, and whether the bundled stylesheet still
      // says pre-line by the time a browser reads it, are answerable only
      // here, against the real dsh and a real chromium.
      const detail = card.locator('[data-shop-incompatible-detail="missing-peers"]')
      await detail.waitFor({ state: 'visible', timeout: 15_000 })
      const shape = await detail.evaluate(el => ({ text: el.textContent ?? '', whiteSpace: getComputedStyle(el).whiteSpace }))
      expect(shape.text, 'the harness i18n dropped the newline the copy carries').toContain('\n')
      expect(shape.whiteSpace, 'pre-line did not survive into the bundled stylesheet').toBe('pre-line')

      // The incompatible filter, against verdicts the real host and the real
      // module table formed: its count comes from their run, not from a
      // fixture that asserts the answer, and this fixture profile makes
      // exactly one of the five shelf entries incompatible.
      const filter = dialog.locator('[data-shop-hide-incompatible]')
      await filter.waitFor({ state: 'visible', timeout: 10_000 })
      expect(await filter.textContent()).toBe(zh.hideIncompatible.replace('{count}', '1'))
      expect(await filter.getAttribute('aria-checked')).toBe('false')
      // It sits at the far edge of the category bar: its RIGHT edge is the
      // bar's right edge, which is what `margin-left: auto` guarantees and
      // only a browser lays out.
      //
      // Stated as edge alignment rather than "further right than the last
      // tab" because the bar WRAPS. That first form passed on Windows, where
      // the nine pills fit one line, and failed on CI's font metrics, where
      // they do not: the filter had wrapped to a line of its own — still
      // flush right, still correct — and a same-line comparison read that as
      // the control being in the wrong place. Edge alignment holds in both
      // layouts, which is why it is the property and the other was an
      // accident of how one machine broke the line.
      const filterBox = await filter.boundingBox()
      const barBox = await dialog.locator('[class*="categoryBar"]').boundingBox()
      expect(filterBox).not.toBeNull()
      expect(barBox).not.toBeNull()
      if (filterBox !== null && barBox !== null) {
        expect(
          Math.abs((filterBox.x + filterBox.width) - (barBox.x + barBox.width)),
          'the filter is not flush with the right edge of the category bar',
        ).toBeLessThan(2)
      }

      await filter.click()
      // The card is gone from the shelf, and the switch says so. The label is
      // the same string it was — it names what the switch does, not which way
      // it is thrown — so `aria-checked` is where the state is read.
      await card.waitFor({ state: 'detached', timeout: 10_000 })
      expect(await filter.textContent()).toBe(zh.hideIncompatible.replace('{count}', '1'))
      expect(await filter.getAttribute('aria-checked')).toBe('true')
      // The compatible fixtures stayed — the seed-only live card among them,
      // which the filter would have taken too if node resolution alone had
      // decided.
      expect(await dialog.locator('[data-shop-entry="dsh-shop-e2e-live"]').count()).toBe(1)
      await filter.click()
      await card.waitFor({ state: 'visible', timeout: 10_000 })

      // Install → the community-tier gate opens and shows the
      // incompatibility warning alongside the §9.3 acknowledgement.
      await card.locator('[data-shop-install]').click()
      await card.locator('[data-shop-confirm]').waitFor({ state: 'visible', timeout: 10_000 })
      // The gate does NOT restate what is missing: the card above it already
      // does, and both rendering the same lines printed them twice. The
      // outdated row is the one surface that still needs the gate to say it,
      // and it has no card detail to duplicate. One line per blocker.
      expect(await card.locator('[data-shop-incompatible-warning]').count()).toBe(0)
      expect(await card.locator('[data-shop-incompatible-detail]').count()).toBe(3)
      for (const kind of ['missing-peers', 'harness-range', 'harness-profile']) {
        expect(await card.locator(`[data-shop-incompatible-detail="${kind}"]`).count(), kind).toBe(1)
      }

      // Confirm → warn, never block: the real pnpm install only warns on the
      // unresolvable peer (the profile's autoInstallPeers: false, same as
      // every real dsh profile) and still reaches its terminal done state —
      // never the failed or rejected view.
      await card.locator('[data-shop-confirm]').click()
      await card.locator('[data-shop-restart-notice]').waitFor({ state: 'visible', timeout: 60_000 })
    },
    120_000,
  )

  it(
    'a hot-mounted package with a browser half reports restart, and the reload it does not offer would deliver nothing',
    async () => {
      expect(page).toBeDefined()
      const app = page!

      // Close the dialog left open by the previous spec, then reopen on the
      // shop tab for the client fixture's card (same reopen sequence as the
      // previous two specs' start).
      const dialog0 = app.getByRole('dialog', { name: '设置' })
      await dialog0.locator('.VOzbGW_close').click()
      await app.getByRole('button', { name: '设置', exact: true }).click({ timeout: 15_000 })
      const dialog = app.getByRole('dialog', { name: '设置' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      await dialog.getByRole('button', { name: '插件', exact: true }).click()
      await dialog.getByRole('tab', { name: '插件商店' }).click()
      await dialog.locator('[data-shop-tab]').waitFor({ state: 'visible', timeout: 15_000 })
      const card = dialog.locator('[data-shop-entry="dsh-shop-e2e-client"]')
      await card.waitFor({ state: 'visible', timeout: 15_000 })

      // Install: the same gate and poll as every other hot-mount scenario.
      // The one thing new about this fixture is the `dsh.client` declaration
      // in its package.json — the three older live fixtures declare only
      // `dsh.bundle`, so every hot-mount assertion elsewhere in this suite
      // was made about a package with no browser half.
      await card.locator('[data-shop-install]').click()
      await card.locator('[data-shop-confirm]').waitFor({ state: 'visible', timeout: 10_000 })
      await card.locator('[data-shop-confirm]').click()

      // activation `restart`, and the measurement under it is why.
      //
      // The host half hot-mounts live, exactly like the plain live fixture —
      // the sibling spec reads that shape straight out of the loader
      // inventory. What this fixture adds is a `dsh.client` declaration, and
      // a browser half does not arrive by the same route: it reaches a tab
      // only through `window.__DSH_BOOT__`, which the harness composes from
      // the BOOT composition. A hot mount adds to the live loader entries
      // without entering that, so there is nothing for a reload to fetch.
      //
      // The done view must therefore render the client-half restart copy and
      // the restart activation's offer — never the no-restart line (the §0
      // `dsh-theme-endfield` report: told nothing was needed, needed a
      // restart) and never the reload offer, which would send the reader to
      // press a button that provably changes nothing. WHICH offer the restart
      // activation shows is the host's call, not this case's; `activation` is
      // `restart` either way, and that is what this case is about.
      const notice = card.locator('[data-shop-restart-notice]')
      await notice.waitFor({ state: 'visible', timeout: 60_000 })
      expect(await notice.textContent()).toBe(zh.hotClientHalfNotice)
      // Measured 2026-09-14 on Windows 11, dsh 0.1.5-rc.1: an unconditional
      // wait for `[data-shop-restart]` here sat red for its full 10s on a host
      // behaving exactly as designed, which is why this goes through the
      // helper rather than naming one platform's outcome.
      await expectRestartOffer(dialog, card)
      // Platform-independent, and the half this case is actually about: a hot
      // mount puts no client half in the boot graph, so a reload would fetch
      // nothing and must never be offered.
      expect(await card.locator('[data-shop-reload]').count()).toBe(0)

      // The measurement the paragraph above rests on, taken here rather than
      // asserted from the design, because the design said the opposite until
      // this ran: §2 measured a runtime disable, a runtime enable, and that
      // the hot-mounted row's bundle URL answers 200 — never that the
      // package enters the graph a tab boots from, which is what would make
      // anything request that URL.
      //
      // 2026-09-14, dsh 0.1.5-rc.1: across a reload following the hot mount
      // the served graph is BYTE-IDENTICAL — same `rev`, the fixture's
      // client half absent before and after — while its host half is live
      // the whole time. The shop's own client half IS in the graph, and the
      // shop is boot-composed rather than hot-mounted; that control is what
      // separates "this graph carries no client halves" from "it carries
      // every one except a hot-mounted one".
      //
      // This is also the only thing in the suite that executes the fixture's
      // browser half at all. Without it `dsh-shop-e2e-client/client.js` and
      // its `exports["./client"]` are loaded by nothing, and the suite stayed
      // green while asserting only what the shop SAID.
      //
      // If these lines ever fail, the harness has started composing hot
      // mounts into the client registry — and that is the signal to move the
      // install path back to `reload`, not to relax the assertion.
      const boot = async (): Promise<{ rev: string; ids: string[] }> => app.evaluate(() => {
        const graph = (window as unknown as { __DSH_BOOT__?: { rev?: string; entries?: Array<{ id?: string }> } }).__DSH_BOOT__
        return { rev: graph?.rev ?? '', ids: (graph?.entries ?? []).map(entry => entry.id ?? '') }
      })
      const before = await boot()
      expect(before.ids).not.toContain('dsh-shop-e2e-client')
      await app.reload({ waitUntil: 'domcontentloaded' })
      await app.waitForFunction(
        () => (window as unknown as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ !== undefined,
        undefined,
        { timeout: 30_000 },
      )
      const after = await boot()
      expect(after.rev).toBe(before.rev)
      expect(after.ids).not.toContain('dsh-shop-e2e-client')
      expect(after.ids).toContain('dsh-plugin-shop')
    },
    120_000,
  )
})
