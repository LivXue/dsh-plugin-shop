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

// Measured on dsh 0.1.7-rc.2 source: dsh-app-boot's pluginCompatibilityWarning
// (the `dsh plugin allow-version` sentence) and the install rollback message
// (`run 'dsh plugin install'`), concatenated as removeBundle's pnpm failure
// would surface them through packageResult.output and error.diagnostic alike.
const rejection = "\ndsh: installation rejected: Plugin dsh-sibling@1.0.0 is incompatible with dsh 0.1.7-rc.2: peerDependencies {\"@deepseek-ai/dsh\":\"0.1.2-rc.1\"}. Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime. To accept this risk explicitly, grant the exact-version exemption for dsh-sibling@1.0.0 on dsh 0.1.7-rc.2 with `dsh plugin allow-version` or the plugin manager, then retry the installation or restart dsh. Exact-version exemption: not active.\ndsh: restored package.json and pnpm-lock.yaml, but node_modules could not be reinstalled; run 'dsh plugin install'.\n"
// The run keeps the structured list of what its compatibility scan rejected,
// and its `kind` is `unknown`, the class dsh gives a log no pattern matches.
const removeRejected = { changed: false, application: 'failed', stage: 'remove', target: 'dsh-managed', error: { code: 'operation-error', diagnostic: rejection }, packageResult: { exitCode: 1, output: rejection, truncated: false, logPath: '/l', kind: 'unknown', incompatible: [{ name: 'dsh-sibling', version: '1.0.0', runtimeVersion: '0.1.7-rc.2', peers: { '@deepseek-ai/dsh': '0.1.2-rc.1' } }] } }

