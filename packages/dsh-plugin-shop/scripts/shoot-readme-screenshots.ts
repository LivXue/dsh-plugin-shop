/**
 * Reshoot the six README screenshots.
 *
 * `pnpm -C packages/dsh-plugin-shop shoot:screenshots`
 *
 * Committed because it had been rewritten from scratch three times: every
 * previous shoot was a throwaway, so each one re-derived the boot sequence,
 * the selectors and the onboarding workaround — and the third rediscovery is
 * what produced the three unusable images this replaces.
 *
 * Needs a real `dsh` on PATH and a playwright chromium, like the e2e does.
 *
 * Three of the six on disk were captured with the "Add an API key to get
 * started" modal covering the page. Clicking through that modal is what the
 * previous shoot did, and it is fragile twice over: the dismissal is per page
 * load, so reloading for the next theme brings it back, and its button label
 * moves with the locale.
 *
 * This seeds $DSH_HOME/settings.yaml instead, so neither onboarding dialog is
 * ever raised — and it takes locale and theme from that file rather than from
 * browser emulation, which makes both deterministic. assertUnobstructed then
 * REFUSES to write a file while any dialog but Settings is visible, which is
 * the check the previous shoot did not have.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { gte } from 'semver'
import { isSeq, parseDocument } from 'yaml'
import { welcomeNoticeVersion } from '../tests/fixtures/onboarding.ts'

/** The version the READMEs tell a reader to install, read from a README
 * rather than restated here.
 *
 * The screenshot shows the shop's version badge, and the install command sits
 * a few lines above the image in the same file — a hardcoded copy here goes
 * stale at the next release and puts a badge in the picture that disagrees
 * with the command beside it. Same pin `readme-pins.test.ts` guards, and the
 * same expression it matches with. The workspace version is deliberately NOT
 * used: it is a beta nobody can install yet. */
function readmePin(): string {
  const readme = readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8')
  const pin = /dsh-plugin-shop@(\d[^\s`]*)/.exec(readme)?.[1]
  if (pin === undefined) throw new Error('README.md carries no dsh-plugin-shop@<version> install pin')
  return pin
}

const SHOP_VERSION = process.env.SHOP_VERSION ?? readmePin()
// Resolved from this module, never the cwd: an absolute path baked in from one
// machine, or a cwd-relative one, both write the images somewhere else the
// moment the script is run from anywhere but where it was written.
const OUT = process.env.OUT_DIR ?? fileURLToPath(new URL('../../../docs/images', import.meta.url))
const GATE_TARGET = '@ahggg/dsh-side-chat'

// `plugins` is the Settings section the shop's tab lives under. dsh 0.1.5
// labels it Plugins / 插件; 0.1.7 relabels the same section Built-in plugins /
// 内置插件 (`dsh-client-ui-settings-plugins`), because the plain word now names
// the sidebar's own plugin-manager page. Anchored, so it matches nothing else.
// `firstRun` opens the toast dsh-client-ui-workspace raises when it cannot
// create the default workspace (`defaultWorkspace.failed`); see waitForFirstRun.
const T = {
  en: { settings: 'Settings', plugins: /^(?:Plugins|Built-in plugins)$/, shop: 'Plugin shop', install: 'Install', search: 'Search plugins', firstRun: 'Unable to create default workspace' },
  zh: { settings: '设置', plugins: /^(?:插件|内置插件)$/, shop: '插件商店', install: '安装', search: '搜索插件', firstRun: '无法创建默认工作区' },
} as const
type Lang = keyof typeof T

function seedSettings(home: string, lang: Lang, theme: 'light' | 'dark', notice: string): void {
  // A configured provider suppresses "Add an API key to get started";
  // welcomeNoticeVersion suppresses the first-run notice, at the version the
  // dsh on PATH compares (tests/fixtures/onboarding.ts). The key is an obvious
  // placeholder — these captures never send a model request, and the profile
  // is a temp directory removed at the end.
  writeFileSync(join(home, 'settings.yaml'), [
    'agent-default-model:',
    '  provider: deepseek-official',
    '  model: deepseek-v4-pro',
    'ui-onboarding:',
    `  welcomeNoticeVersion: ${notice}`,
    'locale:',
    `  preference: ${lang}`,
    'ui-theme:',
    `  preference: ${theme}`,
    '',
  ].join('\n'))
  // 0600, and chmod after the write: dsh-credentials-local refuses to boot on
  // a credentials file readable beyond its owner, and writeFileSync's `mode`
  // applies only when it CREATES the file — rewriting it each step leaves the
  // first write's 644 in place and every boot after the first fails.
  const credentials = join(home, '.credentials.yaml')
  writeFileSync(credentials,
    'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-screenshot-placeholder-not-a-key\n', { mode: 0o600 })
  chmodSync(credentials, 0o600)
}

async function assertUnobstructed(page: Page, shot: string, allow: string): Promise<void> {
  const dialogs = page.locator('[role="dialog"]')
  for (let i = 0; i < await dialogs.count(); i += 1) {
    const one = dialogs.nth(i)
    if (!await one.isVisible().catch(() => false)) continue
    const label = (await one.getAttribute('aria-label'))
      ?? ((await one.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 60)
    if (label.includes(allow)) continue
    throw new Error(`${shot}: a dialog is covering the page — ${JSON.stringify(label)}`)
  }
}

async function bootWeb(home: string): Promise<{ url: string; proc: ChildProcess }> {
  const proc = spawn('dsh', ['--profile', 'web', '--no-open', '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSH_HOME: home }, detached: true })
  const out: string[] = []
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no URL:\n${out.join('\n')}`)), 120_000)
    proc.stdout?.on('data', (c: Buffer) => {
      for (const line of c.toString().split('\n')) {
        if (line === '') continue
        out.push(line)
        const m = /dsh web: (http:\/\/\S+)/.exec(line)
        if (m?.[1] !== undefined) { clearTimeout(timer); resolve(m[1]) }
      }
    })
    proc.stderr?.on('data', (c: Buffer) => out.push(c.toString()))
    proc.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`dsh exited ${String(code)}:\n${out.slice(-25).join('\n')}`))
    })
  })
  return { url, proc }
}

