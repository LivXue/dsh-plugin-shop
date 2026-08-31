/** One-time backfill of registry/first-seen.yml from the manifest.lock git
 * history: a name's first-seen date is the date of the first committed
 * snapshot that listed it. Real dates only — no fabrication. Run once with
 * `node --experimental-strip-types registry/scripts/src/backfill-first-seen.ts`,
 * commit the produced file, then never run it again (the daily build appends).
 *
 * manifest.lock line shapes (emit.ts): npm entries are `name version integrity`,
 * repo entries are `owner/slug name version` — the slash disambiguates. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serializeFirstSeen } from './config.ts'

const REGISTRY_DIR = 'registry'
const LOCK = 'snapshots/manifest.lock'

function namesOf(lockText: string): Set<string> {
  const names = new Set<string>()
  for (const line of lockText.split('\n')) {
    if (line === '') continue
    const parts = line.split(' ')
    const name = (parts[0] ?? '').includes('/') ? parts[1] : parts[0]
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

writeFileSync(join(REGISTRY_DIR, 'first-seen.yml'), serializeFirstSeen(firstSeen))
process.stderr.write(`backfilled ${firstSeen.size} name(s) from ${history.length} snapshot commit(s)\n`)
