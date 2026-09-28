import { describe, expect, it } from 'vitest'
import { asPluginManager, forDesktopReader, managerOutcome, type ManagerChange, type OutcomeContext } from '../../src/host/plugin-manager.ts'

const fn = async (): Promise<unknown> => ({})
const complete = { installBundle: fn, removeBundle: fn, setPluginEnabled: fn, setBundleEnabled: fn, cancelInstall: fn }

describe('asPluginManager', () => {
  it('takes a service that offers every operation the shop calls', () => {
    expect(asPluginManager(complete)).toBe(complete)
  })

  it('refuses a service missing any one of the four operations', () => {
    // A harness offering half the service would take an install through it
    // and then fail the uninstall; all or nothing is the rule.
    for (const method of ['installBundle', 'removeBundle', 'setPluginEnabled', 'setBundleEnabled'] as const) {
      const partial: Record<string, unknown> = { ...complete }
      delete partial[method]
      expect(asPluginManager(partial), method).toBeNull()
    }
  })

  it('takes a service without cancelInstall, which only the deadline uses', () => {
    const { cancelInstall: _unused, ...rest } = complete
    expect(asPluginManager(rest)).not.toBeNull()
  })

  it('refuses a service whose cancelInstall is present but not a function', () => {
    expect(asPluginManager({ ...complete, cancelInstall: 'nope' })).toBeNull()
  })

  it('refuses what is not a service at all', () => {
    expect(asPluginManager(undefined)).toBeNull()
    expect(asPluginManager(null)).toBeNull()
    expect(asPluginManager('pluginManager')).toBeNull()
  })
})

const context: OutcomeContext = {
  profile: 'web', name: 'dsh-managed', operation: 'install',
  alreadyImported: false, hasClientHalf: false, desktop: false, timeoutMs: 900_000,
}
const desktop: OutcomeContext = { ...context, profile: 'desktop', desktop: true }
const applied = { changed: true, application: 'applied', stage: 'enable', target: 'dsh-managed', enabled: true, bundle: 'dsh-managed', registries: [null], warnings: [] }
// Measured (Global Constraint): a real restart-required answer carries no
// `warnings` key at all, so this is declared beside `applied` rather than
// spread from it.
const restartRequired = { changed: true, application: 'restart-required', stage: 'enable', target: 'dsh-managed', enabled: true, bundle: 'dsh-managed', registries: [null] }
const refused = {
  changed: false, application: 'failed', stage: 'install', target: 'dsh-managed@1.0.0', enabled: true, registries: [null],
  error: { code: 'incompatible-version', incompatible: [{ name: 'dsh-managed', version: '1.0.0', runtimeVersion: '0.1.7-rc.2', peers: { '@deepseek-ai/dsh': '0.1.2-rc.1' } }] },
  packageResult: { exitCode: 1, output: '', truncated: false, logPath: '/l', kind: 'unknown' },
}
// A failed pnpm run as dsh 0.1.7-rc.2 answers it: runPnpm classifies the
// run's `kind`, then installBundle and removeBundle throw its output as a
// plain Error, which managementError codes `operation-error` with that whole
// output as the diagnostic (dsh-plugin-manager lib/index.js :1776, :1858,
// :1108).
const pnpmFailed = (kind: string, output: string, extra: object = {}) => ({
  changed: false, application: 'failed', stage: 'install', target: 'dsh-managed@1.0.0', registries: [null], ...extra,
  error: { code: 'operation-error', diagnostic: output },
  packageResult: { exitCode: 1, output, truncated: false, logPath: '/l', kind },
})
// The same failure in a removal, whose answer removeBundle builds from
// `{ stage: 'remove', target }` alone: no registries and no failedAt.
const removalFailed = (kind: string, output: string, extra: object = {}) => ({
  changed: false, application: 'failed', stage: 'remove', target: 'dsh-managed', ...extra,
  error: { code: 'operation-error', diagnostic: output },
  packageResult: { exitCode: 1, output, truncated: false, logPath: '/l', kind },
})

