import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { readTar } from '../../src/shared/tar.ts'

/** One regular-file entry of a ustar archive, its name field holding exactly the bytes given. */
function entry(name: Buffer, body: string, prefix = ''): Buffer {
  const header = Buffer.alloc(512)
  name.copy(header, 0)
  header.write('0000644\0', 100, 'ascii')
  header.write(`${Buffer.byteLength(body).toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  Buffer.from(prefix, 'utf8').copy(header, 345)
  const content = Buffer.from(body, 'utf8')
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)])
}

const archive = (...entries: Buffer[]): Buffer => Buffer.concat([...entries, Buffer.alloc(1024)])

/** The name as the reader spells it: one character for each byte, which is what a UTF-8 name comes back as. */
const spelledByBytes = (name: string): string => Buffer.from(name, 'utf8').toString('latin1')

describe('readTar: how a name is spelled', () => {
  // The reader hands back names as strings, and a tar name is bytes. Decoding
  // them as ASCII dropped the high bit of every byte, so `é` (C3 A9) came back
  // as `C)` and two different files could be one key; one character for each
  // byte keeps every bit, and is the same string for a name that is ASCII.
  it('reads an ASCII name as it is written', () => {
    const files = readTar(archive(entry(Buffer.from('package/v1/index.json'), '{}')))
    expect([...files.keys()]).toEqual(['package/v1/index.json'])
  })

  it('spells a name written in UTF-8 by its bytes, one character each', () => {
    const name = 'package/assets/图标.svg'
    const files = readTar(archive(entry(Buffer.from(name, 'utf8'), 'x')))
    expect([...files.keys()]).toEqual([spelledByBytes(name)])
    expect(files.has(name)).toBe(false)
  })

  it('keeps two names apart that differ only in the high bit of a byte', () => {
    const files = readTar(archive(
      entry(Buffer.from('package/é.svg', 'utf8'), 'accent'),
      entry(Buffer.from('package/C).svg', 'utf8'), 'paren'),
    ))
    expect(files.size).toBe(2)
    expect(files.get(spelledByBytes('package/é.svg'))?.toString()).toBe('accent')
    expect(files.get('package/C).svg')?.toString()).toBe('paren')
  })

  it('joins a prefix to a name, a prefix in UTF-8 included', () => {
    const files = readTar(archive(entry(Buffer.from('file.svg'), 'x', 'package/图标')))
    expect([...files.keys()]).toEqual([spelledByBytes('package/图标/file.svg')])
  })

  it('ends a name at its first NUL, as the padding of the field requires', () => {
    const name = Buffer.concat([Buffer.from('package/a.svg'), Buffer.from([0]), Buffer.from('ignored')])
    expect([...readTar(archive(entry(name, 'x'))).keys()]).toEqual(['package/a.svg'])
  })

  it('reads a tarball `npm pack` wrote for a package whose icon is `assets/图标.svg`', () => {
    // `npm pack` 11.18.0. node-tar writes the name in UTF-8 in the ustar header
    // and again in a pax header, which the reader skips.
    const tarball = Buffer.from(
      'H4sIAAAAAAAC/+2VO07EMBCGU+cUlmuwx84DZUWoKekRhRVMNrB5KDabCETNIWg4CbeBczCGFeLZLdHuyl8zo/93YWv0ezpVXKlS8+69skvTNsGaAYA0jslvukNE6EVJCkKkKWCPTeLOQzAB18aqHq+yhkci5KNuCbeENqrWdEZo0exXRdvQPUKXujcVtqgKBgyc9uahoIzR1vDnh6eXx3tmlqUzL6qFNuiermx6Ru7CwLPxnKjxWKtz3X8a6NT5d3H5mn+ZxKiNPv//Dv69nbLzfPX/8x/pDkVGalvVOo+zTKQyAQiFIKa6QUX6jG85f859uvxDIr/nP4oPpN//U3CIoyZjvWhMTufWdjPOh2FgQ8TavuQSn8LdiudHPukej8ezU7wCF1ptMgAQAAA=',
      'base64',
    )
    const files = readTar(gunzipSync(tarball))
    expect([...files.keys()].sort()).toEqual(['package/assets/' + spelledByBytes('图标.svg'), 'package/package.json'].sort())
    expect(files.get(`package/assets/${spelledByBytes('图标.svg')}`)?.toString()).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>\n')
  })
})
