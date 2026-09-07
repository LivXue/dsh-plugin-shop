import { describe, expect, it } from 'vitest'
import {
  ACKNOWLEDGEMENT_EN, INSTALL_POLL_MS, SHOP_VISIBLE_BATCH, categoryKey, displayVersion, entryKey, formatSize, formatStars,
  authorOf, hasGithubHome, heldBy, isCustomLicense, isShopLike, missingPeersOf,
  nextVisibleCount, npmPageUrl,
  reduceInstall,
  reviewHashPin, sortByStars, starsOf, tierKey,
} from '../../src/client/present.ts'
import type { CatalogEntry } from '../../src/host/index.ts'

const entry: CatalogEntry = {
  name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null,
  repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm',
  added: '2026-08-25',
}

describe('entryKey', () => {
  it('answers the npm identity for an npm entry', () => {
    expect(entryKey(entry)).toBe('npm:dsh-hello-plugin')
  })

  it('answers the repo identity for a github entry, so its name never decides', () => {
    // The catalog's uniqueness invariant is the install identity, and for a
    // repo entry that is the repository — never the package.json name.
    expect(entryKey({ ...entry, source: 'github', repo: 'octocat/template' })).toBe('github:octocat/template#')
    expect(entryKey({ ...entry, source: 'github', repo: 'octocat/mono', subdir: 'packages/a' }))
      .toBe('github:octocat/mono#packages/a')
  })

  it('separates repositories that publish the same package name', () => {
    // Five live repos are cookiecutter templates that all name themselves
    // `{{PKG_NAME}}`; 151 live names cover 243 entries between them. Keying a
    // list by name collapses each such group into one identity.
    const a = { ...entry, name: '{{PKG_NAME}}', source: 'github' as const, repo: 'one/template' }
    const b = { ...entry, name: '{{PKG_NAME}}', source: 'github' as const, repo: 'two/template' }
    expect(entryKey(a)).not.toBe(entryKey(b))
  })

  it('separates two subpackages of one repository', () => {
    const root = { ...entry, source: 'github' as const, repo: 'octocat/mono' }
    const sub = { ...entry, source: 'github' as const, repo: 'octocat/mono', subdir: 'packages/a' }
    expect(entryKey(root)).not.toBe(entryKey(sub))
  })

  it('falls back to the name for a github entry carrying no repo', () => {
    // Same shape as the registry invariant, which reads `entry.repo ?? entry.name`.
    expect(entryKey({ ...entry, source: 'github' })).toBe('github:dsh-hello-plugin#')
  })
})

describe('tierKey', () => {
  it('maps each tier to its locale key', () => {
    expect(tierKey('verified')).toBe('tierVerified')
    expect(tierKey('verified-stale')).toBe('tierVerifiedStale')
    expect(tierKey('community')).toBe('tierCommunity')
  })
})

describe('ACKNOWLEDGEMENT_EN', () => {
  it('is the spec §9.3 wording verbatim', () => {
    expect(ACKNOWLEDGEMENT_EN).toBe(
      'Once installed, this plugin holds the same privileges as a built-in one: reading and writing your files, running shell commands, and reading and modifying the requests sent to the model. It has not been reviewed.',
    )
  })
})

describe('nextVisibleCount', () => {
  it('grows by the batch and clamps at the total', () => {
    expect(SHOP_VISIBLE_BATCH).toBe(48)
    expect(nextVisibleCount(0, 5, 48)).toBe(5)
    expect(nextVisibleCount(48, 100, 48)).toBe(96)
    expect(nextVisibleCount(96, 100, 48)).toBe(100)
    expect(nextVisibleCount(100, 100, 48)).toBe(100)
  })
})

describe('INSTALL_POLL_MS', () => {
  it('polls once per second per §7.2', () => {
    expect(INSTALL_POLL_MS).toBe(1000)
  })
})

