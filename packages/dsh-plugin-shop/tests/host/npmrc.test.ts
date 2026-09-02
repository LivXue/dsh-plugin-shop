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

  it('keeps an http registry, which a local mirror legitimately uses', () => {
    expect(from('registry=http://127.0.0.1:4873/')).toBe('http://127.0.0.1:4873/')
  })

  it('rejects a value that is not an absolute url, as if the line were absent', () => {
    // Every one of these makes `new URL('<pkg>/latest', value)` throw a raw
    // TypeError inside npmOrigin's probe. That is NOT a TransportError, and
    // catalog.ts's race loop rethrows anything that is not one — so an
    // unvalidated registry line fails the WHOLE load with npmmirror, npmjs
    // and Pages all healthy and no cache fallback. Returning null instead is
    // what keeps the design's own stated property true: a registry we guess
    // wrong about "loses a 400-byte request and nothing else" (design §3).
    expect(from('registry=foo/')).toBeNull()
    expect(from('registry=localhost:4873/')).toBeNull()
    expect(from('registry=registry.npmmirror.com/')).toBeNull()
    expect(from('registry=~/local-registry/')).toBeNull()
  })

  it("rejects npm's own unexpanded env-var syntax rather than reading it as a host", () => {
    // The realistic trigger. `registry=${NPM_REGISTRY}/` is npm's documented
    // config expansion: it works perfectly for npm, and a reader that does
    // not expand it captures the literal — which is not a URL.
    expect(from('registry=${NPM_REGISTRY}/')).toBeNull()
    expect(from('registry=${NPM_REGISTRY}')).toBeNull()
  })

  it('rejects a scheme the raced origins cannot fetch from', () => {
    // `new URL` accepts both of these, so the scheme check is a gate the
    // absolute-url parse does not already cover.
    expect(from('registry=file:///tmp/local-registry/')).toBeNull()
    expect(from('registry=ftp://reg.test/')).toBeNull()
  })

  it('does not let an unusable line mask a usable one below it', () => {
    // An unusable value is skipped, not returned: the line is treated as if
    // it were not a registry line at all.
    expect(from('registry=${NPM_REGISTRY}/\nregistry=https://plain.test/')).toBe('https://plain.test/')
  })
})
