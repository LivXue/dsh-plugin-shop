import { describe, expect, it } from 'vitest'
import { gateRepo } from '../src/repo-gate.ts'
import { ENTRY_PAYLOAD_MAX_BYTES, LICENSE_MAX_LENGTH, REPOSITORY_MAX_LENGTH, gate } from '../src/gate.ts'
import { parseRegistryConfig } from '../src/config.ts'
import type { RepoCandidate } from '../src/types.ts'

const config = parseRegistryConfig({
  verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
  denied: '[]',
  allowedSimilar: '[]',
  categories: '[]',
  firstSeen: '[]',
})

const commit = 'a'.repeat(40)

/** An unpaired UTF-16 surrogate; see gate.test.ts for the hazard it marks. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function repo(overrides: Partial<RepoCandidate> = {}): RepoCandidate {
  return {
    name: 'dsh-repo-plugin',
    repo: 'someone/dsh-repo-plugin',
    commit,
    version: commit,
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: 'https://github.com/someone/dsh-repo-plugin',
    license: 'MIT',
    hasBundle: true,
    requiresBuild: false,
    hasWorkspaceDeps: false,
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    description: 'A repo plugin.',
    ...overrides,
  }
}

describe('gateRepo', () => {
  it('accepts a repository with a bundle, license, and a declared catalog', () => {
    const result = gateRepo(repo(), config)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.accepted.metadata).toBe('declared')
  })

  it('rejects a repository whose manifest declares no dsh.bundle — the silent no-op install', () => {
    const result = gateRepo(repo({ hasBundle: false }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.name).toBe('someone/dsh-repo-plugin')
      expect(result.rejection.code).toBe('no-bundle')
      expect(result.rejection.detail).toContain('plain dependency')
    }
  })

  it('rejects a repository without a license', () => {
    const result = gateRepo(repo({ license: null }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('no-license')
  })

  it('rejects a requires-build repository that has no release tarball, with the old detail', () => {
    const result = gateRepo(repo({ requiresBuild: true }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('requires-build')
      expect(result.rejection.detail).toContain('prepare/prepack build script')
      expect(result.rejection.detail).toContain('Publish to npm, or drop the script')
    }
  })

  it('accepts a requires-build repository rescued by a release tarball', () => {
    const result = gateRepo(repo({
      requiresBuild: true,
      release: {
        tag: 'v1.0.0',
        url: 'https://github.com/someone/dsh-repo-plugin/releases/download/v1.0.0/plugin.tgz',
        sha256: 'a'.repeat(64),
      },
    }), config)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.accepted.repo.release?.tag).toBe('v1.0.0')
      expect(result.accepted.metadata).toBe('declared')
    }
  })

  it('derives a listing from the repo description when no dsh.catalog is declared', () => {
    const result = gateRepo(repo({ catalog: null, description: 'Derives from the description.' }), config)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.accepted.metadata).toBe('derived')
      expect(result.accepted.catalog.summary.en).toBe('Derives from the description.')
    }
  })

  it('never splits a surrogate pair when capping a derived summary', () => {
    // The same defect as gate.ts's, in the twin call site. A repo description
    // is GitHub-supplied free text and lands in the same published
    // plugins.json; see the gate.test.ts case for the end-to-end measurement.
    const result = gateRepo(repo({ catalog: null, description: `${'a'.repeat(199)}\u{1F600}tail` }), config)
    if (!result.ok) throw new Error('expected acceptance')
    const en = result.accepted.catalog.summary.en
    expect(en).toMatch(/^a{199}$/)
    expect(LONE_SURROGATE.test(en)).toBe(false)
  })

  it('keeps an astral character that ends exactly at the cap', () => {
    const result = gateRepo(repo({ catalog: null, description: `${'a'.repeat(198)}\u{1F600}tail` }), config)
    if (!result.ok) throw new Error('expected acceptance')
    const en = result.accepted.catalog.summary.en
    expect(en.length).toBe(200)
    expect(en.endsWith('\u{1F600}')).toBe(true)
    expect(LONE_SURROGATE.test(en)).toBe(false)
  })

  it('rejects a repository with neither a catalog nor a description', () => {
    const result = gateRepo(repo({ catalog: null, description: null }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('no-summary')
  })

  it('rejects a malformed declared catalog, never downgrading to derived', () => {
    const result = gateRepo(repo({ catalog: { category: 'not-a-category' } }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('invalid-catalog')
  })

  it('denies by repo identity and by bundle name, preferring the repo as the key', () => {
    const denied = parseRegistryConfig({
      verified: '[]',
      denied: '- name: someone/dsh-repo-plugin\n  reason: known bad actor\n- name: dsh-denied-name\n  reason: bundle name denied\n',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    const byRepo = gateRepo(repo(), denied)
    expect(byRepo.ok).toBe(false)
    if (!byRepo.ok) {
      expect(byRepo.rejection.name).toBe('someone/dsh-repo-plugin')
      expect(byRepo.rejection.detail).toBe('Denied by the registry: known bad actor')
      expect(byRepo.rejection.replacement).toBeUndefined()
    }
    const byName = gateRepo(repo({ repo: 'other/dsh-denied-name', name: 'dsh-denied-name' }), denied)
    expect(byName.ok).toBe(false)
    if (!byName.ok) {
      expect(byName.rejection.code).toBe('denied')
      expect(byName.rejection.detail).toBe('Denied by the registry: bundle name denied')
      expect(byName.rejection.replacement).toBeUndefined()
    }
  })

  it('names the recorded replacement in the detail of a denial by repo or by bundle name', () => {
    const denied = parseRegistryConfig({
      verified: '[]',
      denied: '- name: someone/dsh-repo-plugin\n  reason: known bad actor.\n  replacement: dsh-good-plugin\n- name: dsh-denied-name\n  reason: bundle name denied.\n  replacement: dsh-good-plugin\n',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    const byRepo = gateRepo(repo(), denied)
    expect(byRepo.ok).toBe(false)
    if (!byRepo.ok) {
      expect(byRepo.rejection.code).toBe('denied')
      expect(byRepo.rejection.detail)
        .toBe('Denied by the registry: known bad actor. Known replacement: dsh-good-plugin.')
      expect(byRepo.rejection.replacement).toBe('dsh-good-plugin')
    }
    const byName = gateRepo(repo({ repo: 'other/dsh-denied-name', name: 'dsh-denied-name' }), denied)
    expect(byName.ok).toBe(false)
    if (!byName.ok) {
      expect(byName.rejection.code).toBe('denied')
      expect(byName.rejection.detail)
        .toBe('Denied by the registry: bundle name denied. Known replacement: dsh-good-plugin.')
      expect(byName.rejection.replacement).toBe('dsh-good-plugin')
    }
  })

  it('holds a lookalike slug AND a lookalike bundle name for adjudication', () => {
    const bySlug = gateRepo(repo({ repo: 'someone/dsh-fs-tol', name: 'something-else' }), config)
    expect(bySlug.ok).toBe(false)
    if (!bySlug.ok) expect(bySlug.rejection.code).toBe('name-too-similar')
    const byName = gateRepo(repo({ repo: 'someone/original', name: 'dsh-fs-too1' }), config)
    expect(byName.ok).toBe(false)
    if (!byName.ok) expect(byName.rejection.code).toBe('name-too-similar')
  })
})

describe('workspace-deps and subpackage units', () => {
  it('rejects a manifest with workspace:-protocol dependencies, naming the exit', () => {
    const result = gateRepo(repo({ hasWorkspaceDeps: true }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('workspace-deps')
      expect(result.rejection.detail).toContain('Publish the package to npm')
    }
  })

  it('names a subpackage rejection by repo#subdir — the unit an author fixes', () => {
    const result = gateRepo(repo({ subdir: 'packages/plugin', license: null }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.name).toBe('someone/dsh-repo-plugin#packages/plugin')
      expect(result.rejection.code).toBe('no-license')
    }
  })
})

describe('the shop excludes its own repository', () => {
  // Today this repository is caught by `workspace-deps` — the shop's own
  // package.json carries workspace: specifiers — but that is an accident of
  // how the monorepo is wired, not a decision. Drop the workspace dep and the
  // shop would list itself. And once the npm gate excludes the published
  // package by name, pipeline.ts no longer records it in `npmNames`, so the
  // repository stops being shadowed and reaches this gate on its own.

  it('rejects its own repository whatever else the manifest says', () => {
    const result = gateRepo(repo({
      name: 'dsh-plugin-shop',
      repo: 'LivXue/dsh-plugin-shop',
      repository: 'https://github.com/LivXue/dsh-plugin-shop',
      hasWorkspaceDeps: false,
      requiresBuild: false,
    }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('self')
  })

  it('matches the owner too, so a same-named repository elsewhere is judged normally', () => {
    const result = gateRepo(repo({
      name: 'dsh-plugin-shop',
      repo: 'someone-else/dsh-plugin-shop',
      repository: 'https://github.com/someone-else/dsh-plugin-shop',
    }), config)
    expect(result.ok, 'another owner is not us').toBe(true)
  })
})

describe('the bounds the two channels share', () => {
  // `license` and `repository` are the same two published fields on both
  // channels, and only the npm gate bounded them. Low risk today — a repo
  // license is GitHub's `license.spdx_id` (live maximum 37) and `repository`
  // is built from `meta.fullName` (live maximum 108) — but an API shape change
  // is precisely what a bound exists for, and a field bounded on one channel
  // and not the other is a hole with a published name on it.

  /** The npm candidate the same over-long value would arrive on, so the two
   * details can be compared rather than transcribed. */
  const npmConfig = parseRegistryConfig({
    verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]', firstSeen: '[]',
  })
  const npmCandidate = (overrides: Partial<import('../src/types.ts').Candidate>) => ({
    name: 'dsh-hello-plugin',
    version: '1.0.0',
    integrity: 'sha512-abc',
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: 'https://github.com/you/hello-plugin',
    license: 'MIT',
    deprecated: false,
    hasBundle: true,
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    description: 'A plugin.',
    keywords: [],
    peers: [],
    ...overrides,
  })

  it("rejects an over-long license with the reason npm's gate gives, word for word", () => {
    const license = 'M'.repeat(LICENSE_MAX_LENGTH + 1)
    const result = gateRepo(repo({ license }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('no-license')
    expect(result.rejection.detail).toBe(
      'Declares a license string longer than 128 characters, so it is not an SPDX identifier.')
    // The claim itself: an author reads the same sentence whichever channel
    // their listing came from. Compared rather than transcribed, so the two
    // cannot drift apart without this failing.
    const npm = gate(npmCandidate({ license }), npmConfig)
    expect(npm.ok).toBe(false)
    if (npm.ok) return
    expect(result.rejection.detail).toBe(npm.rejection.detail)
  })

  it("rejects an over-long repository URL with the reason npm's gate gives, word for word", () => {
    const repository = `https://github.com/you/${'x'.repeat(REPOSITORY_MAX_LENGTH)}`
    const result = gateRepo(repo({ repository }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('no-repository')
    expect(result.rejection.detail).toBe(
      'Declares a repository URL longer than 512 characters, so it cannot be audited as a source location.')
    const npm = gate(npmCandidate({ repository }), npmConfig)
    expect(npm.ok).toBe(false)
    if (npm.ok) return
    expect(result.rejection.detail).toBe(npm.rejection.detail)
  })

  it('accepts a license and a repository exactly at the bounds', () => {
    expect(gateRepo(repo({ license: 'M'.repeat(LICENSE_MAX_LENGTH) }), config).ok, 'license').toBe(true)
    expect(gateRepo(repo({ repository: `https://h/${'x'.repeat(REPOSITORY_MAX_LENGTH - 10)}` }), config).ok, 'repository').toBe(true)
  })

  it('names the rejection by the unit an author fixes, not by the bundle name', () => {
    // The repo gate keys every rejection on `owner/slug`; the two new bounds
    // must not be the ones that key on something else.
    const result = gateRepo(repo({ license: 'M'.repeat(LICENSE_MAX_LENGTH + 1) }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.name).toBe('someone/dsh-repo-plugin')
  })
})

describe('the per-entry size budget on the github channel', () => {
  // A repo entry carries no `peers`, so the budget is not where its weight is
  // today — but a release-rescued entry publishes `tarball.url` straight from
  // the GitHub releases API, and that string is bounded nowhere else. The
  // budget is the backstop for it and for whatever field an entry grows next.

  it('rejects a repo entry whose published payload is past the budget', () => {
    const result = gateRepo(repo({
      requiresBuild: true,
      release: {
        tag: 'v1.0.0',
        url: `https://github.com/someone/dsh-repo-plugin/releases/download/v1.0.0/${'u'.repeat(20_000)}.tgz`,
        sha256: 'a'.repeat(64),
      },
    }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('no-manifest')
    expect(result.rejection.detail).toContain(`past the ${ENTRY_PAYLOAD_MAX_BYTES}-byte budget`)
    expect(result.rejection.name).toBe('someone/dsh-repo-plugin')
  })

  it('accepts the worst repo entry the live catalog could hold', () => {
    // Every maximum measured against the live catalog on 2026-09-04, in one
    // entry: repository 108, license 37, both summaries 200 CJK characters
    // (599 UTF-8 bytes each), 20 capabilities of 14. A github entry has no
    // peers and no publisher, so this is the whole of its weight — about
    // 2.5 KiB against a 12,288-byte budget.
    const summary = `${'中'.repeat(199)}x`
    const result = gateRepo(repo({
      repository: `https://github.com/an-organization/${'r'.repeat(73)}`,
      license: 'l'.repeat(37),
      catalog: {
        category: 'tool',
        summary: { en: summary, zh: summary },
        capabilities: Array.from({ length: 20 }, () => 'c'.repeat(14)),
      },
    }), config)
    expect(result.ok).toBe(true)
  })
})

describe('the hold and the reviewed identity', () => {
  const commitPin = 'b'.repeat(40)
  const reviewed = parseRegistryConfig({
    verified: [
      '- name: dsh-repo-plugin',
      '  repo: someone/dsh-repo-plugin',
      `  reviewedCommit: ${commitPin}`,
      '  reviewer: github:alice-reviewer',
      '  reviewCommit: abc',
      '  notes: fine',
    ].join('\n') + '\n',
    denied: '[]',
    allowedSimilar: '[]',
    categories: '[]',
    firstSeen: '[]',
  })

  it('lists the repository the review names instead of rejecting it as an impersonator of itself', () => {
    // B-2: edits === 0 on the slug used to make the reviewed repo the "most
    // dangerous lookalike" of the review written about it, and the pipeline
    // listed nothing at all.
    const result = gateRepo(repo(), reviewed)
    expect(result.ok, result.ok ? '' : result.rejection.detail).toBe(true)
    // And whatever case the candidate spells the repository in. The review
    // key is lowercased at insert, so ONLY the fold on the candidate side
    // makes these meet; without it the reviewed repository falls into the
    // hold loop and is held as an exact match of its own bundle name. Task 6
    // folds the denial lookup and the probes, but not this exemption.
    const cased = gateRepo(repo({ repo: 'Someone/dsh-repo-plugin' }), reviewed)
    expect(cased.ok, cased.ok ? '' : cased.rejection.detail).toBe(true)
  })

  it('still holds a different repository carrying the reviewed bundle name', () => {
    // B-3 / A-4: this is the fork. It must not reach the catalog on the
    // strength of somebody else's review.
    const fork = gateRepo(repo({ repo: 'bob/dsh-repo-plugin' }), reviewed)
    expect(fork.ok).toBe(false)
    if (!fork.ok) {
      expect(fork.rejection.name).toBe('bob/dsh-repo-plugin')
      expect(fork.rejection.code).toBe('name-too-similar')
      expect(fork.rejection.detail).toContain('dsh-repo-plugin')
    }
  })

  it('clears a lookalike source by owner/slug and never by bundle name', () => {
    // A bundle-name clearance would clear every repository using the name —
    // 83 live bundle names are claimed by both a fork and an original.
    const byRepo = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
      denied: '[]',
      allowedSimilar: '- good/dsh-fs-tol\n',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(gateRepo(repo({ repo: 'good/dsh-fs-tol', name: 'something-else' }), byRepo).ok).toBe(true)
    expect(gateRepo(repo({ repo: 'evil/dsh-fs-tol', name: 'something-else' }), byRepo).ok).toBe(false)

    const byName = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
      denied: '[]',
      allowedSimilar: '- dsh-fs-tol\n',
      categories: '[]',
      firstSeen: '[]',
    })
    const held = gateRepo(repo({ repo: 'anyone/dsh-fs-tol', name: 'something-else' }), byName)
    expect(held.ok, 'a bundle-name clearance must not clear a repository').toBe(false)
  })

  it('exempts every subpackage of the reviewed repository, since the clearance unit is the repo', () => {
    const sub = gateRepo(repo({ subdir: 'packages/plugin' }), reviewed)
    expect(sub.ok, sub.ok ? '' : sub.rejection.detail).toBe(true)
  })
})

describe('case folding on the GitHub channel', () => {
  it('matches a repo denial whatever case the repository is spelled in', () => {
    // GitHub resolves repository names case-insensitively, so `Someone/x` and
    // `someone/x` are one repository — and a denial that misses one of the
    // two spellings fails open.
    const denied = parseRegistryConfig({
      verified: '[]',
      denied: '- name: someone/dsh-repo-plugin\n  reason: known bad actor\n',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    const result = gateRepo(repo({ repo: 'Someone/dsh-repo-plugin' }), denied)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('denied')
      expect(result.rejection.detail).toBe('Denied by the registry: known bad actor')
    }
  })

  it('holds an uppercase bundle name that folds onto a verified name', () => {
    // Plain Levenshtein puts DSH-FS-TOOL nine edits from dsh-fs-tool — one
    // per changed letter — so the hold never saw it.
    const result = gateRepo(repo({ repo: 'someone/anything', name: 'DSH-FS-TOOL' }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('name-too-similar')
  })

  it('holds an uppercase slug that folds onto a verified name', () => {
    const result = gateRepo(repo({ repo: 'someone/DSH-FS-TOOL', name: 'something-else' }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('name-too-similar')
  })

  it('holds a lowercase lookalike of a verified name that is itself uppercase', () => {
    // The fold is needed on the VERIFIED side too, not just the probe. npm
    // still serves legacy uppercase names and Task 3's grammar admits them on
    // purpose, so a review can name `DSH-Legacy` — and `dsh-legacy` sits four
    // substitutions away from it unfolded, clear of a threshold of 2.
    const upper = parseRegistryConfig({
      verified: '- name: DSH-Legacy\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
      denied: '[]',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    const result = gateRepo(repo({ repo: 'someone/dsh-legacy', name: 'something-else' }), upper)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('name-too-similar')
  })
})

describe('the no-bundle detail names the file the author must fix', () => {
  it('tells a plain package to declare dsh.bundle in its package.json', () => {
    const result = gateRepo(repo({ hasBundle: false }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('no-bundle')
      expect(result.rejection.detail).toContain('plain dependency')
      expect(result.rejection.detail).not.toContain('subpackage')
    }
  })

  it('tells a probed monorepo root that no subpackage declared one either', () => {
    // hub-borrowings §A: the root keeps the `no-bundle` code, but the detail
    // has to say a probe happened — otherwise the author of a monorepo whose
    // subpackage is the plugin is told to edit the root manifest.
    const result = gateRepo(repo({ hasBundle: false, probedSubpackages: 6 }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('no-bundle')
      expect(result.rejection.detail).toContain('6 subpackage')
      expect(result.rejection.detail).toContain('none of them declares dsh.bundle')
    }
  })
})

describe('workspace deps and the release rescue', () => {
  it('still rejects a git-installed repository with workspace: dependencies', () => {
    const result = gateRepo(repo({ hasWorkspaceDeps: true }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('workspace-deps')
      expect(result.rejection.detail).toContain('a git install from outside it cannot succeed')
      // All three exits, because the tarball one is the point of this change:
      // an author reads this string to find out what to do, and a clause
      // nothing asserts can be dropped without a test noticing.
      expect(result.rejection.detail).toContain('Publish the package to npm')
      expect(result.rejection.detail).toContain('attach a packed release tarball')
      expect(result.rejection.detail).toContain('drop the workspace: specifiers')
    }
  })

  it('accepts a release-rescued repository whose SOURCE manifest has workspace: deps', () => {
    // B-11, reproduced 2026-09-04 with pnpm 11.13.0: `pnpm pack` rewrites
    // `workspace:^1.0.0` to `^1.0.0` in the packed manifest, and a
    // release-rescued entry installs that tarball, never the git ref. The old
    // rejection told the author a git install would fail — for an entry that
    // performs no git install. The rescue reads assets[].browser_download_url
    // only (tarball_url and zipball_url appear nowhere), so the artifact is
    // pack output rather than GitHub's source snapshot, which is what makes
    // the rewrite apply. A sibling that is genuinely unpublished is still an
    // honest install-time failure the executor reports verbatim, which is the
    // same posture the github-channel design takes for transitive postinstall
    // scripts (§4, item 2b).
    const result = gateRepo(repo({
      hasWorkspaceDeps: true,
      release: {
        tag: 'v1.0.0',
        url: 'https://github.com/someone/dsh-repo-plugin/releases/download/v1.0.0/plugin.tgz',
        sha256: 'a'.repeat(64),
      },
    }), config)
    expect(result.ok, result.ok ? '' : result.rejection.detail).toBe(true)
  })
})