describe('starsOf against a prototype-bearing map (G-8)', () => {
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    it(`answers undefined for an entry named ${name}`, () => {
      expect(starsOf({ ...entry, name }, {})).toBeUndefined()
    })
  }

  it('still reads a real count for such a name', () => {
    expect(starsOf({ ...entry, name: 'constructor' }, { constructor: 12 })).toBe(12)
  })

  it('does not sort a prototype-named entry to the top of the shelf', () => {
    const proto = { ...entry, name: 'constructor' }
    const real = { ...entry, name: 'dsh-real' }
    expect(sortByStars([proto, real], { 'dsh-real': 5 }).map(e => e.name)).toEqual(['dsh-real', 'constructor'])
  })
})

describe('reduceInstall', () => {
  it('keeps the log when the install finishes, not only when it fails', () => {
    // Reported 2026-09-06: the log a user is reading during an install
    // vanishes the moment it succeeds. `failed` carried the log and `done`
    // did not, so the outcome that leaves something to inspect — what was
    // installed, what pnpm did — was the one that showed nothing, while the
    // outcome that failed kept its evidence.
    const running = { kind: 'running' as const, installId: 'i1', log: ['+ dsh-x 1.0.0'] }
    const done = reduceInstall(running, {
      type: 'status',
      status: { found: true, state: 'done', log: ['+ dsh-x 1.0.0', 'Done in 1.2s'], needsRestart: false },
    })
    expect(done.kind).toBe('done')
    expect(done).toHaveProperty('log', ['+ dsh-x 1.0.0', 'Done in 1.2s'])
  })

  it('starts from idle into running with the install id', () => {
    const next = reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'abc' })
    expect(next).toEqual({ kind: 'running', installId: 'abc', log: [] })
  })

  it('carries running status updates with their log', () => {
    const running = reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'abc' })
    const next = reduceInstall(running, { type: 'status', status: { found: true, state: 'running', log: ['a'] } })
    expect(next).toEqual({ kind: 'running', installId: 'abc', log: ['a'] })
  })

  it('reaches done with needsRestart', () => {
    const running = reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'abc' })
    const next = reduceInstall(running, { type: 'status', status: { found: true, state: 'done', log: ['a'], needsRestart: true } })
    expect(next).toEqual({ kind: 'done', needsRestart: true, log: ['a'] })
    // Without a host reason the done view keeps the old shape: no
    // restartReason key at all (toEqual would ignore an undefined one).
    expect('restartReason' in next).toBe(false)
  })

  it('reaches done carrying the host restart reason code when the hot mount failed', () => {
    const running = reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'abc' })
    const next = reduceInstall(running, { type: 'status', status: { found: true, state: 'done', log: ['a'], needsRestart: true, restartReason: 'mount-failed' } })
    expect(next).toEqual({ kind: 'done', needsRestart: true, log: ['a'], restartReason: 'mount-failed' })
  })

  it('reaches done with needsRestart false when the host reports the live outcome', () => {
    // The live install/uninstall outcome: nothing to restart, so the done
    // view says so and the panels branch on it.
    const running = reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'abc' })
    const next = reduceInstall(running, { type: 'status', status: { found: true, state: 'done', log: ['a'], needsRestart: false } })
    expect(next).toEqual({ kind: 'done', needsRestart: false, log: ['a'] })
  })

  it('reaches failed with the host detail and the log', () => {
    const running = reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'abc' })
    const next = reduceInstall(running, { type: 'status', status: { found: true, state: 'failed', log: ['boom'], detail: 'pnpm failed — run: dsh plugin --profile web install' } })
    expect(next).toEqual({ kind: 'failed', detail: 'pnpm failed — run: dsh plugin --profile web install', log: ['boom'] })
  })

  it('treats a lost install record as failed', () => {
    const running = reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'abc' })
    const next = reduceInstall(running, { type: 'status', status: { found: false, state: 'failed', log: [] } })
    expect(next?.kind).toBe('failed')
  })

  it('records a rejection with its author-readable detail', () => {
    const next = reduceInstall({ kind: 'idle' }, { type: 'rejected', code: 'denied', detail: 'dsh-plugin-shop: dsh-blocked is denied: matched the denylist' })
    expect(next).toEqual({ kind: 'rejected', code: 'denied', detail: 'dsh-plugin-shop: dsh-blocked is denied: matched the denylist' })
  })

  it('ignores unrelated events', () => {
    expect(reduceInstall({ kind: 'idle' }, { type: 'status', status: { found: true, state: 'running', log: [] } })).toEqual({ kind: 'idle' })
  })
})

