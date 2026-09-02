# Catalog Mirrors and Origin Racing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the catalog as an npm package alongside GitHub Pages, and have the Host race a cheap pointer probe across several origins so a reader in mainland China downloads from a mirror at 12.53 MB/s instead of 0.03 MB/s.

**Architecture:** One build writes `dist/v1/` exactly as today; a publish script packs those same bytes into the npm package `dsh-plugin-shop-catalog`. On the reading side a `CatalogOrigin` abstraction gives `loadCatalog` two interchangeable transports — HTTP (unchanged) and npm (resolve `latest`, verify `dist.integrity`, gunzip, untar). `loadCatalog` races every origin's cheap probe, commits to the first that answers, and falls through to the next on a transport failure. All cache and validation code is untouched: the npm transport's extracted `v1/index.json` **is** the existing pointer.

**Tech Stack:** TypeScript (ESM, `node --experimental-strip-types`), vitest, zod, Node built-ins `node:zlib` and `node:crypto`. No new runtime dependency.

**Spec:** `docs/design/2026-09-01-catalog-mirrors.md` (committed `ba0ea17`)

## Running tests

Two suites, two configs — the root `vitest.config.ts` includes only
`registry/scripts/tests/**`, so a root `npx vitest run packages/...` matches
nothing and exits 1. Use:

| What | Command |
|---|---|
| One package test | `pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/<file>.test.ts` |
| Whole package suite (incl. the live e2e) | `pnpm -C packages/dsh-plugin-shop test` |
| One registry test | `npx vitest run registry/scripts/tests/<file>.test.ts` |
| Whole registry suite | `pnpm test` |
| Typechecks | `pnpm typecheck` and `pnpm -C packages/dsh-plugin-shop typecheck` |

## Global Constraints

- **No fourth runtime dependency in `packages/dsh-plugin-shop`.** It has exactly three (`js-yaml`, `semver`, `zod`). `node:zlib` and `node:crypto` are built in; the tar reader is hand-written.
- **ESM everywhere**; `.ts` extensions on local relative imports.
- **`strict` and `noUncheckedIndexedAccess` are on.** Guard every index access; never assert it away. `buffer[156]` is `number | undefined`.
- **Files end with exactly one trailing newline.**
- **Pure core, impure shell.** `tar.ts`, `race.ts`, `npm-package.ts` take no clock, network, filesystem or environment. `npm-origin.ts`, `origin.ts`'s fetch half, `publish-catalog.ts` are shell.
- **Fail loudly.** A transport failure falls through to the next origin; an *interpretation* failure (bad schema, sha mismatch, integrity mismatch) throws. Never mask a corrupt origin with a healthy one.
- **Fixtures over mocks; never mock the module under test.** The tar fixture must come from a real `npm pack`, never hand-assembled.
- **Verify fixture arithmetic.** Any asserted hash, size or version ordering must actually hold.
- **Design docs are English only.** User-facing docs are bilingual (`X.md` + `X.zh.md`).
- **`builtAt` never enters hashed content.** Unchanged by this work; do not disturb it.

## File Structure

**Host — `packages/dsh-plugin-shop/src/host/`**

| File | Responsibility |
|---|---|
| `tar.ts` (new, pure) | `readTar(buffer)` — ustar parsing to a path→bytes map, path-escape refusal |
| `race.ts` (new, pure) | `inCompletionOrder(promises)` — yields settled results in finish order |
| `origin.ts` (new) | `CatalogOrigin`/`OriginHandle` types, `TransportError`, `httpOrigin`, `resolveDataUrl` (moved from `catalog.ts`) |
| `npm-origin.ts` (new, shell) | `npmOrigin(registryUrl, pkg, fetchImpl)` — resolve `latest`, verify `dist.integrity`, gunzip + untar |
| `npmrc.ts` (new, pure) | `npmrcRegistry(readFile, home)` — the user's configured registry, if any |
| `catalog.ts` (modify) | `loadCatalog` gains `origins`; keeps every line of cache and validation logic |
| `index.ts` (modify) | Builds the origin list from row config |

**Registry — `registry/scripts/src/`**

| File | Responsibility |
|---|---|
| `npm-package.ts` (new, pure) | `nextCatalogVersion`, `catalogPackageFiles` — the package's text content |
| `publish-catalog.ts` (new, shell) | Resolve published `latest`, decide skip, assemble `dist/npm/`, publish, trigger the mirror sync |

**Tests** — one file per module, mirroring the source layout.

---

### Task 1: The tar reader

**Files:**
- Create: `packages/dsh-plugin-shop/src/host/tar.ts`
- Create: `packages/dsh-plugin-shop/tests/host/tar.test.ts`
- Create: `packages/dsh-plugin-shop/tests/fixtures/catalog-package.tgz` (generated, committed)

**Interfaces:**
- Consumes: nothing
- Produces: `readTar(buffer: Buffer): Map<string, Buffer>` — keys are full archive paths (`package/v1/index.json`); throws on any path escaping its root

- [ ] **Step 1: Generate the fixture tarball with real `npm pack`**

The fixture must come from npm's own packer. Hand-assembling one would let the reader and the fixture share a wrong assumption about the format.

```bash
cd /tmp && rm -rf tarfix && mkdir -p tarfix/v1 && cd tarfix
cat > package.json <<'EOF'
{
  "name": "dsh-plugin-shop-catalog-fixture",
  "version": "2026.901.0",
  "description": "tar fixture for the shop's reader test",
  "license": "MIT",
  "files": ["v1"]
}
EOF
printf '{"schemaVersion":5,"builtAt":"2026-09-01T00:00:00.000Z","count":1,"rejected":0,"plugins":{"url":"plugins.abc.json","sha256":"abc"}}\n' > v1/index.json
printf '{"schemaVersion":5,"plugins":[],"denied":[]}\n' > v1/plugins.abc.json
npm pack --silent
cp dsh-plugin-shop-catalog-fixture-2026.901.0.tgz \
   /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/packages/dsh-plugin-shop/tests/fixtures/catalog-package.tgz
```

Confirm what npm actually produced before writing assertions against it:

```bash
tar -tzf /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/packages/dsh-plugin-shop/tests/fixtures/catalog-package.tgz
```

Expected: `package/package.json`, `package/v1/index.json`, `package/v1/plugins.abc.json`. If npm emits different paths, the test below must assert what it actually emitted, not what this plan predicted.

- [ ] **Step 2: Write the failing test**

`packages/dsh-plugin-shop/tests/host/tar.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readTar } from '../../src/host/tar.ts'

const FIXTURE = join(import.meta.dirname, '../fixtures/catalog-package.tgz')

describe('readTar', () => {
  it('reads every file out of a real npm pack tarball', () => {
    const files = readTar(gunzipSync(readFileSync(FIXTURE)))
    expect([...files.keys()].sort()).toEqual([
      'package/package.json',
      'package/v1/index.json',
      'package/v1/plugins.abc.json',
    ])
  })

  it('returns exact file bytes', () => {
    const files = readTar(gunzipSync(readFileSync(FIXTURE)))
    const data = files.get('package/v1/plugins.abc.json')
    expect(data).toBeDefined()
    expect(data?.toString('utf8')).toBe('{"schemaVersion":5,"plugins":[],"denied":[]}\n')
  })

  it('refuses a path that climbs out of the archive root', () => {
    // A single ustar header naming ../evil, then one zero block to end.
    const header = Buffer.alloc(512)
    header.write('package/../evil', 0, 'utf8')
    header.write('00000000000\0', 124, 'ascii')   // size 0, octal, NUL-terminated
    header.write('0', 156, 'ascii')               // typeflag: regular file
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    expect(() => readTar(Buffer.concat([header, Buffer.alloc(512)])))
      .toThrow(/escapes the archive root/)
  })

  it('stops at the end-of-archive marker and ignores directory entries', () => {
    const files = readTar(gunzipSync(readFileSync(FIXTURE)))
    for (const key of files.keys()) expect(key.endsWith('/')).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test and watch it fail**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/tar.test.ts
```

Expected: FAIL — cannot resolve `../../src/host/tar.ts`.

- [ ] **Step 4: Write the reader**

`packages/dsh-plugin-shop/src/host/tar.ts`:

```ts
/** A read-only ustar parser: the npm transport's only way into a tarball.
 *
 * Pure — bytes in, a path-to-bytes map out. It handles exactly what `npm
 * pack` emits and refuses everything else loudly, because the alternative to
 * a small strict reader is a fourth runtime dependency (design §4). */

/** Bytes up to the first NUL, as ASCII. Tar pads its fixed-width text fields
 * with NULs, so a plain toString would carry them into the path. */
function cstring(field: Buffer): string {
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('ascii')
}

/** Tar sizes are octal text, NUL- or space-terminated. An unparseable size
 * would desynchronise every subsequent header, so it throws rather than
 * guessing zero. */
function parseOctal(field: Buffer): number {
  const text = cstring(field).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`tar: unparseable size field ${JSON.stringify(text)}`)
  }
  return value
}

/** `..` in any position, or a leading `/`, would let an archive write outside
 * the directory it claims. Nothing we publish contains either, so a tarball
 * that does is hostile or corrupt — refuse it rather than filter it. */
function assertContained(path: string): string {
  if (path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`tar: ${JSON.stringify(path)} escapes the archive root`)
  }
  return path
}

/**
 * Parse an uncompressed tar archive into path → bytes.
 *
 * Directory entries and every non-regular type (symlinks, pax and GNU
 * extension headers) are skipped: npm packs regular files under `package/`,
 * and a catalog tarball that needs anything else is not one we published.
 */
export function readTar(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    // The archive ends with zero blocks; one is enough to stop reading.
    if (header.every(byte => byte === 0)) break
    const name = cstring(header.subarray(0, 100))
    const prefix = cstring(header.subarray(345, 500))
    const size = parseOctal(header.subarray(124, 136))
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const path = prefix === '' ? name : `${prefix}/${name}`
    offset += 512
    if (typeflag === '0' || typeflag === '\0') {
      files.set(assertContained(path), buffer.subarray(offset, offset + size))
    }
    offset += Math.ceil(size / 512) * 512
  }
  return files
}
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/tar.test.ts
```

Expected: 4 passed. If the path-escape test fails because `assertContained` is never reached, check that the fabricated header's typeflag byte is at offset 156 and reads `'0'`.

- [ ] **Step 6: Typecheck**

```bash
pnpm -C packages/dsh-plugin-shop typecheck
```

Expected: clean. `header[156] ?? 0` is the `noUncheckedIndexedAccess` guard; if you removed it, tsc fails here.

- [ ] **Step 7: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/tar.ts \
        packages/dsh-plugin-shop/tests/host/tar.test.ts \
        packages/dsh-plugin-shop/tests/fixtures/catalog-package.tgz
git commit -m "feat(host): read-only tar parser for the npm catalog transport"
```

---

### Task 2: Completion-order racing

**Files:**
- Create: `packages/dsh-plugin-shop/src/host/race.ts`
- Create: `packages/dsh-plugin-shop/tests/host/race.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `inCompletionOrder<T>(promises: readonly Promise<T>[]): AsyncGenerator<Settled<T>>` where `Settled<T> = { index: number; value: T } | { index: number; reason: unknown }`. Discriminate with `'value' in settled`.