// dsh-app-boot 0.1.7-rc.2's pluginCompatibilityWarning, verbatim for a
// package pinning `@deepseek-ai/dsh` 0.1.2-rc.1: it names the
// `dsh plugin allow-version` command.
const warningFor = (name: string): string => `Plugin ${name}@1.0.0 is incompatible with dsh 0.1.7-rc.2: peerDependencies {"@deepseek-ai/dsh":"0.1.2-rc.1"}.`
  + ' Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime.'
  + ` To accept this risk explicitly, grant the exact-version exemption for ${name}@1.0.0 on dsh 0.1.7-rc.2 with \`dsh plugin allow-version\``
  + ' or the plugin manager, then retry the installation or restart dsh. Exact-version exemption: not active.'
/** dsh's refusal block (dsh-plugin-manager's `rejected`, lib/index.js:486):
 * the refused packages, then one line saying what it restored. */
const rejectedWith = (warning: string, restoration: string): string => `\ndsh: installation rejected: ${warning}\ndsh: ${restoration}.\n`
// dsh's two restoration lines after its post-install check (:644-668); its
// pre-check says `nothing was installed` (:514). The failed repair's line
// names `dsh plugin install`.
const REPAIRED = 'restored package.json, pnpm-lock.yaml, and node_modules'
const NOT_REPAIRED = "restored package.json and pnpm-lock.yaml, but node_modules could not be reinstalled; run 'dsh plugin install'"
const rejection = rejectedWith(warningFor('dsh-sibling'), NOT_REPAIRED)
// A `pnpm remove` whose output dsh's scan refused over a sibling it touched:
// pnpm's own lines, then the refusal block. The run keeps the structured
// list the scan rejected, and its `kind` is `unknown`, the class dsh gives a
// log no pattern matches. `changed` is true when dsh had switched an enabled
// bundle off before pnpm ran, which leaves a `warnings` list beside it.
const removalRejected = (restoration: string, changed = false) => {
  const output = `Packages: -1\n-\n\ndependencies:\n- dsh-managed 1.0.0\n${rejectedWith(warningFor('dsh-sibling'), restoration)}`
  return {
    changed, application: 'failed', stage: 'remove', target: 'dsh-managed', ...(changed ? { warnings: [] } : {}),
    error: { code: 'operation-error', diagnostic: output },
    packageResult: {
      exitCode: 1, output, truncated: false, logPath: '/l', kind: 'unknown',
      incompatible: [{ name: 'dsh-sibling', version: '1.0.0', runtimeVersion: '0.1.7-rc.2', peers: { '@deepseek-ai/dsh': '0.1.2-rc.1' } }],
    },
  }
}
const uninstall: OutcomeContext = { ...context, operation: 'uninstall' }

