import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The additive-key guard.
//
// zod strips what it does not declare, in silence and with no error anywhere.
// So the registry can publish a key, the build report can count it green, and
// every installed shop can drop it on the floor — which is exactly what
// happened to `installSize`: written for all 10,767 entries from 0.8.1,
// declared by no client until 0.8.3, and for two releases every one of the
// 6,492 github cards showed no size. Nothing failed, because the producer-side
// signal (`emit.ts`'s "No install size: 0 of N") counts what the build WROTE,
// never what a client can SEE.
//
// Fixing that one key turned up a second with the same defect, `review.repo`:
// written by `config.ts` onto every stored Review, carried through `tier.ts`
// and `emit.ts` verbatim, and declared by no consumer. It was invisible only
// because `registry/verified.yml` is empty — the state in which nobody looks.
//
// A convention ("remember to declare it on both sides") would not have caught
// either: both were written by people who knew the rule. So this reads the two
// declarations and requires every key the registry PUBLISHES to be declared by
// the consumer that parses it. It lives here, on the producer side, so that the
// PR which ADDS a key is the PR that goes red.
//
// Parsing source text rather than importing: the registry half is a TypeScript
// interface, which has no runtime representation to compare against, and the
// consumer half lives in a package whose host modules pull node built-ins this
// suite does not otherwise load. `github-client.test.ts`'s body-cap guard sets
// the precedent for a structural test that reads a module's own source.
// ---------------------------------------------------------------------------

const REGISTRY_TYPES = fileURLToPath(new URL('../src/types.ts', import.meta.url))
const CONSUMER_SCHEMA = fileURLToPath(
  new URL('../../../packages/dsh-plugin-shop/src/host/catalog.ts', import.meta.url),
)

/**
 * Keys the registry publishes that the consumer deliberately does not declare.
 *
 * EMPTY, and that is the point: it was empty the day this guard was written,
 * which is what makes the guard a gate rather than a backlog. An entry here
 * must say, in words, why a published key is one no client should read — not
 * "not needed yet", which is how both silent strips above were reasoned.
 */
const NOT_CONSUMED: Record<string, string> = {}

/** The brace-matched body of `declaration`, comments stripped. */
function bodyAfter(source: string, declaration: RegExp, what: string): string {
  const opener = declaration.exec(source)
  if (opener === null) throw new Error(`${what}: declaration not found — this guard's parse is stale, not the code`)
  let depth = 1
  let i = opener.index + opener[0].length
  while (depth > 0) {
    const ch = source[i]
    if (ch === undefined) throw new Error(`${what}: unbalanced braces`)
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    i += 1
  }
  return source.slice(opener.index + opener[0].length, i - 1)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '')
}

/** Top-level property names in `body`, ignoring anything nested inside it. */
function topLevelKeys(body: string): string[] {
  const keys: string[] = []
  let depth = 0
  for (const line of body.split('\n')) {
    if (depth === 0) {
      const named = /^\s*(\w+)\??\s*:/.exec(line)
      if (named?.[1] !== undefined) keys.push(named[1])
    }
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') depth += 1
      else if (ch === '}' || ch === ')' || ch === ']') depth -= 1
    }
  }
  return keys
}

describe('every key the registry publishes is declared by the consumer that parses it', () => {
  const registry = readFileSync(REGISTRY_TYPES, 'utf8')
  const consumer = readFileSync(CONSUMER_SCHEMA, 'utf8')

  const registryEntry = topLevelKeys(bodyAfter(registry, /export interface Entry\s*\{/, 'registry Entry'))
  const registryReview = topLevelKeys(bodyAfter(registry, /export interface Review\s*\{/, 'registry Review'))
  const consumerEntry = topLevelKeys(bodyAfter(consumer, /const entrySchema = z\.object\(\{/, 'consumer entrySchema'))
  const consumerReview = topLevelKeys(bodyAfter(consumer, /\breview: z\.object\(\{/, 'consumer review'))

  // A guard whose own parse silently returned nothing would pass forever while
  // covering nothing, which is the failure mode it exists to prevent. These
  // floors are deliberately far below the real counts: they catch a parse that
  // broke, not a shape that changed.
  it('parsed all four declarations, so a green run means something', () => {
    expect(registryEntry.length, 'registry Entry').toBeGreaterThan(10)
    expect(registryReview.length, 'registry Review').toBeGreaterThan(4)
    expect(consumerEntry.length, 'consumer entrySchema').toBeGreaterThan(10)
    expect(consumerReview.length, 'consumer review').toBeGreaterThan(4)
    // The key this guard was written for, on both sides: proof the two parses
    // reached the same shape rather than two unrelated object literals.
    expect(registryEntry).toContain('installSize')
    expect(consumerEntry).toContain('installSize')
  })

  it('declares every published Entry key', () => {
    const missing = registryEntry.filter(key => !consumerEntry.includes(key) && NOT_CONSUMED[key] === undefined)
    expect(missing, `entrySchema in ${CONSUMER_SCHEMA} declares no ${missing.join(', ')} — zod strips what it does not declare, so the registry would publish it and every shop would drop it in silence`).toEqual([])
  })

  it('declares every published Review key', () => {
    const missing = registryReview.filter(key => !consumerReview.includes(key) && NOT_CONSUMED[key] === undefined)
    expect(missing, `the review sub-object declares no ${missing.join(', ')} — a review's own fields are stripped the same way, and verified.yml being empty is why nobody would notice`).toEqual([])
  })

  it('carries no stale exemption', () => {
    const published = new Set([...registryEntry, ...registryReview])
    const stale = Object.keys(NOT_CONSUMED).filter(key => !published.has(key))
    expect(stale, `${stale.join(', ')} is exempted but no longer published — an exemption outliving its key covers whatever next takes that name`).toEqual([])
  })
})