- [ ] **Step 1: Write the failing test**

`packages/dsh-plugin-shop/tests/host/race.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { inCompletionOrder } from '../../src/host/race.ts'

/** A promise that settles when the returned trigger is called — real timers
 * would make the ordering assertions racy. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('inCompletionOrder', () => {
  it('yields in finish order, not argument order', async () => {
    const a = deferred<string>()
    const b = deferred<string>()
    const c = deferred<string>()
    const seen: string[] = []
    const drain = (async () => {
      for await (const settled of inCompletionOrder([a.promise, b.promise, c.promise])) {
        if ('value' in settled) seen.push(settled.value)
      }
    })()
    c.resolve('third-arg')
    await Promise.resolve()
    a.resolve('first-arg')
    await Promise.resolve()
    b.resolve('second-arg')
    await drain
    expect(seen).toEqual(['third-arg', 'first-arg', 'second-arg'])
  })

  // The case above settles its tail in ascending argument order, which is
  // also what an argument-order tie-break would produce — so on its own it
  // cannot tell the two apart. This one can: the consumer does real work
  // between yields (a macrotask, as the origin race's bulk fetch does),
  // letting two promises settle inside one turn, and the true settle order
  // runs DOWN the argument list.
  it('preserves settle order when the consumer works between yields', async () => {
    const order: string[] = []
    const make = (label: string) => {
      const d = deferred<string>()
      return { promise: d.promise, fire: () => { order.push(label); d.resolve(label) } }
    }
    const a = make('arg0')
    const b = make('arg1')
    const c = make('arg2')
    const seen: string[] = []
    const drain = (async () => {
      for await (const settled of inCompletionOrder([a.promise, b.promise, c.promise])) {
        if ('value' in settled) seen.push(settled.value)
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    })()
    c.fire()
    await new Promise(resolve => setTimeout(resolve, 1))
    b.fire()
    a.fire()
    await drain
    expect(seen).toEqual(order)
    expect(seen).toEqual(['arg2', 'arg1', 'arg0'])
  })

  // Handlers must be attached at call time, not at first iteration: an
  // `async function*` body is lazy, and a rejection left unhandled while the
  // caller does something else first crashes the process by default.
  it('handles a rejection even when construction and iteration are separated', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const sequence = inCompletionOrder([Promise.reject(new Error('boom'))])
      await new Promise(resolve => setTimeout(resolve, 20))
      const seen: string[] = []
      for await (const settled of sequence) seen.push('value' in settled ? 'ok' : 'err')
      expect(seen).toEqual(['err'])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })

  it('delivers every outcome when all promises settled before the first read', async () => {
    const sequence = inCompletionOrder([Promise.resolve('a'), Promise.resolve('b'), Promise.resolve('c')])
    await new Promise(resolve => setTimeout(resolve, 10))
    const seen: string[] = []
    for await (const settled of sequence) if ('value' in settled) seen.push(settled.value)
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('yields rejections in place rather than aborting the sequence', async () => {
    const bad = Promise.reject(new Error('boom'))
    const good = Promise.resolve('ok')
    const results: string[] = []
    for await (const settled of inCompletionOrder([bad, good])) {
      results.push('value' in settled ? `ok:${settled.value}` : `err:${String(settled.reason)}`)
    }
    expect(results).toHaveLength(2)
    expect(results.filter(r => r.startsWith('ok:'))).toEqual(['ok:ok'])
  })

  it('carries the argument index so a caller can identify the origin', async () => {
    const indices: number[] = []
    for await (const settled of inCompletionOrder([Promise.resolve('x'), Promise.resolve('y')])) {
      indices.push(settled.index)
    }
    expect(indices.sort()).toEqual([0, 1])
  })

  it('completes immediately on an empty list', async () => {
    const seen: unknown[] = []
    for await (const settled of inCompletionOrder([])) seen.push(settled)
    expect(seen).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/race.test.ts
```

Expected: FAIL — cannot resolve `../../src/host/race.ts`.

- [ ] **Step 3: Write the helper**

`packages/dsh-plugin-shop/src/host/race.ts`:

```ts
/** Settle a set of promises in the order they finish (design §3).
 *
 * Pure and timer-free. `Promise.any` would give only the first success and
 * discard the rest; the origin race needs the losers too, in order, so a
 * winner that fails its bulk fetch can fall through to the runner-up. */

export type Settled<T> = { index: number; value: T } | { index: number; reason: unknown }

/**
 * Yield each promise's outcome as it settles, tagged with its argument index.
 *
 * Deliberately NOT an `async function*`. Two properties depend on that:
 *
 * 1. **Handlers attach synchronously, at call time.** An async generator's
 *    body does not run until its first `next()`, so wiring the handlers
 *    inside one would leave a rejection unhandled for as long as the caller
 *    waits before iterating — which crashes the process under Node's default
 *    unhandled-rejection policy.
 * 2. **Order is recorded when each promise settles**, not when a consumer
 *    asks. Re-racing the survivors on every turn tie-breaks on argument
 *    order instead: `Promise.race` over promises that are ALREADY settled
 *    resolves with the first in iteration order, not the first to have
 *    settled — and a consumer doing any work between yields, which is
 *    exactly this module's use case, is what lets two settle inside one turn.
 */
export function inCompletionOrder<T>(promises: readonly Promise<T>[]): AsyncGenerator<Settled<T>> {
  const settled: Settled<T>[] = []
  let wake: (() => void) | null = null
  const record = (outcome: Settled<T>): void => {
    settled.push(outcome)
    const resume = wake
    wake = null
    resume?.()
  }
  for (const [index, promise] of promises.entries()) {
    void promise.then(
      value => { record({ index, value }) },
      (reason: unknown) => { record({ index, reason }) },
    )
  }

  return (async function* () {
    for (let delivered = 0; delivered < promises.length; delivered += 1) {
      if (settled.length === delivered) {
        await new Promise<void>(resolve => { wake = resolve })
      }
      const outcome = settled[delivered]
      // Unreachable: the loop only waits when nothing new has arrived, and
      // `record` is the sole waker and always pushes before waking. Guarded
      // rather than asserted because `noUncheckedIndexedAccess` is on and a
      // silent `undefined` here would be a yielded hole.
      if (outcome === undefined) throw new Error('inCompletionOrder: woke with nothing settled')
      yield outcome
    }
  })()
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/race.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/race.ts packages/dsh-plugin-shop/tests/host/race.test.ts
git commit -m "feat(host): settle promises in completion order for the origin race"
```

---

### Task 3: The origin seam, and the HTTP origin

This is the refactor with the largest blast radius. Its success criterion is that **every existing `catalog.test.ts` case passes unchanged** — the HTTP transport must behave identically, including the two security guards on pointer-named URLs.

**Files:**
- Create: `packages/dsh-plugin-shop/src/host/origin.ts`
- Create: `packages/dsh-plugin-shop/tests/host/origin.test.ts`
- Modify: `packages/dsh-plugin-shop/src/host/catalog.ts` (remove `resolveDataUrl`; route the three fetches through an origin)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `class TransportError extends Error` — the *only* failure class that falls through to another origin
  - `interface OriginHandle { readonly id: string; pointer(): Promise<string>; file(url: string): Promise<string> }`
  - `interface CatalogOrigin { readonly id: string; probe(signal: AbortSignal): Promise<OriginHandle> }`
  - `function httpOrigin(baseUrl: string, fetchImpl: typeof fetch): CatalogOrigin`
  - `function resolveDataUrl(baseUrl: string, url: string): string` (moved verbatim from `catalog.ts`)

**`file()` takes the pointer's raw url string, not a basename.** Passing a basename would strip an attacker-supplied absolute URL down to something fetchable and silently defeat the existing cross-origin guard. Each origin interprets the raw string with its own guard.

- [ ] **Step 1: Write the failing test**

`packages/dsh-plugin-shop/tests/host/origin.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { TransportError, httpOrigin, resolveDataUrl } from '../../src/host/origin.ts'

const ok = (body: string): Response => new Response(body, { status: 200 })

describe('resolveDataUrl', () => {
  it('resolves a relative name against the base', () => {
    expect(resolveDataUrl('https://shop.test/v1/', 'plugins.abc.json'))
      .toBe('https://shop.test/v1/plugins.abc.json')
  })

  it('refuses an absolute url on another origin', () => {
    expect(() => resolveDataUrl('https://shop.test/v1/', 'https://evil.test/x.json'))
      .toThrow(/must be relative to the catalog base/)
  })

  it('refuses a protocol-relative url', () => {
    expect(() => resolveDataUrl('https://shop.test/v1/', '//evil.test/x.json'))
      .toThrow(/must be relative to the catalog base/)
  })
})

describe('httpOrigin', () => {
  it('probes index.json and serves the pointer without a second request', async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: string | URL) => {
      seen.push(String(input))
      return ok('{"pointer":true}')
    }) as unknown as typeof fetch
    const handle = await httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal)
    expect(await handle.pointer()).toBe('{"pointer":true}')
    expect(await handle.pointer()).toBe('{"pointer":true}')
    expect(seen).toEqual(['https://shop.test/v1/index.json'])
  })

  it('raises TransportError on a non-2xx probe', async () => {
    const fetchImpl = (async () => new Response('', { status: 503 })) as unknown as typeof fetch
    await expect(httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal))
      .rejects.toBeInstanceOf(TransportError)
  })

  it('raises TransportError when the network throws', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    await expect(httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal))
      .rejects.toBeInstanceOf(TransportError)
  })

  it('refuses a cross-origin file url loudly, not as a TransportError', async () => {
    const fetchImpl = (async (input: string | URL) =>
      String(input).endsWith('index.json') ? ok('{}') : ok('data')) as unknown as typeof fetch
    const handle = await httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal)
    const failure = await handle.file('https://evil.test/x.json').catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(TransportError)
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/origin.test.ts
```

Expected: FAIL — cannot resolve `../../src/host/origin.ts`.

- [ ] **Step 3: Write `origin.ts`**

```ts
/** The transport seam under `loadCatalog` (design §3).
 *
 * An origin answers a cheap probe, then serves the pointer and the files the
 * pointer names. HTTP and npm are interchangeable behind it, so every line of
 * cache and validation logic in `catalog.ts` stays transport-blind. */

/** A failure of the link, not of the content: the wire threw, or answered
 * non-2xx. This is the ONLY class `loadCatalog` retries on another origin.
 * A bad schema, a sha mismatch, or a refused url is an interpretation
 * failure and throws — masking a corrupt origin behind a healthy one is
 * exactly the silent-wrongness this project refuses. */
export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TransportError'
  }
}

export interface OriginHandle {
  readonly id: string
  /** The pointer JSON text. Cheap: the probe has already paid for it. */
  pointer: () => Promise<string>
  /** One file named by the pointer, by the pointer's own raw url string.
   * Callers pass that string verbatim — never a basename, which would strip
   * a hostile absolute url into a fetchable relative one. */
  file: (url: string) => Promise<string>
}

export interface CatalogOrigin {
  readonly id: string
  /** Cheap reachability + identity request. Resolving means this origin can
   * serve; the expensive work happens on the returned handle. */
  probe: (signal: AbortSignal) => Promise<OriginHandle>
}

/** Resolve the pointer's data URL against the catalog base. An absolute URL —
 * any scheme, or a protocol-relative `//host/...` — would hand the pointer a
 * fetch primitive to arbitrary hosts, so it is refused loudly before any
 * fetch (§9.2). The guard is the resolved origin, not the raw string: WHATWG
 * normalization strips leading whitespace and accepts backslash spellings
 * before the string could be inspected, so only comparing the resolved URL's
 * origin to the base's closes every spelling class. */