describe('isShopLike', () => {
  it('matches a segment equal to a shop keyword, qualified as a plugin or by ending the name', () => {
    expect(isShopLike('dsh-plugin-shop')).toBe(true)
    expect(isShopLike('dsh-store')).toBe(true)
    expect(isShopLike('@scope/dsh-plugin-market')).toBe(true)
    expect(isShopLike('dsh-plugin-mall')).toBe(true)
    expect(isShopLike('plugin-shop')).toBe(true)
  })

  it('matches glued dsh-keyword forms', () => {
    // `dshmarket` is one segment — no hyphen to split on — so the segment
    // rule never saw it; these are the unhyphenated spellings of the same
    // competing-market names.
    expect(isShopLike('dshmarket')).toBe(true)
    expect(isShopLike('dshstore')).toBe(true)
    expect(isShopLike('dshmall')).toBe(true)
    expect(isShopLike('dshshop')).toBe(true)
    expect(isShopLike('dshmarketplace')).toBe(true)
  })

  it('matches a dsh-prefixed name whose second segment is a keyword', () => {
    expect(isShopLike('dsh-market-plus')).toBe(true)
    expect(isShopLike('@scope/dsh-market-plus')).toBe(true)
    expect(isShopLike('dsh-store-pro')).toBe(true)
  })

  it('does not match a dsh-prefixed name whose second segment merely starts with a keyword', () => {
    // `marketing` starts with `market` but is not a market.
    expect(isShopLike('dsh-marketing-tool')).toBe(false)
  })

  it('does not match a dsh-keyword name whose third segment is not a store qualifier', () => {
    // The real false positive found in the live catalog: an ecommerce
    // operators' tool, not a competing store.
    expect(isShopLike('dsh-shop-assistant')).toBe(false)
    expect(isShopLike('dsh-market-data')).toBe(false)
    expect(isShopLike('dsh-store-tools')).toBe(false)
  })

  it('does not match a glued keyword with extra letters after it', () => {
    // `dshstorekeeper` is dsh+storekeeper, not dsh+store — the same
    // precision principle as the hyphenated `dsh-storekeeper-tool` case.
    expect(isShopLike('dshstorekeeper-tool')).toBe(false)
    expect(isShopLike('dshrestore')).toBe(false)
  })

  it('matches plugin-keyword concatenations', () => {
    expect(isShopLike('pluginstore')).toBe(true)
    expect(isShopLike('dsh-pluginmarket')).toBe(true)
    expect(isShopLike('storeplugin')).toBe(true)
    expect(isShopLike('market-plugin')).toBe(true)
  })

  it('matches the named competing marketplaces that no pattern catches', () => {
    // Plugin-market packages whose names carry no store/market keyword sit
    // on the explicit list rather than the pattern rules. Only the exact
    // names match — anything else stays listed.
    expect(isShopLike('dsh-plugin')).toBe(true)
    expect(isShopLike('dsh-plugin-hub')).toBe(true)
    expect(isShopLike('@lanbaolu/dsh-plugin-hub')).toBe(true)
    expect(isShopLike('@mutocenew/dsh-plugin-catalog')).toBe(true)
    expect(isShopLike('@dsheval/dsh-top100-plugin')).toBe(true)
    // Not on the list: other scopes, other spellings, and hub-flavored
    // tools that manage content rather than markets.
    expect(isShopLike('@dshplugin/dsh-plugin')).toBe(false)
    expect(isShopLike('dsh-top100-plugin')).toBe(false)
    expect(isShopLike('dsh-plugin-tools')).toBe(false)
    expect(isShopLike('@lcthe/dsh-skills-hub')).toBe(false)
    expect(isShopLike('dsh-extension-hub')).toBe(false)
  })

  it('does not match ordinary plugin names', () => {
    // Precision over recall: a name that merely CONTAINS a keyword segment
    // without a plugin qualifier or keyword ending is not a shop plugin.
    expect(isShopLike('dsh-restore')).toBe(false)
    expect(isShopLike('dsh-storekeeper-tool')).toBe(false)
    expect(isShopLike('market-data-provider')).toBe(false)
    expect(isShopLike('marketplace-hub')).toBe(false)
    expect(isShopLike('dsh-shopping-list')).toBe(false)
    expect(isShopLike('dsh-hello-plugin')).toBe(false)
  })
})