function kill(proc: ChildProcess | undefined): void {
  if (proc?.pid === undefined) return
  try { process.kill(-proc.pid, 'SIGTERM') } catch { proc.kill() }
}

/**
 * Keep dsh 0.1.7's first-use workspace from being created, so its failure toast
 * is raised on every platform and nothing navigates.
 *
 * The same recipe as `seedNoDefaultWorkspace` in web-full-flow.e2e.ts, which
 * records why: 0.1.7 creates `<Documents>/deepseek-harness/default-workspace` on
 * first load and navigates into it, which closes an open Settings dialog. A
 * Documents path that is a regular file makes the creation fail instead.
 */
function seedNoDefaultWorkspace(home: string): void {
  const blocker = join(home, 'documents-is-a-file')
  writeFileSync(blocker, 'A file, so the first-use workspace cannot be created under it (seedNoDefaultWorkspace).\n')
  const layer = join(home, 'profiles', 'web', 'cordis.patch.yml')
  const document = parseDocument(readFileSync(layer, 'utf8'))
  if (!isSeq(document.contents)) throw new Error(`${layer} is not a YAML list of patch rows`)
  document.contents.flow = false
  document.add({ id: 'workspace-controller', config: { documentsDirectory: blocker } })
  writeFileSync(layer, document.toString({ lineWidth: 0 }))
}

/**
 * Let dsh 0.1.7's first run finish before Settings opens, or it closes the
 * dialog.
 *
 * When the host first answers the sessions list, an onboarding step appears,
 * and dsh-client-ui-settings-general closes an open Settings dialog. That
 * happens once per page load. The e2e's waitForFirstRun has the measurement. Its
 * signal is the default-workspace toast, which seedNoDefaultWorkspace
 * guarantees. On 2026-10-06 the second boot of a reshoot on 0.2.0-rc.2 lost
 * exactly this race: the dialog was gone and the shop's cards never appeared.
 * The toast is also waited OUT, three seconds, so that no capture contains it.
 */
async function waitForFirstRun(page: Page, lang: Lang, dshVersion: string): Promise<void> {
  if (!gte(dshVersion, '0.1.7-rc.1')) return
  const toast = page.getByRole('alert').filter({ hasText: T[lang].firstRun })
  await toast.waitFor({ state: 'visible', timeout: 30_000 })
  await toast.waitFor({ state: 'hidden', timeout: 15_000 })
}

