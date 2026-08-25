/**
 * Minimal `window.__ModuleLoader__` for tests: the published dsh client
 * packages ship their browser bundles (a `__ModuleLoader__.load` handoff) as
 * the `./client` default, and jsdom has no loader. This shim mirrors the web
 * shell's loader contract — one module-table entry per requested package:
 * a required specifier with a `./client` export loads that package's bundle
 * through this same loader; non-bundle rows (react, cordis, ...) come from
 * the requiring bundle's own node_modules. `loadModule` lets the test itself
 * fetch modules through the loader, so every cordis instance in the process
 * is node's single copy.
 */
import { createRequire } from 'node:module'

declare global {
  interface Window {
    __ModuleLoader__?: {
      load(contribution: { id: string; factory: (require: (specifier: string) => unknown) => unknown }): unknown
    }
  }
}

const resolveFromHere = createRequire(import.meta.url)
const table = new Map<string, unknown>()
const loading = new Set<string>()

// Baseline externals the web shell seeds into the module table itself, which
// have no node-loadable form here: the primitives' published half is ESM that
// imports `.module.css` files, which node's ESM loader rejects. The locale
// bundle dereferences only these two symbols, and only inside a render path
// this suite never reaches; a missing symbol would throw loudly, not render
// garbage.
for (const [specifier, exports] of Object.entries({
  '@deepseek-ai/dsh-client-ui-primitives': {
    Menu: undefined,
    IconChevronDownOutline14: undefined,
  },
} as Record<string, unknown>)) {
  table.set(specifier, exports)
}

window.__ModuleLoader__ = {
  load({ id, factory }) {
    const bundlePath = resolveFromHere.resolve(`${id}/client`)
    const requireRow = (specifier: string): unknown => {
      const cached = table.get(specifier)
      if (cached !== undefined) return cached
      if (loading.has(specifier)) {
        throw new Error(`__loader__: circular module-table request for ${specifier}`)
      }
      loading.add(specifier)
      try {
        const packageId = specifier.replace(/\/client$/, '')
        const fromChild = table.get(packageId)
        if (fromChild !== undefined) return fromChild
        let childPath: string | undefined
        try {
          childPath = resolveFromHere.resolve(`${packageId}/client`)
        } catch {
          childPath = undefined
        }
        if (childPath === undefined) {
          // Non-bundle row (react, cordis, ...): the publisher's node_modules.
          const row = createRequire(bundlePath)(specifier)
          table.set(specifier, row)
          return row
        }
        // A bundle row: require the child file, whose own load handoff records
        // its exports under its package id.
        createRequire(bundlePath)(childPath)
        const row = table.get(packageId)
        if (row === undefined) {
          throw new Error(`__loader__: no contribution recorded for ${packageId}`)
        }
        table.set(specifier, row)
        return row
      } finally {
        loading.delete(specifier)
      }
    }
    const exports = factory(requireRow)
    table.set(id, exports)
    return exports
  },
}

/** Load a module through the loader: its browser bundle when it has a
 * `./client` export, its published main otherwise. */
export function loadModule<T>(specifier: string): T {
  const packageId = specifier.replace(/\/client$/, '')
  const recorded = table.get(packageId)
  if (recorded !== undefined) return recorded as T
  let path: string
  try {
    path = resolveFromHere.resolve(`${packageId}/client`)
  } catch {
    path = resolveFromHere.resolve(specifier)
  }
  // For a bundle, requiring the file executes its load handoff synchronously;
  // for a plain package this is an ordinary require.
  const required = createRequire(path)(path)
  const row = table.get(packageId)
  return (row ?? required) as T
}