export function resolveDataUrl(baseUrl: string, url: string): string {
  const resolved = new URL(url, baseUrl)
  if (resolved.origin !== new URL(baseUrl).origin) {
    throw new Error('catalog data url must be relative to the catalog base')
  }
  return resolved.href
}

/** The transport this project has always used: a static `v1/` tree. */
export function httpOrigin(baseUrl: string, fetchImpl: typeof fetch): CatalogOrigin {
  const id = `http:${baseUrl}`
  return {
    id,
    async probe(signal) {
      let response: Response
      try {
        response = await fetchImpl(new URL('index.json', baseUrl).href, { signal })
      } catch (error) {
        // The cause is attached for a debugger, but callers here (and the
        // pre-existing catalog tests) match on `.message` alone — folding the
        // underlying reason in is what keeps "offline" visible after the wrap.
        const detail = error instanceof Error ? error.message : String(error)
        throw new TransportError(`catalog pointer fetch failed for ${id}: ${detail}`, { cause: error })
      }
      if (!response.ok) throw new TransportError(`catalog pointer returned ${response.status}`)
      const pointerText = await response.text()
      return {
        id,
        pointer: async () => pointerText,
        // resolveDataUrl throws a plain Error on a refused url — deliberately
        // NOT a TransportError. A pointer naming another host is a poisoned
        // catalog, not a flaky link, and must not be retried elsewhere.
        file: async (url) => {
          const resolved = resolveDataUrl(baseUrl, url)
          let dataResponse: Response
          try {
            dataResponse = await fetchImpl(resolved)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            throw new TransportError(`catalog data fetch failed for ${id}: ${detail}`, { cause: error })
          }
          if (!dataResponse.ok) throw new TransportError(`catalog data returned ${dataResponse.status}`)
          return dataResponse.text()
        },
      }
    },
  }
}
```

- [ ] **Step 4: Run the origin test and watch it pass**

```bash
pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/origin.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Route `catalog.ts` through the origin, preserving behaviour exactly**

In `packages/dsh-plugin-shop/src/host/catalog.ts`:

1. Delete the local `resolveDataUrl` function and its doc comment; import it instead:

```ts
import { type CatalogOrigin, TransportError, httpOrigin, resolveDataUrl } from './origin.ts'
```

`resolveDataUrl` stays imported because nothing else changes about how it is used — keeping the import documents that the guard did not move semantically, only physically.

2. Add `origins` to the options, keeping `baseUrl` as the single-origin spelling:

```ts
export interface LoadCatalogOptions {
  /** A single HTTP origin — the explicit-override spelling. Mutually
   * exclusive with `origins`; exactly one must be given. */
  baseUrl?: string
  /** Origins to race (design §3). */
  origins?: CatalogOrigin[]
  cacheDir: string
  refresh?: boolean
  fetchImpl?: typeof fetch
  now?: () => Date
  fsImpl?: CatalogFs
  sleep?: (ms: number) => Promise<void>
}
```

3. At the top of `loadCatalog`, build the origin list:

```ts
  if ((options.baseUrl === undefined) === (options.origins === undefined)) {
    throw new Error('loadCatalog: exactly one of baseUrl or origins is required')
  }
  const originList = options.origins
    ?? [httpOrigin(options.baseUrl as string, fetchImpl)]
```

The `as string` is safe only because of the guard directly above it, and it is the one place in this plan an assertion is acceptable — the alternative spellings all reintroduce a branch tsc cannot see through. If you prefer, widen the guard to a type predicate rather than leaving the assertion bare.

4. Replace the pointer fetch block. Where it read:

```ts
  let pointerText: string
  try {
    const response = await fetchImpl(new URL('index.json', baseUrl).href)
    if (!response.ok) throw new Error(`catalog pointer returned ${response.status}`)
    pointerText = await response.text()
  } catch (error) {
    const cached = readCached()
    if (cached !== null) return { snapshot: cached, stale: true }
    throw error
  }
```

it becomes a single-origin probe against `originList[0]` for now — **Task 5 adds the race.** Doing both at once would leave no green step between a refactor and a behaviour change:

```ts
  const only = originList[0]
  if (only === undefined) throw new Error('loadCatalog: no origins')
  let handle: OriginHandle
  let pointerText: string
  try {
    handle = await only.probe(AbortSignal.timeout(PROBE_TIMEOUT_MS))
    pointerText = await handle.pointer()
  } catch (error) {
    const cached = readCached()
    if (cached !== null) return { snapshot: cached, stale: true }
    throw error
  }
```

with `import type { OriginHandle } from './origin.ts'` and, beside `FRESH_MS`:

```ts
/** How long a probe may take before the race gives up on that origin. Long
 * enough for a slow but working link, short enough that a black-holed origin
 * does not hold the shelf closed. */
const PROBE_TIMEOUT_MS = 10_000
```

5. Replace the data fetch. Where it read `const dataUrl = resolveDataUrl(baseUrl, pointer.plugins.url)` followed by the fetch block, it becomes:

```ts
  let dataText: string
  try {
    dataText = await handle.file(pointer.plugins.url)
  } catch (error) {
    if (!(error instanceof TransportError)) throw error
    const cached = readCached()
    if (cached !== null) return { snapshot: cached, stale: true }
    throw error
  }
```

The `instanceof TransportError` rethrow is what keeps a refused cross-origin url loud: previously `resolveDataUrl` threw *outside* the try, so it was never converted to a stale-cache fallback. Now it throws inside `handle.file`, so the guard has to be restated here or the security behaviour silently changes.

6. Replace the stars fetch inside its advisory try:

```ts
      const starsText = await handle.file(pointer.stars.url)
      const starsActual = createHash('sha256').update(starsText).digest('hex')
      if (starsActual === pointer.stars.sha256) {
        stars = parseStarsText(starsText)
        fsImpl.write(join(cacheDir, basename(pointer.stars.url)), starsText)
      }
```

The surrounding `try { ... } catch { }` and its comment stay exactly as they are: a refused or unreachable sidecar still degrades to no stars.

- [ ] **Step 6: Run the whole existing catalog suite unchanged**

```bash
pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/catalog.test.ts
```

Expected: every pre-existing case passes with **no edits to the test file**. If a case needed editing, the refactor changed behaviour — find out which and why before proceeding. In particular the cases covering an absolute data url and a cross-origin stars url are the ones step 5.5 and 5.6 are protecting.

- [ ] **Step 7: Full package suite and typecheck**

```bash
pnpm -C packages/dsh-plugin-shop test
pnpm -C packages/dsh-plugin-shop typecheck
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/origin.ts \
        packages/dsh-plugin-shop/tests/host/origin.test.ts \
        packages/dsh-plugin-shop/src/host/catalog.ts
git commit -m "refactor(host): put a transport seam under loadCatalog"
```

---

### Task 4: The npm origin

**Files:**
- Create: `packages/dsh-plugin-shop/src/host/npm-origin.ts`
- Create: `packages/dsh-plugin-shop/tests/host/npm-origin.test.ts`

**Interfaces:**
- Consumes: `readTar` (Task 1); `CatalogOrigin`, `OriginHandle`, `TransportError` (Task 3)
- Produces: `function npmOrigin(registryUrl: string, packageName: string, fetchImpl: typeof fetch): CatalogOrigin`

- [ ] **Step 1: Write the failing test**

`packages/dsh-plugin-shop/tests/host/npm-origin.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TransportError } from '../../src/host/origin.ts'
import { npmOrigin } from '../../src/host/npm-origin.ts'

/** The same real `npm pack` output Task 1 uses. Its inner paths are
 * package/v1/index.json and package/v1/plugins.abc.json. */
const TARBALL = readFileSync(join(import.meta.dirname, '../fixtures/catalog-package.tgz'))
const INTEGRITY = `sha512-${createHash('sha512').update(TARBALL).digest('base64')}`

function registry(options: {
  tarball?: Buffer
  integrity?: string
  tarballUrl?: string
  latestStatus?: number
}): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input)
    if (url.endsWith('/latest')) {
      if (options.latestStatus !== undefined) return new Response('', { status: options.latestStatus })
      return new Response(JSON.stringify({
        name: 'dsh-plugin-shop-catalog',
        version: '2026.901.0',
        dist: {
          tarball: options.tarballUrl ?? 'https://reg.test/dsh-plugin-shop-catalog/-/x-2026.901.0.tgz',
          integrity: options.integrity ?? INTEGRITY,
        },
      }), { status: 200 })
    }
    return new Response(options.tarball ?? TARBALL, { status: 200 })
  }) as unknown as typeof fetch
}

const signal = (): AbortSignal => new AbortController().signal

describe('npmOrigin', () => {
  it('resolves latest, verifies integrity, and serves the packed pointer', async () => {
    const handle = await npmOrigin('https://reg.test/', 'dsh-plugin-shop-catalog', registry({})).probe(signal())
    expect(JSON.parse(await handle.pointer())).toMatchObject({ schemaVersion: 5, count: 1 })
  })

  it('serves a file the pointer names, from inside the tarball', async () => {
    const handle = await npmOrigin('https://reg.test/', 'dsh-plugin-shop-catalog', registry({})).probe(signal())
    expect(await handle.file('plugins.abc.json')).toBe('{"schemaVersion":5,"plugins":[],"denied":[]}\n')
  })

  it('downloads the tarball once for repeated reads', async () => {
    let tarballFetches = 0
    const counting = (async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/latest')) {
        return new Response(JSON.stringify({
          name: 'c', version: '2026.901.0',
          dist: { tarball: 'https://reg.test/c/-/c-1.tgz', integrity: INTEGRITY },
        }), { status: 200 })
      }
      tarballFetches += 1
      return new Response(TARBALL, { status: 200 })
    }) as unknown as typeof fetch
    const handle = await npmOrigin('https://reg.test/', 'c', counting).probe(signal())
    await handle.pointer()
    await handle.file('plugins.abc.json')
    await handle.file('plugins.abc.json')
    expect(tarballFetches).toBe(1)
  })

  it('refuses a tarball whose bytes do not match dist.integrity', async () => {
    const wrong = `sha512-${createHash('sha512').update('not the tarball').digest('base64')}`
    const handle = await npmOrigin('https://reg.test/', 'c', registry({ integrity: wrong })).probe(signal())
    const failure = await handle.pointer().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toMatch(/integrity/)
    // An integrity mismatch is corruption, not a flaky link: it must NOT be
    // retried on another origin.
    expect(failure).not.toBeInstanceOf(TransportError)
  })

  it('refuses a tarball url on a different host than the registry', async () => {
    const handle = await npmOrigin('https://reg.test/', 'c',
      registry({ tarballUrl: 'https://evil.test/c-1.tgz' })).probe(signal())
    const failure = await handle.pointer().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(TransportError)
  })

  it('refuses a pointer-named file that is a path rather than a name', async () => {
    const handle = await npmOrigin('https://reg.test/', 'c', registry({})).probe(signal())
    await expect(handle.file('../package.json')).rejects.toThrow(/must be a plain file name/)
  })

  it('raises TransportError when the registry is unreachable', async () => {
    const dead = (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
    await expect(npmOrigin('https://reg.test/', 'c', dead).probe(signal()))
      .rejects.toBeInstanceOf(TransportError)
  })

  it('raises TransportError on a non-2xx latest', async () => {
    await expect(npmOrigin('https://reg.test/', 'c', registry({ latestStatus: 502 })).probe(signal()))
      .rejects.toBeInstanceOf(TransportError)
  })

  it('reports a missing file inside the tarball by name', async () => {
    const handle = await npmOrigin('https://reg.test/', 'c', registry({})).probe(signal())
    await expect(handle.file('stars.nope.json')).rejects.toThrow(/stars\.nope\.json/)
  })
})
```

