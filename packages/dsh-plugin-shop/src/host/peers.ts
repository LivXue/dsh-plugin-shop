/** Harness compatibility: which declared peers the running installation does
 * not provide (design 2026-09-01-harness-compatibility), and — for the
 * shop's OWN declared peers — which ones it provides at a version outside
 * the declared range. */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { satisfies, valid, validRange } from 'semver'
import { identityKey, type EntryIdentity } from '../shared/identity.ts'

/** Answers "can this installation provide `spec`?" — injected so fixtures
 * drive every verdict and exactly one call site touches the filesystem. */
export type PeerResolver = (spec: string) => boolean

/**
 * The production resolver: the same question the harness's own
 * ClientModuleRegistry asks, through a require anchored at the profile. Asking
 * what the loader asks is what keeps this verdict and the runtime's behaviour
 * from drifting apart.
 */
export function nodeResolver(baseUrl: string): PeerResolver {
  const require = createRequire(baseUrl)
  return spec => {
    try {
      require.resolve(`${spec}/package.json`)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Genuine module-not-found is the only "absent" answer.
      if (code === 'MODULE_NOT_FOUND') return false
      // An installed package may intentionally hide ./package.json behind an
      // exports map. Resolution found the package directory; the restricted
      // subpath is not evidence that the peer is missing.
      if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return true
      // Preserve unknown resolution failures so incompatibilityMap can make
      // its explicit no-verdict choice rather than inventing a warning.
      throw error
    }
  }
}

/**
 * Package name → the peer names that did not resolve. A key is present only
 * when at least one peer is missing, so an absent key means "runs here, or we
 * could not tell" — the client renders nothing for either.
 *
 * A resolver that throws yields NO verdict at all: an unavailable fact must
 * never read as an accusation, because one false warning teaches a reader to
 * ignore every warning.
 */
export function incompatibilityMap(
  entries: readonly (EntryIdentity & { peers?: string[] })[],
  resolve: PeerResolver,
): Record<string, string[]> {
  const known = new Map<string, boolean | null>() // null marks "threw"
  const out: Record<string, string[]> = {}
  for (const entry of entries) {
    if (entry.peers === undefined || entry.peers.length === 0) continue
    const missing: string[] = []
    let usable = true
    for (const spec of entry.peers) {
      let present = known.get(spec)
      if (present === undefined) {
        try {
          present = resolve(spec)
          known.set(spec, present)
        } catch {
          // Resolution threw; mark so we don't retry, and discard this entry's
          // partial list. See the doc comment above.
          known.set(spec, null)
          usable = false
          break
        }
      } else if (present === null) {
        // This name threw before; discard this entry's partial list.
        usable = false
        break
      }
      if (!present) missing.push(spec)
    }
    if (usable && missing.length > 0) out[identityKey(entry)] = missing
  }
  return out
}

/**
 * The same question one step further on: which VERSION does this
 * installation provide for `spec`? `null` is the no-verdict signal — the
 * peer is absent, or its manifest could not be read. Injected exactly like
 * `PeerResolver`, so fixtures drive every verdict and only one call site
 * touches the filesystem.
 */
export type PeerVersionResolver = (spec: string) => string | null

/** One declared peer whose provided version is outside its declared range. */
export interface PeerVersionMismatch {
  spec: string
  /** The range this build declares in `peerDependencies`. */
  range: string
  /** The version the installation actually provides. */
  found: string
}

/**
 * The production resolver: `nodeResolver`'s own resolution, kept this time
 * instead of collapsed to a boolean. Anything that leaves no version to read
 * answers null — a peer that is absent, one that restricts `./package.json`
 * in its exports, an unreadable or malformed manifest, a manifest with no
 * `version`. Absence is deliberately NOT reported as a version violation:
 * `incompatibilityMap` is what covers a missing peer.
 */
