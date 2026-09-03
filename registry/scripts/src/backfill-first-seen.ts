/** One-time backfill of registry/first-seen.yml from the manifest.lock git
 * history: a name's first-seen date is the date of the first committed
 * snapshot that listed it. Real dates only — no fabrication. Run once with
 * `node --experimental-strip-types registry/scripts/src/backfill-first-seen.ts`,
 * commit the produced file, then never run it again (the daily build appends).
 *
 * manifest.lock line shapes (emit.ts): npm entries are `name version integrity`,
 * repo entries are `owner/slug name version`. Scoped npm names lead with `@`
 * (and contain a slash); repo slugs are `owner/slug` with no leading `@` — so
 * the leading `@`, not the slash, decides which field holds the name. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serializeFirstSeen } from './config.ts'

// Real work — shelling out to `git log`/`git show` and overwriting
// registry/first-seen.yml — belongs to the entry point alone, never to an
// import. registry/scripts/tests/strip-types.test.ts dynamically imports
// every entry point under --experimental-strip-types to prove the syntax is
// supported; emit-schema.ts already draws this same line so schema.test.ts
// can import renderJsonSchema without writing the schema file. `node -e`
// leaves process.argv[1] undefined, so a bare import never matches this and
// the module exits before any of the real work below runs.
if (process.argv[1]?.endsWith('backfill-first-seen.ts') !== true) {
  process.exit(0)
}

const REGISTRY_DIR = 'registry'
const LOCK = 'snapshots/manifest.lock'

function namesOf(lockText: string): Set<string> {
  const names = new Set<string>()
  for (const line of lockText.split('\n')) {
    if (line === '') continue
    const parts = line.split(' ')
    const first = parts[0] ?? ''
    const name = first.startsWith('@') || !first.includes('/') ? parts[0] : parts[1]
    if (name !== undefined && name !== '') names.add(name)
  }
  return names
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

const current = namesOf(readFileSync(join(REGISTRY_DIR, LOCK), 'utf8'))
const firstSeen = new Map<string, string>()
for (const { sha, date } of history) {
  if (sha === '' || date === '') continue
  let lockText: string
  try {
    lockText = lockAt(sha)
  } catch {
    continue // a rename or filter edge — the next commit still answers
  }
  for (const name of namesOf(lockText)) {
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
