import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { MAX_TARBALL_BYTES } from '../src/github-client.ts'
import { MAX_CATALOG_ICON_BYTES, checkIconBytes, iconDataUrl, sha256Hex } from '../src/icon-bytes.ts'
import { iconDetail, iconLabel, shownPath } from '../src/icon-declaration.ts'
import type { IconDeclaration } from '../src/icon-declaration.ts'
import {
  ICON_FETCH_BUDGET_DEFAULT,
  ICON_FETCH_CONCURRENCY,
  ICON_FETCH_TIME_BUDGET_MS_DEFAULT,
  PUBLISHED_CATALOG_URL,
  fetchIcon,
  harvestIcons,
  readPublishedIcons,
} from '../src/icon-fetch.ts'
import type { IconTransport } from '../src/icon-fetch.ts'
import type { IconFetchResult, IconPlan, IconWork } from '../src/icon-plan.ts'
import { githubIconKey, npmIconKey, releaseIconKey } from '../src/icon-state.ts'
import { serializeIcons } from '../src/icons-assemble.ts'
import type { IconsFile } from '../src/icons-assemble.ts'
import { MAX_INFLATED_BYTES, readPackedDeclarations, verifyReleaseAsset } from '../src/release-asset.ts'
import { rawTarball } from './packed-tarball.ts'
import { headersThenBodyError, headersThenStalledBody } from './stalling-fetch.ts'

const MIB = 1024 * 1024
const sleep = async (_ms: number) => {}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>'
const COMMIT = 'c'.repeat(40)
const PATH = 'assets/icon.svg'
const LABEL = iconLabel('icon')
const SHOWN = shownPath(PATH)

// ---------------------------------------------------------------------------
// Fixtures. Every fetch here is a stub: no test reaches a network.
// ---------------------------------------------------------------------------

interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** A fetch that answers from `answer` and remembers what it was asked. */
function recording(answer: (url: string) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return await answer(url)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** A fetch that answers every URL with what `make` builds: a body is read once, so each call needs a fresh response. */
function always(make: () => Response): { fetchImpl: typeof fetch; calls: Call[] } {
  return recording(() => make())
}

/** The Authorization header a call carried, which is the one thing a token travels in. */
function authorization(call: Call | undefined): string | undefined {
  return (call?.init?.headers as Record<string, string> | undefined)?.Authorization
}

/**
 * `total` zero bytes served a mebibyte at a time, counting the pulls and whether
 * the reader gave up. A reader that stops exactly at the last chunk finds the
 * stream already closed, and cancelling a closed stream tells its source nothing:
 * a fixture that wants to see the cancel must hold more than the cap.
 */
function streamOfZeros(total: number): { make: () => Response; stats: { pulled: number; cancelled: boolean } } {
  const stats = { pulled: 0, cancelled: false }
  const make = (): Response => {
    let sent = 0
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const size = Math.min(MIB, total - sent)
        if (size <= 0) {
          controller.close()
          return
        }
        stats.pulled += 1
        sent += size
        controller.enqueue(new Uint8Array(size))
      },
      cancel() {
        stats.cancelled = true
      },
    }))
  }
  return { make, stats }
}

function transportOf(fetchImpl: typeof fetch, overrides: Partial<IconTransport> = {}): IconTransport {
  return { fetchImpl, sleep, token: 'gh-token', timeoutMs: 30_000, tarballTimeoutMs: 30_000, ...overrides }
}

/** SRI text for `bytes`, as npm writes `dist.integrity` (sha512) or as another algorithm would. */
function sriOf(bytes: Uint8Array, algorithm = 'sha512'): string {
  return `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`
}

/** A gzipped tar whose members are `files` under `root`: `package` as `npm pack` writes it, or another, or `./package`. */
function tarballOf(files: Record<string, string>, root = 'package'): Uint8Array {
  return rawTarball(Object.fromEntries(Object.entries(files).map(([path, body]) => [`${root}/${path}`, body])))
}

function declaration(path = PATH, source: IconDeclaration['source'] = 'icon'): IconDeclaration {
  return { source, path, mediaType: 'image/svg+xml' }
}

const NPM_URL = 'https://registry.npmjs.org/x/-/x-1.0.0.tgz'

function npmWork(
  tarball: Uint8Array,
  overrides: { path?: string; source?: IconDeclaration['source']; tarball?: string; integrity?: string } = {},
): IconWork {
  const path = overrides.path ?? PATH
  return {
    key: npmIconKey('x', '1.0.0', path),
    target: { kind: 'npm', name: 'x', version: '1.0.0', tarball: overrides.tarball ?? NPM_URL, integrity: overrides.integrity ?? sriOf(tarball), path },
    declaration: declaration(path, overrides.source),
  }
}

/** A git-installed entry's icon; `subdir` is the subpackage directory, which the repository path carries and the declaration does not. */
function githubWork(declared = PATH, options: { subdir?: string; repo?: string; commit?: string } = {}): IconWork {
  const repo = options.repo ?? 'owner/repo'
  const commit = options.commit ?? COMMIT
  const path = options.subdir === undefined ? declared : `${options.subdir}/${declared}`
  return {
    key: githubIconKey(repo, commit, path),
    target: { kind: 'github', repo, commit, path },
    declaration: declaration(declared),
  }
}

const RELEASE_URL = 'https://github.com/owner/repo/releases/download/v1.0.0/plugin.tgz'

function releaseWork(tarball: Uint8Array, overrides: { url?: string; sha256?: string; repo?: string } = {}): IconWork {
  const sha256 = overrides.sha256 ?? sha256Hex(tarball)
  return {
    key: releaseIconKey(sha256, PATH),
    target: { kind: 'release', repo: overrides.repo ?? 'owner/repo', url: overrides.url ?? RELEASE_URL, sha256, path: PATH },
    declaration: declaration(),
  }
}

/** The bytes of a result that has them, as text. */
function textOf(result: IconFetchResult): string {
  if (result.kind !== 'bytes') throw new Error(`expected bytes, got ${JSON.stringify(result)}`)
  return Buffer.from(result.bytes).toString('utf8')
}

/** The reason of a result that has one, which is the log's. */
function reasonOf(result: IconFetchResult): string {
  if (result.kind !== 'not-yet-read') throw new Error(`expected not-yet-read, got ${JSON.stringify(result)}`)
  return result.reason
}

// ---------------------------------------------------------------------------
// What the module is held to
// ---------------------------------------------------------------------------

describe('the figures the module and its published sentences are held to', () => {
  // `iconDetail` sits below the modules that own these constants and cannot
  // import them, so it writes the figures out in the sentences an author reads.
  // If a constant moves and the copy does not, an author is told a bound the
  // build does not apply; this is what makes one change drag the other.
  it('packageTooLarge names the cap an npm tarball is read under', () => {
    expect(iconDetail.packageTooLarge('x', '1.0.0')).toContain(`the ${MAX_TARBALL_BYTES / MIB} MiB the catalog build downloads`)
  })

  it('packageUnpacksTooLarge names the cap an archive is inflated under', () => {
    expect(iconDetail.packageUnpacksTooLarge('x', '1.0.0')).toContain(`the ${MAX_INFLATED_BYTES / MIB} MiB the catalog build reads`)
  })

  it('applies those caps when the transport names none', async () => {
    // Each cap at its boundary, read through the defaults: a transport that
    // forgot its `caps` would otherwise be tested only at the values the tests
    // lower them to.
    const body = streamOfZeros(MAX_TARBALL_BYTES + 8 * MIB)
    const downloaded = await fetchIcon(npmWork(new Uint8Array(1)), transportOf(always(body.make).fetchImpl))
    expect(downloaded).toEqual({ kind: 'not-read', detail: iconDetail.packageTooLarge('x', '1.0.0') })
    // The reader gives up just past the cap, a chunk or two ahead of itself at
    // the most, and does not buy the rest of the body.
    expect(body.stats.cancelled).toBe(true)
    expect(body.stats.pulled).toBeLessThanOrEqual(MAX_TARBALL_BYTES / MIB + 2)
    // A body of exactly the cap is within it: it is read whole, and then fails
    // the integrity check it has no digest for, which is another answer.
    const atCap = await fetchIcon(npmWork(new Uint8Array(1)), transportOf(always(streamOfZeros(MAX_TARBALL_BYTES).make).fetchImpl))
    expect(atCap.kind).toBe('not-yet-read')
    expect(reasonOf(atCap)).toContain('dist.integrity')

    // The inflate cap is read the same way: nothing but zeros, so the archives
    // are small. One byte past it is too large; at it, the archive is unpacked
    // and holds no member, which is a different answer.
    const zeros = new Uint8Array(MAX_INFLATED_BYTES + 1)
    const over = gzipSync(zeros)
    const unpacked = await fetchIcon(npmWork(over), transportOf(always(() => new Response(over)).fetchImpl))
    expect(unpacked).toEqual({ kind: 'not-read', detail: iconDetail.packageUnpacksTooLarge('x', '1.0.0') })
    const at = gzipSync(zeros.subarray(0, MAX_INFLATED_BYTES))
    const empty = await fetchIcon(npmWork(at), transportOf(always(() => new Response(at)).fetchImpl))
    expect(empty).toEqual({ kind: 'refused', detail: iconDetail.notInPackage(LABEL, SHOWN, 'x', '1.0.0') })
  }, 30_000)

  it('keeps the figures the arithmetic in their comment derives', () => {
    expect(ICON_FETCH_BUDGET_DEFAULT).toBe(1500)
    expect(ICON_FETCH_TIME_BUDGET_MS_DEFAULT).toBe(15 * 60 * 1000)
    expect(ICON_FETCH_CONCURRENCY).toBe(8)
    expect(PUBLISHED_CATALOG_URL).toBe('https://LivXue.github.io/dsh-plugin-shop/v1/')
  })
})

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

