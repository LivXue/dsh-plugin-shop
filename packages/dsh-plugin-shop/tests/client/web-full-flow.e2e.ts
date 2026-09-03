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
 * three live fixtures — `dsh-shop-e2e-live` (a plain `- id:` / `name:` patch,
 * the only form the hot tree can mount), `dsh-shop-e2e-config` (a config-row
 * patch, valid for the bundle layer but not hot-mountable), and
 * `dsh-shop-e2e-peer` (the same hot-mountable patch as the live fixture, plus
 * a `peerDependencies` entry this profile never installs). The profile's
 * .npmrc points at the registry once the profile exists (pnpm, unlike npm,
 * never reads the registry from env vars), so gateway-spawned pnpm resolves
 * those installs locally while the beforeAll `file:` installs keep the real
 * registry. The live install must report done with `needsRestart === false`
 * and the entry must appear in the loader inventory (the strict liveness
 * read — a route-based probe is unavailable, see the fixture's index.js
 * comment); the config install must report done with the localized restart
 * reason and the §8 restart offer instead; the peer install proves the
 * harness-compatibility badge and gate warning render for a genuinely
 * unresolvable declared peer, and — warn, never block — still reaches done.
 *
 * Skipped unless the machine has both the real `dsh` CLI on PATH and a
 * playwright chromium installed (CI installs both; see .github/workflows).
 *
 * Pinned selectors (all verified against the live app, zh-CN):
 * - the app root frame: `[class*="frame"]` — the frame class is CSS-module
 *   hashed, and the live app's root element carries a class containing `frame`
 * - first-run 内测声明 dialog → 继续; then the 添加一个 API Key 开始使用
 *   dialog → 稍后配置 (the keyless escape; the dialogs mask the page until
 *   dismissed)
 * - settings trigger: `page.getByRole('button', { name: '设置', exact: true })`
 * - settings modal: `page.getByRole('dialog', { name: '设置' })`
 * - plugins section: `dialog.getByRole('button', { name: '插件', exact: true })`
 * - shop tab: `dialog.getByRole('tab', { name: '插件商店' })` — the panel
 *   renders lazily, only after the tab is activated
 * - shop panel + entry: `[data-shop-tab]`, `[data-shop-entry=<name>]`
 * - install gate: `[data-shop-confirm]`; failure view: 安装失败 + the detail
 *   paragraph; state lines are plain text (no data attributes)
 * - harness compatibility: `[data-shop-incompatible]` (badge, on both the
 *   catalog card and the installed row) and `[data-shop-incompatible-detail]`
 *   (gate warning line) — both render only when the entry has a declared
 *   peer this host cannot resolve; there is no `[data-shop-install-done]` —
 *   the done view below is the only terminal signal
 * - install done view: `[data-shop-restart-notice]` (the no-restart copy
 *   when needsRestart is false, the host's reason code localized otherwise) and
 *   the §8 offer `[data-shop-restart]` (only when needsRestart && the host
 *   can restart)
 * - uninstall: `[data-shop-uninstall]`; done view `[data-shop-uninstall-done]`
 * - loader inventory tab: `dialog.getByRole('tab', { name: '插件列表' })`;
 *   each card `[data-plugin-entry=<entryId>]` with the enabled tag
 *   `[data-enabled=true]` and the phase dot `[data-phase=active]`
 * - settings modal close: `.VOzbGW_close` (visually-hidden label 关闭)
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstall } from '../../src/host/executor.ts'
import { zh } from '../../src/client/locales.ts'
import { startCatalogServer, type CatalogServer } from '../fixtures/catalog-server.ts'
import { startLocalRegistry, type LocalRegistry } from '../fixtures/local-registry.ts'

// The test needs the real dsh executable on PATH and a playwright chromium.
// CI installs both (the dsh CLI in the workflow, chromium by the
// `playwright install chromium` step); the skip fires only on machines that
// never set them up, so the P2 exit criterion still gates the CI run.
const hasDsh = (() => {
  try {
    const probe = spawnSync('dsh', ['--version'], { stdio: 'ignore' })
    return probe.status === 0
  } catch {
    return false
  }
})()