describe('managerOutcome', () => {
  it('builds the refusal from the structured list, with the exemption command', () => {
    // Rule 1. Nothing is parsed: the list is dsh's own record.
    const outcome = managerOutcome(refused, context)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('@deepseek-ai/dsh 0.1.2-rc.1')
    expect(outcome.detail).toContain('dsh plugin --profile web allow-version dsh-managed@1.0.0 --dsh-version 0.1.7-rc.2 --accept-risk')
  })

  it("reads an install's version refusal on web word for word, and says nothing was installed when dsh's output is empty", () => {
    expect(managerOutcome(refused, context).detail).toBe(
      'dsh-plugin-shop: dsh refused the install: dsh-managed@1.0.0 declares @deepseek-ai/dsh 0.1.2-rc.1, which dsh 0.1.7-rc.2 does not satisfy.'
      + ' Nothing was installed. To accept the risk of crashes or data loss for this exact version,'
      + ' run: dsh plugin --profile web allow-version dsh-managed@1.0.0 --dsh-version 0.1.7-rc.2 --accept-risk - then install again.')
  })

  // R28: dsh keeps only the last 16 KB of a pnpm run's output, so a long
  // refusal block can lose its opener; a truncated output must not be read
  // as proof that nothing happened.
  it('says nothing about restoration when a truncated output could have said anything', () => {
    const cut = { ...refused, packageResult: { ...refused.packageResult, truncated: true } }
    expect(managerOutcome(cut, context).detail).not.toContain('Nothing was')
  })

  it("passes on dsh's own pre-check words once, never beside the shop's", () => {
    // dsh's pre-check refuses before pnpm runs and says so itself (:514).
    const precheck = rejectedWith(warningFor('dsh-managed'), 'nothing was installed')
    const answer = { ...refused, packageResult: { exitCode: 1, output: precheck, truncated: false, logPath: '/l', kind: 'unknown', incompatible: refused.error.incompatible } }
    const detail = managerOutcome(answer, context).detail ?? ''
    expect(detail.match(/Nothing was installed\./g)).toHaveLength(1)
  })

  it('tells a desktop reader the exemption cannot be granted here, and prints no command', () => {
    const detail = managerOutcome(refused, desktop).detail ?? ''
    expect(detail).toContain('@deepseek-ai/dsh 0.1.2-rc.1')
    expect(detail).not.toContain('dsh plugin')
    expect(detail).toMatch(/does not manage the desktop profile/)
  })

  it('never reports an enablement failure after pnpm succeeded as a done install', () => {
    // Rule 2, the confusion dsh-market reported as a bug (fa8722a).
    const outcome = managerOutcome({ ...applied, application: 'failed', error: { code: 'operation-error', diagnostic: 'duplicate entry id' }, packageResult: { exitCode: 0, output: '', truncated: false, logPath: '/l' } }, context)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toMatch(/is installed, but dsh could not enable it/)
    expect(outcome.detail).toContain('duplicate entry id')
    expect(outcome.detail).toContain('dsh reported: duplicate entry id. Uninstall it from the shop')
    expect(outcome.detail).toMatch(/Uninstall it from the shop/)
  })

  it('names the builds pnpm is holding, and the approval step, for build-blocked', () => {
    const outcome = managerOutcome(pnpmFailed('build-blocked', 'ERR_PNPM_IGNORED_BUILDS', { pendingBuilds: ['esbuild'] }), context)
    expect(outcome.detail).toContain('esbuild')
    expect(outcome.detail).toContain('approve-builds')
  })

  it('reads an unknown failure through installFailureDetail, where the pnpm 12 hint lives', () => {
    const outcome = managerOutcome(pnpmFailed('unknown', 'memory allocation of 671088640 bytes failed\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace'), context)
    expect(outcome.detail).toContain('pnpm/pnpm#15362')
  })

  it('reads an unknown failure for a desktop reader without the CLI command', () => {
    const detail = managerOutcome(pnpmFailed('unknown', 'ERR_PNPM_SOMETHING went wrong'), desktop).detail ?? ''
    expect(detail).toContain('ERR_PNPM_SOMETHING went wrong')
    expect(detail).not.toContain('dsh plugin')
    // Rule 3's excerpt, never rule 4's `dsh reported:` over the whole output.
    expect(detail).not.toContain('dsh reported')
  })

  it('says what a classified failure was and where', () => {
    expect(managerOutcome(pnpmFailed('not-found', 'ERR_PNPM_FETCH_404', { failedAt: 'registry' }), context).detail)
      .toBe('dsh-plugin-shop: the install failed at the registry: no such package was found.')
    expect(managerOutcome(pnpmFailed('network', 'ENOTFOUND', { failedAt: 'spec-host' }), context).detail)
      .toBe('dsh-plugin-shop: the install failed at the host the package is fetched from: the network failed.')
    expect(managerOutcome(pnpmFailed('disk-full', 'ENOSPC'), context).detail)
      .toBe('dsh-plugin-shop: the install failed: the disk is full.')
    // R40: for a GitHub repository dsh runs `git ls-remote` before pnpm,
    // bounded at 5 s by default, and a timeout there answers failedAt
    // `spec-host` with the check's own log as the output. pnpm's own timeouts
    // never carry failedAt (dsh-plugin-manager 0.1.7-rc.2, installBundle).
    const repositoryCheck = { failedAt: 'spec-host', registries: [], target: `github:someone/dsh-managed#${'e'.repeat(40)}` }
    expect(managerOutcome(pnpmFailed('timeout', 'dsh: connection to github.com timed out after 5000ms\n', repositoryCheck), context).detail)
      .toBe('dsh-plugin-shop: the install failed at the host the package is fetched from: dsh checks that a GitHub repository is reachable'
        + ' before pnpm runs, and that check did not finish within its bound (5 s by default), so pnpm never ran.')
    expect(managerOutcome(pnpmFailed('timeout', 'Progress: resolved 1\n'), context).detail)
      .toBe("dsh-plugin-shop: the install failed: pnpm did not finish within dsh's own time bound.")
  })

  // What pnpm printed for the web e2e's 404 through dsh 0.1.7-rc.2 on
  // 2026-09-27, the lines that name it.
  const registry404 = '[ERR_PNPM_FETCH_404] GET http://127.0.0.1:46237/dsh-e2e-fixture-plugin: Not Found - 404\n'
    + 'dsh-e2e-fixture-plugin is not in the npm registry, or you have no permission to fetch it.\n'

  it("reads dsh's answer to a registry 404 as the sentence for it, and embeds none of its output", () => {
    expect(managerOutcome(pnpmFailed('not-found', registry404, { failedAt: 'registry' }), context))
      .toEqual({ state: 'failed', detail: 'dsh-plugin-shop: the install failed at the registry: no such package was found.' })
  })

  it('names the operation that failed: a removal pnpm was not permitted', () => {
    const removal = removalFailed('permission', "EACCES: permission denied, unlink '/home/u/.dsh/profiles/web/node_modules/dsh-managed/index.js'")
    expect(managerOutcome(removal, uninstall).detail).toBe('dsh-plugin-shop: the uninstall failed: permission was denied.')
  })

  it("says an update found no version matching the one it asked for, not the catalog's", () => {
    // R42.9: an update of the shop itself takes its version from npm's
    // dist-tags (updateStart), not from the catalog.
    expect(managerOutcome(pnpmFailed('no-matching-version', 'ERR_PNPM_NO_MATCHING_VERSION', { failedAt: 'registry' }), { ...context, operation: 'update' }).detail)
      .toBe('dsh-plugin-shop: the update failed at the registry: no version matching the requested one was found.')
  })

  // R42.10: the app bundles its own package manager, so `pnpm approve-builds`
  // is no step for a desktop reader. dsh's own Plugins page offers "Allow
  // these scripts and retry" on the failed screen of an install it runs
  // (dsh-client-ui-plugin-manager 0.1.7-rc.2: lib/client.js, and its README),
  // so the detail names it, but only for an install whose held builds dsh
  // listed: that page's Add plugin dialog refuses a name already installed,
  // so it cannot rerun an update, and with no name listed it offers no such
  // button.
  it("names dsh's Plugins page to a desktop reader whose install pnpm held on build scripts, and no pnpm command", () => {
    const held = pnpmFailed('build-blocked', 'ERR_PNPM_IGNORED_BUILDS', { pendingBuilds: ['esbuild'] })
    expect(managerOutcome(held, desktop).detail).toBe(
      'dsh-plugin-shop: pnpm is holding the build scripts of esbuild, which it blocks by default, and this shop never allows them.'
      + ' dsh\'s Plugins page offers "Allow these scripts and retry" when an install it runs stops on them.')
    expect(managerOutcome(held, { ...desktop, operation: 'update' }).detail).toBe(
      'dsh-plugin-shop: pnpm is holding the build scripts of esbuild, which it blocks by default, and this shop never allows them.')
    expect(managerOutcome(pnpmFailed('build-blocked', 'ERR_PNPM_IGNORED_BUILDS'), desktop).detail).toBe(
      'dsh-plugin-shop: pnpm is holding the build scripts of a dependency, which it blocks by default, and this shop never allows them.')
  })

  it('tells an update held on build scripts to update again, not to install again', () => {
    const outcome = managerOutcome(pnpmFailed('build-blocked', 'ERR_PNPM_IGNORED_BUILDS', { pendingBuilds: ['esbuild'] }), { ...context, operation: 'update' })
    expect(outcome.detail).toBe('dsh-plugin-shop: pnpm is holding the build scripts of esbuild, which it blocks by default:'
      + ' run `pnpm approve-builds` in the profile directory to allow them, then update again.')
  })

  it('reads a pnpm failure the same way when dsh does not wrap it in an error, as a later harness may not', () => {
    const { error: _wrapped, ...unwrapped } = pnpmFailed('not-found', registry404, { failedAt: 'registry' })
    expect(managerOutcome(unwrapped, context).detail).toBe('dsh-plugin-shop: the install failed at the registry: no such package was found.')
  })

  it('reads a failed answer with neither an error code nor a kind as one it cannot read', () => {
    expect(managerOutcome({ changed: false, application: 'failed', stage: 'install', target: 'dsh-managed@1.0.0', registries: [null] }, context).detail)
      .toBe('dsh-plugin-shop: dsh answered the install with "failed", which this shop does not know how to read.')
  })

  it('carries a management code with the sentence dsh source gives it, and dsh diagnostic', () => {
    const outcome = managerOutcome({ changed: false, application: 'failed', stage: 'remove', target: 'dsh-managed', error: { code: 'bundle-in-use', diagnostic: 'still mounted' } }, { ...context, operation: 'uninstall' })
    expect(outcome.detail).toBe('dsh-plugin-shop: dsh refused the uninstall of dsh-managed (bundle-in-use): the bundle was switched off, but some of its plugins are still running. dsh reported: still mounted.')
  })

  it('strips one trailing period from the diagnostic rather than doubling it', () => {
    const outcome = managerOutcome({ changed: false, application: 'failed', stage: 'remove', target: 'dsh-managed', error: { code: 'bundle-in-use', diagnostic: 'still mounted.' } }, { ...context, operation: 'uninstall' })
    expect(outcome.detail).toBe('dsh-plugin-shop: dsh refused the uninstall of dsh-managed (bundle-in-use): the bundle was switched off, but some of its plugins are still running. dsh reported: still mounted.')
  })

  it('says dsh could not, rather than that it refused, for the code of an unexpected error', () => {
    // R42.11: `operation-error` is what dsh codes any error that is not one
    // of its refusals (managementError), so "refused" misnamed it.
    const outcome = managerOutcome({ changed: false, application: 'failed', stage: 'remove', target: 'dsh-managed', error: { code: 'operation-error', diagnostic: 'EBUSY: node_modules' } }, uninstall)
    expect(outcome.detail).toBe('dsh-plugin-shop: dsh could not uninstall dsh-managed (operation-error): dsh hit an unexpected error. dsh reported: EBUSY: node_modules.')
  })

  it('still reports a code this shop has no sentence for', () => {
    const outcome = managerOutcome({ changed: false, application: 'failed', stage: 'install', target: 'x', error: { code: 'brand-new-code' } }, context)
    expect(outcome).toEqual({ state: 'failed', detail: 'dsh-plugin-shop: dsh refused the install of dsh-managed (brand-new-code).' })
  })

  // R42.8. This case used to pin the CLI path's timeout detail on web, with
  // its `dsh plugin --profile web install`. dsh answers `cancelled` only once
  // pnpm, or its repository check, has exited and package.json and
  // pnpm-lock.yaml are back as they were (dsh-plugin-manager 0.1.7-rc.2,
  // cancelInstall), so that command no longer involves the package at all.
  it('says what dsh did with a cancelled install, and names no command on web or on desktop', () => {
    const cancelled = { changed: false, application: 'cancelled', stage: 'install', target: 'x' }
    const said = 'dsh-plugin-shop: the install did not finish within 900s, so the shop cancelled it.'
      + " dsh stopped it, restored the profile's package.json and pnpm-lock.yaml, and installed nothing. Try the install again from the shop."
    expect(managerOutcome(cancelled, context)).toEqual({ state: 'failed', detail: said })
    expect(managerOutcome(cancelled, desktop)).toEqual({ state: 'failed', detail: said })
    expect(managerOutcome(cancelled, { ...context, operation: 'update' }).detail).toContain('Try the update again from the shop.')
  })

  it('asks for a restart when dsh does, and names an update as already loaded', () => {
    expect(managerOutcome({ ...restartRequired }, { ...context, operation: 'update' }))
      .toEqual({ state: 'done', activation: 'restart', restartReason: 'already-loaded' })
    expect(managerOutcome({ ...restartRequired }, context))
      .toEqual({ state: 'done', activation: 'restart' })
  })

  it('keeps overridden as success, with a note that another layer decides', () => {
    const outcome = managerOutcome({ ...applied, application: 'overridden' }, context)
    expect(outcome.state).toBe('done')
    expect(outcome.detail).toMatch(/higher-priority layer/)
  })

  it('reads applied as live for a host-only install and as reload for one with a browser half', () => {
    expect(managerOutcome(applied, context)).toEqual({ state: 'done', activation: 'live' })
    expect(managerOutcome(applied, { ...context, hasClientHalf: true })).toEqual({ state: 'done', activation: 'reload' })
  })

  it('asks for a restart when this process imported the package before, whatever dsh applied', () => {
    // Design 2026-09-26-market-borrowings section 1: Node answers a second
    // import with the module it cached. Measured on 0.1.7-rc.2 (open item
    // O1): after removeBundle and installBundle both answered applied, the
    // new entry ran the module Node had cached. The rule stays.
    expect(managerOutcome(applied, { ...context, alreadyImported: true }))
      .toEqual({ state: 'done', activation: 'restart', restartReason: 'already-loaded' })
  })

  it('fails loudly on an application it does not know', () => {
    // Review Focus 4: a later harness answering something new must not read
    // as success.
    const outcome = managerOutcome({ ...applied, application: 'deferred' }, context)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('"deferred"')
  })

  // A removal dsh refused over a sibling's peers, once per restoration and
  // reader. Rewritten for R27 (2026-09-27) from R22's single case, which had
  // the shop assert "Nothing was removed." whatever dsh did: dsh prints what
  // it restored on the line after its refusal, and the version refusal now
  // passes that line on, scrubbed for a desktop reader like the rest of
  // dsh's text, beside the refusal the shop builds from the structured list.
  it("passes on what dsh restored after refusing a removal, with the shop's own exemption command on web", () => {
    expect(managerOutcome(removalRejected(REPAIRED), uninstall).detail).toBe(
      'dsh-plugin-shop: dsh refused the uninstall: dsh-sibling@1.0.0 declares @deepseek-ai/dsh 0.1.2-rc.1, which dsh 0.1.7-rc.2 does not satisfy.'
      + ' Restored package.json, pnpm-lock.yaml, and node_modules. To accept the risk of crashes or data loss for this exact version,'
      + ' run: dsh plugin --profile web allow-version dsh-sibling@1.0.0 --dsh-version 0.1.7-rc.2 --accept-risk - then uninstall again.')
  })

  it("passes dsh's whole restoration line on to a web reader, its own repair step included", () => {
    expect(managerOutcome(removalRejected(NOT_REPAIRED), uninstall).detail).toBe(
      'dsh-plugin-shop: dsh refused the uninstall: dsh-sibling@1.0.0 declares @deepseek-ai/dsh 0.1.2-rc.1, which dsh 0.1.7-rc.2 does not satisfy.'
      + " Restored package.json and pnpm-lock.yaml, but node_modules could not be reinstalled; run 'dsh plugin install'."
      + ' To accept the risk of crashes or data loss for this exact version,'
      + ' run: dsh plugin --profile web allow-version dsh-sibling@1.0.0 --dsh-version 0.1.7-rc.2 --accept-risk - then uninstall again.')
  })

  it('keeps what dsh restored for a desktop reader, and drops only its dsh plugin step', () => {
    const detail = managerOutcome(removalRejected(NOT_REPAIRED), { ...desktop, operation: 'uninstall' }).detail ?? ''
    expect(detail).toBe(
      'dsh-plugin-shop: dsh refused the uninstall: dsh-sibling@1.0.0 declares @deepseek-ai/dsh 0.1.2-rc.1, which dsh 0.1.7-rc.2 does not satisfy.'
      + ' Restored package.json and pnpm-lock.yaml, but node_modules could not be reinstalled.'
      + " dsh's CLI, which grants version exemptions, does not manage the desktop profile, and this shop grants none.")
    expect(detail).not.toContain('dsh plugin')
  })

  it('says a removal dsh began and could not finish left the package installed and switched off, after any rule', () => {
    // removeBundle switches an enabled bundle off before pnpm runs
    // (lib/index.js:1851-1853), nothing switches it back on, and `changed`
    // compares package.json among the rest (:2058): a failed removal that
    // reports a change left the package installed and off.
    const inUse = { changed: true, application: 'failed', stage: 'remove', target: 'dsh-managed', warnings: [], error: { code: 'bundle-in-use' } }
    expect(managerOutcome(inUse, uninstall).detail).toBe(
      'dsh-plugin-shop: dsh refused the uninstall of dsh-managed (bundle-in-use): the bundle was switched off, but some of its plugins are still running.'
      + ' dsh-managed is still installed, but dsh has switched it off.')
    const denied = removalFailed('permission', 'EACCES: permission denied', { changed: true, warnings: [] })
    expect(managerOutcome(denied, uninstall).detail)
      .toBe('dsh-plugin-shop: the uninstall failed: permission was denied. dsh-managed is still installed, but dsh has switched it off.')
    // The same after a refusal over a sibling's peers: dsh snapshots
    // package.json when pnpm starts (:461), after the switch-off, so what it
    // restored still has the package switched off.
    expect(managerOutcome(removalRejected(REPAIRED, true), uninstall).detail).toBe(
      'dsh-plugin-shop: dsh refused the uninstall: dsh-sibling@1.0.0 declares @deepseek-ai/dsh 0.1.2-rc.1, which dsh 0.1.7-rc.2 does not satisfy.'
      + ' Restored package.json, pnpm-lock.yaml, and node_modules. To accept the risk of crashes or data loss for this exact version,'
      + ' run: dsh plugin --profile web allow-version dsh-sibling@1.0.0 --dsh-version 0.1.7-rc.2 --accept-risk - then uninstall again.'
      + ' dsh-managed is still installed, but dsh has switched it off.')
    // Only a failed uninstall says it: an install reports a change of its own,
    // and a removal that succeeded left nothing installed.
    expect(managerOutcome({ ...pnpmFailed('permission', 'EACCES: permission denied'), changed: true }, context).detail)
      .toBe('dsh-plugin-shop: the install failed: permission was denied.')
    const removed = { changed: true, application: 'applied', stage: 'remove', target: 'dsh-managed', warnings: [], packageResult: { exitCode: 0, output: 'Packages: -1\n', truncated: false, logPath: '/l' } }
    expect(managerOutcome(removed, uninstall)).toEqual({ state: 'done', activation: 'live' })
  })

  // R28: rule 3's unknown-kind detail ends with pnpm's raw log line, which
  // usually carries no punctuation of its own, so the switched-off note
  // below used to run straight into it.
  it('breaks the sentence before the switched-off note when the detail has no terminal punctuation', () => {
    const outdated = removalFailed('unknown', 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json', { changed: true, warnings: [] })
    expect(managerOutcome(outdated, uninstall).detail).toContain('package.json. dsh-managed is still installed, but dsh has switched it off.')
  })

  it('scrubs the dsh plugin command out of an unknown failure log before installFailureDetail reads it', () => {
    // installFailureDetail's own rule ("dsh refusing the install is not pnpm
    // failing, and has its own remedy") reads the rejection block ahead of
    // any ERR_ code, on the web profile just the same, so ERR_PNPM_SOMETHING
    // never reaches the final detail either way; this is not the scrub's
    // doing. What the scrub must still do is keep the `dsh plugin` sentence
    // out of what that block reads, since it reads change.output directly,
    // never through plugin-manager.ts's own codeReason path, which the
    // CLI-step case below covers.
    const detail = managerOutcome(pnpmFailed('unknown', `ERR_PNPM_SOMETHING went wrong${rejection}`), desktop).detail ?? ''
    expect(detail).not.toContain('dsh plugin')
    expect(detail).toContain('is incompatible with dsh 0.1.7-rc.2')
    // Rule 3's reading, never rule 4's `dsh reported:` over the whole output.
    expect(detail).not.toContain('dsh reported')
  })

  it('reads a diagnostic that is only a CLI step as absent once scrubbed, for a desktop reader', () => {
    const cliOnly = { changed: false, application: 'failed', stage: 'remove', target: 'dsh-managed', error: { code: 'operation-error', diagnostic: "run 'dsh plugin install'." } }
    const detail = managerOutcome(cliOnly, desktop).detail ?? ''
    // "could not install" since R42.11, a wording fix: the case is about the
    // scrubbed diagnostic reading as absent.
    expect(detail).toBe('dsh-plugin-shop: dsh could not install dsh-managed (operation-error): dsh hit an unexpected error.')
    expect(detail).not.toContain('dsh reported:')
  })
})

describe('forDesktopReader', () => {
  it('keeps an untouched line exactly as it was, and a null diagnostic stays null', () => {
    const change: ManagerChange = {
      application: 'failed', stage: 'remove', errorCode: 'operation-error', diagnostic: null,
      incompatible: [], kind: null, output: 'ERR_PNPM_SOMETHING went wrong', pendingBuilds: [], failedAt: null, changed: null, truncated: false,
    }
    const scrubbed = forDesktopReader(change)
    expect(scrubbed.diagnostic).toBeNull()
    expect(scrubbed.output).toBe('ERR_PNPM_SOMETHING went wrong')
  })

  // Retitled for R27: it also said "and the whole line when that is all it
  // says", which its restoration line showed. That line now loses only the
  // clause naming the command; the case below that keeps `ERR_X boom.` shows
  // a line dropped whole.
  it('drops only the sentence naming the command from a mixed line', () => {
    const change: ManagerChange = {
      application: 'failed', stage: 'remove', errorCode: 'operation-error', diagnostic: rejection,
      incompatible: [], kind: null, output: '', pendingBuilds: [], failedAt: null, changed: null, truncated: false,
    }
    const scrubbed = forDesktopReader(change)
    expect(scrubbed.diagnostic).not.toContain('dsh plugin')
    expect(scrubbed.diagnostic).toContain('is incompatible with dsh 0.1.7-rc.2')
    expect(scrubbed.diagnostic).toContain('Exact-version exemption: not active')
  })

  it("keeps what dsh's restoration line says it restored, and drops only the clause naming the command", () => {
    const change: ManagerChange = {
      application: 'failed', stage: 'remove', errorCode: 'operation-error', diagnostic: null,
      incompatible: [], kind: null, output: `dsh: ${NOT_REPAIRED}.`, pendingBuilds: [], failedAt: null, changed: null, truncated: false,
    }
    expect(forDesktopReader(change).output).toBe('dsh: restored package.json and pnpm-lock.yaml, but node_modules could not be reinstalled.')
  })

  it('keeps the clauses that name no command with the sentence terminator, and drops a line whose every clause does', () => {
    const change: ManagerChange = {
      application: 'failed', stage: 'install', errorCode: 'operation-error', diagnostic: "ERR_X boom; run 'dsh plugin install'.\nrun 'dsh plugin install'.\nnext",
      incompatible: [], kind: null, output: '', pendingBuilds: [], failedAt: null, changed: null, truncated: false,
    }
    expect(forDesktopReader(change).diagnostic).toBe('ERR_X boom.\nnext')
  })

  /** A failed removal whose pnpm output is `output`. */
  const outputOf = (output: string): ManagerChange => ({
    application: 'failed', stage: 'remove', errorCode: 'operation-error', diagnostic: null,
    incompatible: [], kind: null, output, pendingBuilds: [], failedAt: null, changed: null, truncated: false,
  })

  // The sentence splitter is a left-to-right scan since the final fix wave;
  // it was a regex. Each line names `dsh plugin` where a sentence boundary in
  // the wrong place would change what the scrub keeps, so these pin the
  // pieces the regex yielded.
  it.each([
    ['a dot before a letter ends no sentence (a.b. c)', 'dsh plugin a.b. c', 'c'],
    ['a run before a letter ends no sentence (x...y)', 'dsh plugin x...y\nkept.', 'kept.'],
    ['an empty line gives no sentence and stays', 'dsh plugin one.\n\nlast', '\nlast'],
    ['a line with no punctuation is one sentence', 'no punctuation\ndsh plugin no punctuation', 'no punctuation'],
    ['a sentence carries the whitespace after its run (ends. )', 'ends. dsh plugin run.', 'ends. '],
    ['a kept clause keeps the terminator and the whitespace after it', 'keep; dsh plugin x. ', 'keep. '],
    ['a CRLF line keeps its carriage return with its sentence', 'a. dsh plugin b.\r\nkept.\r\n', 'a. \nkept.\r\n'],
    ['each of . ! and ? ends a sentence', 'one! dsh plugin two? three', 'one! three'],
  ])('splits sentences as it always has: %s', (_case, output, scrubbed) => {
    expect(forDesktopReader(outputOf(output)).output).toBe(scrubbed)
  })

  it('scrubs a line holding a 64,000-character run of dots within half a second', () => {
    // The regex backtracked quadratically on a run of `.` not followed by
    // whitespace: about 300 ms at dsh's 16 KB output cap and seconds here. It
    // blocks the event loop, so vitest's timeout cannot interrupt it; this
    // budget is what fails. Every line reaches the splitter, and naming `dsh
    // plugin` also sends this one through terminatorStart.
    const line = `dsh plugin ${'.'.repeat(64_000)}x`
    const started = performance.now()
    const scrubbed = forDesktopReader(outputOf(`${line}\nkept.`))
    const elapsed = performance.now() - started
    expect(scrubbed.output).toBe('kept.')
    expect(elapsed).toBeLessThan(500)
  })
})