Note `gzipSync` is imported for symmetry with the fixture's own compression; if your editor flags it as unused after you finish, drop the import rather than inventing a use for it.

- [ ] **Step 2: Run the test and watch it fail**

```bash
pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/npm-origin.test.ts
```

Expected: FAIL — cannot resolve `../../src/host/npm-origin.ts`.

- [ ] **Step 3: Write `npm-origin.ts`**

```ts
/** The npm transport (design §2, §3): the catalog as a package.
 *
 * Shell — this and `origin.ts`'s fetch half are the only places the catalog
 * loader touches the network. The payoff is measured, not assumed: the same
 * bytes reach a China-side machine at 12.53 MB/s from npmmirror against
 * 0.03 MB/s from GitHub Pages. */

import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { z } from 'zod'
import { readTar } from './tar.ts'
import { type CatalogOrigin, type OriginHandle, TransportError } from './origin.ts'

/** The abbreviated `latest` manifest. Non-strict: a registry may add keys,
 * and stripping them is what keeps an old host working against a new one. */
const latestSchema = z.object({
  version: z.string(),
  dist: z.object({ tarball: z.string(), integrity: z.string() }),
})

/** Where the published package keeps the catalog tree (design §2). */
const PACKAGE_ROOT = 'package/v1/'

/** Verify tarball bytes against npm's own Subresource-Integrity string.
 * `dist.integrity` may carry several space-separated digests; npm publishes
 * one, and the first is the one we check. */
function verifyIntegrity(bytes: Buffer, integrity: string): void {
  const first = integrity.trim().split(/\s+/)[0] ?? ''
  const dash = first.indexOf('-')
  const algorithm = dash === -1 ? '' : first.slice(0, dash)
  const expected = dash === -1 ? '' : first.slice(dash + 1)
  if (algorithm !== 'sha512' && algorithm !== 'sha256') {
    throw new Error(`npm origin: unsupported dist.integrity algorithm ${JSON.stringify(algorithm)}`)
  }
  const actual = createHash(algorithm).update(bytes).digest('base64')
  if (actual !== expected) {
    throw new Error(`npm origin: tarball failed dist.integrity check (${algorithm})`)
  }
}

/**
 * An origin that reads the catalog out of `<registryUrl>`'s copy of
 * `<packageName>`.
 *
 * The probe is the abbreviated `latest` manifest — 13.5 KB against the live
 * registry — so the race is decided without downloading anything large. The
 * tarball is fetched lazily on the first `pointer()` or `file()` and kept on
 * the handle, so one origin download serves the whole load.
 */
export function npmOrigin(registryUrl: string, packageName: string, fetchImpl: typeof fetch): CatalogOrigin {
  const id = `npm:${registryUrl}`
  return {
    id,
    async probe(signal): Promise<OriginHandle> {
      const url = new URL(`${encodeURIComponent(packageName)}/latest`, registryUrl).href
      let response: Response
      try {
        response = await fetchImpl(url, { signal })
      } catch (error) {
        // Fold the cause's message into the text, as httpOrigin does: the
        // cause is for a debugger, but a person reading why their shop will
        // not open sees `.message` and nothing else.
        const detail = error instanceof Error ? error.message : String(error)
        throw new TransportError(`npm origin ${registryUrl} probe failed: ${detail}`, { cause: error })
      }
      if (!response.ok) throw new TransportError(`npm origin ${registryUrl} returned ${response.status}`)
      const manifest = latestSchema.parse(await response.json())

      let files: Map<string, Buffer> | null = null
      const load = async (): Promise<Map<string, Buffer>> => {
        if (files !== null) return files
        // A registry that serves its tarballs from somewhere else is refused
        // rather than followed. npmmirror rewrites dist.tarball to its own
        // host, so the mirrors this design targets pass; an origin that does
        // not simply loses the race, which costs the reader nothing.
        const tarballUrl = new URL(manifest.dist.tarball)
        if (tarballUrl.origin !== new URL(registryUrl).origin) {
          throw new Error(`npm origin: dist.tarball host ${tarballUrl.origin} is not the registry's`)
        }
        let tarballResponse: Response
        try {
          tarballResponse = await fetchImpl(tarballUrl.href)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new TransportError(`npm origin ${registryUrl} tarball fetch failed: ${detail}`, { cause: error })
        }
        if (!tarballResponse.ok) {
          throw new TransportError(`npm origin tarball returned ${tarballResponse.status}`)
        }
        const bytes = Buffer.from(await tarballResponse.arrayBuffer())
        verifyIntegrity(bytes, manifest.dist.integrity)
        files = readTar(gunzipSync(bytes))
        return files
      }

      const read = async (name: string): Promise<string> => {
        const entry = (await load()).get(`${PACKAGE_ROOT}${name}`)
        if (entry === undefined) throw new Error(`npm origin: ${name} is not in the catalog package`)
        return entry.toString('utf8')
      }

      return {
        id,
        pointer: async () => read('index.json'),
        // The pointer's url is a bare file name in every catalog this project
        // publishes. Anything else — a path, an absolute url — is refused
        // rather than resolved, the npm-side equivalent of resolveDataUrl's
        // cross-origin guard.
        file: async (url) => {
          if (url.includes('/') || url.startsWith('.')) {
            throw new Error(`npm origin: ${JSON.stringify(url)} must be a plain file name`)
          }
          return read(url)
        },
      }
    },
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/npm-origin.test.ts
```

Expected: 9 passed.

- [ ] **Step 5: Typecheck**

```bash
pnpm -C packages/dsh-plugin-shop typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/npm-origin.ts \
        packages/dsh-plugin-shop/tests/host/npm-origin.test.ts
git commit -m "feat(host): read the catalog from an npm registry"
```

---

### Task 5: Race the origins

**Files:**
- Create: `packages/dsh-plugin-shop/src/host/npmrc.ts`
- Create: `packages/dsh-plugin-shop/tests/host/npmrc.test.ts`
- Modify: `packages/dsh-plugin-shop/src/host/catalog.ts` (single probe → race)
- Modify: `packages/dsh-plugin-shop/src/host/index.ts` (build the origin list; four `load(...)` call sites)
- Modify: `packages/dsh-plugin-shop/tests/host/catalog.test.ts` (add race cases; touch no existing case)

**Interfaces:**
- Consumes: `inCompletionOrder` (Task 2); `CatalogOrigin`, `TransportError`, `httpOrigin` (Task 3); `npmOrigin` (Task 4)
- Produces:
  - `function npmrcRegistry(readFile: (path: string) => string | null, home: string): string | null`
  - `const DEFAULT_CATALOG_URL = 'https://LivXue.github.io/dsh-plugin-shop/v1/'` (exported from `catalog.ts`)
  - `const CATALOG_PACKAGE = 'dsh-plugin-shop-catalog'` (exported from `catalog.ts`)
  - `function catalogOrigins(catalogUrl: string, fetchImpl: typeof fetch, npmRegistry: string | null): CatalogOrigin[]` (exported from `catalog.ts`)

- [ ] **Step 1: Write the failing npmrc test**

`packages/dsh-plugin-shop/tests/host/npmrc.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { npmrcRegistry } from '../../src/host/npmrc.ts'

const from = (text: string | null) => npmrcRegistry(() => text, '/home/u')