describe('categoryKey', () => {
  it('maps a declared category and falls back to other for derived entries', () => {
    expect(categoryKey({ ...entry, catalog: { category: 'provider', summary: { en: 'x' }, capabilities: [] } })).toBe('categoryProvider')
    expect(categoryKey({ ...entry, catalog: { category: 'theme', summary: { en: 'x' }, capabilities: [] } })).toBe('categoryTheme')
    expect(categoryKey(entry)).toBe('categoryOther')
  })
})

describe('reviewHashPin', () => {
  const review = { reviewer: 'someone', reviewCommit: 'abc123', notes: 'x' }

  it('shortens the reviewed commit to the 7-char card form', () => {
    expect(reviewHashPin({ ...review, reviewedCommit: 'b'.repeat(40) })).toBe('bbbbbbb')
  })

  it('names the reviewed release tarball sha256 for release-rescued entries', () => {
    expect(reviewHashPin({ ...review, reviewedSha256: 'a'.repeat(64) })).toBe('aaaaaaa')
  })

  it('prefers the commit pin when both hashes are present', () => {
    expect(reviewHashPin({ ...review, reviewedCommit: 'c'.repeat(40), reviewedSha256: 'a'.repeat(64) })).toBe('ccccccc')
  })

  it('returns an empty string when no hash pin exists', () => {
    expect(reviewHashPin(review)).toBe('')
  })
})

describe('npmPageUrl', () => {
  const npm = (name: string): CatalogEntry => ({ ...entry, name })

  it('builds the npm package page for an unscoped and a scoped name', () => {
    expect(npmPageUrl(npm('dsh-hello-plugin'))).toBe('https://www.npmjs.com/package/dsh-hello-plugin')
    expect(npmPageUrl(npm('@scope/dsh-hello'))).toBe('https://www.npmjs.com/package/@scope/dsh-hello')
  })

  it('answers null for a github entry, which has no npm page', () => {
    expect(npmPageUrl({ ...entry, name: 'dsh-repo-plugin', source: 'github', repo: 'you/dsh-repo-plugin' })).toBeNull()
  })

  it('refuses a name that is not a legal npm package name', () => {
    // The name is untrusted catalog input and this function CONSTRUCTS a URL
    // from it, so anything outside the npm grammar gets no link at all —
    // the same rule the repository row applies to its own value.
    for (const bad of [
      '../../evil',
      'dsh-hello?x=1',
      'dsh hello',
      'dsh#hello',
      '@scope/sub/dsh-hello',
      '@/dsh-hello',
      'https://evil.test/x',
      '',
    ]) {
      expect(npmPageUrl(npm(bad)), bad).toBeNull()
    }
  })
})

