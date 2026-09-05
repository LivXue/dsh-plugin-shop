import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  cleanHotDir, hotMount, hotUnmount, listHotMounts, parseSimplePatch, renderRows,
  type HotFs,
} from '../../src/host/hot.ts'
import { JSON_SCHEMA, load } from 'js-yaml'
import { fileTempRoot } from './temp-root.ts'

const TEMP_ROOT = fileTempRoot('hot')

describe('parseSimplePatch', () => {
  it('parses plain id/name insert rows', () => {
    expect(parseSimplePatch('- insert:\n    - id: hello\n      name: dsh-hello-plugin\n')).toEqual([
      { id: 'hello', name: 'dsh-hello-plugin' },
    ])
  })

  it('parses multiple rows and strips comments', () => {
    const text = ['# a comment', '- insert:', '    - id: a', '      name: pkg-a', '    - id: b', '      name: pkg-b'].join('\n') + '\n'
    expect(parseSimplePatch(text)).toEqual([
      { id: 'a', name: 'pkg-a' },
      { id: 'b', name: 'pkg-b' },
    ])
  })

  it('parses CRLF lines (the Windows-patch regression their hot.ts documents)', () => {
    expect(parseSimplePatch('- insert:\r\n    - id: hello\r\n      name: dsh-hello-plugin\r\n')).toEqual([
      { id: 'hello', name: 'dsh-hello-plugin' },
    ])
  })

  it('rejects config/expression rows', () => {
    expect(parseSimplePatch('- insert:\n    - id: hello\n      name: dsh-hello-plugin\n      config:\n        foo: 1\n')).toBe(null)
    expect(parseSimplePatch('- insert:\n    - id: hello\n      name: !!js/expression foo()\n')).toBe(null)
    // A bare id-keyed row TARGETS an entry the bundle layer already composed;
    // replicating it hot would invent a row boot never had.
    expect(parseSimplePatch('- id: hello\n  name: dsh-hello-plugin\n')).toBe(null)
    // An insert into a named group targets a group this subtree does not have.
    expect(parseSimplePatch('- id: some-group\n  insert:\n    - id: hello\n      name: dsh-hello-plugin\n')).toBe(null)
  })

  it('rejects a trailing dangling id and empty text', () => {
    expect(parseSimplePatch('- insert:\n    - id: hello\n')).toBe(null)
    expect(parseSimplePatch('')).toBe(null)
  })
})

describe('renderRows (F-4)', () => {
  it('emits a scoped module name the Include dialect can parse', () => {
    const text = renderRows([{ id: 'archify', name: '@tt-a1i/archify-dsh' }], 'mkt-')
    expect(load(text, { schema: JSON_SCHEMA })).toEqual([{ id: 'mkt-archify', name: '@tt-a1i/archify-dsh' }])
  })

  it('emits an unscoped name unchanged, byte for byte', () => {
    expect(renderRows([{ id: 'hello', name: 'dsh-hello-plugin' }], 'mkt-'))
      .toBe('- id: mkt-hello\n  name: dsh-hello-plugin\n')
  })

  it('survives every scalar a package name or id can carry', () => {
    for (const name of ['@deepseek-ai/dsh-skill-filesystem', '{{PKG_NAME}}', 'yes', 'no', 'null', '1.0', '- dash', 'a: colon', '*star', '#hash', 'tab\tinside']) {
      const text = renderRows([{ id: 'x', name }], 'mkt-')
      expect(load(text, { schema: JSON_SCHEMA }), name).toEqual([{ id: 'mkt-x', name }])
    }
  })

  it('round-trips several rows', () => {
    const text = renderRows([{ id: 'a', name: '@scope/a' }, { id: 'b', name: 'b' }], 'mkt-')
    expect(load(text, { schema: JSON_SCHEMA })).toEqual([
      { id: 'mkt-a', name: '@scope/a' },
      { id: 'mkt-b', name: 'b' },
    ])
  })
})

class FakeHotTree {
  static lastInstance: FakeHotTree | null = null
  path: string
  constructor(_ctx: unknown, config: { path: string }) { this.path = config.path; FakeHotTree.lastInstance = this }
  write(): void { /* suppressed in the subclass; faked here */ }
  import(name: string): unknown { return { name } }
}

const PROFILE = '/home/user/.dsh'
const PKG_DIR = join(PROFILE, 'node_modules', 'dsh-hello-plugin')
const HOT_DIR = join(PROFILE, '.dsh-shop')

/** An in-memory stand-in for the node:fs surface hot.ts uses (like
 * catalog.test.ts's memFs): reads and lists throw ENOENT on missing paths,
 * writes register their parent directory. */
function memFs(): HotFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  return {
    files,
    read: p => {
      const value = files.get(p)
      if (value === undefined) throw new Error(`ENOENT: ${p}`)
      return value
    },
    write: (p, data) => {
      dirs.add(dirname(p))
      files.set(p, data)
    },
    list: p => {
      if (!dirs.has(p)) throw new Error(`ENOENT: ${p}`)
      const prefix = p.endsWith('/') ? p : p + '/'
      return [...files.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
    },
  }
}