const hasChromium = existsSync(chromium.executablePath())

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

  beforeAll(async () => {
    catalogServer = await startCatalogServer()
    // The hot-mount installs resolve through this registry — the profile's
    // .npmrc points at it (written below, once the profile exists), so the
    // gateway's `dsh plugin add <name>@<version>` finds the fixtures locally
    // (and the failed-install name still 404s here, like it does on npm).
    localRegistry = await startLocalRegistry([liveFixtureDir, configFixtureDir, peerFixtureDir])
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

    // Boot the real web profile against the fixture catalog. `--port 0` lets
    // the OS pick the port; dsh prints the BOUND port in `dsh web: <url>`
    // once the Loader tree settles (the web-app bundle announces readiness),
    // so the URL is parsed from stdout rather than guessed.
    dshProcess = spawn('dsh', ['--profile', 'web', '--no-open', '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_HOME: tmpHome, DSH_SHOP_CATALOG_URL: catalogServer.baseUrl },
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
      try {
        process.kill(-dshProcess.pid, 'SIGTERM') // the whole process group
      } catch {
        dshProcess.kill()
      }
    }
    await catalogServer?.close().catch(() => {})
    await localRegistry?.close().catch(() => {})
    if (tmpHome !== '') rmSync(tmpHome, { recursive: true, force: true })
  }, 30_000)

  it(
    'browses the shop, installs with the §9.3 acknowledgement, sees the real failure and the recovery hint, and the manifest reflects the file: installs',
    async () => {
      expect(page).toBeDefined()
      const app = page!

      // Onboarding: a fresh profile shows the 内测声明 notice, then the
      // 添加一个 API Key 开始使用 dialog; the keyless escape is 稍后配置.
      await app.goto(webUrl, { waitUntil: 'load' })
      await app.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      const notice = app.getByRole('dialog', { name: '内测声明' })
      if (await notice.count() > 0) {
        await notice.getByRole('button', { name: '继续' }).click()
      }
      const keyDialog = app.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
      try {
        await keyDialog.waitFor({ state: 'visible', timeout: 5000 })
        await keyDialog.getByRole('button', { name: '稍后配置' }).click()
      } catch {
        // The keyless prompt is only present when no key row exists; a boot
        // that skips it must not fail the e2e.
      }

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

      // needsRestart === false: the done view renders the no-restart notice
      // (never a restart reason) and offers no restart. A hot-mount failure
      // would surface the host's localized reason here instead, failing this.
      const notice = card.locator('[data-shop-restart-notice]')
      await notice.waitFor({ state: 'visible', timeout: 60_000 })
      expect(await notice.textContent()).toContain('已安装，但 profile 未变化')
      expect(await card.locator('[data-shop-restart]').count()).toBe(0)

      // Liveness through the loader inventory — the strict read of what is
      // actually mounted. A route-based probe is unavailable: the harness
      // bundles no plugin-side HTTP router for the fixture to register on
      // (see the fixture's index.js comment). The hot entry carries the
      // mkt- prefixed row id at the end of its inventory id chain — the shop
      // registers the hot tree with its own ctx, a subtree of the gateway
      // include, so the loader lists it as `include:typert-gateway:mkt-e2e-live`
      // — plus the enabled tag and the active phase dot.
      await dialog.getByRole('tab', { name: '插件列表' }).click()
      const liveEntry = dialog.locator('[data-plugin-entry="include:typert-gateway:mkt-e2e-live"]')
      await liveEntry.waitFor({ state: 'visible', timeout: 15_000 })
      await liveEntry.locator('[data-enabled="true"]').waitFor({ state: 'visible' })
      await liveEntry.locator('[data-phase="active"]').waitFor({ state: 'visible' })

      // The installed actions need a fresh installed() read, so the settings
      // modal is closed and reopened (the shop tab remounts and refetches;
      // the 刷新 toolbar button only renders for a stale snapshot, and this
      // fixture catalog is fresh).
      await dialog.locator('.VOzbGW_close').click()
      await app.getByRole('button', { name: '设置', exact: true }).click({ timeout: 15_000 })
      const dialog2 = app.getByRole('dialog', { name: '设置' })
      await dialog2.waitFor({ state: 'visible', timeout: 10_000 })
      await dialog2.getByRole('button', { name: '插件', exact: true }).click()
      await dialog2.getByRole('tab', { name: '插件商店' }).click()
      await dialog2.locator('[data-shop-tab]').waitFor({ state: 'visible', timeout: 15_000 })
      const card2 = dialog2.locator('[data-shop-entry="dsh-shop-e2e-live"]')
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

      // Uninstall: no gate, the poll runs to done, and needsRestart === false
      // — the live-uninstall notice, no restart offer.
      await card2.locator('[data-shop-uninstall]').click()
      const uninstallDone = card2.locator('[data-shop-uninstall-done]')
      await uninstallDone.waitFor({ state: 'visible', timeout: 60_000 })
      expect(await uninstallDone.textContent()).toContain('已卸载并立即停止')
      expect(await card2.locator('[data-shop-restart]').count()).toBe(0)

      // The hot fiber is gone: a fresh settings mount takes a fresh inventory
      // snapshot (the tab's list() runs per mount), which no longer lists the
      // entry. An anchor entry's phase dot proves the snapshot rendered.
      await dialog2.locator('.VOzbGW_close').click()
      await app.getByRole('button', { name: '设置', exact: true }).click({ timeout: 15_000 })
      const dialog3 = app.getByRole('dialog', { name: '设置' })
      await dialog3.waitFor({ state: 'visible', timeout: 10_000 })
      await dialog3.getByRole('button', { name: '插件', exact: true }).click()
      await dialog3.getByRole('tab', { name: '插件列表' }).click()
      await dialog3.locator('[data-phase]').first().waitFor({ state: 'visible', timeout: 15_000 })
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
      // reports done with needsRestart === true and the host's published
      // localized reason (parseSimplePatch rejects the row; the reason
      // renders verbatim on the notice).
      await card.locator('[data-shop-install]').click()
      await card.locator('[data-shop-confirm]').waitFor({ state: 'visible', timeout: 10_000 })
      await card.locator('[data-shop-confirm]').click()
      const notice = card.locator('[data-shop-restart-notice]')
      await notice.waitFor({ state: 'visible', timeout: 60_000 })
      expect(await notice.textContent()).toContain('该插件的补丁包含无法热挂载的配置；重启 dsh 后生效')
      // The §8 restart offer renders for a restart-required install on a
      // restart-capable host (this composition: spawned by vitest, no
      // systemd markers in the env).
      await card.locator('[data-shop-restart]').waitFor({ state: 'visible', timeout: 10_000 })

      // Nothing is live: a fresh settings mount takes a fresh inventory
      // snapshot, and the config fixture has no hot entry in it.
      await dialog.locator('.VOzbGW_close').click()
      await app.getByRole('button', { name: '设置', exact: true }).click({ timeout: 15_000 })
      const dialog2 = app.getByRole('dialog', { name: '设置' })
      await dialog2.waitFor({ state: 'visible', timeout: 10_000 })
      await dialog2.getByRole('button', { name: '插件', exact: true }).click()
      await dialog2.getByRole('tab', { name: '插件列表' }).click()
      await dialog2.locator('[data-phase]').first().waitFor({ state: 'visible', timeout: 15_000 })
      expect(await dialog2.locator('[data-plugin-entry="include:typert-gateway:mkt-e2e-config"]').count()).toBe(0)
    },
    120_000,
  )

  it(
    'badges a plugin whose declared peer this harness does not provide, and still installs on confirm',
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

      // The catalog entry declares peers: ["@deepseek-ai/dsh-client-store"]
      // (the real module whose absence broke a real user's harness on the
      // 0.1.1-rc.2 line); this profile never installs it, so the host's
      // nodeResolver (src/host/peers.ts), anchored at the profile root, finds
      // it unresolvable and the badge renders — its raw name lands in the
      // card's visible text via the always-rendered incompatibleDetail line,
      // not just the badge's title attribute.
      await card.locator('[data-shop-incompatible]').waitFor({ state: 'visible', timeout: 15_000 })
      expect(await card.textContent()).toContain('@deepseek-ai/dsh-client-store')
      expect(await card.locator('[data-shop-incompatible]').textContent()).toBe(zh.incompatibleBadge)

      // The copy is two sentences separated by a `\n` it carries itself, and
      // NOTHING else in this suite can prove that renders. The component tests
      // stub `t` with a hand-rolled dictionary lookup, so they establish only
      // that the dictionary holds a newline — whether the harness's own i18n
      // passes it through untouched, and whether the bundled stylesheet still
      // says pre-line by the time a browser reads it, are answerable only
      // here, against the real dsh and a real chromium.
      const detail = card.locator('[data-shop-incompatible-detail]')
      await detail.waitFor({ state: 'visible', timeout: 15_000 })
      const shape = await detail.evaluate(el => ({ text: el.textContent ?? '', whiteSpace: getComputedStyle(el).whiteSpace }))
      expect(shape.text, 'the harness i18n dropped the newline the copy carries').toContain('\n')
      expect(shape.whiteSpace, 'pre-line did not survive into the bundled stylesheet').toBe('pre-line')

      // Install → the community-tier gate opens and shows the
      // incompatibility warning alongside the §9.3 acknowledgement.
      await card.locator('[data-shop-install]').click()
      await card.locator('[data-shop-confirm]').waitFor({ state: 'visible', timeout: 10_000 })
      // The gate does NOT restate what is missing: the card above it already
      // does, and both rendering the same two lines printed them twice. The
      // outdated row is the one surface that still needs the gate to say it,
      // and it has no card detail to duplicate.
      expect(await card.locator('[data-shop-incompatible-warning]').count()).toBe(0)
      expect(await card.locator('[data-shop-incompatible-detail]').count()).toBe(1)

      // Confirm → warn, never block: the real pnpm install only warns on the
      // unresolvable peer (the profile's autoInstallPeers: false, same as
      // every real dsh profile) and still reaches its terminal done state —
      // never the failed or rejected view.
      await card.locator('[data-shop-confirm]').click()
      await card.locator('[data-shop-restart-notice]').waitFor({ state: 'visible', timeout: 60_000 })
    },
    120_000,
  )
})