describe('sortByStars', () => {
  const make = (name: string): CatalogEntry => ({ ...entry, name })

  it('sorts by stars descending, unstarred last, name asc on ties', () => {
    const entries = [make('dsh-alpha'), make('dsh-mid'), make('dsh-top'), make('dsh-nostar'), make('dsh-mid-tie')]
    const stars = { 'dsh-mid': 5, 'dsh-top': 100, 'dsh-mid-tie': 5 }
    expect(sortByStars(entries, stars).map(e => e.name)).toEqual([
      'dsh-top', 'dsh-mid', 'dsh-mid-tie', 'dsh-alpha', 'dsh-nostar',
    ])
  })

  it('is case-insensitive on the name tiebreak', () => {
    const a = make('dsh-Beta')
    const b = make('dsh-alpha')
    expect(sortByStars([a, b], {}).map(e => e.name)).toEqual(['dsh-alpha', 'dsh-Beta'])
  })

  it('keeps pure name order when stars is empty', () => {
    const entries = [make('dsh-zebra'), make('dsh-alpha')]
    expect(sortByStars(entries, {}).map(e => e.name)).toEqual(['dsh-alpha', 'dsh-zebra'])
  })

  it('reads a github entry\'s count under its repo, the key the sidecar uses', () => {
    // The sidecar keys npm entries by package name and github entries by repo
    // full name — two disjoint keyspaces (registry stars-assemble.ts). The
    // sort read the name for every entry, so 1590 of the 2210 github listings
    // in the live catalog sorted as unstarred, a 4014-star plugin among them,
    // while their own cards displayed the real count.
    const gh = { ...entry, name: 'dsh-popular', source: 'github' as const, repo: 'someone/dsh-popular' }
    const npm = make('dsh-modest')
    const stars = { 'someone/dsh-popular': 500, 'dsh-modest': 5 }
    expect(sortByStars([npm, gh], stars).map(e => e.name)).toEqual(['dsh-popular', 'dsh-modest'])
  })

  it('does not rank a github entry by a same-named npm package\'s stars', () => {
    // The live shelf put a 1-star plugin on the first page: an unrelated npm
    // package named `dsh-plugin-catalog` declared awesome-dsh-plugin as its
    // repository, so the sidecar carried 13960 under that NAME while the
    // listed github entry (LuniteGlaze/dsh-plugin-catalog) had 1 star. The
    // npm candidate was never even published to the catalog — its key was.
    const gh = { ...entry, name: 'dsh-plugin-catalog', source: 'github' as const, repo: 'LuniteGlaze/dsh-plugin-catalog' }
    const other = make('dsh-real-favourite')
    const stars = { 'dsh-plugin-catalog': 13960, 'LuniteGlaze/dsh-plugin-catalog': 1, 'dsh-real-favourite': 40 }
    expect(sortByStars([gh, other], stars).map(e => e.name)).toEqual(['dsh-real-favourite', 'dsh-plugin-catalog'])
  })
})

describe('sortByStars cost (G-5)', () => {
  it('sorts 9,400 entries well inside a keystroke budget', () => {
    const entries: CatalogEntry[] = Array.from({ length: 9400 }, (_, i) => ({
      ...entry,
      name: `dsh-plugin-${(i * 7919) % 9400}`,
    }))
    const stars: Record<string, number> = Object.create(null)
    for (const [i, candidate] of entries.entries()) {
      if (i % 3 === 0) stars[candidate.name] = (i * 31) % 5000
    }
    const runs = 5
    // CPU time measures the comparator itself; wall time is dominated by
    // scheduler contention when Vitest runs every package suite in parallel.
    const started = process.cpuUsage()
    for (let run = 0; run < runs; run += 1) sortByStars(entries, stars)
    const used = process.cpuUsage(started)
    const perRun = (used.user + used.system) / 1000 / runs
    expect(perRun).toBeLessThan(60)
  })

  it('still tiebreaks case-insensitively on the name', () => {
    const a = { ...entry, name: 'Beta' }
    const b = { ...entry, name: 'alpha' }
    expect(sortByStars([a, b], {}).map(candidate => candidate.name)).toEqual(['alpha', 'Beta'])
  })
})

