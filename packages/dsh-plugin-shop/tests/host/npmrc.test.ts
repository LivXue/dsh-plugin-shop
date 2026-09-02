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