describe('npmrcRegistry', () => {
  it('reads a plain registry line', () => {
    expect(from('registry=https://registry.npmmirror.com/')).toBe('https://registry.npmmirror.com/')
  })

  it('tolerates spaces around the equals sign', () => {
    expect(from('registry = https://registry.npmmirror.com/')).toBe('https://registry.npmmirror.com/')
  })

  it('ignores scoped registry lines, which do not apply to an unscoped package', () => {
    expect(from('@acme:registry=https://acme.test/\nregistry=https://plain.test/')).toBe('https://plain.test/')
  })

  it('returns null when there is no registry line', () => {
    expect(from('audit=false\nfund=false')).toBeNull()
  })

  it('returns null when there is no file', () => {
    expect(from(null)).toBeNull()
  })

  it('ignores a commented-out registry', () => {
    expect(from('; registry=https://commented.test/\n# registry=https://also.test/')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/npmrc.test.ts
```

Expected: FAIL — cannot resolve `../../src/host/npmrc.ts`.

- [ ] **Step 3: Write `npmrc.ts`**

```ts
/** The user's configured npm registry, if they have one (design §3).
 *
 * Pure: the caller injects the read. This is a deliberately partial reading
 * of npm's config resolution — only the user-level `registry=` line — and
 * that is safe precisely because the origin list is raced: a registry we
 * guess wrong about loses a 400-byte request and nothing else. */

import { join } from 'node:path'

/**
 * @param readFile - returns the file's text, or null when it does not exist.
 * @param home - the user's home directory.
 */
export function npmrcRegistry(readFile: (path: string) => string | null, home: string): string | null {
  const text = readFile(join(home, '.npmrc'))
  if (text === null) return null
  for (const line of text.split('\n')) {
    // Unscoped `registry=` only: `@scope:registry=` governs one scope and
    // says nothing about where an unscoped package should come from.
    const match = /^\s*registry\s*=\s*(\S+)\s*$/.exec(line)
    const value = match?.[1]
    if (value !== undefined) return value
  }
  return null
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/npmrc.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: Write the failing race tests**

Append to `packages/dsh-plugin-shop/tests/host/catalog.test.ts` — **add cases, edit none**. It already imports `loadCatalog` and `CatalogFs`; extend that import:

```ts
import { DEFAULT_CATALOG_URL, catalogOrigins, loadCatalog, type CatalogFs } from '../../src/host/catalog.ts'
import { TransportError, type CatalogOrigin } from '../../src/host/origin.ts'
```

```ts
describe('origin racing', () => {
  const entry = {
    name: 'dsh-hello-plugin', version: '1.2.0', integrity: 'sha512-i', publishedAt: null,
    repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
    added: '2026-08-25',
  }

  /** An origin that resolves its probe after `delay` microtask turns. */
  function fakeOrigin(id: string, opts: {
    delay?: number
    probeFails?: 'transport' | 'loud'
    /** Fails when the loader asks for the pointer — still inside the race,
     * so the loader may still fall through to another origin. */
    pointerFails?: 'transport' | 'loud'
    /** Fails on the bulk fetch, after the winner is committed to. */
    dataFails?: 'transport' | 'loud'
    data?: string
    pointer?: string
  }): CatalogOrigin {
    return {
      id,
      async probe() {
        for (let i = 0; i < (opts.delay ?? 0); i += 1) await Promise.resolve()
        if (opts.probeFails === 'transport') throw new TransportError(`${id} down`)
        if (opts.probeFails === 'loud') throw new Error(`${id} corrupt`)
        return {
          id,
          pointer: async () => {
            if (opts.pointerFails === 'transport') throw new TransportError(`${id} pointer down`)
            if (opts.pointerFails === 'loud') throw new Error(`${id} pointer corrupt`)
            return opts.pointer ?? ''
          },
          file: async () => {
            if (opts.dataFails === 'transport') throw new TransportError(`${id} data down`)
            if (opts.dataFails === 'loud') throw new Error(`${id} data corrupt`)
            return opts.data ?? ''
          },
        }
      },
    }
  }

  it('takes the first origin to answer, not the first listed', async () => {
    const data = dataJson([entry])
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z')
    const result = await loadCatalog({
      cacheDir: '/cache', fsImpl: memFs(),
      origins: [
        fakeOrigin('slow', { delay: 8, pointer, data }),
        fakeOrigin('fast', { delay: 0, pointer, data }),
      ],
    })
    expect(result.snapshot.entries).toHaveLength(1)
  })

  it('falls through to the next origin when the winner is a transport failure', async () => {
    const data = dataJson([entry])
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z')
    const result = await loadCatalog({
      cacheDir: '/cache', fsImpl: memFs(),
      origins: [
        fakeOrigin('broken', { delay: 0, probeFails: 'transport' }),
        fakeOrigin('working', { delay: 4, pointer, data }),
      ],
    })
    expect(result.snapshot.entries).toHaveLength(1)
    expect(result.stale).toBe(false)
  })

  it('falls through when the winner answers its probe but cannot serve the pointer', async () => {
    const data = dataJson([entry])
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z')
    const result = await loadCatalog({
      cacheDir: '/cache', fsImpl: memFs(),
      origins: [
        fakeOrigin('half-up', { delay: 0, pointerFails: 'transport' }),
        fakeOrigin('working', { delay: 4, pointer, data }),
      ],
    })
    expect(result.snapshot.entries).toHaveLength(1)
  })

  it('falls back to the cache — not to another origin — when the committed winner fails its bulk fetch', async () => {
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.files.set('/cache/index.json', pointer)
    fs.files.set(`/cache/${url}`, data)
    const result = await loadCatalog({
      cacheDir: '/cache', fsImpl: fs,
      now: () => new Date('2026-09-01T00:00:00Z'),
      origins: [
        fakeOrigin('half-up', { delay: 0, pointer, dataFails: 'transport' }),
        fakeOrigin('working', { delay: 4, pointer, data }),
      ],
    })
    expect(result.stale).toBe(true)
  })

  it('does NOT fall through on a loud failure — a corrupt origin is reported, not papered over', async () => {
    const data = dataJson([entry])
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z')
    await expect(loadCatalog({
      cacheDir: '/cache', fsImpl: memFs(),
      origins: [
        fakeOrigin('corrupt', { delay: 0, pointer, dataFails: 'loud' }),
        fakeOrigin('working', { delay: 4, pointer, data }),
      ],
    })).rejects.toThrow(/data corrupt/)
  })

  it('throws when every origin is a transport failure and there is no cache', async () => {
    await expect(loadCatalog({
      cacheDir: '/cache', fsImpl: memFs(),
      origins: [
        fakeOrigin('a', { probeFails: 'transport' }),
        fakeOrigin('b', { probeFails: 'transport' }),
      ],
    })).rejects.toThrow()
  })

  it('serves the stale cache when every origin is a transport failure', async () => {
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.files.set('/cache/index.json', pointer)
    fs.files.set(`/cache/${url}`, data)
    const result = await loadCatalog({
      cacheDir: '/cache', fsImpl: fs,
      now: () => new Date('2026-09-01T00:00:00Z'),
      origins: [fakeOrigin('a', { probeFails: 'transport' })],
    })
    expect(result.stale).toBe(true)
    expect(result.snapshot.entries).toHaveLength(1)
  })
})

describe('catalogOrigins', () => {
  const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch

  it('races npm and Pages when the row carries the built-in default', () => {
    const ids = catalogOrigins(DEFAULT_CATALOG_URL, fetchImpl, null).map(o => o.id)
    expect(ids).toContain('npm:https://registry.npmmirror.com/')
    expect(ids).toContain('npm:https://registry.npmjs.org/')
    expect(ids).toContain(`http:${DEFAULT_CATALOG_URL}`)
  })

  it('uses an explicit override alone, with no race', () => {
    const origins = catalogOrigins('http://127.0.0.1:9/v1/', fetchImpl, null)
    expect(origins.map(o => o.id)).toEqual(['http:http://127.0.0.1:9/v1/'])
  })

  it('adds the user configured registry as a candidate', () => {
    const ids = catalogOrigins(DEFAULT_CATALOG_URL, fetchImpl, 'https://corp.test/npm/').map(o => o.id)
    expect(ids).toContain('npm:https://corp.test/npm/')
  })

  it('does not list the configured registry twice when it is already a default', () => {
    const ids = catalogOrigins(DEFAULT_CATALOG_URL, fetchImpl, 'https://registry.npmmirror.com/').map(o => o.id)
    expect(ids.filter(id => id === 'npm:https://registry.npmmirror.com/')).toHaveLength(1)
  })
})
```

- [ ] **Step 6: Run and watch the new cases fail**

```bash
pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/catalog.test.ts
```

Expected: the pre-existing cases pass; the new ones fail (`catalogOrigins` is not exported; `origins` without `baseUrl` currently only probes `originList[0]`).

- [ ] **Step 6b: Drop the now-unused `resolveDataUrl` import from `catalog.ts`**

Task 3's brief had `catalog.ts` keep importing `resolveDataUrl` on the
reasoning that it "documents that the guard did not move semantically". Its
review was right that this does not hold: after the refactor all three fetch
sites go through `handle.file`, which resolves internally, so the import has
no call site. An unused import is not documentation — it is something the
next lint pass silently deletes. Remove it from the import list, leaving the
other named imports intact:

```ts
import { type CatalogOrigin, TransportError, httpOrigin } from './origin.ts'
```

- [ ] **Step 7: Replace the single probe with the race in `catalog.ts`**

Swap the Task 3 step-5.4 block for:

```ts
  const cachedOrThrow = (error: unknown): CatalogResult => {
    const cached = readCached()
    if (cached !== null) return { snapshot: cached, stale: true }
    throw error
  }

  // Race every origin's cheap probe and commit to the first that answers
  // (design §3). A transport failure — here or on the bulk fetch — moves to
  // the next finisher; anything else throws, so a corrupt origin is never
  // hidden behind a healthy one.
  let handle: OriginHandle | null = null
  let pointerText = ''
  let lastTransportError: unknown = new TransportError('no catalog origin was reachable')
  for await (const settled of inCompletionOrder(
    originList.map(origin => origin.probe(AbortSignal.timeout(PROBE_TIMEOUT_MS))),
  )) {
    if (!('value' in settled)) {
      if (!(settled.reason instanceof TransportError)) throw settled.reason
      lastTransportError = settled.reason
      continue
    }
    try {
      pointerText = await settled.value.pointer()
      handle = settled.value
      break
    } catch (error) {
      if (!(error instanceof TransportError)) throw error
      lastTransportError = error
    }
  }
  if (handle === null) return cachedOrThrow(lastTransportError)
```

with the imports:

```ts
import { inCompletionOrder } from './race.ts'
```

Then simplify the two later `catch` blocks that Task 3 wrote to use the shared helper:

```ts
  let dataText: string
  try {
    dataText = await handle.file(pointer.plugins.url)
  } catch (error) {
    if (!(error instanceof TransportError)) throw error
    return cachedOrThrow(error)
  }
```

**A transport failure on the bulk fetch does not re-race.** The winner has already been chosen and its pointer parsed; retrying a different origin would mean reconciling a second, possibly different pointer mid-load. The cache fallback covers it and the next load races afresh. This is the boundary the two `half-up` tests draw: a failure in `pointer()` is still inside the race and falls through to another origin, while a failure in `file()` is past the commit point and falls back to the cache.

- [ ] **Step 8: Add `catalogOrigins` and the two constants to `catalog.ts`**

```ts
/** The catalog base the shipped `cordis.patch.yml` names. A row carrying
 * exactly this value expresses no preference, so the loader races its
 * defaults; anything else is a deliberate override and is used alone. */
export const DEFAULT_CATALOG_URL = 'https://LivXue.github.io/dsh-plugin-shop/v1/'

/** The npm package carrying the same `v1/` tree (design §2). */
export const CATALOG_PACKAGE = 'dsh-plugin-shop-catalog'

/** Registries raced by default: the domestic mirror first for legibility —
 * the race, not the order, decides the winner. */
const DEFAULT_REGISTRIES = ['https://registry.npmmirror.com/', 'https://registry.npmjs.org/']

/**
 * The origins to race for this installation (design §3).
 *
 * @param catalogUrl - the row's configured base.
 * @param npmRegistry - the user's own registry from `~/.npmrc`, or null.
 */
export function catalogOrigins(
  catalogUrl: string,
  fetchImpl: typeof fetch,
  npmRegistry: string | null,
): CatalogOrigin[] {
  // An explicit override must not be raced: racing would make the e2e
  // fixture nondeterministic and would silently defeat "point the shop at my
  // own mirror", which the README documents.
  if (catalogUrl !== DEFAULT_CATALOG_URL) return [httpOrigin(catalogUrl, fetchImpl)]
  const registries = [...DEFAULT_REGISTRIES]
  if (npmRegistry !== null && !registries.includes(npmRegistry)) registries.unshift(npmRegistry)
  return [
    ...registries.map(registry => npmOrigin(registry, CATALOG_PACKAGE, fetchImpl)),
    httpOrigin(catalogUrl, fetchImpl),
  ]
}
```

`npmRegistry` is compared against the defaults verbatim: a trailing-slash variant listing twice costs one extra probe and nothing else, which is not worth a normalisation routine that could itself be wrong.

- [ ] **Step 9: Run and watch the new cases pass**

```bash
pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/catalog.test.ts
```

Expected: all pass, pre-existing cases still unedited.

- [ ] **Step 10: Wire the origin list into `index.ts`**

In `packages/dsh-plugin-shop/src/host/index.ts`, add the imports and a memoised per-gateway origin list:

```ts
import { catalogOrigins, loadCatalog } from './catalog.ts'
import type { CatalogOrigin } from './origin.ts'
import { npmrcRegistry } from './npmrc.ts'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
```

`loadCatalog` is already imported in this file; merge rather than duplicating the import.

Add a private method on `ShopGateway`:

```ts
  /** The origins to race for this row's catalog. Read once per gateway: the
   * user's npmrc does not change under a running dsh, and re-reading it on
   * every catalog call would put a filesystem read on the hot path. */
  private originsFor(catalogUrl: string): CatalogOrigin[] {
    if (this.originCache?.catalogUrl === catalogUrl) return this.originCache.origins
    const registry = npmrcRegistry(path => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        // No user npmrc, or unreadable: the defaults are raced instead. This
        // is a preference, never a requirement.
        return null
      }
    }, homedir())
    const origins = catalogOrigins(catalogUrl, fetch, registry)
    this.originCache = { catalogUrl, origins }
    return origins
  }
```

with the field beside the existing `lastSnapshot`:

```ts
  private originCache: { catalogUrl: string; origins: CatalogOrigin[] } | null = null
```

Then change all four `load({ baseUrl: catalogUrl, cacheDir, ... })` call sites (around lines 546, 597, 727, 819) to:

```ts
    const { snapshot } = await load({ origins: this.originsFor(catalogUrl), cacheDir })
```

and the one at ~546, which passes `refresh`:

```ts
    const { snapshot, stale } = await load({ origins: this.originsFor(catalogUrl), cacheDir, refresh: args?.refresh ?? false })
```

Find them exactly rather than trusting these line numbers:

```bash
grep -n "baseUrl: catalogUrl" packages/dsh-plugin-shop/src/host/index.ts
```

- [ ] **Step 11: Full suite and typecheck**

```bash
pnpm -C packages/dsh-plugin-shop test
pnpm -C packages/dsh-plugin-shop typecheck
pnpm typecheck
```

Expected: all green. The `index.test.ts` cases inject `loadCatalog`, so they are unaffected; if any fails, it is asserting on `baseUrl` and needs to assert on `origins` — say so in the commit rather than quietly rewriting the assertion.

- [ ] **Step 12: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/npmrc.ts \
        packages/dsh-plugin-shop/tests/host/npmrc.test.ts \
        packages/dsh-plugin-shop/src/host/catalog.ts \
        packages/dsh-plugin-shop/src/host/index.ts \
        packages/dsh-plugin-shop/tests/host/catalog.test.ts
git commit -m "feat(host): race catalog origins and take the first to answer"
```

---

### Task 6: The catalog package's content

**Files:**
- Create: `registry/scripts/src/npm-package.ts`
- Create: `registry/scripts/tests/npm-package.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `function nextCatalogVersion(today: Date, publishedLatest: string | null): string`
  - `function catalogPackageFiles(input: CatalogPackageInput): CatalogPackageFiles`
  - `interface CatalogPackageInput { version: string; builtAt: string; count: number; pluginsFileName: string; starsFileName: string | null; shas: { plugins: string; stars: string | null } }`
  - `interface CatalogPackageFiles { packageJson: string; indexJs: string; readme: string }`

- [ ] **Step 1: Write the failing test**

`registry/scripts/tests/npm-package.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { catalogPackageFiles, nextCatalogVersion } from '../src/npm-package.ts'

describe('nextCatalogVersion', () => {
  it('stamps YYYY.MMDD.0 for the first build of a day', () => {
    expect(nextCatalogVersion(new Date('2026-09-01T03:17:00Z'), null)).toBe('2026.901.0')
  })

  it('increments the counter for a second build the same day', () => {
    expect(nextCatalogVersion(new Date('2026-09-01T11:00:00Z'), '2026.901.0')).toBe('2026.901.1')
    expect(nextCatalogVersion(new Date('2026-09-01T11:00:00Z'), '2026.901.7')).toBe('2026.901.8')
  })

  it('restarts the counter on a new day', () => {
    expect(nextCatalogVersion(new Date('2026-09-02T03:17:00Z'), '2026.901.4')).toBe('2026.902.0')
  })

  it('pads nothing: October is 1015, not 1015 zero-padded', () => {
    expect(nextCatalogVersion(new Date('2026-10-15T03:17:00Z'), null)).toBe('2026.1015.0')
  })

  // These orderings are the whole point of the scheme. Every version here is
  // PRODUCED by nextCatalogVersion, never written as a literal: a literal
  // version compared against a local helper tests only the helper, and would
  // pass against an implementation that returned a constant.
  it('orders monotonically across month and year boundaries', () => {
    const at = (iso: string, latest: string | null = null): string =>
      nextCatalogVersion(new Date(iso), latest)
    const sep = at('2026-09-01T03:17:00Z')
    const oct = at('2026-10-15T03:17:00Z')
    const dec = at('2026-12-31T03:17:00Z')
    const jan = at('2027-01-01T03:17:00Z')
    const sepAgain = at('2026-09-01T11:00:00Z', sep)

    // Every field is a bare integer, so a numeric tuple compare IS the semver
    // compare for this scheme — asserted below rather than assumed.
    for (const version of [sep, oct, dec, jan, sepAgain]) {
      expect(version.split('.').every(part => /^(0|[1-9]\d*)$/.test(part))).toBe(true)
    }
    const gt = (a: string, b: string): boolean => {
      const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)]
      for (let i = 0; i < 3; i += 1) {
        const l = x[i] ?? 0, r = y[i] ?? 0
        if (l !== r) return l > r
      }
      return false
    }
    expect(gt(oct, sep)).toBe(true)
    expect(gt(jan, dec)).toBe(true)
    expect(gt(sepAgain, sep)).toBe(true)
    expect(gt(dec, oct)).toBe(true)
  })

  it('uses UTC, so a late-evening local build does not skip a day', () => {
    expect(nextCatalogVersion(new Date('2026-09-01T23:59:00Z'), null)).toBe('2026.901.0')
  })

  it('ignores a published latest it cannot parse', () => {
    expect(nextCatalogVersion(new Date('2026-09-01T00:00:00Z'), '2026.901.beta')).toBe('2026.901.0')
  })
})

describe('catalogPackageFiles', () => {
  const input = {
    version: '2026.901.0',
    builtAt: '2026-09-01T03:17:00.000Z',
    count: 8897,
    pluginsFileName: 'plugins.abc123.json',
    starsFileName: 'stars.def456.json',
    shas: { plugins: 'abc123', stars: 'def456' },
  }

  it('declares the package with the given version and ships only v1', () => {
    const manifest = JSON.parse(catalogPackageFiles(input).packageJson) as Record<string, unknown>
    expect(manifest.name).toBe('dsh-plugin-shop-catalog')
    expect(manifest.version).toBe('2026.901.0')
    expect(manifest.files).toEqual(['v1', 'index.js'])
    expect(manifest.main).toBe('index.js')
    expect(manifest.license).toBe('MIT')
  })

  it('records the content hashes so the next build can decide to skip', () => {
    const manifest = JSON.parse(catalogPackageFiles(input).packageJson) as Record<string, unknown>
    expect(manifest.catalogShas).toEqual({ plugins: 'abc123', stars: 'def456' })
  })

  it('records a null stars hash when the build published no sidecar', () => {
    const manifest = JSON.parse(
      catalogPackageFiles({ ...input, starsFileName: null, shas: { plugins: 'abc123', stars: null } }).packageJson,
    ) as Record<string, unknown>
    expect(manifest.catalogShas).toEqual({ plugins: 'abc123', stars: null })
  })

  it('names both data files in the entry point', () => {
    const indexJs = catalogPackageFiles(input).indexJs
    expect(indexJs).toContain('plugins.abc123.json')
    expect(indexJs).toContain('stars.def456.json')
  })

  it('omits the stars accessor when the build published no sidecar', () => {
    const indexJs = catalogPackageFiles({ ...input, starsFileName: null, shas: { plugins: 'abc123', stars: null } }).indexJs
    expect(indexJs).not.toContain('stars.')
    expect(indexJs).toContain('starsPath = null')
  })

  it('states the build time and count in the readme', () => {
    const readme = catalogPackageFiles(input).readme
    expect(readme).toContain('2026-09-01T03:17:00.000Z')
    expect(readme).toContain('8897')
  })

  it('ends every file with exactly one trailing newline', () => {
    const files = catalogPackageFiles(input)
    for (const text of [files.packageJson, files.indexJs, files.readme]) {
      expect(text.endsWith('\n')).toBe(true)
      expect(text.endsWith('\n\n')).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run registry/scripts/tests/npm-package.test.ts
```

Expected: FAIL — cannot resolve `../src/npm-package.ts`.

- [ ] **Step 3: Write `npm-package.ts`**

```ts
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
```

- [ ] **Step 4: Run and watch it pass**

```bash
npx vitest run registry/scripts/tests/npm-package.test.ts
```

Expected: 12 passed.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add registry/scripts/src/npm-package.ts registry/scripts/tests/npm-package.test.ts
git commit -m "feat(registry): the catalog npm package's version and files"
```

---

### Task 7: The publish script

**Files:**
- Create: `registry/scripts/src/publish-catalog.ts`
- Modify: `package.json` (add the `publish:catalog` script)

**Interfaces:**
- Consumes: `nextCatalogVersion`, `catalogPackageFiles` (Task 6)
- Produces: a CLI. `node --experimental-strip-types registry/scripts/src/publish-catalog.ts [--dry-run]`. Exit 0 on publish or on a deliberate skip; non-zero on any failure.

This module is shell: clock, network, filesystem, environment, and a child process. Everything decidable without those already lives in Task 6.

- [ ] **Step 1: Write the script**

`registry/scripts/src/publish-catalog.ts`:

```ts
/**
 * Publish `dist/v1/` to npm as `dsh-plugin-shop-catalog` (design §2).
 *
 * Shell: reads the clock, the filesystem, the network, and spawns `npm
 * publish`. Every decision that could be made without those is in
 * `npm-package.ts`, which this only calls.
 *
 *   node --experimental-strip-types registry/scripts/src/publish-catalog.ts [--dry-run]
 *
 * Skips when the published `latest` already carries the same plugins and
 * stars hashes. Exits 0 on a skip: an unchanged catalog is a success, not a
 * failure.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { catalogPackageFiles, nextCatalogVersion } from './npm-package.ts'

const OUT_DIR = 'dist/v1'
const PKG_DIR = 'dist/npm'
const PACKAGE_NAME = 'dsh-plugin-shop-catalog'
const REGISTRY = 'https://registry.npmjs.org'
const MIRROR_SYNC = 'https://registry-direct.npmmirror.com'

const dryRun = process.argv.includes('--dry-run')

interface Pointer {
  builtAt: string
  count: number
  plugins: { url: string; sha256: string }
  stars?: { url: string; sha256: string }
}

const pointer = JSON.parse(readFileSync(join(OUT_DIR, 'index.json'), 'utf8')) as Pointer
const shas = { plugins: pointer.plugins.sha256, stars: pointer.stars?.sha256 ?? null }

/** The published `latest`, and the hashes it was built from. Absent when the
 * package has never been published — the first run. */
async function publishedLatest(): Promise<{ version: string; shas: { plugins: string; stars: string | null } } | null> {
  const response = await fetch(`${REGISTRY}/${PACKAGE_NAME}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`resolving ${PACKAGE_NAME} returned ${response.status}`)
  const packument = await response.json() as {
    'dist-tags'?: { latest?: string }
    versions?: Record<string, { catalogShas?: { plugins: string; stars: string | null } }>
  }
  const version = packument['dist-tags']?.latest
  if (version === undefined) return null
  return { version, shas: packument.versions?.[version]?.catalogShas ?? { plugins: '', stars: null } }
}

const previous = await publishedLatest()
if (previous !== null && previous.shas.plugins === shas.plugins && previous.shas.stars === shas.stars) {
  console.log(`catalog unchanged since ${previous.version} — nothing to publish`)
  process.exit(0)
}

const version = nextCatalogVersion(new Date(), previous?.version ?? null)
const files = catalogPackageFiles({
  version,
  builtAt: pointer.builtAt,
  count: pointer.count,
  pluginsFileName: pointer.plugins.url,
  starsFileName: pointer.stars?.url ?? null,
  shas,
})

rmSync(PKG_DIR, { recursive: true, force: true })
mkdirSync(join(PKG_DIR, 'v1'), { recursive: true })
writeFileSync(join(PKG_DIR, 'package.json'), files.packageJson)
writeFileSync(join(PKG_DIR, 'index.js'), files.indexJs)
writeFileSync(join(PKG_DIR, 'README.md'), files.readme)
// Copied, never regenerated: these are the bytes Pages serves.
for (const name of ['index.json', pointer.plugins.url, ...(pointer.stars === undefined ? [] : [pointer.stars.url])]) {
  copyFileSync(join(OUT_DIR, name), join(PKG_DIR, 'v1', name))
}

if (dryRun) {
  console.log(`would publish ${PACKAGE_NAME}@${version} from ${PKG_DIR}`)
  process.exit(0)
}

execFileSync('npm', ['publish', '--access', 'public'], { cwd: PKG_DIR, stdio: 'inherit' })
console.log(`published ${PACKAGE_NAME}@${version}`)

// Warm the mirror. npmmirror syncs on demand, and without this the first
// reader of each new version pays for the cold cache — precisely the reader
// this whole design exists for (design §2). Failing to warm is not failing to
// publish, so this never exits non-zero.
try {
  const created = await fetch(`${MIRROR_SYNC}/-/package/${PACKAGE_NAME}/syncs`, { method: 'PUT' })
  const task = await created.json() as { id?: string }
  if (task.id === undefined) throw new Error(`sync request returned ${created.status}`)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await fetch(`${MIRROR_SYNC}/-/package/${PACKAGE_NAME}/syncs/${task.id}`)
    const state = (await status.json() as { state?: string }).state
    if (state !== 'waiting') { console.log(`npmmirror sync ${task.id}: ${String(state)}`); break }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
} catch (error) {
  console.warn(`npmmirror sync could not be triggered: ${String(error)}`)
}
```

- [ ] **Step 2: Add the script to `package.json`**

In the root `package.json`, beside `build:catalog`:

```json
    "publish:catalog": "node --experimental-strip-types registry/scripts/src/publish-catalog.ts",
```

- [ ] **Step 3: Prove the skip path and the assembly, without publishing**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
mkdir -p dist/v1
printf '{"schemaVersion":5,"plugins":[],"denied":[]}\n' > dist/v1/plugins.testsha.json
printf '{"stars":{}}\n' > dist/v1/stars.teststars.json
cat > dist/v1/index.json <<'EOF'
{
  "schemaVersion": 5,
  "builtAt": "2026-09-01T03:17:00.000Z",
  "count": 0,
  "rejected": 0,
  "plugins": { "url": "plugins.testsha.json", "sha256": "testsha" },
  "stars": { "url": "stars.teststars.json", "sha256": "teststars" }
}
EOF
pnpm publish:catalog -- --dry-run
```

Expected on a never-published package: `would publish dsh-plugin-shop-catalog@<YYYY>.<MMDD>.0 from dist/npm`.

Then inspect what it assembled:

```bash
find dist/npm -type f | sort
cat dist/npm/package.json
node -e "const c=require('./dist/npm');console.log(c.readIndex().count, c.readPlugins().plugins.length, c.readStars())"
```

Expected: the three generated files plus `v1/index.json`, `v1/plugins.testsha.json`, `v1/stars.teststars.json`; `readIndex()`/`readPlugins()`/`readStars()` all work through the generated `index.js`.

Clean up so the throwaway pointer cannot be mistaken for a build:

```bash
rm -rf dist
```

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/publish-catalog.ts package.json
git commit -m "feat(registry): publish the catalog to npm and warm the mirror"
```

---

### Task 8: The CI publish step

**Files:**
- Modify: `.github/workflows/daily.yml`

**Interfaces:**
- Consumes: `pnpm publish:catalog` (Task 7)
- Produces: nothing other tasks depend on

**Per the spec §7.2, this step is `workflow_dispatch`-only in this commit.** The granular token's ability to publish non-interactively is inference until a real publish proves it, and this account has blocked non-interactive publishes before. Moving it to the daily schedule is a separate, deliberate commit after the first manual run succeeds.

- [ ] **Step 0: Give the `build` job the OIDC permission provenance needs**

`NPM_CONFIG_PROVENANCE: 'true'` (step 1) makes `npm publish` request a Sigstore
attestation, which it mints from GitHub's OIDC endpoint *before* uploading. That
needs `id-token: write` on the job — and job-level `permissions:` is
**exhaustive, not additive**, so the `build` job's `contents: write` leaves
`id-token` at `none`. The `deploy` job's own `id-token: write` does not reach
`build`. Without this the publish hard-fails:

```
npm error code EUSAGE
npm error Provenance generation in GitHub Actions requires "write" access to the "id-token" permission
```

which would kill the first human-watched `workflow_dispatch` run on an error
that has nothing to do with the token being tested. Provenance is worth keeping
rather than dropping: the repository is public and the script already passes
`--access public`, which are the other two conditions npm requires, and it lets
anyone verify the catalog came from this repo's CI with `npm audit signatures`.

In the `build` job's `permissions:` block:

```yaml
    permissions:
      contents: write
      # Provenance attestation on the catalog publish is minted from GitHub's
      # OIDC endpoint. Job permissions are exhaustive, so this must be named
      # here even though the deploy job already has it.
      id-token: write
```

- [ ] **Step 1: Add the step**

In `.github/workflows/daily.yml`, in the `build` job, immediately after `- name: Upload build report` and before `- name: Publish to Pages`:

```yaml
      - name: Publish the catalog to npm
        # workflow_dispatch only until a real publish proves the granular
        # token publishes without an OTP (design §7.2). Moving this to the
        # schedule is its own commit, made after the first manual run.
        if: github.event_name == 'workflow_dispatch'
        # Bounded because the mirror-warm poll at the end of publish:catalog has
        # no timeout of its own (Task 7 review, Minor): it makes up to 21
        # requests to npmmirror, and a connection that is accepted but never
        # answered falls back on undici's 300 s defaults. Publishing plus a
        # successful warm takes well under a minute, so ten is generous and
        # still fails fast instead of burning runner time.
        timeout-minutes: 10
        run: pnpm publish:catalog
        env:
          # Distinct from NPM_TOKEN, which is read-only and only lifts the
          # search API's rate limit.
          NODE_AUTH_TOKEN: ${{ secrets.NPM_PUBLISH_TOKEN }}
          NPM_CONFIG_PROVENANCE: 'true'
```

`npm publish` reads `NODE_AUTH_TOKEN` only when an `.npmrc` references it, so also add, as the step immediately before it:

```yaml
      - name: Authenticate to npm
        if: github.event_name == 'workflow_dispatch'
        run: echo "//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}" > ~/.npmrc
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_PUBLISH_TOKEN }}
```

- [ ] **Step 2: Validate the workflow parses**

```bash
python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/daily.yml')); \
  steps=d['jobs']['build']['steps']; \
  print('\n'.join(s.get('name', s.get('run','<run>'))[:60] for s in steps))"
```

Expected: the two new steps appear between the report upload and the Pages publish.

- [ ] **Step 3: Confirm the secret exists**

```bash
gh secret list --repo LivXue/dsh-plugin-shop | grep NPM_PUBLISH_TOKEN
```

Expected: one row. It was set on 2026-09-01. **The token in that secret was pasted in plaintext into a chat transcript and must be rotated**; rotating it does not change this workflow, only the secret's value.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/daily.yml
git commit -m "ci: publish the catalog package on manual dispatch"
```

---

### Task 9: End-to-end, and the byte-identical property

**Files:**
- Create: `packages/dsh-plugin-shop/tests/fixtures/npm-registry.ts`
- Create: `packages/dsh-plugin-shop/tests/host/transport-parity.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: nothing other tasks depend on

- [ ] **Step 1: Write the npm registry fixture**

`packages/dsh-plugin-shop/tests/fixtures/npm-registry.ts`:

```ts
/**
 * A minimal in-process npm registry for the origin tests: serves the
 * abbreviated `latest` manifest and the tarball it names, with
 * `dist.integrity` computed from the bytes actually served — the same
 * binding a real registry makes.
 *
 * Port 0 → the OS assigns an ephemeral port; the caller reads `registryUrl`
 * and closes the server in teardown.
 */

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface NpmRegistryFixture {
  registryUrl: string
  close: () => Promise<void>
}

/**
 * @param packageName - the package to serve; any other path 404s.
 * @param version - the version `latest` resolves to.
 * @param tarball - a real gzipped tar, e.g. from `npm pack`.
 */
export async function startNpmRegistry(
  packageName: string,
  version: string,
  tarball: Buffer,
): Promise<NpmRegistryFixture> {
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  let registryUrl = ''
  const server: Server = createServer((request, response) => {
    const path = request.url ?? '/'
    if (path === `/${packageName}/latest`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        name: packageName,
        version,
        dist: { tarball: `${registryUrl}${packageName}/-/${packageName}-${version}.tgz`, integrity },
      }))
      return
    }
    if (path === `/${packageName}/-/${packageName}-${version}.tgz`) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(tarball)
      return
    }
    response.writeHead(404).end('not found')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  registryUrl = `http://127.0.0.1:${port}/`
  return {
    registryUrl,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}
```

- [ ] **Step 2: Write the parity test**

`packages/dsh-plugin-shop/tests/host/transport-parity.test.ts`:

```ts
/**
 * The load-bearing property of design §2: one build, two transports, one
 * snapshot. If the npm package and the Pages tree can produce different
 * catalogs, the whole design's premise is gone — so this test builds a real
 * tarball from the same bytes the HTTP fixture serves and compares the two
 * loaded snapshots exactly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCatalog, type CatalogFs } from '../../src/host/catalog.ts'
import { httpOrigin } from '../../src/host/origin.ts'
import { npmOrigin } from '../../src/host/npm-origin.ts'
import { startNpmRegistry, type NpmRegistryFixture } from '../fixtures/npm-registry.ts'

const PKG = 'dsh-plugin-shop-catalog-parity'
const VERSION = '2026.901.0'

const ENTRY = {
  name: 'dsh-parity-plugin', version: '2.0.0', integrity: 'sha512-p', publishedAt: null,
  repository: null, license: 'MIT', tier: 'community', metadata: 'derived', added: '2026-08-25',
}

const pluginsText = `${JSON.stringify({ schemaVersion: 5, plugins: [ENTRY], denied: [] }, null, 2)}\n`
const pluginsSha = createHash('sha256').update(pluginsText).digest('hex')
const pluginsName = `plugins.${pluginsSha}.json`
const starsText = `${JSON.stringify({ stars: { 'dsh-parity-plugin': 7 } }, null, 2)}\n`
const starsSha = createHash('sha256').update(starsText).digest('hex')
const starsName = `stars.${starsSha}.json`
const indexText = `${JSON.stringify({
  schemaVersion: 5, builtAt: '2026-09-01T03:17:00.000Z', count: 1, rejected: 0,
  plugins: { url: pluginsName, sha256: pluginsSha },
  stars: { url: starsName, sha256: starsSha },
}, null, 2)}\n`

function memFs(): CatalogFs {
  const files = new Map<string, string>()
  return { exists: p => files.has(p), read: p => files.get(p) ?? '', write: (p, d) => { files.set(p, d) } }
}

let pagesServer: Server
let pagesUrl = ''
let registry: NpmRegistryFixture
let workDir = ''

beforeAll(async () => {
  // The Pages transport: the three files, served as-is.
  const bodies = new Map([
    ['/v1/index.json', indexText],
    [`/v1/${pluginsName}`, pluginsText],
    [`/v1/${starsName}`, starsText],
  ])
  pagesServer = createServer((request, response) => {
    const body = bodies.get(request.url ?? '')
    if (body === undefined) { response.writeHead(404).end('not found'); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(body)
  })
  await new Promise<void>(resolve => pagesServer.listen(0, '127.0.0.1', resolve))
  pagesUrl = `http://127.0.0.1:${(pagesServer.address() as AddressInfo).port}/v1/`

  // The npm transport: the SAME three files, packed by npm itself.
  workDir = mkdtempSync(join(tmpdir(), 'shop-parity-'))
  mkdirSync(join(workDir, 'v1'), { recursive: true })
  writeFileSync(join(workDir, 'v1', 'index.json'), indexText)
  writeFileSync(join(workDir, 'v1', pluginsName), pluginsText)
  writeFileSync(join(workDir, 'v1', starsName), starsText)
  writeFileSync(join(workDir, 'package.json'), `${JSON.stringify({
    name: PKG, version: VERSION, license: 'MIT', files: ['v1'],
  }, null, 2)}\n`)
  execFileSync('npm', ['pack', '--silent'], { cwd: workDir, stdio: 'pipe' })
  const packed = readdirSync(workDir).find(f => f.endsWith('.tgz'))
  if (packed === undefined) throw new Error('npm pack produced no tarball')
  registry = await startNpmRegistry(PKG, VERSION, readFileSync(join(workDir, packed)))
}, 60_000)

afterAll(async () => {
  await new Promise<void>(resolve => pagesServer.close(() => resolve()))
  await registry.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('transport parity', () => {
  it('produces an identical snapshot over HTTP and over npm', async () => {
    const viaHttp = await loadCatalog({
      cacheDir: '/cache-http', fsImpl: memFs(),
      origins: [httpOrigin(pagesUrl, fetch)],
    })
    const viaNpm = await loadCatalog({
      cacheDir: '/cache-npm', fsImpl: memFs(),
      origins: [npmOrigin(registry.registryUrl, PKG, fetch)],
    })
    expect(viaNpm.snapshot).toEqual(viaHttp.snapshot)
    expect(viaNpm.snapshot.entries).toHaveLength(1)
    expect(viaNpm.snapshot.stars).toEqual({ 'dsh-parity-plugin': 7 })
    expect(viaNpm.stale).toBe(false)
  })

  it('races the two and still produces that same snapshot', async () => {
    const viaHttp = await loadCatalog({
      cacheDir: '/cache-http2', fsImpl: memFs(),
      origins: [httpOrigin(pagesUrl, fetch)],
    })
    const raced = await loadCatalog({
      cacheDir: '/cache-race', fsImpl: memFs(),
      origins: [npmOrigin(registry.registryUrl, PKG, fetch), httpOrigin(pagesUrl, fetch)],
    })
    expect(raced.snapshot).toEqual(viaHttp.snapshot)
  })

  it('survives a dead origin in the list', async () => {
    const raced = await loadCatalog({
      cacheDir: '/cache-dead', fsImpl: memFs(),
      origins: [
        npmOrigin('http://127.0.0.1:1/', PKG, fetch),
        httpOrigin('http://127.0.0.1:1/v1/', fetch),
        npmOrigin(registry.registryUrl, PKG, fetch),
      ],
    })
    expect(raced.snapshot.entries).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run it**

```bash
pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/transport-parity.test.ts
```

Expected: 3 passed. If `npm pack` is slow in your environment the 60 s `beforeAll` budget covers it; if it exceeds that, raise the budget rather than dropping the real `npm pack`.

- [ ] **Step 4: Full suite, both typechecks**

```bash
pnpm -C packages/dsh-plugin-shop test
pnpm test
pnpm typecheck
pnpm -C packages/dsh-plugin-shop typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/tests/fixtures/npm-registry.ts \
        packages/dsh-plugin-shop/tests/host/transport-parity.test.ts
git commit -m "test(host): prove the npm and HTTP transports load one snapshot"
```

---

### Task 10: Documentation

**Files:**
- Modify: `packages/dsh-plugin-shop/README.md`
- Modify: `packages/dsh-plugin-shop/docs/README.zh.md`
- Modify: `docs/design/2026-08-18-dsh-plugin-shop-design.md` (the amendment the spec promises)

**Interfaces:**
- Consumes: nothing
- Produces: nothing

- [ ] **Step 0: Correct §4's tar prose in this feature's own spec**

The Task 1 review found `docs/design/2026-09-01-catalog-mirrors.md` §4 saying
the parser will "reject any name escaping `package/`", while the shipped
parser refuses any path with a `..` segment or a leading `/` — a generic
root-escape check, which is the actual security property and stronger than a
prefix requirement. CLAUDE.md: when spec and code disagree, the spec wins or
the spec is amended in the same change. The code is right here, so amend §4:

Replace `collect the entries
under `package/v1/`, reject any name escaping `package/`.` with:

```markdown
collect every entry, refusing any path with a `..` segment or a leading `/`
— the generic escape check, not a `package/` prefix requirement, because the
property that matters is that nothing can be written outside the tree.
```

- [ ] **Step 1: Amend the authority spec**

`docs/design/2026-08-18-dsh-plugin-shop-design.md` is the authority, and this change contradicts two places in it. Per CLAUDE.md the spec wins or the spec gets amended in the same change.

In §5.1, after the sentence beginning "Artifacts publish to a CDN as `/v1/index.json`…", add:

```markdown
**Amendment (2026-09-01): the CDN becomes a set of raced origins.** The same
`v1/` tree also publishes as the npm package `dsh-plugin-shop-catalog`, and
the Host races a cheap pointer request across npm registries and Pages,
taking the bulk transfer from whichever answers first. The pointer/data split
is unchanged and does all the same work; what changes is that there is more
than one place to ask. Driven by measurement: the Pages origin serves a
China-side reader at 0.03 MB/s against an npm mirror's 12.53 MB/s. See
`2026-09-01-catalog-mirrors.md`.
```

In the threat-model table, replace the "Catalog man-in-the-middle" row's residual-risk cell so it reads:

```markdown
| Catalog man-in-the-middle | `index.json` points at content-addressed data; the Host verifies the fetched sha256 against the pointer; this repository's git history is the second source of truth | `index.json` itself being replaced, mitigated by HTTPS and — over the npm transport — by npm's `dist.integrity`, computed at publish time and carried in a signed packument |
```

- [ ] **Step 2: Document the behaviour in the English README**

`packages/dsh-plugin-shop/README.md` already has an environment-variable table containing `DSH_SHOP_CATALOG_URL`. Change that row's description and add a paragraph above the table:

```markdown
The shop reads its catalog from whichever source answers first: the npm
package `dsh-plugin-shop-catalog` (via your configured registry, npmmirror,
or npmjs) or `https://LivXue.github.io/dsh-plugin-shop/v1/`. All of them
carry the same bytes; the race exists because the link to one of them can be
far slower than the link to another. Setting `DSH_SHOP_CATALOG_URL` opts out
of the race and uses only what you name.
```

Row description becomes:

```markdown
| `DSH_SHOP_CATALOG_URL` | Read the catalog only from this base, instead of racing the default sources |
```

- [ ] **Step 3: Mirror it in the Chinese README**

`packages/dsh-plugin-shop/docs/README.zh.md`. State the same facts in its own register — this is not a word-for-word translation:

```markdown
插件目录会从几个来源里挑最先响应的那个读：npm 包 `dsh-plugin-shop-catalog`
（走你配置的 registry、npmmirror 或 npmjs），或者
`https://LivXue.github.io/dsh-plugin-shop/v1/`。几个来源的内容完全一致，之所以
要赛跑，是因为不同网络到它们的快慢可以差出几百倍。设了
`DSH_SHOP_CATALOG_URL` 就不再赛跑，只读你指定的那个。
```

Row description becomes:

```markdown
| `DSH_SHOP_CATALOG_URL` | 只从这个地址读目录，不再在默认来源之间赛跑 |
```

- [ ] **Step 4: Check both READMEs still agree on the version pin**

```bash
npx vitest run registry/scripts/tests/readme-pins.test.ts
```

Expected: pass. This task changes no version; if it fails, a pin was disturbed by accident.

- [ ] **Step 5: Commit**

```bash
git add docs/design/2026-08-18-dsh-plugin-shop-design.md \
        packages/dsh-plugin-shop/README.md \
        packages/dsh-plugin-shop/docs/README.zh.md
git commit -m "docs: the catalog has several origins, raced"
```

---

## Known gap

`PROBE_TIMEOUT_MS` is enforced through `AbortSignal.timeout` and is **not
covered by a test**: asserting it needs either fake timers threaded through
an async generator or a real ten-second wait, and neither earns its cost
against a two-line construction. It is called out here rather than left for a
reviewer to notice its absence. If the timeout ever needs tuning, make it an
injectable option at that point and test it then.

## Release

Not a task — the sequence after the plan is done, from spec §7.

1. Merge to `main`; the daily build keeps publishing Pages exactly as before.
2. Run the `catalog` workflow by hand (`workflow_dispatch`) to make the first
   `dsh-plugin-shop-catalog` publish. **This is the step that proves the
   granular token publishes without an OTP.** If it fails on 2FA, the token
   must be replaced with one that bypasses it before anything else proceeds.
3. Confirm the package is on npm and reachable from the mirror:

   ```bash
   curl -sS --noproxy '*' https://registry.npmmirror.com/dsh-plugin-shop-catalog/latest | head -c 300
   ```

4. Publish the Host change to the `beta` dist-tag; install it on a real
   profile and confirm the shelf still loads — and, on a China-side machine,
   that it now loads fast.
5. Only then: a separate commit moving the CI publish step from
   `workflow_dispatch` to the daily schedule, and the promotion of the Host
   change to `latest` with the README pins.
