import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  cleanHotDir, hotMount, hotUnmount, listHotMounts, parseSimplePatch,
  type HotFs,
} from '../../src/host/hot.ts'

describe('parseSimplePatch', () => {
  it('parses plain id/name insert rows', () => {
    expect(parseSimplePatch('- id: hello\n  name: dsh-hello-plugin\n')).toEqual([
      { id: 'hello', name: 'dsh-hello-plugin' },
    ])
  })

  it('parses multiple rows and strips comments', () => {
    const text = ['# a comment', '- id: a', '  name: pkg-a', '- id: b', '  name: pkg-b'].join('\n') + '\n'
    expect(parseSimplePatch(text)).toEqual([
      { id: 'a', name: 'pkg-a' },
      { id: 'b', name: 'pkg-b' },
    ])
  })

  it('parses CRLF lines (the Windows-patch regression their hot.ts documents)', () => {
    expect(parseSimplePatch('- id: hello\r\n  name: dsh-hello-plugin\r\n')).toEqual([
      { id: 'hello', name: 'dsh-hello-plugin' },
    ])
  })

  it('rejects config/expression rows', () => {
    expect(parseSimplePatch('- id: hello\n  config:\n    foo: 1\n')).toBe(null)
    expect(parseSimplePatch('- id: hello\n  name: !!js/expression foo()\n')).toBe(null)
  })

  it('rejects a trailing dangling id and empty text', () => {
    expect(parseSimplePatch('- id: hello\n')).toBe(null)
    expect(parseSimplePatch('')).toBe(null)
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
    seedPackage(fs, '- id: hello\n  name: dsh-hello-plugin\n')
    let disposed = false
    const ctx = testCtx({ await: async () => {}, dispose: async () => { disposed = true } })

    const result = await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 })

    expect(result).toEqual({ ok: true, reason: null })
    // The hot file is written under the shop namespace with mkt- ids, and
    // the tree was created against its file URL.
    expect(parseSimplePatch(fs.files.get(join(HOT_DIR, 'hot-1.yml')) ?? '')).toEqual([
      { id: 'mkt-hello', name: 'dsh-hello-plugin' },
    ])
    expect(FakeHotTree.lastInstance?.path).toBe(pathToFileURL(join(HOT_DIR, 'hot-1.yml')).href)
    expect(listHotMounts()).toContain('dsh-hello-plugin')

    expect(await hotUnmount('dsh-hello-plugin')).toBe(true)
    expect(disposed).toBe(true)
    expect(await hotUnmount('dsh-hello-plugin')).toBe(false)
    expect(listHotMounts()).not.toContain('dsh-hello-plugin')
  })

  it('numbers a second mount in the same session hot-2.yml', async () => {
    const fs = memFs()
    seedPackage(fs, '- id: hello\n  name: dsh-hello-plugin\n')
    const ctx = testCtx({ await: async () => {}, dispose: async () => {} })

    await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 })
    await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 })

    expect(fs.files.get(join(HOT_DIR, 'hot-1.yml'))).not.toBeUndefined()
    expect(fs.files.get(join(HOT_DIR, 'hot-2.yml'))).not.toBeUndefined()
  })

  it('disposes the previous handle before activating a re-mount of the same package', async () => {
    const fs = memFs()
    seedPackage(fs, '- id: hello\n  name: dsh-hello-plugin\n')
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

  it('times out a never-settling activation, disposes the tree, and reports a bilingual restart reason', async () => {
    const fs = memFs()
    seedPackage(fs, '- id: hello\n  name: dsh-hello-plugin\n')
    let disposed = false
    const never = new Promise<unknown>(() => {})
    const ctx = testCtx({ await: () => never, dispose: async () => { disposed = true } })

    const result = await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1 })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('热挂载超时')
    expect(result.reason).toContain('restart required')
    expect(disposed).toBe(true)
    expect(listHotMounts()).not.toContain('dsh-hello-plugin')
  })

  it('falls back when activation fails, disposing the tree', async () => {
    const fs = memFs()
    seedPackage(fs, '- id: hello\n  name: dsh-hello-plugin\n')
    let disposed = false
    const ctx = testCtx({ await: async () => { throw new Error('activation boom') }, dispose: async () => { disposed = true } })

    const result = await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('热挂载失败')
    expect(result.reason).toContain('restart required')
    expect(disposed).toBe(true)
    expect(listHotMounts()).not.toContain('dsh-hello-plugin')
  })

  it('falls back when the include plugin is unavailable, writing no file', async () => {
    const fs = memFs()
    seedPackage(fs, '- id: hello\n  name: dsh-hello-plugin\n')

    const result = await hotMount(
      { plugin: () => { throw new Error('must not be called') }, logger: { info: () => {}, warn: () => {} } },
      PROFILE, 'dsh-hello-plugin', { hotTreeClass: null, fs, dir: HOT_DIR, timeoutMs: 1000 },
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('cannot hot-mount')
    expect(result.reason).toContain('重启后生效')
    expect(fs.files.has(join(HOT_DIR, 'hot-1.yml'))).toBe(false)
  })

  it('degrades to restart activation when the tree class is not a constructor', async () => {
    const fs = memFs()
    seedPackage(fs, '- id: hello\n  name: dsh-hello-plugin\n')

    const result = await hotMount(
      { plugin: () => { throw new Error('must not be called') }, logger: { info: () => {}, warn: () => {} } },
      PROFILE, 'dsh-hello-plugin', { hotTreeClass: 42, fs, dir: HOT_DIR, timeoutMs: 1000 },
    )

    // Building the subclass over a non-constructor throws; the build sits
    // inside the fallback, so the call degrades instead of throwing.
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('热挂载失败')
    expect(result.reason).toContain('restart required')
  })

  it('falls back with a bilingual reason when the package has no patch file', async () => {
    const fs = memFs()

    const result = await hotMount(
      { plugin: () => { throw new Error('must not be called') }, logger: { info: () => {}, warn: () => {} } },
      PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 },
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no patch file')
    expect(result.reason).toContain('重启后生效')
    expect(fs.files.has(join(HOT_DIR, 'hot-1.yml'))).toBe(false)
  })
})

describe('cleanHotDir', () => {
  it('wipes only this session\'s hot-<n>.yml files', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-shop-hot-'))
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
    const root = mkdtempSync(join(tmpdir(), 'dsh-shop-hot-'))
    try {
      expect(() => cleanHotDir(join(root, 'profile'))).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
