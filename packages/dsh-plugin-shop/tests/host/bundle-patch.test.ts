import { describe, expect, it } from 'vitest'
import { bundlePatchFiles, patchDeclarationHazard } from '../../src/host/bundle-patch.ts'

describe('bundlePatchFiles', () => {
  it('reads one file for a string and the listed files, in order, for a list', () => {
    expect(bundlePatchFiles('./cordis.patch.yml')).toEqual(['./cordis.patch.yml'])
    expect(bundlePatchFiles(['./host.yml', './web.yml'])).toEqual(['./host.yml', './web.yml'])
    expect(bundlePatchFiles([])).toEqual([])
  })

  it('answers null for a declaration dsh refuses, never an empty list a caller could fall back from', () => {
    for (const declared of [undefined, null, 7, { path: './x.yml' }, ['./x.yml', 3], [null]]) {
      expect(bundlePatchFiles(declared), JSON.stringify(declared)).toBeNull()
    }
  })

  it('hands back a copy, so a caller cannot edit the manifest it was read from', () => {
    const declared = ['./a.yml']
    const files = bundlePatchFiles(declared)
    files?.push('./b.yml')
    expect(declared).toEqual(['./a.yml'])
  })
})

describe('patchDeclarationHazard', () => {
  it('finds nothing wrong with a single file, or with no declaration at all', () => {
    // No declaration means the package is not a bundle, and dsh does not add
    // it to the profile's bundle list, so nothing reads the field at boot.
    for (const patchLists of [true, false, null]) {
      expect(patchDeclarationHazard('./cordis.patch.yml', patchLists)).toBeNull()
      expect(patchDeclarationHazard(undefined, patchLists)).toBeNull()
    }
  })

  it('names a list only on a dsh known to read one file', () => {
    // 0.1.5 joins the declaration onto a path; 0.1.7 applies the list. An
    // unidentified harness forms no verdict, like every other harness read.
    expect(patchDeclarationHazard(['./a.yml', './b.yml'], false)).toBe('list-unsupported')
    expect(patchDeclarationHazard(['./a.yml', './b.yml'], true)).toBeNull()
    expect(patchDeclarationHazard(['./a.yml', './b.yml'], null)).toBeNull()
  })

  it('names a declaration dsh refuses on every harness, whatever is known about this one', () => {
    for (const patchLists of [true, false, null]) {
      expect(patchDeclarationHazard(7, patchLists)).toBe('malformed')
      expect(patchDeclarationHazard(['./a.yml', 3], patchLists)).toBe('malformed')
    }
  })
})
