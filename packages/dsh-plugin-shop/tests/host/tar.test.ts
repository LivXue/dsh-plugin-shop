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
