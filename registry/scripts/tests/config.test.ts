import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { loadRegistryConfig, parseRegistryConfig, serializeFirstSeen } from '../src/config.ts'

const empty = {
  verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]', firstSeen: '[]',
}

describe('parseRegistryConfig', () => {
  it('derives the shop-like exemption from market:false rows only', () => {
    // markets.yml records BOTH verdicts so the classifier has a memory and
    // never re-asks. Only the false ones clear the client's name filter — a
    // reading a `Set(rows.keys())` would get wrong, silently shelving all 45
    // genuine markets.
    const config = parseRegistryConfig({
      ...empty,
      markets: [
        '- name: dsh-plugin-market\n  market: true\n  by: human\n  reason: a market\n',
        '- name: dsh-tea-store\n  market: false\n  by: human\n  reason: stores tea\n',
        '- name: dsh-skin-market\n  market: false\n  by: llm\n  reason: sells skins\n',
      ].join(''),
    })
    expect([...config.notAShop].sort()).toEqual(['dsh-skin-market', 'dsh-tea-store'])
    // Judged covers both verdicts: the classifier asks only about names absent
    // from it, so a name judged a market must be in here or it is re-asked
    // every day and can flip on a bad roll.
    expect([...config.marketsJudged].sort()).toEqual(['dsh-plugin-market', 'dsh-skin-market', 'dsh-tea-store'])
  })

  it('throws on a duplicate name in markets.yml', () => {
    // Caught a real property of the data when this file was seeded: seven
    // separate repos publish `dsh-plugin-market`, so the audit had to fold
    // 73 caught entries onto 65 distinct names before it could be written.
    expect(() => parseRegistryConfig({
      ...empty,
      markets: '- name: dsh-plugin-market\n  market: true\n  by: human\n  reason: a\n'
        + '- name: dsh-plugin-market\n  market: true\n  by: human\n  reason: b\n',
    })).toThrow(/markets\.yml: duplicate entry for dsh-plugin-market/)
  })

  it('parses empty files', () => {
    const config = parseRegistryConfig(empty)
    expect(config.verified.size).toBe(0)
    expect(config.denied.size).toBe(0)
    expect(config.allowedSimilar.size).toBe(0)
  })

  it('parses a verified entry', () => {
    const config = parseRegistryConfig({
      ...empty,
      verified: `
- name: dsh-hello-plugin
  reviewedVersion: 1.2.0
  reviewer: github:someone
  reviewCommit: abc1234
  notes: fine
`,
    })
    expect(config.verified.get('dsh-hello-plugin')).toEqual({
      reviewedVersion: '1.2.0',
      reviewer: 'github:someone',
      reviewCommit: 'abc1234',
      notes: 'fine',
    })
  })

  it('parses a denied entry with its reason', () => {
    const config = parseRegistryConfig({
      ...empty,
      denied: `
- name: dsh-evil-plugin
  reason: Exfiltrates credentials.
`,
    })
    expect(config.denied.get('dsh-evil-plugin')).toEqual({ reason: 'Exfiltrates credentials.' })
  })

  it('parses a denied entry with a known replacement', () => {
    const config = parseRegistryConfig({
      ...empty,
      denied: `
- name: dsh-evil-plugin
  reason: Exfiltrates credentials.
  replacement: dsh-good-plugin
`,
    })
    expect(config.denied.get('dsh-evil-plugin')).toEqual({
      reason: 'Exfiltrates credentials.',
      replacement: 'dsh-good-plugin',
    })
  })

  it('parses allowed-similar names', () => {
    const config = parseRegistryConfig({ ...empty, allowedSimilar: '- dsh-fs-tools\n' })
    expect(config.allowedSimilar.has('dsh-fs-tools')).toBe(true)
  })

  it('keys a github review by the repository it covers, and an npm review by the package name', () => {
    // A GitHub review binds (repo, commit). 83 live bundle names are claimed
    // by both a fork and an original, so a review keyed by the bundle name
    // handed every fork the reviewer's verdict — and, at the reviewed commit,
    // the skipped install acknowledgement (B-3 / A-4).
    const config = parseRegistryConfig({
      ...empty,
      verified: [
        '- name: dsh-npm-plugin',
        '  reviewedVersion: 1.2.0',
        '  reviewer: github:someone',
        '  reviewCommit: abc1234',
        '- name: dsh-repo-plugin',
        '  repo: Alice/dsh-repo-plugin',
        `  reviewedCommit: ${'a'.repeat(40)}`,
        '  reviewer: github:someone',
        '  reviewCommit: abc1234',
      ].join('\n') + '\n',
    })
    expect(config.verified.get('dsh-npm-plugin')?.reviewedVersion).toBe('1.2.0')
    // Lowercased: GitHub resolves repository names case-insensitively, and
    // `own.ts` already folds case on the same string.
    expect(config.verified.get('alice/dsh-repo-plugin')?.reviewedCommit).toBe('a'.repeat(40))
    expect(config.verified.get('alice/dsh-repo-plugin')?.repo).toBe('Alice/dsh-repo-plugin')
    expect(config.verified.get('dsh-repo-plugin')).toBeUndefined()
    // The bundle name still reaches the typosquatting probe set: a lookalike
    // of a reviewed name is held whichever channel published it.
    expect([...config.verifiedNames].sort()).toEqual(['dsh-npm-plugin', 'dsh-repo-plugin'])
  })

  it('throws when a github review names no repo', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: `- name: dsh-repo-plugin\n  reviewedCommit: ${'a'.repeat(40)}\n  reviewer: r\n  reviewCommit: c\n`,
    })).toThrow(/verified\.yml.*repo: owner\/slug/s)
  })

  it('throws when a release review names no repo', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: `- name: dsh-repo-plugin\n  reviewedSha256: ${'a'.repeat(64)}\n  reviewer: r\n  reviewCommit: c\n`,
    })).toThrow(/verified\.yml.*repo: owner\/slug/s)
  })

  it('throws when an npm review carries a repo', () => {
    // An npm review is pinned by the version alone; a `repo:` on it would
    // read as a github review and never match anything.
    expect(() => parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-npm-plugin\n  repo: a/b\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
    })).toThrow(/verified\.yml.*github review/s)
  })

  it('lets two repositories sharing a bundle name each hold their own review', () => {
    const config = parseRegistryConfig({
      ...empty,
      verified: [
        '- name: dsh-repo-plugin',
        '  repo: alice/dsh-repo-plugin',
        `  reviewedCommit: ${'a'.repeat(40)}`,
        '  reviewer: github:alice-reviewer',
        '  reviewCommit: abc',
        '- name: dsh-repo-plugin',
        '  repo: bob/dsh-repo-plugin',
        `  reviewedCommit: ${'b'.repeat(40)}`,
        '  reviewer: github:bob-reviewer',
        '  reviewCommit: def',
      ].join('\n') + '\n',
    })
    expect(config.verified.get('alice/dsh-repo-plugin')?.reviewer).toBe('github:alice-reviewer')
    expect(config.verified.get('bob/dsh-repo-plugin')?.reviewer).toBe('github:bob-reviewer')
  })

  it('names verified.yml when reviewedVersion is not a semver version', () => {
    // The build used to die in tier.ts with `Invalid Version:
    // one-point-two`, which names no file and no row.
    expect(() => parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-x\n  reviewedVersion: one-point-two\n  reviewer: r\n  reviewCommit: c\n',
    })).toThrow(/verified\.yml: 0\.reviewedVersion.*semver/s)
  })

  it('requires the canonical semver spelling, so an exact comparison is a semver comparison', () => {
    // `v1.2.0` and `1.2.0+build` both mean 1.2.0 to semver but are different
    // strings; tier.ts compares strings (Task 7), so the file must carry the
    // canonical form or the review would silently never match.
    for (const version of ['v1.2.0', '1.2.0+build', '1.2']) {
      expect(() => parseRegistryConfig({
        ...empty,
        verified: `- name: dsh-x\n  reviewedVersion: ${version}\n  reviewer: r\n  reviewCommit: c\n`,
      }), `verified.yml must reject ${version}`).toThrow(/verified\.yml/)
    }
    const config = parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-x\n  reviewedVersion: 1.2.0-rc.9\n  reviewer: r\n  reviewCommit: c\n',
    })
    expect(config.verified.get('dsh-x')?.reviewedVersion).toBe('1.2.0-rc.9')
  })

  it('throws when a name is both reviewed and denied instead of letting the denial win silently', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-x\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
      denied: '- name: dsh-x\n  reason: Exfiltrates credentials.\n',
    })).toThrow(/verified\.yml\/denied\.yml: dsh-x is both reviewed and denied/)
  })

  it('throws when a reviewed repository is also denied, in either case spelling', () => {
    // Both directions on purpose. The verified key is already lowercased at
    // insert, and the denied key is kept as written, so ONLY a denial spelled
    // in a different case exercises the fold on the denied side — the first
    // half of this test passes with that fold removed.
    expect(() => parseRegistryConfig({
      ...empty,
      verified: `- name: dsh-x\n  repo: Alice/dsh-x\n  reviewedCommit: ${'a'.repeat(40)}\n  reviewer: r\n  reviewCommit: c\n`,
      denied: '- name: alice/dsh-x\n  reason: known bad actor\n',
    })).toThrow(/is both reviewed and denied/)
    expect(() => parseRegistryConfig({
      ...empty,
      verified: `- name: dsh-x\n  repo: alice/dsh-x\n  reviewedCommit: ${'a'.repeat(40)}\n  reviewer: r\n  reviewCommit: c\n`,
      denied: '- name: Alice/dsh-x\n  reason: known bad actor\n',
    })).toThrow(/is both reviewed and denied/)
  })

  it('rejects a denial whose name is not a package name or an owner/slug', () => {
    // A padded, cased or newline-terminated name loads fine and then matches
    // nothing forever: the denial fails OPEN, which is the one direction a
    // denylist must never fail in.
    for (const name of ['" dsh-evil "', '"dsh evil"', '"dsh-evil\\n"', '"a/b/c"']) {
      expect(() => parseRegistryConfig({ ...empty, denied: `- name: ${name}\n  reason: Bad.\n` }),
        `denied.yml must reject ${name}`).toThrow(/denied\.yml/)
    }
  })

  it('accepts both denial forms: an npm name and a GitHub owner/slug', () => {
    const config = parseRegistryConfig({
      ...empty,
      denied: [
        '- name: dsh-evil-plugin\n  reason: Exfiltrates credentials.\n',
        '- name: "@scope/dsh-evil"\n  reason: Same code, scoped.\n',
        '- name: Someone/dsh-repo-plugin\n  reason: known bad actor\n',
      ].join(''),
    })
    expect(config.denied.get('dsh-evil-plugin')?.reason).toBe('Exfiltrates credentials.')
    expect(config.denied.get('@scope/dsh-evil')?.reason).toBe('Same code, scoped.')
    // The repo form also gets a case-folded index, because GitHub resolves
    // repository names case-insensitively and both gates read it.
    expect(config.deniedRepos.get('someone/dsh-repo-plugin')?.reason).toBe('known bad actor')
    expect(config.deniedRepos.has('dsh-evil-plugin')).toBe(false)
  })

  it('throws when two denials name the same repository in different cases', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      denied: '- name: Someone/dsh-x\n  reason: a\n- name: someone/dsh-x\n  reason: b\n',
    })).toThrow(/denied\.yml.*duplicate entry for someone\/dsh-x/s)
  })

  it('rejects a malformed allowed-similar row and indexes the repo form case-folded', () => {
    expect(() => parseRegistryConfig({ ...empty, allowedSimilar: '- " dsh-fs-tools "\n' }))
      .toThrow(/allowed-similar\.yml/)
    const config = parseRegistryConfig({ ...empty, allowedSimilar: '- dsh-fs-tools\n- Good/dsh-fs-tool\n' })
    expect(config.allowedSimilar.has('dsh-fs-tools')).toBe(true)
    expect([...config.allowedSimilarRepos]).toEqual(['good/dsh-fs-tool'])
  })

  it('rejects a review whose repo is not an owner/slug', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: `- name: dsh-x\n  repo: not-a-repo\n  reviewedCommit: ${'a'.repeat(40)}\n  reviewer: r\n  reviewCommit: c\n`,
    })).toThrow(/verified\.yml.*owner\/slug/s)
  })

  it('throws on two reviews of the same repository', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: [
        '- name: dsh-repo-plugin',
        '  repo: alice/dsh-repo-plugin',
        `  reviewedCommit: ${'a'.repeat(40)}`,
        '  reviewer: r',
        '  reviewCommit: c',
        '- name: dsh-other-name',
        '  repo: Alice/dsh-repo-plugin',
        `  reviewedCommit: ${'b'.repeat(40)}`,
        '  reviewer: r',
        '  reviewCommit: d',
      ].join('\n') + '\n',
    })).toThrow(/verified\.yml.*duplicate entry for alice\/dsh-repo-plugin/s)
  })

  it('throws on a verified entry with none of the three pins', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-hello-plugin\n  reviewer: github:someone\n  reviewCommit: abc\n',
    })).toThrow(/reviewedVersion.*reviewedCommit.*reviewedSha256/)
  })

  it('accepts a verified entry pinned by commit, keyed by the repository it covers', () => {
    const config = parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-hello-plugin\n  repo: someone/hello\n  reviewedCommit: abc123def\n  reviewer: github:someone\n  reviewCommit: abc\n',
    })
    expect(config.verified.get('someone/hello')?.reviewedCommit).toBe('abc123def')
  })

  it('accepts a verified entry pinned by tarball sha256 for a release-rescued entry', () => {
    const config = parseRegistryConfig({
      ...empty,
      verified: `- name: dsh-hello-plugin\n  repo: someone/hello\n  reviewedSha256: ${'a'.repeat(64)}\n  reviewer: github:someone\n  reviewCommit: abc\n`,
    })
    expect(config.verified.get('someone/hello')?.reviewedSha256).toBe('a'.repeat(64))
  })

  it('throws on a denied entry with no reason', () => {
    expect(() => parseRegistryConfig({ ...empty, denied: '- name: dsh-evil-plugin\n' }))
      .toThrow(/reason/)
  })

  it('throws on a denied entry whose replacement is not a string', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      denied: '- name: dsh-evil-plugin\n  reason: Bad.\n  replacement: 42\n',
    })).toThrow(/replacement/)
  })

  it('throws when a file is not a list', () => {
    expect(() => parseRegistryConfig({ ...empty, denied: 'name: x\n' })).toThrow(/list/)
  })

  it('throws on a duplicate name in verified.yml instead of silently keeping the last entry', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: `
- name: dsh-hello-plugin
  reviewedVersion: 1.0.0
  reviewer: github:someone
  reviewCommit: abc1234
- name: dsh-hello-plugin
  reviewedVersion: 2.0.0
  reviewer: github:someone-else
  reviewCommit: def5678
`,
    })).toThrow(/verified\.yml.*dsh-hello-plugin/s)
  })

  it('throws on a duplicate name in denied.yml instead of silently keeping the last entry', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      denied: `
- name: dsh-evil-plugin
  reason: Exfiltrates credentials.
- name: dsh-evil-plugin
  reason: Also does something else bad.
`,
    })).toThrow(/denied\.yml.*dsh-evil-plugin/s)
  })

  it('allows a duplicate name in allowed-similar.yml, treating it as a set', () => {
    const config = parseRegistryConfig({ ...empty, allowedSimilar: '- dsh-fs-tools\n- dsh-fs-tools\n' })
    expect(config.allowedSimilar.size).toBe(1)
  })
})

