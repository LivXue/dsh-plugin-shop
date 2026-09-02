/** The catalog's npm package: its version and its non-data files.
 *
 * Pure — no clock, no filesystem, no network. `publish-catalog.ts` supplies
 * the date and the published `latest`, and writes what this returns.
 *
 * The data files themselves are NOT built here: they are the bytes
 * `build.ts` already wrote to `dist/v1/`, copied verbatim. One build, two
 * transports (design §2) — a second generator would be free to drift. */

export interface CatalogPackageInput {
  version: string
  /** The build time, from the emitted `index.json`. Readme only: it must not
   * enter any hashed content. */
  builtAt: string
  count: number
  pluginsFileName: string
  starsFileName: string | null
  /** The content hashes this build produced. Published as `catalogShas` so
   * the next build can decide whether anything changed by reading the
   * packument, instead of downloading and unpacking the previous tarball. */
  shas: { plugins: string; stars: string | null }
}

export interface CatalogPackageFiles {
  packageJson: string
  indexJs: string
  readme: string
}

const PACKAGE_NAME = 'dsh-plugin-shop-catalog'

/**
 * The next version in the `YYYY.MMDD.N` scheme (design §2).
 *
 * `MMDD` is `month * 100 + day`, unpadded, which keeps the field numeric and
 * monotonic: 1015 > 901 within a year, and the year field carries the
 * rollover. `N` counts builds within one UTC day.
 */
export function nextCatalogVersion(today: Date, publishedLatest: string | null): string {
  const prefix = `${today.getUTCFullYear()}.${(today.getUTCMonth() + 1) * 100 + today.getUTCDate()}.`
  if (publishedLatest !== null && publishedLatest.startsWith(prefix)) {
    const counter = Number.parseInt(publishedLatest.slice(prefix.length), 10)
    // A latest we cannot parse restarts at 0 rather than guessing: npm
    // refuses a duplicate version, so a wrong guess fails the publish loudly
    // instead of overwriting anything.
    if (Number.isInteger(counter) && counter >= 0) return `${prefix}${counter + 1}`
  }
  return `${prefix}0`
}

/** The package's own files. The `v1/` tree is copied, not generated. */
export function catalogPackageFiles(input: CatalogPackageInput): CatalogPackageFiles {
  const packageJson = `${JSON.stringify({
    name: PACKAGE_NAME,
    version: input.version,
    description: 'The dsh plugin catalog, as published by dsh-plugin-shop.',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/LivXue/dsh-plugin-shop.git' },
    homepage: 'https://github.com/LivXue/dsh-plugin-shop',
    keywords: ['dsh', 'deepseek-harness', 'plugin', 'catalog'],
    type: 'commonjs',
    main: 'index.js',
    files: ['v1', 'index.js'],
    catalogShas: input.shas,
  }, null, 2)}\n`

  const starsLine = input.starsFileName === null
    ? 'const starsPath = null'
    : `const starsPath = join(__dirname, 'v1', ${JSON.stringify(input.starsFileName)})`

  // CommonJS on purpose: this is a data package that any tool should be able
  // to require() without caring about its own module system.
  const indexJs = `/** The dsh plugin catalog, as published by dsh-plugin-shop. */

const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const indexPath = join(__dirname, 'v1', 'index.json')
const pluginsPath = join(__dirname, 'v1', ${JSON.stringify(input.pluginsFileName)})
${starsLine}

/** The pointer: schemaVersion, builtAt, count, and the data file's sha256. */
function readIndex() {
  return JSON.parse(readFileSync(indexPath, 'utf8'))
}

/** The catalog itself: { schemaVersion, plugins, denied }. */
function readPlugins() {
  return JSON.parse(readFileSync(pluginsPath, 'utf8'))
}

/** GitHub star counts by package name, or null when this build published none. */
function readStars() {
  return starsPath === null ? null : JSON.parse(readFileSync(starsPath, 'utf8'))
}

module.exports = { indexPath, pluginsPath, starsPath, readIndex, readPlugins, readStars }
`

  const readme = `# dsh-plugin-shop-catalog

The plugin catalog published by [dsh-plugin-shop](https://github.com/LivXue/dsh-plugin-shop),
packaged so it can be read from an npm registry as well as from the web.

- Build: \`${input.builtAt}\`
- Listed plugins: ${input.count}

The same bytes are served at
<https://LivXue.github.io/dsh-plugin-shop/v1/>. This package exists so a
reader whose link to GitHub is slow can take the catalog from a nearby npm
mirror instead; the shop races both and uses whichever answers first.

\`\`\`js
const catalog = require('dsh-plugin-shop-catalog')

catalog.readIndex()    // { schemaVersion, builtAt, count, plugins: { url, sha256 }, ... }
catalog.readPlugins()  // { schemaVersion, plugins: [...], denied: [...] }
catalog.readStars()    // { stars: { "<name|owner/repo>": <count> } } or null
\`\`\`

\`readIndex().plugins.sha256\` is the sha256 of the file \`readPlugins()\`
parses; verifying it is how the shop binds the pointer to the data, and any
consumer can do the same.

Versions are \`YYYY.MMDD.N\`. Published from CI on each catalog build; a
version is never republished.
`

  return { packageJson, indexJs, readme }
}