describe('fetchIcon: the listed npm tarball', () => {
  const files = { 'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }), [PATH]: SVG }

  it.each([
    ['package/', 'package'],
    ['another directory, pkg/', 'pkg'],
    ['members prefixed ./package/', './package'],
  ])('finds the icon in a tarball rooted at %s', async (_label, root) => {
    const tarball = tarballOf(files, root)
    const { fetchImpl } = always(() => new Response(tarball))
    const result = await fetchIcon(npmWork(tarball), transportOf(fetchImpl))
    expect(textOf(result)).toBe(SVG)
  })

  it('asks the registry for the URL it parsed, and sends it no token', async () => {
    // The token is the job's GitHub token: an npm credential it is not, and
    // the registry has no use for it.
    const tarball = tarballOf(files)
    const { fetchImpl, calls } = always(() => new Response(tarball))
    await fetchIcon(npmWork(tarball), transportOf(fetchImpl))
    expect(calls.map(call => call.url)).toEqual([NPM_URL])
    expect(authorization(calls[0])).toBeUndefined()
  })

  it('looks the icon up at its path under the root, in a nested directory too', async () => {
    const tarball = tarballOf({ ...files, 'dist/assets/other.svg': '<svg/>' })
    const { fetchImpl } = always(() => new Response(tarball))
    const result = await fetchIcon(npmWork(tarball, { path: 'dist/assets/other.svg' }), transportOf(fetchImpl))
    expect(textOf(result)).toBe('<svg/>')
  })

  describe('a file name that is not ASCII', () => {
    // `readTar` spells a name by its bytes, one character each, so the member
    // `package/assets/图标.svg` reaches the lookup as the string those UTF-8 bytes
    // make, and the declared path is looked for as the same bytes. Spelled any
    // other way the icon is reported missing from a package that ships it, a
    // reason that is false, or another file's bytes are taken for it.
    const path = 'assets/图标.svg'

    it('finds the icon', async () => {
      const tarball = tarballOf({ 'package.json': '{}', [path]: SVG })
      const { fetchImpl } = always(() => new Response(tarball))
      expect(textOf(await fetchIcon(npmWork(tarball, { path }), transportOf(fetchImpl)))).toBe(SVG)
    })

    it('finds it in a tarball `npm pack` wrote, pax header and all', async () => {
      // `npm pack` 11.18.0 of a package whose icon is `assets/图标.svg` (the 42
      // bytes below): node-tar writes the name in UTF-8 in the ustar header and
      // again in a pax header, which the reader skips.
      const tarball = Buffer.from(
        'H4sIAAAAAAAC/+2VO07EMBCGU+cUlmuwx84DZUWoKekRhRVMNrB5KDabCETNIWg4CbeBczCGFeLZLdHuyl8zo/93YWv0ezpVXKlS8+69skvTNsGaAYA0jslvukNE6EVJCkKkKWCPTeLOQzAB18aqHq+yhkci5KNuCbeENqrWdEZo0exXRdvQPUKXujcVtqgKBgyc9uahoIzR1vDnh6eXx3tmlqUzL6qFNuiermx6Ru7CwLPxnKjxWKtz3X8a6NT5d3H5mn+ZxKiNPv//Dv69nbLzfPX/8x/pDkVGalvVOo+zTKQyAQiFIKa6QUX6jG85f859uvxDIr/nP4oPpN//U3CIoyZjvWhMTufWdjPOh2FgQ8TavuQSn8LdiudHPukej8ezU7wCF1ptMgAQAAA=',
        'base64',
      )
      const { fetchImpl } = always(() => new Response(tarball))
      const work: IconWork = { ...npmWork(tarball, { path }), target: { kind: 'npm', name: 'cn-icon', version: '1.0.0', tarball: NPM_URL, integrity: sriOf(tarball), path } }
      expect(textOf(await fetchIcon(work, transportOf(fetchImpl)))).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>\n')
    })

    it('does not take another file for it whose name has the same low bits', async () => {
      // `é` is C3 A9, which with the high bit of each byte dropped is `C)`: a
      // reader that decodes names as ASCII makes one name of `é.svg` and `C).svg`.
      const tarball = tarballOf({ 'C).svg': '<svg id="not-the-declared-file"/>' })
      const { fetchImpl } = always(() => new Response(tarball))
      const result = await fetchIcon(npmWork(tarball, { path: 'é.svg' }), transportOf(fetchImpl))
      expect(result).toEqual({ kind: 'refused', detail: iconDetail.notInPackage(LABEL, shownPath('é.svg'), 'x', '1.0.0') })
    })

    it('takes the declared file when an archive holds both', async () => {
      const tarball = tarballOf({ 'é.svg': '<svg id="e-acute"/>', 'C).svg': '<svg id="c-paren"/>' })
      const { fetchImpl } = always(() => new Response(tarball))
      expect(textOf(await fetchIcon(npmWork(tarball, { path: 'é.svg' }), transportOf(fetchImpl)))).toBe('<svg id="e-acute"/>')
      expect(textOf(await fetchIcon(npmWork(tarball, { path: 'C).svg' }), transportOf(fetchImpl)))).toBe('<svg id="c-paren"/>')
    })
  })

  it('hands over a copy of the member, not a view that keeps the whole inflated archive alive', async () => {
    // Every result of a run is held until the fold has run, and a view would
    // keep each one's archive, up to 64 MiB, in memory with it.
    const tarball = tarballOf({ ...files, 'filler.bin': 'x'.repeat(100_000) })
    const { fetchImpl } = always(() => new Response(tarball))
    const result = await fetchIcon(npmWork(tarball), transportOf(fetchImpl))
    if (result.kind !== 'bytes') throw new Error(JSON.stringify(result))
    expect(result.bytes.buffer.byteLength).toBe(result.bytes.byteLength)
  })

  describe('the dist.integrity check', () => {
    const tarball = tarballOf(files)
    const other = tarballOf({ ...files, [PATH]: '<svg/>' })
    const serve = always(() => new Response(tarball))

    it.each(['sha512', 'sha384', 'sha256', 'sha1'])('accepts a matching %s digest', async algorithm => {
      const result = await fetchIcon(npmWork(tarball, { integrity: sriOf(tarball, algorithm) }), transportOf(serve.fetchImpl))
      expect(textOf(result)).toBe(SVG)
    })

    it('is not-yet-read when the digest is another tarball\'s, and never reads the icon from it', async () => {
      const result = await fetchIcon(npmWork(tarball, { integrity: sriOf(other) }), transportOf(serve.fetchImpl))
      expect(result.kind).toBe('not-yet-read')
      expect(reasonOf(result)).toContain('dist.integrity')
    })

    it.each([
      // The digests below all MATCH the tarball: what is refused is the algorithm.
      ['md5', sriOf(tarball, 'md5')],
      ['sha224', sriOf(tarball, 'sha224')],
      ['sha3-256', sriOf(tarball, 'sha3-256')],
      // The gate admits any `[a-z0-9]+` algorithm, so one the build cannot compute reaches here.
      ['an algorithm no build computes', `sha999-${createHash('sha512').update(tarball).digest('base64')}`],
      ['no algorithm', `-${createHash('sha512').update(tarball).digest('base64')}`],
      ['no hyphen at all', createHash('sha512').update(tarball).digest('base64')],
      ['an empty string', ''],
    ])('is not-yet-read, and downloads nothing, for an integrity with %s', async (_label, integrity) => {
      // The algorithm is read before the request: a tarball nothing can check
      // is not worth 32 MiB, and would be asked for again tomorrow.
      const { fetchImpl, calls } = always(() => new Response(tarball))
      const result = await fetchIcon(npmWork(tarball, { integrity }), transportOf(fetchImpl))
      expect(result.kind).toBe('not-yet-read')
      expect(reasonOf(result)).toContain('sha512, sha384, sha256 or sha1')
      expect(calls).toEqual([])
    })

    it('uses a digest it can compute from a list that also holds ones it cannot', async () => {
      const { fetchImpl, calls } = always(() => new Response(tarball))
      const integrity = `md5-${createHash('md5').update(other).digest('base64')} ${sriOf(tarball)}`
      expect(textOf(await fetchIcon(npmWork(tarball, { integrity }), transportOf(fetchImpl)))).toBe(SVG)
      expect(calls).toHaveLength(1)
    })

    it('calls bytes that do not match unverified, whatever they hold: only the listed bytes can be called unreadable', async () => {
      // A mirror or an edge answering in the registry's place may serve anything.
      // What it serves says nothing about the version, so it is "not yet read",
      // never the "not read" that would be recorded for good.
      const junk = Buffer.from('this is not a tarball')
      const { fetchImpl } = always(() => new Response(junk))
      const result = await fetchIcon(npmWork(junk, { integrity: sriOf(tarball) }), transportOf(fetchImpl))
      expect(result.kind).toBe('not-yet-read')
      expect(reasonOf(result)).toContain('dist.integrity')
    })

    it('judges a list of digests by its strongest, as SRI does', async () => {
      const wrong = sriOf(other)
      const right = sriOf(tarball)
      const weakRight = sriOf(tarball, 'sha1')
      const weakWrong = sriOf(other, 'sha1')
      const transport = transportOf(serve.fetchImpl)
      // A weak digest that does not match is outvoted by a strong one that does.
      expect(textOf(await fetchIcon(npmWork(tarball, { integrity: `${weakWrong} ${right}` }), transport))).toBe(SVG)
      // A weak digest that matches cannot vouch for a strong one that does not.
      expect((await fetchIcon(npmWork(tarball, { integrity: `${weakRight} ${wrong}` }), transport)).kind).toBe('not-yet-read')
      // Of several digests of the strongest algorithm, one match is enough.
      expect(textOf(await fetchIcon(npmWork(tarball, { integrity: `${wrong} ${right}` }), transport))).toBe(SVG)
    })
  })

  describe('the tarball URL, which is hostile input', () => {
    const tarball = tarballOf(files)

    it.each([
      ['another host', 'https://registry.example.com/x/-/x-1.0.0.tgz'],
      ['plain http', 'http://registry.npmjs.org/x/-/x-1.0.0.tgz'],
      ['a port', 'https://registry.npmjs.org:8443/x/-/x-1.0.0.tgz'],
      ['a lookalike host', 'https://registry.npmjs.org.evil.example/x/-/x-1.0.0.tgz'],
      ['credentials that point the host elsewhere', 'https://registry.npmjs.org@evil.example/x/-/x-1.0.0.tgz'],
      ['credentials on the right host', 'https://user:secret@registry.npmjs.org/x/-/x-1.0.0.tgz'],
      ['a scheme that is not http', 'ftp://registry.npmjs.org/x/-/x-1.0.0.tgz'],
      ['a relative URL', '/x/-/x-1.0.0.tgz'],
      ['a protocol-relative URL to another host', '//evil.example/x-1.0.0.tgz'],
      ['text that is no URL', 'not a url'],
      ['an empty string', ''],
    ])('is not-yet-read, and asks nothing, for %s', async (_label, url) => {
      const { fetchImpl, calls } = always(() => new Response(tarball))
      const result = await fetchIcon(npmWork(tarball, { tarball: url }), transportOf(fetchImpl))
      expect(result.kind).toBe('not-yet-read')
      expect(calls).toEqual([])
    })

    it('quotes the URL in the reason, so a newline in it cannot start a log line', async () => {
      // `::error::` at the start of a line is a workflow command to GitHub Actions.
      const { fetchImpl } = always(() => new Response(tarball))
      const hostile = 'nowhere\n::error::injected'
      const result = await fetchIcon(npmWork(tarball, { tarball: hostile }), transportOf(fetchImpl))
      expect(reasonOf(result)).not.toMatch(/[\r\n]/)
      expect(reasonOf(result)).toContain(JSON.stringify(hostile))
    })

    it('accepts the registry host however its case was written', async () => {
      const { fetchImpl, calls } = always(() => new Response(tarball))
      const result = await fetchIcon(npmWork(tarball, { tarball: 'https://REGISTRY.NPMJS.ORG/x/-/x-1.0.0.tgz' }), transportOf(fetchImpl))
      expect(textOf(result)).toBe(SVG)
      expect(calls.map(call => call.url)).toEqual([NPM_URL])
    })
  })

  describe('a failure that says nothing about the package', () => {
    const tarball = tarballOf(files)

    it.each([403, 404, 429, 500, 503])('is not-yet-read when the registry answers %i', async status => {
      const { fetchImpl } = always(() => new Response('nope', { status }))
      const result = await fetchIcon(npmWork(tarball), transportOf(fetchImpl))
      expect(result.kind).toBe('not-yet-read')
      expect(reasonOf(result)).toContain(String(status))
    })

    it('is not-yet-read when the request throws, and carries the cause', async () => {
      const fetchImpl = (async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
      const result = await fetchIcon(npmWork(tarball), transportOf(fetchImpl))
      expect(result).toEqual({ kind: 'not-yet-read', reason: 'socket hang up' })
    })

    it('is not-yet-read when something that is no Error is thrown', async () => {
      const fetchImpl = (async () => { throw 'boom' }) as unknown as typeof fetch
      expect(await fetchIcon(npmWork(tarball), transportOf(fetchImpl))).toEqual({ kind: 'not-yet-read', reason: 'boom' })
    })

    it('is not-yet-read when the body stalls after the headers, within the tarball deadline', async () => {
      const started = Date.now()
      const result = await fetchIcon(npmWork(tarball), transportOf(headersThenStalledBody(), { tarballTimeoutMs: 60 }))
      expect(reasonOf(result)).toContain('exceeded 60ms')
      expect(Date.now() - started).toBeLessThan(5000)
    })

    it('is not-yet-read when no answer comes at all, within the tarball deadline', async () => {
      const stalled = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch
      const result = await fetchIcon(npmWork(tarball), transportOf(stalled, { tarballTimeoutMs: 60 }))
      expect(reasonOf(result)).toContain('exceeded 60ms')
    })

    it('is not-yet-read when the body fails part-way', async () => {
      const result = await fetchIcon(npmWork(tarball), transportOf(headersThenBodyError(new Error('terminated'))))
      expect(result).toEqual({ kind: 'not-yet-read', reason: 'terminated' })
    })
  })

  describe('a package past a cap', () => {
    // A package past a cap is no fault of its author's: it is "not read",
    // recorded with the sentence for the cap, and not asked for again.
    const tarball = tarballOf(files)
    const inflatedLength = gunzipSync(tarball).length

    it('is not-read, with exactly the sentence for the download cap, when the body is over it', async () => {
      const body = new Uint8Array(101)
      const { fetchImpl } = always(() => new Response(body))
      const result = await fetchIcon(npmWork(body), transportOf(fetchImpl, { caps: { tarballBytes: 100, inflatedBytes: MAX_INFLATED_BYTES } }))
      expect(result).toEqual({ kind: 'not-read', detail: iconDetail.packageTooLarge('x', '1.0.0') })
    })

    it('reads a body of exactly the cap, and not one byte less', async () => {
      const { fetchImpl } = always(() => new Response(tarball))
      const at = await fetchIcon(npmWork(tarball), transportOf(fetchImpl, { caps: { tarballBytes: tarball.length, inflatedBytes: MAX_INFLATED_BYTES } }))
      expect(textOf(at)).toBe(SVG)
      const under = await fetchIcon(npmWork(tarball), transportOf(fetchImpl, { caps: { tarballBytes: tarball.length - 1, inflatedBytes: MAX_INFLATED_BYTES } }))
      expect(under.kind).toBe('not-read')
    })

    it('is not-read, with exactly the sentence for the inflate cap, when it unpacks past it', async () => {
      const { fetchImpl } = always(() => new Response(tarball))
      const result = await fetchIcon(npmWork(tarball), transportOf(fetchImpl, { caps: { tarballBytes: MAX_TARBALL_BYTES, inflatedBytes: 10 } }))
      expect(result).toEqual({ kind: 'not-read', detail: iconDetail.packageUnpacksTooLarge('x', '1.0.0') })
    })

    it('unpacks an archive of exactly the inflate cap, and not one byte less', async () => {
      const { fetchImpl } = always(() => new Response(tarball))
      const at = await fetchIcon(npmWork(tarball), transportOf(fetchImpl, { caps: { tarballBytes: MAX_TARBALL_BYTES, inflatedBytes: inflatedLength } }))
      expect(textOf(at)).toBe(SVG)
      const under = await fetchIcon(npmWork(tarball), transportOf(fetchImpl, { caps: { tarballBytes: MAX_TARBALL_BYTES, inflatedBytes: inflatedLength - 1 } }))
      expect(under.kind).toBe('not-read')
    })
  })

  describe('an icon the tarball does not hold', () => {
    it('is refused, naming the package, when the member is missing', async () => {
      const tarball = tarballOf({ 'package.json': '{}' })
      const { fetchImpl } = always(() => new Response(tarball))
      const result = await fetchIcon(npmWork(tarball), transportOf(fetchImpl))
      expect(result).toEqual({ kind: 'refused', detail: iconDetail.notInPackage(LABEL, SHOWN, 'x', '1.0.0') })
    })

    it('names the declaration by the source it came from', async () => {
      const tarball = tarballOf({ 'package.json': '{}' })
      const { fetchImpl } = always(() => new Response(tarball))
      const result = await fetchIcon(npmWork(tarball, { source: 'export' }), transportOf(fetchImpl))
      expect(result).toEqual({ kind: 'refused', detail: iconDetail.notInPackage(iconLabel('export'), SHOWN, 'x', '1.0.0') })
      expect(result).not.toEqual({ kind: 'refused', detail: iconDetail.notInPackage(LABEL, SHOWN, 'x', '1.0.0') })
    })

    it('takes nothing for the icon but the member at the path under the root', async () => {
      // The same path one directory down, or beside a longer name, is not it.
      const tarball = tarballOf({ [`other/${PATH}`]: SVG, [`prefix-${PATH}`]: SVG })
      const { fetchImpl } = always(() => new Response(tarball))
      const result = await fetchIcon(npmWork(tarball), transportOf(fetchImpl))
      expect(result.kind).toBe('refused')
    })

    it('is refused when the archive holds nothing', async () => {
      const tarball = rawTarball({})
      const { fetchImpl } = always(() => new Response(tarball))
      const result = await fetchIcon(npmWork(tarball), transportOf(fetchImpl))
      expect(result).toEqual({ kind: 'refused', detail: iconDetail.notInPackage(LABEL, SHOWN, 'x', '1.0.0') })
    })

    it('quotes the path the way every other sentence does', async () => {
      const path = 'a"b\nc.svg'
      const tarball = tarballOf({ 'package.json': '{}' })
      const { fetchImpl } = always(() => new Response(tarball))
      const result = await fetchIcon(npmWork(tarball, { path }), transportOf(fetchImpl))
      expect(result).toEqual({ kind: 'refused', detail: iconDetail.notInPackage(LABEL, shownPath(path), 'x', '1.0.0') })
      expect(result.kind === 'refused' && result.detail).not.toMatch(/[\r\n]/)
    })
  })

  describe('a file at the top beside the one directory', () => {
    // The root is the tarball's one top-level DIRECTORY, as the harvest's own
    // reader finds it (`singleRoot`): npm and pnpm strip the first path
    // component when they extract, so a file with none left lands nowhere. A
    // hand-made tarball can carry one, and it must not hide an icon the install
    // carries.
    const members = { 'package/package.json': '{}', [`package/${PATH}`]: SVG, 'README.md': '# x' }

    it('does not hide the icon', async () => {
      const tarball = rawTarball(members)
      const { fetchImpl } = always(() => new Response(tarball))
      expect(textOf(await fetchIcon(npmWork(tarball), transportOf(fetchImpl)))).toBe(SVG)
    })

    it('does not hide it behind a ./ spelling either', async () => {
      const tarball = rawTarball({ './package/package.json': '{}', [`./package/${PATH}`]: SVG, './README.md': '# x' })
      const { fetchImpl } = always(() => new Response(tarball))
      expect(textOf(await fetchIcon(npmWork(tarball), transportOf(fetchImpl)))).toBe(SVG)
    })

    it('is not taken for the icon: a path the install would not carry is missing', async () => {
      const tarball = rawTarball({ 'package/package.json': '{}', 'icon.svg': SVG })
      const { fetchImpl } = always(() => new Response(tarball))
      const result = await fetchIcon(npmWork(tarball, { path: 'icon.svg' }), transportOf(fetchImpl))
      expect(result).toEqual({ kind: 'refused', detail: iconDetail.notInPackage(LABEL, shownPath('icon.svg'), 'x', '1.0.0') })
    })
  })

  describe('an archive without one top-level directory', () => {
    // Several top-level directories are not what `npm pack` writes, and which
    // of them an install keeps depends on the order of the members; no
    // directory at all leaves nothing to land. The bytes are the listed
    // version's, so that does not change: it is "not read", recorded with its
    // sentence, and not downloaded again every day.
    it.each([
      ['two directories', { 'package/package.json': '{}', [`pkg/${PATH}`]: SVG }],
      ['only a file at the top', { 'icon.svg': SVG }],
      ['a member whose first segment is empty', { './/package.json': '{}' }],
    ])('is not-read for %s', async (_label, members) => {
      const tarball = rawTarball(members)
      const { fetchImpl } = always(() => new Response(tarball))
      const result = await fetchIcon(npmWork(tarball), transportOf(fetchImpl))
      expect(result).toEqual({ kind: 'not-read', detail: iconDetail.packageUnreadable('x', '1.0.0') })
    })
  })

  describe('an archive this pipeline cannot read', () => {
    // A version's bytes never change, so these stay unreadable once they have
    // been shown to be the version's: "not read", with its sentence.
    it.each([
      ['bytes that are not gzip', Buffer.from('this is not a tarball')],
      ['a gzip stream cut short', tarballOf({ [PATH]: SVG }).subarray(0, 20)],
      ['a member that climbs out of the archive', rawTarball({ 'package/../escape.svg': SVG })],
    ])('is not-read for %s', async (_label, tarball) => {
      const { fetchImpl } = always(() => new Response(tarball))
      const result = await fetchIcon(npmWork(tarball), transportOf(fetchImpl))
      expect(result).toEqual({ kind: 'not-read', detail: iconDetail.packageUnreadable('x', '1.0.0') })
    })
  })

  describe('the size of the member', () => {
    const fetchOf = (tarball: Uint8Array) => transportOf(always(() => new Response(tarball)).fetchImpl)

    it('hands over a member of exactly the bound', async () => {
      const tarball = tarballOf({ [PATH]: 'x'.repeat(MAX_CATALOG_ICON_BYTES) })
      const result = await fetchIcon(npmWork(tarball), fetchOf(tarball))
      expect(result.kind === 'bytes' && result.bytes.length).toBe(MAX_CATALOG_ICON_BYTES)
    })

    it('refuses a member one byte over it with its size, the sentence the fold would have written', async () => {
      const tarball = tarballOf({ [PATH]: 'x'.repeat(MAX_CATALOG_ICON_BYTES + 1) })
      const result = await fetchIcon(npmWork(tarball), fetchOf(tarball))
      const folded = checkIconBytes(new Uint8Array(MAX_CATALOG_ICON_BYTES + 1), declaration())
      if (folded.ok) throw new Error('the fixture is one byte over the bound')
      expect(result).toEqual({ kind: 'refused', detail: folded.detail })
      expect(result).toEqual({ kind: 'refused', detail: iconDetail.tooLarge(LABEL, SHOWN, MAX_CATALOG_ICON_BYTES + 1) })
    })

    it('refuses a member of megabytes with its size, handing over none of it', async () => {
      // 8 MiB of one letter compresses to a few kilobytes: the archive is
      // cheap to publish and its member is not cheap to keep.
      const size = 8 * MIB
      const tarball = tarballOf({ [PATH]: 'x'.repeat(size) })
      const result = await fetchIcon(npmWork(tarball), fetchOf(tarball))
      expect(result).toEqual({ kind: 'refused', detail: iconDetail.tooLarge(LABEL, SHOWN, size) })
    })
  })
})

// ---------------------------------------------------------------------------
// GitHub, a file at a pinned commit
// ---------------------------------------------------------------------------

describe('fetchIcon: the file at a pinned commit', () => {
  const RAW = 'https://raw.githubusercontent.com'

  it('reads the file at the commit from the raw host, with the token', async () => {
    const { fetchImpl, calls } = always(() => new Response(SVG))
    const result = await fetchIcon(githubWork(), transportOf(fetchImpl))
    expect(textOf(result)).toBe(SVG)
    expect(calls.map(call => call.url)).toEqual([`${RAW}/owner/repo/${COMMIT}/${PATH}`])
    expect(authorization(calls[0])).toBe('Bearer gh-token')
  })

  it('sends no Authorization header when it has no token', async () => {
    const { fetchImpl, calls } = always(() => new Response(SVG))
    await fetchIcon(githubWork(), transportOf(fetchImpl, { token: '' }))
    expect(authorization(calls[0])).toBeUndefined()
  })

  it('reads a subpackage\'s icon from its directory, and speaks of the path as declared', async () => {
    const work = githubWork(PATH, { subdir: 'packages/a' })
    const found = always(() => new Response(SVG))
    expect(textOf(await fetchIcon(work, transportOf(found.fetchImpl)))).toBe(SVG)
    expect(found.calls.map(call => call.url)).toEqual([`${RAW}/owner/repo/${COMMIT}/packages/a/${PATH}`])
    const missing = always(() => new Response('404: Not Found', { status: 404 }))
    expect(await fetchIcon(work, transportOf(missing.fetchImpl)))
      .toEqual({ kind: 'refused', detail: iconDetail.notAtCommit(LABEL, SHOWN, 'owner/repo', COMMIT) })
  })

  describe('the URL is built from the path, and cannot leave the commit', () => {
    it('writes a literal %2e%2e, a tab between dots and a backslash as the characters they are', async () => {
      // Without encoding each segment, a URL parser reads %2e%2e as `..`,
      // drops the tab from `.<TAB>.` to make `..` too, and turns a backslash
      // into a slash: three ways for a file name to climb out of the commit.
      const cases: [string, string][] = [
        ['%2e%2e/icon.svg', '%252e%252e/icon.svg'],
        ['.\t./icon.svg', '.%09./icon.svg'],
        ['a\\..\\icon.svg', 'a%5C..%5Cicon.svg'],
      ]
      for (const [path, encoded] of cases) {
        const { fetchImpl, calls } = always(() => new Response(SVG))
        await fetchIcon(githubWork(path), transportOf(fetchImpl))
        expect(calls.map(call => call.url), JSON.stringify(path)).toEqual([`${RAW}/owner/repo/${COMMIT}/${encoded}`])
      }
    })

    it.each([
      ['a space', 'my icon.svg'],
      ['a hash', 'a#b.svg'],
      ['a question mark', 'a?b.svg'],
      ['a percent sign', '100%.svg'],
      ['a literal %2e%2e', '%2e%2e/icon.svg'],
      ['dots with a tab between them', '.\t./icon.svg'],
      ['a newline', 'a\nb.svg'],
      ['backslashes', 'a\\..\\icon.svg'],
      ['letters that are not ASCII', '图标/图标.svg'],
    ])('keeps the segments of a path with %s where a URL parser reads them', async (_label, path) => {
      const { fetchImpl, calls } = always(() => new Response(SVG))
      await fetchIcon(githubWork(path), transportOf(fetchImpl))
      const requested = new URL(calls[0]?.url ?? '')
      expect(requested.host).toBe('raw.githubusercontent.com')
      expect(requested.search).toBe('')
      expect(requested.hash).toBe('')
      // Read back from the parsed URL, which is what the host is asked for:
      // the repository, the commit, then exactly the path's own segments.
      expect(requested.pathname.split('/')).toEqual(['', 'owner', 'repo', COMMIT, ...path.split('/').map(encodeURIComponent)])
    })
  })

  describe('the pinned commit, which a carried record names', () => {
    it.each([
      ['a branch name', 'main'],
      ['a short sha', 'abc1234'],
      ['an upper-case sha', 'A'.repeat(40)],
      ['a sha of the wrong length', 'a'.repeat(41)],
      ['a path that climbs', '../x'],
      ['an empty string', ''],
    ])('is not-yet-read, and asks nothing, for %s', async (_label, commit) => {
      // A commit is immutable and a branch is not: a key that names one
      // artifact would name whatever the branch pointed at that day.
      const { fetchImpl, calls } = always(() => new Response(SVG))
      const result = await fetchIcon(githubWork(PATH, { commit }), transportOf(fetchImpl))
      expect(result.kind).toBe('not-yet-read')
      expect(calls).toEqual([])
    })
  })

  describe('what the host answers', () => {
    it('refuses, naming the commit, when the file is not there', async () => {
      const { fetchImpl } = always(() => new Response('404: Not Found', { status: 404 }))
      const result = await fetchIcon(githubWork(), transportOf(fetchImpl))
      expect(result).toEqual({ kind: 'refused', detail: iconDetail.notAtCommit(LABEL, SHOWN, 'owner/repo', COMMIT) })
    })

    it.each([401, 403, 429, 500, 503])('is not-yet-read when it answers %i, after one request', async status => {
      // Taken at its first answer: a fetch in flight when the time budget runs
      // out finishes in one attempt, not in a ladder of waits, and the key is
      // asked for again tomorrow.
      const { fetchImpl, calls } = always(() => new Response('later', { status }))
      const result = await fetchIcon(githubWork(), transportOf(fetchImpl))
      expect(result.kind).toBe('not-yet-read')
      expect(reasonOf(result)).toContain(String(status))
      expect(calls).toHaveLength(1)
    })

    it('is not-yet-read when the request throws', async () => {
      const fetchImpl = (async () => { throw new Error('connection reset') }) as unknown as typeof fetch
      const result = await fetchIcon(githubWork(), transportOf(fetchImpl))
      expect(result).toEqual({ kind: 'not-yet-read', reason: 'connection reset' })
    })

    it('is not-yet-read when the body stalls after the headers, within the request deadline', async () => {
      const result = await fetchIcon(githubWork(), transportOf(headersThenStalledBody(), { timeoutMs: 60 }))
      expect(reasonOf(result)).toContain('exceeded 60ms')
    })
  })

  describe('the size of the file', () => {
    it('hands over a file of exactly the bound', async () => {
      const { fetchImpl } = always(() => new Response('x'.repeat(MAX_CATALOG_ICON_BYTES)))
      const result = await fetchIcon(githubWork(), transportOf(fetchImpl))
      expect(result.kind === 'bytes' && result.bytes.length).toBe(MAX_CATALOG_ICON_BYTES)
    })

    it('hands over a file one byte over it whole, so the fold can tell its author the size', async () => {
      const { fetchImpl } = always(() => new Response('x'.repeat(MAX_CATALOG_ICON_BYTES + 1)))
      const result = await fetchIcon(githubWork(), transportOf(fetchImpl))
      if (result.kind !== 'bytes') throw new Error(JSON.stringify(result))
      expect(result.bytes.length).toBe(MAX_CATALOG_ICON_BYTES + 1)
      expect(checkIconBytes(result.bytes, declaration())).toEqual({ ok: false, detail: iconDetail.tooLarge(LABEL, SHOWN, MAX_CATALOG_ICON_BYTES + 1) })
    })

    it('refuses a file of 40 KiB as larger than the bound, without a size it never read', async () => {
      const { fetchImpl } = always(() => new Response('x'.repeat(40 * 1024)))
      const result = await fetchIcon(githubWork(), transportOf(fetchImpl))
      expect(result).toEqual({ kind: 'refused', detail: iconDetail.tooLarge(LABEL, SHOWN, null) })
      expect(result.kind === 'refused' && result.detail).toContain('is larger than 32 KiB')
    })

    it('gives up on a body that never ends, instead of buying it', async () => {
      const endless = streamOfZeros(Number.POSITIVE_INFINITY)
      const result = await fetchIcon(githubWork(), transportOf(always(endless.make).fetchImpl))
      expect(result).toEqual({ kind: 'refused', detail: iconDetail.tooLarge(LABEL, SHOWN, null) })
      expect(endless.stats.cancelled).toBe(true)
      expect(endless.stats.pulled).toBeLessThanOrEqual(2)
    })
  })
})

// ---------------------------------------------------------------------------
// GitHub, the release asset a rescued entry installs
// ---------------------------------------------------------------------------

describe('fetchIcon: the release asset', () => {
  const asset = tarballOf({ 'package.json': JSON.stringify({ name: 'x' }), [PATH]: SVG })

  it('reads the icon out of the recorded asset, asking for it without a token', async () => {
    const { fetchImpl, calls } = always(() => new Response(asset))
    const result = await fetchIcon(releaseWork(asset), transportOf(fetchImpl))
    expect(textOf(result)).toBe(SVG)
    expect(calls.map(call => call.url)).toEqual([RELEASE_URL])
    // The asset host is not GitHub's API: the job's token goes only where it is for.
    expect(authorization(calls[0])).toBeUndefined()
  })

  it.each([
    ['another repository\'s release', 'https://github.com/other/repo/releases/download/v1.0.0/plugin.tgz'],
    ['another host', 'https://evil.example/owner/repo/releases/download/v1.0.0/plugin.tgz'],
    ['a host that only starts with github.com', 'https://github.com.evil.example/owner/repo/releases/download/v1.0.0/plugin.tgz'],
    ['credentials that point the host elsewhere', 'https://github.com@evil.example/owner/repo/releases/download/v1.0.0/plugin.tgz'],
    ['plain http', 'http://github.com/owner/repo/releases/download/v1.0.0/plugin.tgz'],
    ['a port', 'https://github.com:8443/owner/repo/releases/download/v1.0.0/plugin.tgz'],
    ['a path that is not a release download', 'https://github.com/owner/repo/archive/main.tar.gz'],
    ['text that is no URL', 'not a url'],
  ])('is not-yet-read, and asks nothing, for %s', async (_label, url) => {
    const { fetchImpl, calls } = always(() => new Response(asset))
    const result = await fetchIcon(releaseWork(asset, { url }), transportOf(fetchImpl))
    expect(result.kind).toBe('not-yet-read')
    expect(calls).toEqual([])
  })

  it.each([
    ['no owner', 'repo'],
    ['an empty owner', '/repo'],
    ['a third part', 'owner/repo/extra'],
  ])('is not-yet-read, and asks nothing, for a repository with %s', async (_label, repo) => {
    const { fetchImpl, calls } = always(() => new Response(asset))
    const result = await fetchIcon(releaseWork(asset, { repo }), transportOf(fetchImpl))
    expect(result.kind).toBe('not-yet-read')
    expect(calls).toEqual([])
  })

  it('is not-yet-read when the asset is gone', async () => {
    const { fetchImpl } = always(() => new Response('Not Found', { status: 404 }))
    expect((await fetchIcon(releaseWork(asset), transportOf(fetchImpl))).kind).toBe('not-yet-read')
  })

  it.each([403, 429, 500, 503])('is not-yet-read when the host answers %i, after one request', async status => {
    const { fetchImpl, calls } = always(() => new Response('later', { status }))
    const result = await fetchIcon(releaseWork(asset), transportOf(fetchImpl))
    expect(result.kind).toBe('not-yet-read')
    expect(calls).toHaveLength(1)
  })

  it('is not-yet-read when the bytes are not the recorded asset\'s', async () => {
    const { fetchImpl } = always(() => new Response(asset))
    const result = await fetchIcon(releaseWork(asset, { sha256: sha256Hex(new Uint8Array(1)) }), transportOf(fetchImpl))
    expect(result.kind).toBe('not-yet-read')
    expect(reasonOf(result)).toContain('sha256')
  })

  it('is not-yet-read when the body stalls after the headers, within the asset deadline', async () => {
    const result = await fetchIcon(releaseWork(asset), transportOf(headersThenStalledBody(), { tarballTimeoutMs: 60 }))
    expect(reasonOf(result)).toContain('exceeded 60ms')
  })

  // The recorded sha256 was taken of an asset read under this same cap, so a
  // download past it cannot be that asset: it has changed, which is what a
  // sha256 that does not match says too. Nothing is recorded for it.
  it('is not-yet-read, like a changed asset, when the asset announces more than the cap', async () => {
    const { fetchImpl } = always(() => new Response(asset, { headers: { 'content-length': String(MAX_TARBALL_BYTES + 1) } }))
    const result = await fetchIcon(releaseWork(asset), transportOf(fetchImpl))
    expect(result.kind).toBe('not-yet-read')
    expect(reasonOf(result)).toContain(`${MAX_TARBALL_BYTES}-byte`)
  })

  it('is not-yet-read, with the same reason, when the body outgrows the cap while it is read', async () => {
    const body = streamOfZeros(MAX_TARBALL_BYTES + 8 * MIB)
    const result = await fetchIcon(releaseWork(asset), transportOf(always(body.make).fetchImpl))
    expect(result.kind).toBe('not-yet-read')
    expect(reasonOf(result)).toContain(`${MAX_TARBALL_BYTES}-byte`)
    expect(body.stats.cancelled).toBe(true)
  })

  it('refuses, saying the asset lacks the file, when the member is missing', async () => {
    const without = tarballOf({ 'package.json': '{}' })
    const { fetchImpl } = always(() => new Response(without))
    const result = await fetchIcon(releaseWork(without), transportOf(fetchImpl))
    expect(result).toEqual({ kind: 'refused', detail: iconDetail.notInRelease(LABEL, SHOWN) })
  })

  it('is not-yet-read where the asset unpacks past the inflate cap', async () => {
    // No sentence in the table is true of an asset that unpacks too far, and
    // the rescue that listed it was held to the same cap, so this is not a
    // state the harvest leaves behind: the reason is for the log.
    const { fetchImpl } = always(() => new Response(asset))
    const result = await fetchIcon(releaseWork(asset), transportOf(fetchImpl, { caps: { tarballBytes: MAX_TARBALL_BYTES, inflatedBytes: 10 } }))
    expect(result.kind).toBe('not-yet-read')
    expect(reasonOf(result)).toContain('inflates past')
  })

  it('is not-read, with its sentence, for an asset without one top-level directory', async () => {
    const forked = rawTarball({ 'package/package.json': '{}', [`pkg/${PATH}`]: SVG })
    const { fetchImpl } = always(() => new Response(forked))
    const result = await fetchIcon(releaseWork(forked), transportOf(fetchImpl))
    expect(result).toEqual({ kind: 'not-read', detail: iconDetail.releaseUnreadable() })
  })

  it('is not-read, with its sentence, for an asset that is not a gzipped tar', async () => {
    const junk = Buffer.from('this is not a tarball')
    const { fetchImpl } = always(() => new Response(junk))
    const result = await fetchIcon(releaseWork(junk), transportOf(fetchImpl))
    expect(result).toEqual({ kind: 'not-read', detail: iconDetail.releaseUnreadable() })
  })

  it('is not-yet-read, not unreadable, for bytes that are not the recorded asset', async () => {
    const junk = Buffer.from('this is not a tarball')
    const { fetchImpl } = always(() => new Response(junk))
    const result = await fetchIcon(releaseWork(junk, { sha256: sha256Hex(asset) }), transportOf(fetchImpl))
    expect(result.kind).toBe('not-yet-read')
  })

  it('reads an asset the rescue accepted with a file at the top, as the rescue does', async () => {
    // The harvest listed this entry from an asset `verifyReleaseAsset` accepts,
    // and declared its icon from the manifest `readPackedDeclarations` read:
    // the icon step reads the same layout the same way, or the icon of a
    // rescued entry would stay "not yet read" for good.
    const manifest = { name: 'plug', version: '1.0.0', icon: PATH, dsh: { bundle: { patch: './cordis.patch.yml' } } }
    const stray = rawTarball({
      'package/package.json': JSON.stringify(manifest),
      'package/cordis.patch.yml': '- insert: []\n',
      [`package/${PATH}`]: SVG,
      'README.md': '# stray top-level file',
    })
    expect(verifyReleaseAsset(stray, 'plug').ok).toBe(true)
    expect(readPackedDeclarations(stray, 'plug')).toMatchObject({ ok: true, declarations: { icon: PATH } })
    const { fetchImpl } = always(() => new Response(stray))
    expect(textOf(await fetchIcon(releaseWork(stray), transportOf(fetchImpl)))).toBe(SVG)
  })

  it('refuses a member past the bound with its size', async () => {
    const big = tarballOf({ [PATH]: 'x'.repeat(MAX_CATALOG_ICON_BYTES + 1) })
    const { fetchImpl } = always(() => new Response(big))
    const result = await fetchIcon(releaseWork(big), transportOf(fetchImpl))
    expect(result).toEqual({ kind: 'refused', detail: iconDetail.tooLarge(LABEL, SHOWN, MAX_CATALOG_ICON_BYTES + 1) })
  })
})

// ---------------------------------------------------------------------------
// The published icons file
// ---------------------------------------------------------------------------

describe('readPublishedIcons', () => {
  const BASE = 'https://pages.example/dsh-plugin-shop/v1/'
  const bytesA = new TextEncoder().encode(SVG)
  const bytesB = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
  const shaA = sha256Hex(bytesA)
  const shaB = sha256Hex(bytesB)
  const KEY_A = 'npm:a@1.0.0:icon.svg'
  const KEY_B = 'npm:b@1.0.0:icon.svg'
  const published: IconsFile = {
    icons: { [shaA]: iconDataUrl(bytesA, 'image/svg+xml'), [shaB]: iconDataUrl(bytesB, 'image/svg+xml') },
    sources: { [KEY_A]: shaA, [KEY_B]: shaB },
  }

  /** The index a build publishes for `file`, and the file name and text it points at. */
  function indexFor(file: IconsFile): { index: string; fileName: string; json: string } {
    const { fileName, json, sha256 } = serializeIcons(file)
    const index = JSON.stringify({
      schemaVersion: 5,
      builtAt: '2026-10-23T00:00:00.000Z',
      count: 2,
      rejected: 0,
      plugins: { url: 'plugins.x.json', sha256: '0'.repeat(64) },
      icons: { url: fileName, sha256 },
    })
    return { index, fileName, json }
  }

  /** A pages host serving `files` by path under the base, and answering 404 for anything else. */
  function pages(files: Record<string, string | (() => Response)>, base = BASE): { fetchImpl: typeof fetch; calls: Call[] } {
    return recording(url => {
      const served = url.startsWith(base) ? files[url.slice(base.length)] : undefined
      if (served === undefined) return new Response('Not Found', { status: 404 })
      return typeof served === 'function' ? served() : new Response(served)
    })
  }

  it('returns the file a valid index and file describe', async () => {
    const { index, fileName, json } = indexFor(published)
    const { fetchImpl, calls } = pages({ 'index.json': index, [fileName]: json })
    expect(await readPublishedIcons(fetchImpl, BASE)).toEqual(published)
    expect(calls.map(call => call.url)).toEqual([`${BASE}index.json`, `${BASE}${fileName}`])
  })

  it('reads the catalog\'s own Pages address when it is given no base', async () => {
    const { fetchImpl, calls } = recording(() => new Response('Not Found', { status: 404 }))
    expect(await readPublishedIcons(fetchImpl)).toBeNull()
    expect(calls.map(call => call.url)).toEqual(['https://livxue.github.io/dsh-plugin-shop/v1/index.json'])
  })

  it('sends no credentials to the host', async () => {
    const { index, fileName, json } = indexFor(published)
    const { fetchImpl, calls } = pages({ 'index.json': index, [fileName]: json })
    await readPublishedIcons(fetchImpl, BASE)
    expect(calls.map(authorization)).toEqual([undefined, undefined])
  })

  it('reads under a base written without its closing slash', async () => {
    const { index, fileName, json } = indexFor(published)
    const { fetchImpl, calls } = pages({ 'index.json': index, [fileName]: json })
    expect(await readPublishedIcons(fetchImpl, BASE.slice(0, -1))).toEqual(published)
    expect(calls[0]?.url).toBe(`${BASE}index.json`)
  })

  it('returns an empty file as a file, not as nothing', async () => {
    const empty: IconsFile = { icons: {}, sources: {} }
    const { index, fileName, json } = indexFor(empty)
    const { fetchImpl } = pages({ 'index.json': index, [fileName]: json })
    expect(await readPublishedIcons(fetchImpl, BASE)).toEqual(empty)
  })

  describe('answers null, and never throws', () => {
    it('for an index without icons, after one request', async () => {
      const index = JSON.stringify({ schemaVersion: 5, builtAt: 'x', count: 0, rejected: 0, plugins: { url: 'p.json', sha256: '0'.repeat(64) } })
      const { fetchImpl, calls } = pages({ 'index.json': index })
      expect(await readPublishedIcons(fetchImpl, BASE)).toBeNull()
      expect(calls).toHaveLength(1)
    })

    it.each([
      ['icons that is a string', '"icons.json"'],
      ['icons that is null', 'null'],
      ['icons that is an array', '[]'],
      ['icons without a url', '{"sha256":"%SHA%"}'],
      ['icons without a sha256', '{"url":"%URL%"}'],
      ['a url that is not a string', '{"url":7,"sha256":"%SHA%"}'],
      ['an empty url', '{"url":"","sha256":"%SHA%"}'],
      ['a sha256 that is not a string', '{"url":"%URL%","sha256":7}'],
      ['a sha256 in upper case', '{"url":"%URL%","sha256":"%UPPER%"}'],
      ['a sha256 of the wrong length', '{"url":"%URL%","sha256":"abc"}'],
    ])('for an index with %s', async (_label, pointer) => {
      const { fileName, json, sha256: sha } = { ...indexFor(published), sha256: serializeIcons(published).sha256 }
      const icons = pointer.replace('%URL%', fileName).replace('%SHA%', sha).replace('%UPPER%', sha.toUpperCase())
      const index = `{"icons":${icons}}`
      const { fetchImpl } = pages({ 'index.json': index, [fileName]: json })
      expect(await readPublishedIcons(fetchImpl, BASE)).toBeNull()
    })

    it.each([
      ['an index that is not JSON', '<!doctype html>'],
      ['an index that is an array', '[]'],
      ['an index that is null', 'null'],
      ['an empty index', ''],
    ])('for %s', async (_label, body) => {
      const { fetchImpl } = pages({ 'index.json': body })
      expect(await readPublishedIcons(fetchImpl, BASE)).toBeNull()
    })

    it.each([404, 429, 500])('for an index answered %i', async status => {
      const { fetchImpl } = recording(() => new Response('x', { status }))
      expect(await readPublishedIcons(fetchImpl, BASE)).toBeNull()
    })

    it('for a file answered 404', async () => {
      const { index } = indexFor(published)
      const { fetchImpl } = pages({ 'index.json': index })
      expect(await readPublishedIcons(fetchImpl, BASE)).toBeNull()
    })

    it('for a file whose sha256 is not the one the index names', async () => {
      const { index, fileName, json } = indexFor(published)
      const { json: other } = serializeIcons({ icons: {}, sources: {} })
      expect(other).not.toBe(json)
      const { fetchImpl } = pages({ 'index.json': index, [fileName]: other })
      expect(await readPublishedIcons(fetchImpl, BASE)).toBeNull()
    })

    it('for a file that passes its sha256 and is no icons file', async () => {
      // A sources entry naming an icon the file does not hold.
      const text = '{"icons":{},"sources":{"k":"missing"}}'
      const sha256 = sha256Hex(new TextEncoder().encode(text))
      const index = JSON.stringify({ icons: { url: 'icons.json', sha256 } })
      const { fetchImpl } = pages({ 'index.json': index, 'icons.json': text })
      expect(await readPublishedIcons(fetchImpl, BASE)).toBeNull()
    })

    it('when a request throws, at either step', async () => {
      const { index } = indexFor(published)
      const first = (async () => { throw new Error('offline') }) as unknown as typeof fetch
      expect(await readPublishedIcons(first, BASE)).toBeNull()
      const second = recording(url => {
        if (url.endsWith('index.json')) return new Response(index)
        throw new Error('offline')
      })
      expect(await readPublishedIcons(second.fetchImpl, BASE)).toBeNull()
      expect(second.calls).toHaveLength(2)
    })

    it('when the host never answers', async () => {
      vi.useFakeTimers()
      try {
        const stalled = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch
        const pending = readPublishedIcons(stalled, BASE)
        await vi.advanceTimersByTimeAsync(60 * 60_000)
        await expect(pending).resolves.toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('when the index outgrows 64 KiB, without buying the rest of it', async () => {
      const body = streamOfZeros(2 * MIB)
      const { fetchImpl } = pages({ 'index.json': body.make })
      expect(await readPublishedIcons(fetchImpl, BASE)).toBeNull()
      expect(body.stats.cancelled).toBe(true)
    })

    it('when the file outgrows 24 MiB, without buying the rest of it', async () => {
      const { index, fileName } = indexFor(published)
      const body = streamOfZeros(24 * MIB + 8 * MIB)
      const { fetchImpl } = pages({ 'index.json': index, [fileName]: body.make })
      expect(await readPublishedIcons(fetchImpl, BASE)).toBeNull()
      expect(body.stats.cancelled).toBe(true)
      expect(body.stats.pulled).toBeLessThanOrEqual(24 + 2)
    })
  })

  describe('keeps the pointer under the base', () => {
    // `index.json` is a file on the published host, and a pointer in it that
    // led elsewhere would have the build read, and trust the sha256 of, a file
    // from wherever the pointer said.
    it.each([
      ['an absolute URL to another host', 'https://evil.example/dsh-plugin-shop/v1/icons.json'],
      ['a protocol-relative URL to another host', '//evil.example/dsh-plugin-shop/v1/icons.json'],
      ['the same host over plain http', 'http://pages.example/dsh-plugin-shop/v1/icons.json'],
      ['the same host on another port', 'https://pages.example:8443/dsh-plugin-shop/v1/icons.json'],
      ['a path above the base', '../icons.json'],
      ['a sibling directory the base is a prefix of', '../v10/icons.json'],
      ['an encoded climb', '%2e%2e/icons.json'],
      ['a backslash climb', '..\\icons.json'],
      ['a root-relative path outside the base', '/other/icons.json'],
      ['the base\'s parent directory', '..'],
    ])('answers null for %s, and asks for nothing but the index', async (_label, url) => {
      const { json } = indexFor(published)
      const sha256 = sha256Hex(new TextEncoder().encode(json))
      const index = JSON.stringify({ icons: { url, sha256 } })
      const { fetchImpl, calls } = recording(() => new Response(index))
      expect(await readPublishedIcons(fetchImpl, BASE)).toBeNull()
      expect(calls.map(call => call.url)).toEqual([`${BASE}index.json`])
    })

    it('follows a pointer that is a path below the base', async () => {
      const { json, fileName } = indexFor(published)
      const sha256 = sha256Hex(new TextEncoder().encode(json))
      const index = JSON.stringify({ icons: { url: `sub/${fileName}`, sha256 } })
      const { fetchImpl, calls } = pages({ 'index.json': index, [`sub/${fileName}`]: json })
      expect(await readPublishedIcons(fetchImpl, BASE)).toEqual(published)
      expect(calls.map(call => call.url)).toEqual([`${BASE}index.json`, `${BASE}sub/${fileName}`])
    })

    it('follows an absolute pointer that is under the base', async () => {
      const { json, fileName } = indexFor(published)
      const sha256 = sha256Hex(new TextEncoder().encode(json))
      const index = JSON.stringify({ icons: { url: `${BASE}${fileName}`, sha256 } })
      const { fetchImpl } = pages({ 'index.json': index, [fileName]: json })
      expect(await readPublishedIcons(fetchImpl, BASE)).toEqual(published)
    })
  })

  describe('trusts an icon only if its bytes hash to the key it sits under', () => {
    // The whole-file sha256 proves the file is the one that was published, and
    // nothing about what is in it. Reuse copies an icon forward by its key, so
    // an icon filed under bytes it does not hold would be published for good.
    const forgedKey = sha256Hex(new TextEncoder().encode('bytes the key claims'))

    it('drops the forged icon and every source that names it, and keeps the rest', async () => {
      const file: IconsFile = {
        icons: { [shaA]: iconDataUrl(bytesA, 'image/svg+xml'), [forgedKey]: iconDataUrl(bytesB, 'image/svg+xml') },
        sources: { [KEY_A]: shaA, [KEY_B]: forgedKey, 'npm:c@1.0.0:icon.svg': forgedKey },
      }
      const { index, fileName, json } = indexFor(file)
      const { fetchImpl } = pages({ 'index.json': index, [fileName]: json })
      expect(await readPublishedIcons(fetchImpl, BASE)).toEqual({
        icons: { [shaA]: iconDataUrl(bytesA, 'image/svg+xml') },
        sources: { [KEY_A]: shaA },
      })
    })

    it('drops a data URL that is not the canonical encoding of the bytes it decodes to', async () => {
      // Node reads `YQ=`, `YQ` and `YR==` all as "a", where the decode behind a
      // browser's data: URL refuses the first. Reuse would carry any of them
      // forward for good, so an icon is trusted only in the form this build
      // writes.
      const a = new TextEncoder().encode('a')
      expect(iconDataUrl(a, 'image/svg+xml')).toBe('data:image/svg+xml;base64,YQ==')
      for (const payload of ['YQ=', 'YR==', 'YQ']) {
        const file: IconsFile = {
          icons: { [sha256Hex(a)]: `data:image/svg+xml;base64,${payload}` },
          sources: { [KEY_A]: sha256Hex(a) },
        }
        const { index, fileName, json } = indexFor(file)
        const { fetchImpl } = pages({ 'index.json': index, [fileName]: json })
        expect(await readPublishedIcons(fetchImpl, BASE), payload).toEqual({ icons: {}, sources: {} })
      }
    })

    it('keeps an icon with a media type other than SVG when its bytes are right', async () => {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
      const file: IconsFile = {
        icons: { [sha256Hex(png)]: iconDataUrl(png, 'image/png') },
        sources: { 'npm:p@1.0.0:icon.png': sha256Hex(png) },
      }
      const { index, fileName, json } = indexFor(file)
      const { fetchImpl } = pages({ 'index.json': index, [fileName]: json })
      expect(await readPublishedIcons(fetchImpl, BASE)).toEqual(file)
    })
  })
})

// ---------------------------------------------------------------------------
// Running a plan
// ---------------------------------------------------------------------------

describe('harvestIcons', () => {
  /** `count` works on the raw host, `/icon-<n>.svg`, in the order of their keys. */
  function worksOf(count: number): IconWork[] {
    return Array.from({ length: count }, (_, i) => githubWork(`icon-${String(i).padStart(3, '0')}.svg`))
  }

  const planOf = (works: IconWork[]): IconPlan => ({ reuse: [], fetch: works, deferred: [] })

  it('starts nothing, and answers an empty map, when the deadline is zero', async () => {
    const { fetchImpl, calls } = always(() => new Response(SVG))
    const results = await harvestIcons(planOf(worksOf(3)), transportOf(fetchImpl), { concurrency: 4, deadlineMs: 0 })
    expect(results.size).toBe(0)
    expect(calls).toEqual([])
  })

  it('answers each key it ran under that key', async () => {
    const works = worksOf(3)
    const { fetchImpl } = always(() => new Response(SVG))
    const results = await harvestIcons(planOf(works), transportOf(fetchImpl), { concurrency: 2, deadlineMs: 60_000 })
    expect([...results.keys()]).toEqual(expect.arrayContaining(works.map(work => work.key)))
    expect(results.size).toBe(3)
    for (const work of works) expect(textOf(results.get(work.key) ?? { kind: 'not-yet-read', reason: 'missing' })).toBe(SVG)
  })

  it('answers an empty map for a plan with nothing to fetch', async () => {
    const { fetchImpl, calls } = always(() => new Response(SVG))
    const results = await harvestIcons({ reuse: [], fetch: [], deferred: [] }, transportOf(fetchImpl), { concurrency: 4, deadlineMs: 60_000 })
    expect(results.size).toBe(0)
    expect(calls).toEqual([])
  })

  it('runs no more than `concurrency` fetches at once, and runs that many', async () => {
    let inFlight = 0
    let peak = 0
    const fetchImpl = (async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 10))
      inFlight -= 1
      return new Response(SVG)
    }) as unknown as typeof fetch
    const results = await harvestIcons(planOf(worksOf(7)), transportOf(fetchImpl), { concurrency: 3, deadlineMs: 60_000 })
    expect(results.size).toBe(7)
    expect(peak).toBe(3)
  })

  it('starts the keys in the order the plan lists them', async () => {
    const works = worksOf(4)
    const { fetchImpl, calls } = always(() => new Response(SVG))
    await harvestIcons(planOf(works), transportOf(fetchImpl), { concurrency: 1, deadlineMs: 60_000 })
    expect(calls.map(call => call.url.split('/').pop())).toEqual(['icon-000.svg', 'icon-001.svg', 'icon-002.svg', 'icon-003.svg'])
  })

  it('starts no fetch once the deadline has passed, and leaves the keys it did not start without a result', async () => {
    // Time is whatever the fetches have made of it: each takes 100 ms.
    let elapsed = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    try {
      const works = worksOf(6)
      const { fetchImpl } = recording(() => {
        elapsed += 100
        return new Response(SVG)
      })
      const results = await harvestIcons(planOf(works), transportOf(fetchImpl), { concurrency: 1, deadlineMs: 250 })
      // Started at 0, 100 and 200 ms, all inside the deadline; at 300 ms it has passed.
      expect([...results.keys()]).toEqual(works.slice(0, 3).map(work => work.key))
    } finally {
      clock.mockRestore()
    }
  })

  it('measures the deadline from the call, not from when the process started', async () => {
    let elapsed = 1_000_000
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    try {
      const { fetchImpl } = recording(() => {
        elapsed += 100
        return new Response(SVG)
      })
      const results = await harvestIcons(planOf(worksOf(6)), transportOf(fetchImpl), { concurrency: 1, deadlineMs: 250 })
      expect(results.size).toBe(3)
    } finally {
      clock.mockRestore()
    }
  })

  it('lets one key\'s failure stand for that key alone', async () => {
    const works = worksOf(3)
    const { fetchImpl } = recording(url => {
      if (url.endsWith('icon-001.svg')) throw new Error('reset by peer')
      if (url.endsWith('icon-002.svg')) return new Response('gone', { status: 404 })
      return new Response(SVG)
    })
    const results = await harvestIcons(planOf(works), transportOf(fetchImpl), { concurrency: 2, deadlineMs: 60_000 })
    expect(results.get(works[0]?.key ?? '')?.kind).toBe('bytes')
    expect(results.get(works[1]?.key ?? '')).toEqual({ kind: 'not-yet-read', reason: 'reset by peer' })
    expect(results.get(works[2]?.key ?? '')?.kind).toBe('refused')
  })
})