describe('starsOf', () => {
  it('keys a github entry by its repo and an npm entry by its name', () => {
    const gh = { ...entry, name: 'dsh-popular', source: 'github' as const, repo: 'someone/dsh-popular' }
    expect(starsOf(gh, { 'someone/dsh-popular': 7, 'dsh-popular': 999 })).toBe(7)
    expect(starsOf(entry, { [entry.name]: 3 })).toBe(3)
  })

  it('answers undefined when the sidecar has no count for the entry', () => {
    // Distinct from zero: a repo with no stars is a real count of 0, and the
    // shelf sorts it above an entry the sidecar never covered.
    expect(starsOf(entry, {})).toBeUndefined()
    expect(starsOf(entry, { [entry.name]: 0 })).toBe(0)
  })
})

describe('formatStars', () => {
  it('formats the magnitude boundaries', () => {
    expect(formatStars(0)).toBe('0')
    expect(formatStars(999)).toBe('999')
    expect(formatStars(1000)).toBe('1k')
    expect(formatStars(1234)).toBe('1.2k')
    expect(formatStars(1500)).toBe('1.5k')
    expect(formatStars(99999)).toBe('100k')
  })
})

describe('formatSize', () => {
  it('formats the magnitude boundaries in decimal units', () => {
    // Decimal kB/MB, matching npmjs.com's own package page: the figure IS
    // npm's `dist.unpackedSize`, and a reader who checks the shelf against
    // npm must not find two different numbers for one package. 1024-based
    // units would show 653.6 kB where npm shows 667 kB.
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(1)).toBe('1 B')
    expect(formatSize(999)).toBe('999 B')
    expect(formatSize(1000)).toBe('1.0 kB')
    // Real figures measured against the live registry on 2026-09-07: the
    // smallest, the median and the largest of 250 `dsh-plugin` packages.
    expect(formatSize(25283)).toBe('25.3 kB')
    expect(formatSize(847407)).toBe('847.4 kB')
    expect(formatSize(179562863)).toBe('179.6 MB')
    expect(formatSize(1000000)).toBe('1.0 MB')
    // The GB rung exists so a gigabyte package does not read "1000.0 MB".
    expect(formatSize(1000000000)).toBe('1.0 GB')
    expect(formatSize(2500000000)).toBe('2.5 GB')
    // Past the last rung the unit stops climbing rather than inventing one.
    expect(formatSize(5000000000000)).toBe('5000.0 GB')
  })

  it('carries a value that rounds to 1000 up to the next unit', () => {
    // The unit is chosen AFTER rounding, because `toFixed(1)` is what the
    // reader sees. Choosing first let the mantissa carry across the boundary:
    // every count in [999_950, 1_000_000) printed "1000.0 kB" and every count
    // in [999_950_000, 1_000_000_000) printed "1000.0 MB" — the second being
    // verbatim the string the GB rung's own comment says it exists to prevent,
    // which it could not, because the carry happens one rung below it.
    // `formatSize(999999) === '1000.0 kB'` was asserted here as correct.
    expect(formatSize(999_950)).toBe('1.0 MB')
    expect(formatSize(999_999)).toBe('1.0 MB')
    expect(formatSize(999_949)).toBe('999.9 kB')
    expect(formatSize(999_999_999)).toBe('1.0 GB')
    expect(formatSize(999_949_999)).toBe('999.9 MB')
    // The last rung has no next unit to carry into, so it keeps the reading.
    expect(formatSize(999_999_999_999)).toBe('1000.0 GB')
  })

  it('answers nothing for an entry that carries no size', () => {
    // A github entry has no honest figure and an npm publish older than npm
    // 5.6 recorded none. Undefined in, undefined out — so the card renders no
    // label instead of a "0 B" that would claim the package is empty.
    expect(formatSize(undefined)).toBeUndefined()
  })
})

