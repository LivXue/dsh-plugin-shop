# Security Policy

English | [中文](SECURITY.zh.md)

Two different things get reported here. Both go privately, and neither belongs
in a public issue.

## A vulnerability in the shop or the pipeline

Report it through GitHub's private advisory form:

> <https://github.com/LivXue/dsh-plugin-shop/security/advisories/new>

Private reporting is enabled on this repository, so no email is needed and the
report stays private until there is a fix. Include the version
(`npm view dsh-plugin-shop version`, or the commit you are on), what an attacker
gains, and the smallest reproduction you have.

Supported: whatever `latest` resolves to on npm. There is no long-term support
branch — a fix ships as a new version, and one that changes what the host reads
goes through the `beta` tag first.

## A malicious plugin in the catalog

The catalog lists third-party packages. This project harvests and gates them; it
does not vouch for code nobody has read. The trust tier on each entry records
who has: `verified` means a human reviewed one exact artifact, `verified-stale`
means the review covered a different version than the one on offer, and
`community` means no human has looked. `registry/verified.yml` is empty today,
so `community` is the honest answer for the whole shelf.

If a listed plugin is malicious, use the same private form. Do **not** open a
public issue, and do not send a pull request adding it to `denied.yml`: a public
accusation is unfair to a package that turns out to be misjudged, and it tips
off one that is not. Include the exact package name and version, the repository
if it has one, and what the code actually does. A confirmed report becomes a
`denied.yml` entry stating the reason, and that entry is permanent.

## What is not a security report

- **A plugin missing from the catalog.** That is a listing question. The
  [build report](https://LivXue.github.io/dsh-plugin-shop/v1/report.md) says why,
  per package, and [CONTRIBUTING.md](CONTRIBUTING.md) says what to do about it.
- **A plugin listed as `community`.** Nothing about that tier claims the code
  was read. It is the label for the absence of a review, not a clean bill.