export function nodeVersionResolver(baseUrl: string): PeerVersionResolver {
  const require = createRequire(baseUrl)
  return spec => {
    let manifestPath: string
    try {
      manifestPath = require.resolve(`${spec}/package.json`)
    } catch {
      // Swallows every resolution failure — MODULE_NOT_FOUND (absent) and
      // ERR_PACKAGE_PATH_NOT_EXPORTED (present but unreadable) alike. Unlike
      // nodeResolver, this resolver has no answer that could be mistaken for
      // an accusation: null already means "no verdict", so the two cases need
      // no distinction here.
      return null
    }
    try {
      const version = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }).version
      return typeof version === 'string' ? version : null
    } catch {
      // Swallows an unreadable or malformed manifest: a fact we cannot read
      // is not a mismatch, and this check must never be the reason a load
      // fails.
      return null
    }
  }
}

/**
 * The declared peers whose provided version is outside the declared range,
 * ordered by peer name. Pure: the module graph arrives through `resolve`.
 *
 * `includePrerelease` is load-bearing, not a convenience. The harness ships
 * nothing but `-rc` versions, so under strict semver `^0.1.1-rc.2` excludes
 * `0.1.2-rc.1` — the version that is installed and works — and every future
 * rc bump would raise a false alarm. With it on, the range still excludes an
 * older prerelease (`0.1.1-rc.1`) and a minor- or major-line move
 * (`0.2.0-rc.1`, `1.0.0`), which are the moves that actually break a plugin
 * path. Discrimination on both sides is the whole point: one false warning
 * teaches a reader to ignore every warning.
 *
 * Anything unreadable yields NO verdict for that peer and never a violation:
 * a resolver that answers null or throws, a found version that is not
 * semver, a declared range semver cannot parse. The other peers are still
 * judged.
 */
export function peerVersionMismatches(
  ranges: Readonly<Record<string, string>>,
  resolve: PeerVersionResolver,
): PeerVersionMismatch[] {
  const mismatches: PeerVersionMismatch[] = []
  for (const spec of Object.keys(ranges).sort()) {
    const range = ranges[spec]
    if (range === undefined || validRange(range) === null) continue
    let found: string | null
    try {
      found = resolve(spec)
    } catch {
      // Swallows a resolver that threw: the same rule incompatibilityMap
      // documents, for the same reason — an unavailable fact must never read
      // as an accusation. Nothing else can reach it; every other failure mode
      // arrives as null.
      continue
    }
    if (found === null || valid(found) === null) continue
    if (satisfies(found, range, { includePrerelease: true })) continue
    mismatches.push({ spec, range, found })
  }
  return mismatches
}

/**
 * The load-time message for a set of mismatches, or null when there is
 * nothing to say. Every mismatch is named with its declared range and the
 * version found, in ONE message: the reader needs the whole picture in the
 * line they will scroll past, and the message says the shop still loads
 * because refusing to load would cost them the shop over a diagnostic.
 */
export function peerVersionWarning(mismatches: readonly PeerVersionMismatch[]): string | null {
  if (mismatches.length === 0) return null
  const named = mismatches.map(({ spec, range, found }) => `${spec} ${range}, found ${found}`).join('; ')
  return `dsh-plugin-shop: the harness does not provide the peer versions this shop declares — ${named}.`
    + ' The shop still loads; if a path misbehaves, check this first.'
}

/** What a load-time check needs: the ranges this build declares, a way to
 * read what the installation provides, and somewhere to say it once. */
export interface PeerVersionCheckDeps {
  ranges: Readonly<Record<string, string>>
  resolve: PeerVersionResolver
  warn: (message: string) => void
}

/**
 * A self-check that warns AT MOST ONCE, however many times it is called.
 * The guard is what keeps a diagnostic a diagnostic: a message repeated per
 * call is noise a reader learns to skip, and the shop's load path is not the
 * only place that could reasonably ask this question.
 *
 * It never throws. A check that could fail a load would be worse than the
 * mismatch it reports — the user would lose the whole shop over a warning.
 */
export function createPeerVersionCheck(deps: PeerVersionCheckDeps): () => void {
  let spoken = false
  return () => {
    if (spoken) return
    spoken = true
    try {
      const message = peerVersionWarning(peerVersionMismatches(deps.ranges, deps.resolve))
      if (message !== null) deps.warn(message)
    } catch {
      // Swallows anything the injected resolver, or the sink, throws.
      // peerVersionMismatches already turns a throwing resolver into
      // no-verdict, so nothing else should reach this; a load must not fail
      // over a self-check either way.
    }
  }
}