async function openShop(page: Page, url: string, lang: Lang, dshVersion: string): Promise<void> {
  const t = T[lang]
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 60_000 })
  await waitForFirstRun(page, lang, dshVersion)
  await page.getByRole('button', { name: t.settings, exact: true }).click({ timeout: 30_000 })
  const dialog = page.getByRole('dialog', { name: t.settings })
  await dialog.waitFor({ state: 'visible', timeout: 15_000 })
  await dialog.getByRole('button', { name: t.plugins }).click()
  await dialog.getByRole('tab', { name: t.shop }).click()
  await dialog.locator('[data-shop-tab]').waitFor({ state: 'visible', timeout: 30_000 })
  // The live catalog is a network fetch: wait for real entries, not the frame.
  await dialog.locator('[data-shop-entry]').first().waitFor({ state: 'visible', timeout: 90_000 })
  await page.waitForTimeout(1500)
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-shot-home-'))
  let browser: Browser | undefined
  try {
    // dsh compares the notice's acknowledgement for exact equality, and 0.2
    // moved it, so the seed is the one the dsh this script boots carries: the
    // first on PATH, like every spawn here.
    const dsh = spawnSync('dsh', ['--version'], { encoding: 'utf8' })
    if (dsh.status !== 0) throw new Error(`dsh --version failed:\n${dsh.stdout}\n${dsh.stderr}`)
    const dshVersion = dsh.stdout.trim()
    const notice = welcomeNoticeVersion(dshVersion)
    seedSettings(home, 'en', 'light', notice)
    console.log(`installing dsh-plugin-shop@${SHOP_VERSION} — the version the READMEs tell a reader to run`)
    const add = spawnSync('dsh', ['plugin', '--profile', 'web', 'add', `dsh-plugin-shop@${SHOP_VERSION}`],
      { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
    if (add.status !== 0) throw new Error(`install failed:\n${add.stdout}\n${add.stderr}`)
    if (gte(dshVersion, '0.1.7-rc.1')) seedNoDefaultWorkspace(home)

    browser = await chromium.launch()
    const plan = [
      { lang: 'en', theme: 'light', shelf: 'shelf-light.png', gate: 'gate-light.png' },
      { lang: 'en', theme: 'dark', shelf: 'shelf-dark.png', gate: null },
      { lang: 'zh', theme: 'light', shelf: 'shelf-light.zh.png', gate: 'gate-light.zh.png' },
      { lang: 'zh', theme: 'dark', shelf: 'shelf-dark.zh.png', gate: null },
    ] as const

    for (const step of plan) {
      seedSettings(home, step.lang, step.theme, notice)
      const { url, proc } = await bootWeb(home)
      try {
        const t = T[step.lang]
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
        await openShop(page, url, step.lang, dshVersion)
        await assertUnobstructed(page, step.shelf, t.settings)
        await page.screenshot({ path: join(OUT, step.shelf) })
        console.log(`  wrote ${step.shelf}`)

        if (step.gate !== null) {
          const dialog = page.getByRole('dialog', { name: t.settings })
          // Scoped to the shop's own panel: from dsh 0.2 the Plugin list tab
          // mounted beside it carries a search box with the same placeholder,
          // and a dialog-wide lookup then matches two inputs.
          await dialog.locator('[data-shop-tab]').getByPlaceholder(t.search).fill(GATE_TARGET)
          const card = dialog.locator(`[data-shop-entry="${GATE_TARGET}"]`)
          await card.waitFor({ state: 'visible', timeout: 30_000 })
          await card.getByRole('button', { name: t.install, exact: true }).first().click()
          await dialog.locator('[data-shop-confirm]').waitFor({ state: 'visible', timeout: 15_000 })
          await page.waitForTimeout(800)
          await assertUnobstructed(page, step.gate, t.settings)
          await page.screenshot({ path: join(OUT, step.gate) })
          console.log(`  wrote ${step.gate}`)
        }
        await page.close()
      } finally {
        kill(proc)
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    console.log('all six written')
  } finally {
    await browser?.close().catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
}

await main()