describe('parseRegistryConfig categories', () => {
  it('parses assigned categories', () => {
    const config = parseRegistryConfig({
      ...empty,
      categories: '- name: dsh-hello-plugin\n  category: tool\n- name: dsh-open-app\n  category: integration\n',
    })
    expect(config.categories.get('dsh-hello-plugin')).toBe('tool')
    expect(config.categories.get('dsh-open-app')).toBe('integration')
  })

  it('throws on an unknown category value', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      categories: '- name: dsh-hello-plugin\n  category: wizardry\n',
    })).toThrow(/categories\.yml/)
  })

  it('parses first-seen rows, including quoted scoped names', () => {
    const config = parseRegistryConfig({
      ...empty,
      firstSeen: '- name: dsh-hello-plugin\n  added: 2026-08-10\n- name: "@scope/dsh-a"\n  added: 2026-08-12\n',
    })
    expect(config.firstSeen.get('dsh-hello-plugin')).toBe('2026-08-10')
    expect(config.firstSeen.get('@scope/dsh-a')).toBe('2026-08-12')
  })

  it('throws on a duplicate name in first-seen.yml instead of silently keeping the last row', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      firstSeen: '- name: dsh-hello-plugin\n  added: 2026-08-10\n- name: dsh-hello-plugin\n  added: 2026-08-11\n',
    })).toThrow(/first-seen\.yml.*duplicate entry for dsh-hello-plugin/s)
  })

  it('throws on a malformed added date', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      firstSeen: '- name: dsh-hello-plugin\n  added: not-a-date\n',
    })).toThrow(/first-seen\.yml/)
  })

  it('throws when the file is not a list', () => {
    expect(() => parseRegistryConfig({ ...empty, firstSeen: 'name: x\n' })).toThrow(/list/)
  })

  it('throws on a duplicate name', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      categories: '- name: dsh-hello-plugin\n  category: tool\n- name: dsh-hello-plugin\n  category: ui\n',
    })).toThrow(/duplicate entry for dsh-hello-plugin/)
  })

  it('throws when the file is not a list', () => {
    expect(() => parseRegistryConfig({ ...empty, categories: 'name: x\n' })).toThrow(/list/)
  })
})