/** Seed an installed package: its package.json dsh field and one plain
 * patch file. */
function seedPackage(fs: { files: Map<string, string> }, patch: string): void {
  fs.files.set(join(PKG_DIR, 'package.json'), JSON.stringify({
    name: 'dsh-hello-plugin',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  fs.files.set(join(PKG_DIR, 'cordis.patch.yml'), patch)
}

function testCtx(handle: { await(): Promise<unknown>; dispose(): Promise<unknown> | void }) {
  return {
    // Like cordis, `ctx.plugin` constructs the plugin class with the context
    // and config; the fake records the instance.
    plugin: (plugin: unknown, config: unknown) => {
      new (plugin as new (ctx: unknown, config: unknown) => unknown)({}, config)
      return handle
    },
    logger: { info: () => {}, warn: () => {} },
  }
}

describe('hotMount / hotUnmount', () => {
  afterEach(async () => {
    for (const name of listHotMounts()) await hotUnmount(name)
  })

  it('mounts a simple patch, then unmounts and disposes the tree', async () => {
    const fs = memFs()
    seedPackage(fs, '- insert:\n    - id: hello\n      name: dsh-hello-plugin\n')
    let disposed = false
    const ctx = testCtx({ await: async () => {}, dispose: async () => { disposed = true } })

    const result = await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 })

    expect(result).toEqual({ ok: true, reason: null })
    // The hot file is written under the shop namespace with mkt- ids, and
    // the tree was created against its file URL. It is an ENTRY list (the
    // Include tree reads entries), not a patch list — so it is asserted as
    // written, not round-tripped through the patch parser.
    expect(fs.files.get(join(HOT_DIR, 'hot-1.yml'))).toBe('- id: mkt-hello\n  name: dsh-hello-plugin\n')
    expect(FakeHotTree.lastInstance?.path).toBe(pathToFileURL(join(HOT_DIR, 'hot-1.yml')).href)
    expect(listHotMounts()).toContain('dsh-hello-plugin')

    expect(await hotUnmount('dsh-hello-plugin')).toBe(true)
    expect(disposed).toBe(true)
    expect(await hotUnmount('dsh-hello-plugin')).toBe(false)
    expect(listHotMounts()).not.toContain('dsh-hello-plugin')
  })

  it('mounts a package whose patch inserts a scoped module', async () => {
    const fs = memFs()
    seedPackage(fs, "- insert:\n    - id: archify\n      name: '@tt-a1i/archify-dsh'\n")
    const ctx = testCtx({ await: async () => {}, dispose: async () => {} })
    const result = await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 })
    expect(result).toEqual({ ok: true, reason: null })
    expect(fs.files.get(join(HOT_DIR, 'hot-1.yml'))).toBe("- id: mkt-archify\n  name: '@tt-a1i/archify-dsh'\n")
  })

  it('numbers a second mount in the same session hot-2.yml', async () => {
    const fs = memFs()
    seedPackage(fs, '- insert:\n    - id: hello\n      name: dsh-hello-plugin\n')
    const ctx = testCtx({ await: async () => {}, dispose: async () => {} })

    await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 })
    await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 })

    expect(fs.files.get(join(HOT_DIR, 'hot-1.yml'))).not.toBeUndefined()
    expect(fs.files.get(join(HOT_DIR, 'hot-2.yml'))).not.toBeUndefined()
  })

  it('disposes the previous handle before activating a re-mount of the same package', async () => {
    const fs = memFs()
    seedPackage(fs, '- insert:\n    - id: hello\n      name: dsh-hello-plugin\n')
    // Order of side effects across the two mounts: the first registration
    // yields a handle whose dispose records, the second a handle whose
    // activation records — so a both-dead "replace without dispose" bug would
    // leave the sequence short of dispose-first.
    const events: string[] = []
    let calls = 0
    const ctx = {
      plugin: (plugin: unknown, config: unknown) => {
        new (plugin as new (ctx: unknown, config: unknown) => unknown)({}, config)
        calls++
        return calls === 1
          ? { await: async () => {}, dispose: async () => { events.push('dispose-first') } }
          : { await: async () => { events.push('await-second') }, dispose: async () => {} }
      },
      logger: { info: () => {}, warn: () => {} },
    }

    await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 })
    expect(events).toEqual([])

    await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 })

    // The first handle's dispose is awaited before the second activation is
    // raced, not merely replaced in the map.
    expect(events).toEqual(['dispose-first', 'await-second'])
  })

  it('times out a never-settling activation, disposes the tree, and reports the timeout reason code', async () => {
    const fs = memFs()
    seedPackage(fs, '- insert:\n    - id: hello\n      name: dsh-hello-plugin\n')
    let disposed = false
    const never = new Promise<unknown>(() => {})
    const ctx = testCtx({ await: () => never, dispose: async () => { disposed = true } })

    const result = await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1 })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('timeout')
    expect(disposed).toBe(true)
    expect(listHotMounts()).not.toContain('dsh-hello-plugin')
  })

  it('falls back when activation fails, disposing the tree', async () => {
    const fs = memFs()
    seedPackage(fs, '- insert:\n    - id: hello\n      name: dsh-hello-plugin\n')
    let disposed = false
    const ctx = testCtx({ await: async () => { throw new Error('activation boom') }, dispose: async () => { disposed = true } })

    const result = await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('mount-failed')
    expect(disposed).toBe(true)
    expect(listHotMounts()).not.toContain('dsh-hello-plugin')
  })

  it('falls back when the include plugin is unavailable, writing no file', async () => {
    const fs = memFs()
    seedPackage(fs, '- insert:\n    - id: hello\n      name: dsh-hello-plugin\n')

    const result = await hotMount(
      { plugin: () => { throw new Error('must not be called') }, logger: { info: () => {}, warn: () => {} } },
      PROFILE, 'dsh-hello-plugin', { hotTreeClass: null, fs, dir: HOT_DIR, timeoutMs: 1000 },
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('host-unsupported')
    expect(fs.files.has(join(HOT_DIR, 'hot-1.yml'))).toBe(false)
  })

  it('degrades to restart activation when the tree class is not a constructor', async () => {
    const fs = memFs()
    seedPackage(fs, '- insert:\n    - id: hello\n      name: dsh-hello-plugin\n')

    const result = await hotMount(
      { plugin: () => { throw new Error('must not be called') }, logger: { info: () => {}, warn: () => {} } },
      PROFILE, 'dsh-hello-plugin', { hotTreeClass: 42, fs, dir: HOT_DIR, timeoutMs: 1000 },
    )

    // Building the subclass over a non-constructor throws; the build sits
    // inside the fallback, so the call degrades instead of throwing.
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('mount-failed')
  })

  it('falls back with the no-patch reason code when the package has no patch file', async () => {
    const fs = memFs()

    const result = await hotMount(
      { plugin: () => { throw new Error('must not be called') }, logger: { info: () => {}, warn: () => {} } },
      PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 },
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no-patch')
    expect(fs.files.has(join(HOT_DIR, 'hot-1.yml'))).toBe(false)
  })

  it('refuses a bundle patch path that escapes the package directory (F-10)', async () => {
    const fs = memFs()
    const reads: string[] = []
    const watched: HotFs = {
      read: path => { reads.push(path); return fs.read(path) },
      write: fs.write,
      list: fs.list,
    }
    fs.files.set(join(PKG_DIR, 'package.json'), JSON.stringify({
      name: 'dsh-hello-plugin', version: '1.0.0',
      dsh: { bundle: { patch: '../../../../../etc/hostile.yml' } },
    }))
    fs.files.set('/etc/hostile.yml', '- insert:\n    - id: pwned\n      name: hostile\n')
    const ctx = testCtx({ await: async () => {}, dispose: async () => {} })
    const result = await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs: watched, dir: HOT_DIR, timeoutMs: 1000 })
    expect(result).toEqual({ ok: false, reason: 'no-patch' })
    expect(reads).not.toContain('/etc/hostile.yml')
    expect(fs.files.get(join(HOT_DIR, 'hot-1.yml'))).toBeUndefined()
  })

  it('still reads a patch in a subdirectory of the package', async () => {
    const fs = memFs()
    fs.files.set(join(PKG_DIR, 'package.json'), JSON.stringify({
      name: 'dsh-hello-plugin', version: '1.0.0',
      dsh: { bundle: { patch: './dsh/cordis.patch.yml' } },
    }))
    fs.files.set(join(PKG_DIR, 'dsh', 'cordis.patch.yml'), '- insert:\n    - id: hello\n      name: dsh-hello-plugin\n')
    const ctx = testCtx({ await: async () => {}, dispose: async () => {} })
    const result = await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 })
    expect(result).toEqual({ ok: true, reason: null })
  })
})

