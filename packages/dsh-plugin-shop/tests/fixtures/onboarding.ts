import { gte } from 'semver'

/**
 * The acknowledgement that keeps dsh's first-run notice down, for the harness
 * that will boot.
 *
 * The web e2e and `scripts/shoot-readme-screenshots.ts` both write it into
 * `settings.yaml` before dsh boots rather than click the notice away (the e2e's
 * `seedOnboarding` records why clicking loses). dsh raises the notice unless
 * the stored `welcomeNoticeVersion` equals the version its build carries —
 * `WELCOME_NOTICE_VERSION` in dsh-client-ui-settings-models — and it compares
 * for EXACT equality, so no single value works on every harness. Read from
 * each build's own constant:
 *
 *   0.1.5-rc.3     2026-08-13.1   内测声明
 *   0.1.7-rc.2     2026-08-13.1   内测声明
 *   0.2.0-rc.1     2026-09-28.1   预览版说明, the first build to carry it
 *   0.2.0-rc.2     2026-09-28.1
 *   0.2.1-alpha.1  2026-09-28.1
 *
 * Its settings section moved at 0.1.7 as well, from `ui-onboarding` to
 * `ui-settings-general`, and that needs no branch: dsh-settings maps the
 * removed `ui-onboarding` section onto the `ui-settings-general` entry
 * (`LEGACY_SECTION_ENTRIES`), so `ui-onboarding:` reaches all of them.
 *
 * This table cannot foresee the next bump. A stale value raises the notice,
 * and `expectNoDialog` names it instead of letting a click time out — which is
 * how 预览版说明 was found on 2026-10-05.
 */
export function welcomeNoticeVersion(dshVersion: string): string {
  return gte(dshVersion, '0.2.0-rc.1') ? '2026-09-28.1' : '2026-08-13.1'
}
