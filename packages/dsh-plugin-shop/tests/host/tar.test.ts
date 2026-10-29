import { describe, expect, it } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readTar } from '../../src/shared/tar.ts'

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

  // A name too long or too wide for a ustar header travels in a pax (`x`) or
  // GNU (`L`) header before the entry. Skipping that header, as this reader
  // did, left the file under a truncated name — reported missing from an
  // archive that ships it.
  const block = (name: string, size: number, typeflag: string): Buffer => {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write(typeflag, 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    return header
  }
  const padded = (data: Buffer): Buffer => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])
  /** A pax record whose leading length counts the whole record, its own digits included. */
  const paxRecord = (key: string, value: string): Buffer => {
    let length = Buffer.byteLength(`${key}=${value}\n`) + 3
    for (;;) {
      const record = Buffer.from(`${length} ${key}=${value}\n`, 'utf8')
      if (record.length === length) return record
      length = record.length
    }
  }

  it('reads the name a pax header gives the entry after it', () => {
    const long = `package/${'图'.repeat(40)}.svg`
    // The reader spells a name one character for each UTF-8 byte.
    const spelled = Buffer.from(long, 'utf8').toString('latin1')
    const record = paxRecord('path', long)
    const archive = Buffer.concat([block('PaxHeader', record.length, 'x'), padded(record), block('truncated.svg', 4, '0'), Buffer.from('body'), Buffer.alloc(1024)])
    const files = readTar(archive)
    expect([...files.keys()]).toEqual([spelled])
    expect(files.get(spelled)?.toString('utf8')).toBe('body')
  })

  it('reads the name a GNU long-name header gives it', () => {
    const long = `package/${'a'.repeat(120)}.svg`
    const data = Buffer.from(`${long}\0`, 'latin1')
    const archive = Buffer.concat([block('././@LongLink', data.length, 'L'), padded(data), block('truncated.svg', 4, '0'), Buffer.from('body'), Buffer.alloc(1024)])
    expect([...readTar(archive).keys()]).toEqual([long])
  })

  it('holds a pax name to the same containment rule as a ustar one', () => {
    const record = paxRecord('path', 'package/../evil')
    const archive = Buffer.concat([block('PaxHeader', record.length, 'x'), padded(record), block('truncated.svg', 0, '0'), Buffer.alloc(1024)])
    expect(() => readTar(archive)).toThrow(/escapes the archive root/)
  })
})