describe('displayVersion', () => {
  it('shows npm versions in full and github commits short', () => {
    expect(displayVersion({ source: 'npm', version: '1.2.3' })).toBe('1.2.3')
    expect(displayVersion({ source: 'github', version: 'd'.repeat(40) })).toBe('ddddddd')
  })
})

describe('isCustomLicense', () => {
  it('matches the npm SEE LICENSE IN idiom and nothing else', () => {
    expect(isCustomLicense('SEE LICENSE IN LICENSE')).toBe(true)
    expect(isCustomLicense('SEE LICENSE IN LICENSE.md')).toBe(true)
    expect(isCustomLicense('MIT')).toBe(false)
    expect(isCustomLicense('NOASSERTION')).toBe(false)
    expect(isCustomLicense(null)).toBe(false)
  })
})

describe('missingPeersOf', () => {
  it('returns the named missing peers', () => {
    expect(missingPeersOf({ 'dsh-timeline': ['@deepseek-ai/dsh-client-store'] }, 'dsh-timeline'))
      .toEqual(['@deepseek-ai/dsh-client-store'])
  })

  it('returns none for a name the host said nothing about', () => {
    expect(missingPeersOf({ 'dsh-timeline': ['x'] }, 'dsh-other')).toEqual([])
  })
})

describe('authorOf', () => {
  it('is the npm publishing account for an npm entry', () => {
    expect(authorOf({ ...entry, publisher: 'realauthor' })).toBe('realauthor')
  })

  it('is null for an npm entry whose packument named no account', () => {
    // The live catalog carries no publisher until the next daily build, and a
    // packument may name none at all. Nothing is invented for it.
    expect(authorOf(entry)).toBeNull()
  })

  it('is the repository owner for a github entry', () => {
    // A github entry's identity IS `owner/slug`, so the owner is already on
    // the entry — no catalog field and no schema bump needed for it.
    expect(authorOf({ ...entry, source: 'github', repo: 'octocat/dsh-repo-plugin' })).toBe('octocat')
  })

  it('is null for a github entry whose repo is not owner/slug', () => {
    // `repo` reaches the client as an unvalidated string (the consumer schema
    // types it `z.string()`), so a value that is not the documented shape
    // yields nothing rather than a misleading fragment — the same discipline
    // npmPageUrl applies to a package name.
    expect(authorOf({ ...entry, source: 'github', repo: 'noslash' })).toBeNull()
    expect(authorOf({ ...entry, source: 'github', repo: '/leading' })).toBeNull()
    expect(authorOf({ ...entry, source: 'github', repo: 'bad owner/slug' })).toBeNull()
    expect(authorOf({ ...entry, source: 'github', repo: `${'x'.repeat(40)}/slug` })).toBeNull()
  })

  it('is null for a github entry carrying no repo at all', () => {
    expect(authorOf({ ...entry, source: 'github' })).toBeNull()
  })

  it('ignores a publisher that rode in on a github entry', () => {
    // The registry never sets `publisher` on a repo entry (assignRepoTier does
    // not touch it); if one ever appeared, the owner is still the answer.
    expect(authorOf({ ...entry, source: 'github', repo: 'octocat/x', publisher: 'someone-else' })).toBe('octocat')
  })
})

