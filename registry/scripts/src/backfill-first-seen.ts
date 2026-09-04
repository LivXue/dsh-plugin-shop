/** One-time backfill of registry/first-seen.yml from the manifest.lock git
 * history: a name's first-seen date is the date of the first committed
 * snapshot that listed it. Real dates only — no fabrication. Run once with
 * `node --experimental-strip-types registry/scripts/src/backfill-first-seen.ts`,
 * commit the produced file, then never run it again (the daily build appends).
 *
 * manifest.lock line shapes (emit.ts): npm entries are `name version integrity`,
 * repo entries are `owner/slug name version`. Either way the FIRST field is
 * the first-seen key — the npm name, or the repository `owner/slug` — because
 * `added` is keyed by identity and a bundle name is claimed by up to 14
 * repositories (identity.ts, audit B-9). Repo keys are lowercased to match
 * `firstSeenKey`; npm names are left as published. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { serializeFirstSeen } from './config.ts'

// Real work — shelling out to `git log`/`git show` and overwriting
// registry/first-seen.yml — belongs to the entry point alone, never to an
// import, so all of it runs inside the guard below and none of it outside.
// The guard is POSITIVE and the comparison EXACT, both deliberately.
// Positive: the form this replaced ended in `process.exit(0)` at module
// scope, which terminates whatever process IMPORTS this module — under
// vitest, a worker that vanishes mid-suite and reports success, which is what
// the first unit test of `keysOf` below would have run into. emit-schema.ts
// drew the positive line first, and schema.test.ts already relies on it to
// import renderJsonSchema without the write side effect.
// Exact: `endsWith('backfill-first-seen.ts')` also admits
// `rebackfill-first-seen.ts`. `node -e` leaves process.argv[1] undefined, so
// basename('') matches no name and a bare import runs nothing.
// registry/scripts/tests/strip-types.test.ts derives the entry-point list and
// holds every member of it to both halves of this.
if (basename(process.argv[1] ?? '') === 'backfill-first-seen.ts') {
  const REGISTRY_DIR = 'registry'
  const LOCK = 'snapshots/manifest.lock'

  function keysOf(lockText: string): Set<string> {
    const keys = new Set<string>()
    for (const line of lockText.split('\n')) {
      if (line === '') continue
      const key = line.split(' ')[0]
      if (key === undefined || key === '') continue
      // A repo line leads with `owner/slug`: no leading `@`, exactly one slash.
      keys.add(!key.startsWith('@') && key.includes('/') ? key.toLowerCase() : key)
    }
    return keys
  }

  function lockAt(sha: string): string {
    return execFileSync('git', ['show', `${sha}:${join(REGISTRY_DIR, LOCK)}`], { encoding: 'utf8' })
  }

  const history = execFileSync(
    'git', ['log', '--reverse', '--format=%H %cs', '--', join(REGISTRY_DIR, LOCK)], { encoding: 'utf8' },
  )
    .split('\n').filter(line => line !== '')
    .map(line => {
      const [sha, date] = line.split(' ')
      return { sha: sha ?? '', date: date ?? '' }
    })

  const current = keysOf(readFileSync(join(REGISTRY_DIR, LOCK), 'utf8'))
  const firstSeen = new Map<string, string>()
  for (const { sha, date } of history) {
    if (sha === '' || date === '') continue
    let lockText: string
    try {
      lockText = lockAt(sha)
    } catch {
      continue // a rename or filter edge — the next commit still answers
    }
    for (const name of keysOf(lockText)) {
      if (current.has(name) && !firstSeen.has(name)) firstSeen.set(name, date)
    }
  }

  // Guard: every key must be a real name, never a version string. The 2026-08-31
  // backfill shipped with 187 version-string keys (scoped npm lines misparsed as
  // repo lines, e.g. `@scope/name 0.4.17 sha512-…` yielded "0.4.17"). The build
  // only appends, so that junk would be permanent — fail loudly instead.
  const versionish = [...firstSeen.keys()].filter(name => /^\d+(\.\d+)+/.test(name))
  if (versionish.length > 0) {
    throw new Error(`backfill produced version-string keys: ${versionish.join(', ')}`)
  }

  writeFileSync(join(REGISTRY_DIR, 'first-seen.yml'), serializeFirstSeen(firstSeen))
  process.stderr.write(`backfilled ${firstSeen.size} name(s) from ${history.length} snapshot commit(s)\n`)
}