describe('cleanHotDir', () => {
  it('wipes only this session\'s hot-<n>.yml files', () => {
    const root = mkdtempSync(join(TEMP_ROOT, 'dsh-shop-hot-'))
    try {
      const profileDir = join(root, 'profile')
      const hotDir = join(profileDir, '.dsh-shop')
      mkdirSync(hotDir, { recursive: true })
      writeFileSync(join(hotDir, 'hot-1.yml'), '- id: mkt-a\n  name: pkg-a\n')
      writeFileSync(join(hotDir, 'hot-2.yml'), '- id: mkt-b\n  name: pkg-b\n')
      writeFileSync(join(hotDir, 'hot-keep.txt'), 'not a mount input')
      writeFileSync(join(hotDir, 'notes.yml'), 'not a mount input')

      cleanHotDir(profileDir)

      expect(readdirSync(hotDir).sort()).toEqual(['hot-keep.txt', 'notes.yml'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('is a no-op when the namespace directory does not exist', () => {
    const root = mkdtempSync(join(TEMP_ROOT, 'dsh-shop-hot-'))
    try {
      const profileDir = join(root, 'profile')
      cleanHotDir(profileDir)
      // `not.toThrow()` alone would also pass if cleanHotDir created the
      // directory on its way past, which is the opposite of a no-op (H-9).
      expect(existsSync(profileDir)).toBe(false)
      expect(existsSync(join(profileDir, '.dsh-shop'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