describe('serializeFirstSeen', () => {
  it('quotes every name — scoped names would break unquoted — and sorts rows by name', () => {
    const text = serializeFirstSeen(new Map([
      ['dsh-b', '2026-08-01'],
      ['@scope/dsh-a', '2026-08-02'],
    ]))
    expect(text).toBe([
      '# First catalog appearance per package name (YYYY-MM-DD). Appended by the daily build;',
      '# a name absent here is simply "first seen today".',
      '- name: "@scope/dsh-a"',
      '  added: 2026-08-02',
      '- name: "dsh-b"',
      '  added: 2026-08-01',
      '',
    ].join('\n'))
  })

  it('serializes an empty map as an empty list under the header', () => {
    expect(serializeFirstSeen(new Map())).toBe([
      '# First catalog appearance per package name (YYYY-MM-DD). Appended by the daily build;',
      '# a name absent here is simply "first seen today".',
      '[]',
      '',
    ].join('\n'))
  })

  it('round-trips through parseRegistryConfig', () => {
    const rows = new Map([['@scope/dsh-a', '2026-08-02'], ['dsh-b', '2026-08-01']])
    const config = parseRegistryConfig({ ...empty, firstSeen: serializeFirstSeen(rows) })
    expect([...config.firstSeen]).toEqual([['@scope/dsh-a', '2026-08-02'], ['dsh-b', '2026-08-01']])
  })

  it('round-trips the four hostile-name probes through serialise then parse', () => {
    // first-seen.yml receives EVERY harvested repo candidate name, gated or
    // not (build.ts), so it is the first of the two bot-written files a
    // hostile manifest name reaches. An unescaped `"` made every subsequent
    // build throw in loadRegistryConfig until a human edited the file.
    const probes = [
      'dsh-"quote',
      'dsh-a"\n  added: 2026-01-01\n- name: "dsh-victim',
      'dsh-trailing\\',
      'dsh-b" # comment',
    ]
    const rows = new Map(probes.map(name => [name, '2026-09-03']))
    const text = serializeFirstSeen(rows)
    const parsed = parse(text) as { name: string; added: string }[]
    expect(parsed).toHaveLength(4)
    expect(parsed.map(row => row.name).sort()).toEqual([...probes].sort())
    // And the loader accepts what the serialiser wrote — the property that
    // actually broke: the next build reads this file.
    const config = parseRegistryConfig({ ...empty, firstSeen: text })
    expect(config.firstSeen.size).toBe(4)
  })
})

