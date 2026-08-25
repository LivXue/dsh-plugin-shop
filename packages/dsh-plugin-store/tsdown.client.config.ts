/**
 * Browser client bundle for the dsh `dsh.client` convention: a self-contained
 * CJS closure handed to `window.__ModuleLoader__.load`, with the loader's
 * `require` answering only the seeded module-table baseline (react, cordis,
 * slots, primitives, runtime). Everything else the client source reaches —
 * zod, the generated `./remote` face — is bundled into `lib/client.js`; a
 * `require()` the table cannot answer is a guaranteed runtime throw, so the
 * rule is the package's own request list: baseline specifiers stay imports,
 * everything else inlines. Mirrors `clientConfig()` in the dsh source
 * checkout (`/tmp/dsh/packages/client/tsdown.client.ts`).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { name: string }
const id = pkg.name

/** Deterministic content-derived class-name hash (FNV-1a 32-bit, hex): no
 * clock, no entropy — the same css maps to the same names on every build. */
function hashOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** CSS modules for the browser half, resolved the way the dsh pipeline does
 * it (`/tmp/dsh/packages/client/tsdown.client.ts`): every local class name is
 * mapped to `[hash]_[local]`, the same names replace the selectors in the
 * injected stylesheet, and the style tag lands at factory execution — scoped
 * so a collision with another plugin's classes cannot leak styles. The dsh
 * pipeline transforms with lightningcss; this rewrite covers the selector
 * subset the store tab emits (`.local` class selectors only — no class names
 * inside string/url() values, which this package's css never does). */
const CSS_MODULE = '\0dsh-plugin-store-css:'
// Virtual ids must not end in `.css`: tsdown's built-in css-guard matches the
// extension and demands @tsdown/css before this plugin's load hook can run.
const cssPaths = new Map<string, string>()

/** Module-table rows the web shell seeds or parser-preloads (never bundled). */
const BASELINE = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])
const isRequested = (specifier: string): boolean => BASELINE.has(specifier)

/** Vendored framework libraries: no cross-plugin runtime identity to share. */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/** Generated descriptor/codec contributions with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

export default {
  name: `${id}/client`,
  entry: { client: 'src/client/index.ts' },
  // Browser bundle lands next to the node half (single lib/ artifact dir; the
  // entryFileNames pin keeps it exactly lib/client.js). clean must stay off —
  // a default clean would wipe the node-half output emitted above.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  // Types ship from lib/types (tsc); dts here would wrap the banner/footer into .d.cts and break parsing.
  dts: false,
  // Plugin code is fetched outside the bundler's module graph, so its own
  // bundle must carry the TS/TSX mapping consumed by browser profiling tools.
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: isRequested,
    // Anything NOT requested from the loader module table must inline — a
    // require() the table cannot answer is a guaranteed runtime throw.
    alwaysBundle: (specifier: string) => !isRequested(specifier),
  },
  // Inlined node-idiom dependencies probe process.env.NODE_ENV (and
  // import.meta.env.MODE through their esm builds); the substitutions keep
  // them working inside the CJS closure, honoring the build's NODE_ENV so a
  // dev build keeps dev-branch semantics. Artifacts default to production.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [
    {
      // css module imports become a virtual module carrying the hashed class
      // map plus the stylesheet, injected once per document under a
      // content-derived style tag id (mirrors the dsh pipeline's style-tag
      // injection; the tag id doubles as the dedupe key).
      name: 'dsh-plugin-store-css-modules',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css') || importer === undefined) return null
        const filename = resolve(dirname(importer), source)
        const virtualId = CSS_MODULE + hashOf(filename)
        cssPaths.set(virtualId, filename)
        return virtualId
      },
      load(id: string) {
        if (!id.startsWith(CSS_MODULE)) return null
        const filename = cssPaths.get(id)
        if (filename === undefined) return null
        const css = readFileSync(filename, 'utf8')
        const locals = new Set<string>()
        for (const match of css.matchAll(/\.([a-zA-Z_][\w-]*)/g)) {
          const name = match[1]
          if (name !== undefined) locals.add(name)
        }
        const names = new Map<string, string>()
        for (const local of locals) {
          names.set(local, `${hashOf(`${filename}:${local}`).slice(0, 6)}_${local}`)
        }
        const rewritten = css.replace(/\.([a-zA-Z_][\w-]*)/g, (match, local: string) => {
          const mapped = names.get(local)
          return mapped === undefined ? match : `.${mapped}`
        })
        const tagKey = hashOf(filename).slice(0, 8)
        return [
          `const css = ${JSON.stringify(rewritten)};`,
          `if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="${tagKey}"]')) {`,
          `  const tag = document.createElement('style');`,
          `  tag.dataset.pluginCss = ${JSON.stringify(tagKey)};`,
          `  tag.textContent = css;`,
          `  document.head.appendChild(tag);`,
          `}`,
          `export default ${JSON.stringify(Object.fromEntries(names))};`,
        ].join('\n')
      },
    },
    {
    // Bundle purity gate (build-time mirror of the module-edge rules): the
    // baseline stays external, inline-safe wire layers inline, and every other
    // @deepseek-ai value import is a build error — a cross-plugin value import
    // either inlines a duplicate runtime instance or requires a specifier the
    // module table cannot answer for this package. Cross-plugin collaboration
    // goes through cordis services instead. (Type-only imports are erased and
    // never reach this gate.)
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (isRequested(source)) return null // requested module-table row: external wins
      if (VENDORED_LIBRARY.test(source)) return null // vendored library: inline, no shared identity
      if (GENERATED_REMOTE.test(source)) return null // wire contribution: inline is the point
      throw new Error(
        `client bundle purity: "${source}" is not in the client baseline, a vendored library, or a generated /remote contribution — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services '
        + '(type-only imports are erased and never reach this gate)',
      )
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    // The web module system activates bundles through this handoff; the
    // factory's require is the loader's module table.
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}
