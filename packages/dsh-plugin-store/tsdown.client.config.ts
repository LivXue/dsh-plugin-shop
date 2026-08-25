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

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { name: string }
const id = pkg.name

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
  plugins: [{
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
