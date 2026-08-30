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
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstall } from '../../src/host/executor.ts'
import { startCatalogServer, type CatalogServer } from '../fixtures/catalog-server.ts'

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
  let tmpHome = ''
  let webUrl = ''
  let dshProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let page: Page | undefined

  const shopPackageDir = fileURLToPath(new URL('../../', import.meta.url))
  const helloFixtureDir = fileURLToPath(
    new URL('../fixtures/hello-packages/dsh-plugin-shop', import.meta.url),
  )

  beforeAll(async () => {
    catalogServer = await startCatalogServer()
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
      expect(await card.textContent()).toContain('社区')

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
      // reaches the terminal state: pnpm fails against the real registry
      // (the name is not on npm), and the failed view renders the heading
      // plus the §10 recovery hint with the last pnpm stderr line.
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
})
