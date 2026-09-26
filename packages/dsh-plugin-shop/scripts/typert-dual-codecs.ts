/**
 * Dual-harness typert codecs: one build that loads on harness 0.1.5 and on
 * 0.1.7 (design 2026-09-26-dsh-017-readiness, B0).
 *
 * The two harness generations read a strict codec through different keys.
 * 0.1.5-rc.3's typert-loader demands `codec.schema`, a zod v4 schema, and
 * ignores everything else; 0.1.7-rc.2's demands a `create()` factory (the
 * registry calls it lazily and caches what it returns) and ignores `schema`.
 * Neither rejects the other's key, so a codec carrying both loads on both.
 *
 * The generator this package builds with (0.1.1-rc.2) prints `schema` only,
 * and a manifest 0.1.7 refuses does not fail alone: the loader's activation
 * throws, which withdraws every typert definition in the process, and the web
 * boot shows "Failed to load plugins" — the shop took the whole UI with it.
 *
 * So after the generator writes its faces, this step puts
 * `create: () => <the same schema>` beside every codec's `schema:` line and
 * inside every named schema entry. The client bundle inlines the rewritten
 * remote face, so the one step covers both halves. It reads the generator's
 * printed shape (`strictCodec()` in its emitter.js) line by line and refuses
 * to guess: a strict codec whose schema line it cannot find, or output that
 * already carries factories, stops the build instead of shipping a manifest
 * one harness rejects.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

/** Line 2 of every rewritten face: says what was added after generation, and
 * lets a second pass over the same file recognize its own output. */
export const DUAL_CODEC_MARKER = '/* dsh-plugin-shop: create() added beside every schema for harness 0.1.7 (scripts/typert-dual-codecs.ts). */'

/** The generated faces that carry strict codecs, relative to the output dir. */
export const CODEC_FACES = ['typert.host.js', 'typert.remote-client.js'] as const

// Line-anchored throughout: the model block the generator prints is JSON with
// quoted keys, and zod object keys are quoted too, so an unquoted key at the
// start of a line belongs to a codec literal and nothing else. `[ \t]`, never
// `\s`, so a match cannot start on a blank line and swallow the newline.
const STRICT_CODEC = /^[ \t]*mode: 'strict',$/gm
const CODEC_SCHEMA = /^([ \t]*)schema: ([A-Za-z_$][\w$]*),$/gm
const NAMED_SCHEMA = /^([ \t]*)\{ name: ('(?:[^'\\\n]|\\.)*'), schema: ([A-Za-z_$][\w$]*) \},$/gm
const ANY_NAMED_SCHEMA = /^[ \t]*\{ name: .*\bschema: .*\},$/gm
const FACTORY = /^[ \t]*create: |^[ \t]*\{ name: .*, create: /m

/**
 * Give every strict codec and named schema in one generated face a
 * `create()` factory returning its existing schema. Pure: text in, text out;
 * `file` only names the face in an error.
 */
export function withCreateFactories(source: string, file: string): string {
  if (source.includes(DUAL_CODEC_MARKER)) return source
  if (FACTORY.test(source)) {
    throw new Error(
      `${file}: the generator already emits create() factories. This step was written for one that prints \`schema\` only; `
      + 'check that 0.1.5 still gets its zod `schema` before removing it (scripts/typert-dual-codecs.ts).',
    )
  }

  const strict = source.match(STRICT_CODEC)?.length ?? 0
  let codecs = 0
  let out = source.replace(CODEC_SCHEMA, (_line, indent: string, schema: string) => {
    codecs += 1
    return `${indent}schema: ${schema},\n${indent}create: () => ${schema},`
  })
  if (codecs !== strict) {
    throw new Error(
      `${file}: ${String(strict)} strict codecs but ${String(codecs)} schema lines — the generator's output format changed, `
      + 'and a codec without create() would make harness 0.1.7 refuse the whole manifest.',
    )
  }

  const named = source.match(ANY_NAMED_SCHEMA)?.length ?? 0
  let rewritten = 0
  out = out.replace(NAMED_SCHEMA, (_line, indent: string, name: string, schema: string) => {
    rewritten += 1
    return `${indent}{ name: ${name}, schema: ${schema}, create: () => ${schema} },`
  })
  if (rewritten !== named) {
    throw new Error(
      `${file}: ${String(named)} named schemas but ${String(rewritten)} rewritten — the generator's output format changed.`,
    )
  }

  const newline = out.indexOf('\n')
  return newline === -1
    ? `${out}\n${DUAL_CODEC_MARKER}\n`
    : `${out.slice(0, newline + 1)}${DUAL_CODEC_MARKER}\n${out.slice(newline + 1)}`
}

type TypertPlugin = ReturnType<typeof typertPlugin>

/**
 * The generator's tsdown plugin, followed by the rewrite of what it wrote.
 * Wrapped rather than added as a second plugin because rolldown runs
 * `writeBundle` hooks in parallel: the rewrite has to read the generator's
 * output, not race it, and inside one hook the order holds by construction.
 */
export function dualHarnessTypert(inner: TypertPlugin): TypertPlugin {
  return {
    ...inner,
    writeBundle(options) {
      inner.writeBundle(options)
      if (options.dir === undefined) return
      for (const face of CODEC_FACES) {
        const path = join(options.dir, face)
        let source: string
        try {
          source = readFileSync(path, 'utf8')
        } catch (error) {
          // The generator writes no remote face for a package without one and
          // removes a stale one; a face that does not exist has no codecs.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        writeFileSync(path, withCreateFactories(source, path))
      }
    },
  }
}