describe('hasGithubHome', () => {
  it('is true for an npm entry whose repository is on github', () => {
    // 4892 of the live catalog's 4915 entries are here; the icon pair is the
    // ordinary case, and its ABSENCE is what carries the signal.
    expect(hasGithubHome({ ...entry, repository: 'https://github.com/you/x' })).toBe(true)
    expect(hasGithubHome({ ...entry, repository: 'https://www.github.com/you/x' })).toBe(true)
  })

  it('is true for a github-source entry, which is a repository by definition', () => {
    expect(hasGithubHome({ ...entry, source: 'github', repo: 'you/x', repository: 'https://github.com/you/x' })).toBe(true)
  })

  it('is false for an npm entry hosted somewhere else', () => {
    // The live catalog has gitee, gitcode, codeberg, gitlab and cnb.cool
    // entries. None of them is a GitHub home and none may claim the mark.
    for (const host of ['gitee.com', 'gitcode.com', 'codeberg.org', 'gitlab.com', 'cnb.cool']) {
      expect(hasGithubHome({ ...entry, repository: `https://${host}/you/x` })).toBe(false)
    }
  })

  it('is false when the repository is absent or unparseable', () => {
    // Two live entries carry a repository string with no hostname at all;
    // `repository` is untrusted input, so it is parsed, not pattern-matched.
    expect(hasGithubHome({ ...entry, repository: null })).toBe(false)
    expect(hasGithubHome({ ...entry, repository: 'not a url' })).toBe(false)
    expect(hasGithubHome({ ...entry, repository: '' })).toBe(false)
  })

  it('is false for a lookalike host that merely ends in github.com', () => {
    // Substring matching would accept this; parsing the host does not.
    expect(hasGithubHome({ ...entry, repository: 'https://evil-github.com/you/x' })).toBe(false)
    expect(hasGithubHome({ ...entry, repository: 'https://github.com.evil.test/you/x' })).toBe(false)
  })
})

describe('heldBy', () => {
  const repoEntry: CatalogEntry = {
    ...entry, source: 'github', repo: 'Mvyvn/dsh-hello-plugin', version: 'a'.repeat(40),
  }

  it('names the repository holding this name, in the spec own spelling', () => {
    expect(heldBy(repoEntry, { 'dsh-hello-plugin': 'github:CLAPEILL/dsh-hello-plugin' }))
      .toBe('CLAPEILL/dsh-hello-plugin')
  })

  it('sees a holder no catalog entry matches — the case installed() drops', () => {
    // The gap that made the badge absent exactly where the host refuses: a
    // fork, a hand install, or an entry the catalog has since dropped never
    // appears in `installed()`, but the manifest still holds the name.
    expect(heldBy(entry, { 'dsh-hello-plugin': 'file:/home/me/dev/dsh-hello-plugin' }))
      .toBe('file:/home/me/dev/dsh-hello-plugin')
  })

  it('is silent when the spec names this very install', () => {
    expect(heldBy(entry, { 'dsh-hello-plugin': '^1.0.0' })).toBeUndefined()
    expect(heldBy(repoEntry, { 'dsh-hello-plugin': 'github:Mvyvn/dsh-hello-plugin' })).toBeUndefined()
  })

  it('is silent for a name the profile does not hold at all', () => {
    expect(heldBy(entry, {})).toBeUndefined()
    expect(heldBy(entry, { 'dsh-other': '^1.0.0' })).toBeUndefined()
  })

  it('reads own properties only, so a plugin named constructor is not held', () => {
    // The map is the profile manifest's dependencies carried over the wire,
    // it carries Object.prototype, and `constructor` is a legal npm name — an
    // index read hands back a function for a package nobody installed.
    const named: CatalogEntry = { ...entry, name: 'constructor' }
    expect(heldBy(named, {})).toBeUndefined()
    expect(heldBy({ ...named, source: 'github', repo: 'a/b' }, {})).toBeUndefined()
  })

  it('makes no claim when the host could not read the manifest', () => {
    // undefined is "cannot say", never "nothing is installed": promising a
    // clean install it could not check is the one answer it must not give.
    expect(heldBy(repoEntry, undefined)).toBeUndefined()
  })

  it('names an npm holder with the token the host refusal uses', () => {
    expect(heldBy(repoEntry, { 'dsh-hello-plugin': '^2.0.0' })).toBe('npm:dsh-hello-plugin')
  })
})