describe('loadRegistryConfig', () => {
  it('treats a missing categories.yml as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'categories-config-'))
    try {
      for (const f of ['verified.yml', 'denied.yml', 'allowed-similar.yml']) writeFileSync(join(dir, f), '[]\n')
      const config = loadRegistryConfig(dir)
      expect(config.categories.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats a missing first-seen.yml as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'first-seen-config-'))
    try {
      for (const f of ['verified.yml', 'denied.yml', 'allowed-similar.yml']) writeFileSync(join(dir, f), '[]\n')
      const config = loadRegistryConfig(dir)
      expect(config.firstSeen.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// NPM_BACKUP_REGISTRY, the other registry input — read from the environment
// rather than from a YAML file, and validated at startup by the entry points
// that read it.
//
// A non-empty value that is not a URL is a TYPO, not a disable: silently
// treating `registry.npmmirror.com` (scheme dropped) as "no backup" would
// leave every packument fetch without the failover the 2026-08-31
// hub-borrowings design turned on by default, and nothing anywhere would say
// so. An empty (or all-whitespace) value is the documented way to turn the
// backup off, and must still be accepted.
//
// The guard shipped with no test of any kind, which is the state in which a
// fail-loud check can be deleted green. It is exercised here the only way
// that proves it actually fires — by running the entry point, as a script,
// the way production does.
//
// Two things make that safe, and both are asserted rather than assumed:
//  - the child runs in an EMPTY temp directory, so `registry/verified.yml`
//    does not exist and `loadRegistryConfig` throws ENOENT long before the
//    first network request. The accept cases below assert that ENOENT, which
//    is what makes them a positive control: without it, "did not print the
//    URL error" would also be satisfied by a child that never ran at all.
//  - credentials are stripped from the child's environment, and `timeout` +
//    SIGKILL bound it, so a future reordering that put a fetch before the
//    guard fails this file loudly instead of harvesting npm from a unit test.
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const srcDir = join(repoRoot, 'registry', 'scripts', 'src')

/** Never handed to a child: nothing here may authenticate anywhere, and
 * SHOP_HARVEST_REPOS must not flip the GitHub half on. */
const WITHHELD_FROM_CHILD = [
  'NPM_BACKUP_REGISTRY', 'NPM_TOKEN', 'GITHUB_TOKEN', 'STARS_TOKEN', 'LLM_API_KEY', 'SHOP_HARVEST_REPOS',
]

/** The modules that read NPM_BACKUP_REGISTRY out of the environment, derived
 * from the sources so a THIRD reader added later is checked without anyone
 * remembering to extend a list. */
function backupRegistryReaders(): string[] {
  return readdirSync(srcDir)
    .filter(file => file.endsWith('.ts'))
    .sort()
    .filter(file => readFileSync(join(srcDir, file), 'utf8').includes('process.env.NPM_BACKUP_REGISTRY'))
}

/** Runs one entry point as a script, in an empty directory, with
 * NPM_BACKUP_REGISTRY set to `value` (or unset when it is `undefined`). */
function runWithBackupRegistry(file: string, value: string | undefined): { status: number | null; stderr: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'backup-registry-guard-'))
  try {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const name of WITHHELD_FROM_CHILD) delete env[name]
    if (value !== undefined) env.NPM_BACKUP_REGISTRY = value
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', join(srcDir, file)],
      { cwd, env, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' },
    )
    const spawnError = result.error === undefined ? '' : `\nspawn error: ${result.error.message}`
    return { status: result.status, stderr: `${result.stderr}${spawnError}` }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe('NPM_BACKUP_REGISTRY is refused at startup when it is not a URL', () => {
  it('finds the modules that read it, so the checks below cannot pass by scanning nothing', () => {
    const readers = backupRegistryReaders()
    expect(readers).toContain('build.ts')
    expect(readers).toContain('classify.ts')
  })

  for (const file of backupRegistryReaders()) {
    it(`${file} refuses a non-URL value, and stops before it reads any input`, () => {
      // The realistic typo: the scheme dropped. URL.canParse says no.
      const run = runWithBackupRegistry(file, 'registry.npmmirror.com')
      expect(run.status, `stderr:\n${run.stderr}`).not.toBe(0)
      expect(run.stderr).toContain('NPM_BACKUP_REGISTRY is not a URL')
      // …and it stopped THERE. No registry file was read, so no ENOENT: the
      // guard is a startup check, not something a later failure happens to
      // pre-empt.
      expect(run.stderr, 'the guard must fire before the registry inputs are read').not.toContain('ENOENT')
    })

    it(`${file} accepts a URL, an all-whitespace disable, and no value at all`, () => {
      // Three values that must all get PAST the guard: the production
      // default's own URL, the documented disable (fetchWithFailover treats
      // '' and an all-whitespace value as "no backup"), and the unset case.
      for (const value of ['https://registry.npmmirror.com', '   ', undefined]) {
        const label = value === undefined ? '(unset)' : JSON.stringify(value)
        const run = runWithBackupRegistry(file, value)
        expect(run.stderr, `${label} was refused:\n${run.stderr}`).not.toContain('NPM_BACKUP_REGISTRY is not a URL')
        // The positive control: it really did run on, and died on the missing
        // registry input in the empty directory rather than never starting.
        expect(run.stderr, `${label} did not reach loadRegistryConfig:\n${run.stderr}`).toContain('ENOENT')
        expect(run.status, `${label}:\n${run.stderr}`).not.toBe(0)
      }
    })
  }
})