describe('managerOutcome', () => {
  it('builds the refusal from the structured list, with the exemption command', () => {
    // Rule 1. Nothing is parsed: the list is dsh's own record.
    const outcome = managerOutcome(refused, context)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('@deepseek-ai/dsh 0.1.2-rc.1')
    expect(outcome.detail).toContain('dsh plugin --profile web allow-version dsh-managed@1.0.0 --dsh-version 0.1.7-rc.2 --accept-risk')
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
  })

  it('says what a classified failure was and where', () => {
    expect(managerOutcome(pnpmFailed('not-found', 'ERR_PNPM_FETCH_404', { failedAt: 'registry' }), context).detail)
      .toBe('dsh-plugin-shop: the install failed at the registry: no such package was found.')
    expect(managerOutcome(pnpmFailed('network', 'ENOTFOUND', { failedAt: 'spec-host' }), context).detail)
      .toBe('dsh-plugin-shop: the install failed at the host the package is fetched from: the network failed.')
    expect(managerOutcome(pnpmFailed('disk-full', 'ENOSPC'), context).detail)
      .toBe('dsh-plugin-shop: the install failed: the disk is full.')
  })

  // What pnpm printed for the web e2e's 404 through dsh 0.1.7-rc.2 on
  // 2026-09-27, the lines that name it.
  const registry404 = '[ERR_PNPM_FETCH_404] GET http://127.0.0.1:46237/dsh-e2e-fixture-plugin: Not Found - 404\n'
    + 'dsh-e2e-fixture-plugin is not in the npm registry, or you have no permission to fetch it.\n'

  it("reads dsh's answer to a registry 404 as the sentence for it, and embeds none of its output", () => {
    expect(managerOutcome(pnpmFailed('not-found', registry404, { failedAt: 'registry' }), context))
      .toEqual({ state: 'failed', detail: 'dsh-plugin-shop: the install failed at the registry: no such package was found.' })
  })

  it('names the operation that failed: the same 404 in an uninstall', () => {
    const removal = pnpmFailed('not-found', registry404, { stage: 'remove', target: 'dsh-managed', failedAt: 'registry' })
    expect(managerOutcome(removal, { ...context, operation: 'uninstall' }).detail)
      .toBe('dsh-plugin-shop: the uninstall failed at the registry: no such package was found.')
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

  it('carries a management code with the sentence dsh source gives it, and dsh diagnostic', () => {
    const outcome = managerOutcome({ changed: false, application: 'failed', stage: 'remove', target: 'dsh-managed', error: { code: 'bundle-in-use', diagnostic: 'still mounted' } }, { ...context, operation: 'uninstall' })
    expect(outcome.detail).toBe('dsh-plugin-shop: dsh refused the uninstall of dsh-managed (bundle-in-use): the bundle was switched off, but some of its plugins are still running. dsh reported: still mounted.')
  })

  it('strips one trailing period from the diagnostic rather than doubling it', () => {
    const outcome = managerOutcome({ changed: false, application: 'failed', stage: 'remove', target: 'dsh-managed', error: { code: 'bundle-in-use', diagnostic: 'still mounted.' } }, { ...context, operation: 'uninstall' })
    expect(outcome.detail).toBe('dsh-plugin-shop: dsh refused the uninstall of dsh-managed (bundle-in-use): the bundle was switched off, but some of its plugins are still running. dsh reported: still mounted.')
  })

  it('still reports a code this shop has no sentence for', () => {
    const outcome = managerOutcome({ changed: false, application: 'failed', stage: 'install', target: 'x', error: { code: 'brand-new-code' } }, context)
    expect(outcome).toEqual({ state: 'failed', detail: 'dsh-plugin-shop: dsh refused the install of dsh-managed (brand-new-code).' })
  })

  it('reads a cancelled install as the timeout, with the command outside the desktop profile only', () => {
    const cancelled = { changed: false, application: 'cancelled', stage: 'install', target: 'x' }
    const web = managerOutcome(cancelled, context)
    expect(web.state).toBe('failed')
    expect(web.detail).toContain('did not finish within 900s')
    expect(web.detail).toContain('dsh plugin --profile web install')
    const app = managerOutcome(cancelled, desktop)
    expect(app.detail).toContain('did not finish within 900s')
    expect(app.detail).not.toContain('dsh plugin')
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

  it("reads a removal dsh rejected over a sibling's peers as the version refusal: no command on desktop, the shop's own on web", () => {
    // Rewritten for R22 (2026-09-27). This rejection read through rule 4,
    // as dsh's own text with its `dsh plugin` sentences scrubbed for a
    // desktop reader. dsh codes it `operation-error`, but the run kept the
    // structured list its compatibility scan rejected, so it now reads
    // through the version refusal built from that list, as an
    // `incompatible-version` refusal does: none of dsh's text reaches either
    // reader, and on web the shop builds the exemption command itself.
    const app = managerOutcome(removeRejected, { ...desktop, operation: 'uninstall' }).detail ?? ''
    expect(app).not.toContain('dsh plugin')
    expect(app).toContain('dsh-sibling@1.0.0')
    expect(app).toContain('@deepseek-ai/dsh 0.1.2-rc.1')
    expect(app).toContain('Nothing was removed.')
    const web = managerOutcome(removeRejected, { ...context, operation: 'uninstall' }).detail ?? ''
    expect(web).toContain('dsh plugin --profile web allow-version dsh-sibling@1.0.0 --dsh-version 0.1.7-rc.2 --accept-risk')
    expect(web).toContain('then uninstall again.')
  })

  it('scrubs the dsh plugin command out of an unknown failure log before installFailureDetail reads it', () => {
    // installFailureDetail's own rule ("dsh refusing the install is not pnpm
    // failing, and has its own remedy") reads the rejection block ahead of
    // any ERR_ code, on the web profile just the same, so ERR_PNPM_SOMETHING
    // never reaches the final detail either way — this is not the scrub's
    // doing. What the scrub must still do is keep the `dsh plugin` sentence
    // out of what that block reads, since it reads change.output directly,
    // never through plugin-manager.ts's own codeReason path, which the
    // CLI-step case below covers.
    const detail = managerOutcome(pnpmFailed('unknown', `ERR_PNPM_SOMETHING went wrong${rejection}`), desktop).detail ?? ''
    expect(detail).not.toContain('dsh plugin')
    expect(detail).toContain('is incompatible with dsh 0.1.7-rc.2')
  })

  it('reads a diagnostic that is only a CLI step as absent once scrubbed, for a desktop reader', () => {
    const cliOnly = { changed: false, application: 'failed', stage: 'remove', target: 'dsh-managed', error: { code: 'operation-error', diagnostic: "run 'dsh plugin install'." } }
    const detail = managerOutcome(cliOnly, desktop).detail ?? ''
    expect(detail).toBe('dsh-plugin-shop: dsh refused the install of dsh-managed (operation-error): dsh hit an unexpected error.')
    expect(detail).not.toContain('dsh reported:')
  })
})

describe('forDesktopReader', () => {
  it('keeps an untouched line exactly as it was, and a null diagnostic stays null', () => {
    const change: ManagerChange = {
      application: 'failed', stage: 'remove', errorCode: 'operation-error', diagnostic: null,
      incompatible: [], kind: null, output: 'ERR_PNPM_SOMETHING went wrong', pendingBuilds: [], failedAt: null,
    }
    const scrubbed = forDesktopReader(change)
    expect(scrubbed.diagnostic).toBeNull()
    expect(scrubbed.output).toBe('ERR_PNPM_SOMETHING went wrong')
  })

  it('drops only the sentence naming the command from a mixed line, and the whole line when that is all it says', () => {
    const change: ManagerChange = {
      application: 'failed', stage: 'remove', errorCode: 'operation-error', diagnostic: rejection,
      incompatible: [], kind: null, output: '', pendingBuilds: [], failedAt: null,
    }
    const scrubbed = forDesktopReader(change)
    expect(scrubbed.diagnostic).not.toContain('dsh plugin')
    expect(scrubbed.diagnostic).toContain('is incompatible with dsh 0.1.7-rc.2')
    expect(scrubbed.diagnostic).toContain('Exact-version exemption: not active')
  })
})
