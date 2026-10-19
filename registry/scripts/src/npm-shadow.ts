/**
 * Which accepted npm package hides which repository candidate: the one rule
 * `selectEntries` and `selectPending` both ask, of a map both build with
 * `acceptedNpmRepositories`, so the build and the classifier give a candidate
 * the same verdict (design 2026-10-19-npm-shadow-by-owner §2-§4). They are
 * not always given the same candidates: the classifier reads the committed
 * `repo-state.json`, one build behind the build's own harvest, so a
 * repository that changed owner in between is judged by the build first and
 * by the classifier on the next run (§4).
 *
 * An ACCEPTED npm package hides a repository candidate of its bundle name in
 * exactly two cases.
 *
 * 1. Same owner. The package's `repository` reads as
 *    `https://github.com/<owner>/<name>`, and `<owner>` is the candidate's own,
 *    case-folded. That covers the package naming the candidate's own
 *    `owner/name` and naming a different `owner/name` of the same owner;
 *    which of the two it is decides only the sentence. A different string is
 *    not always another repository: GitHub follows a rename and a string does
 *    not, so it may be this repository under an earlier name, and that
 *    sentence says either.
 * 2. Nothing to compare. The `repository` does not read that way (another
 *    host, an `ssh://` or `github:` spelling), so the candidate stays hidden,
 *    as it always was.
 *
 * Every other candidate goes to `gateRepo` as if no npm package had its name.
 * A rejected npm package hides nothing (B-6), because the rule is given only
 * the accepted ones.
 *
 * It never hides more than the rule it replaced, which hid every repository
 * whose bundle name an accepted npm package held. Both cases need that same
 * package and add a condition, so no listed entry can disappear because of
 * this rule: it only lists.
 *
 * The owner is the line because it is the one identity both channels carry: a
 * GitHub login stands in the package's `repository` and in the repository's
 * `owner/slug`. Under one owner, a second repository of the same name is that
 * owner's own project kept in another place. Under two, it is usually someone
 * else's plugin that happens to choose the same name (issue #88), and telling
 * its author their repository is the npm package's source is a misattributed
 * reason, which this project counts as a defect. The owners are compared as
 * strings, so a transfer or an account rename, which GitHub follows, reads as
 * another owner (design §2, §9).
 *
 * The candidate's owner is the text of `RepoCandidate.repo` before its first
 * slash, never its `repository` field. `repo` is the search's own
 * `owner/slug`, where the repository lives. The rule sets one claim, the npm
 * package's `repository`, against that fact, and the candidate's `repository`
 * is only a second stored spelling of it, not another source for it.
 *
 * Pure: it decides from two strings already in hand, the npm package's
 * `repository` and the candidate's `repo`, and adds no request. No clock,
 * network, filesystem, environment or locale; case-folding is `toLowerCase`,
 * as `firstSeenKey` and the denial lookup fold it, and GitHub logins are
 * ASCII. The sentences quote nothing of the declared repository but the owner
 * and name `githubOwnerName` read out of it. The gate has already bounded that
 * field for an accepted package, and the report's cell writer escapes what it
 * prints.
 * @module npm-shadow
 */
import type { Accepted } from './gate.ts'
import { githubOwnerName } from './github-repo.ts'
import { repoUnit } from './identity.ts'
import type { Rejection, RepoCandidate } from './types.ts'

/**
 * The ACCEPTED npm packages of one build, as `npmShadowOf` reads them: each
 * name, mapped to the `repository` its manifest declares. It is built from the
 * gate's own results, so a package the gate rejected cannot be in it, which
 * is what makes a rejected package hide nothing (B-6), and every package in
 * it declares a repository: the gate refuses one that declares none
 * (`no-repository`). `selectEntries` and `selectPending` both build their map
 * here, so a change to how it is built reaches both readers (design §4).
 * @param accepted - the npm packages the gate accepted.
 */
export function acceptedNpmRepositories(accepted: readonly Accepted[]): ReadonlyMap<string, string> {
  return new Map(accepted.map(item => [item.candidate.name, item.repository]))
}

/**
 * Whether an accepted npm package hides this repository candidate, and the
 * row that says why.
 * @param candidate - the repository as harvested. Only its `name`, `repo` and
 *   `subdir` are read.
 * @param acceptedNpm - the accepted npm packages' declared repositories, by
 *   name, as `acceptedNpmRepositories` builds them.
 * @returns the `shadowed-by-npm` row, or `null` when the candidate is not
 *   hidden and goes on to the gate.
 */
export function npmShadowOf(
  candidate: RepoCandidate,
  acceptedNpm: ReadonlyMap<string, string>,
): Rejection | null {
  // The npm package that could hide a candidate shares its bundle name.
  const npm = candidate.name
  const repository = acceptedNpm.get(npm)
  if (repository === undefined) return null

  // Case 2: nothing to compare.
  const declared = githubOwnerName(repository)
  if (declared === null) return shadowedRow(candidate, unparsedDetail(npm))

  // Case 1: the same owner. The whole `owner/name`, folded, picks the
  // sentence: the same string is this very repository, and a different one is
  // this repository under an earlier name or another of its owner's, which a
  // string cannot tell apart.
  const declaredRepo = `${declared.owner}/${declared.name}`
  const repo = candidate.repo.toLowerCase()
  if (repo === declaredRepo.toLowerCase()) return shadowedRow(candidate, ownDetail(npm))
  // The slash is what refuses an owner that only begins the candidate's:
  // `ali/` does not start `alice/dsh-x`.
  if (repo.startsWith(`${declared.owner.toLowerCase()}/`)) {
    return shadowedRow(candidate, sameOwnerDetail(npm, declaredRepo))
  }
  return null
}

function shadowedRow(candidate: RepoCandidate, detail: string): Rejection {
  return {
    // The same unit `repo-gate.ts` names, so a monorepo's shadowed
    // subpackages are distinguishable rows instead of N identical ones whose
    // order followed the harvest (C-6).
    name: repoUnit(candidate),
    code: 'shadowed-by-npm',
    detail,
  }
}

// The three sentences below are published in report.md (design §3), and every
// one keeps "already listed" and the npm package's name. A hidden candidate
// never reaches the gate, so the hint the last two carry promises a judgement
// and not a listing: the repository behind the row may still fail the gate on
// its own.

/**
 * The npm package names this very repository: no hint, as there is no other
 * plugin to judge.
 */
function ownDetail(npm: string): string {
  return `The npm package ${npm} names this repository as its source and is already listed; the repository is not listed separately.`
}

/**
 * The npm package names a different `owner/name` of the candidate's owner. A
 * string cannot tell this repository under an earlier name from another one,
 * and design §2 counts rows of both, so the sentence claims only a
 * repository of the same owner.
 */
function sameOwnerDetail(npm: string, declaredRepo: string): string {
  return `The npm package ${npm} is already listed and names ${declaredRepo} as its source: a repository of the same owner, either this one under an earlier name or another. This repository is not listed separately. If it is a different plugin, giving it a package name of its own lets the catalog judge it on its own.`
}

/** The npm package's repository cannot be read as a GitHub URL. */
function unparsedDetail(npm: string): string {
  return `The npm package ${npm} is already listed, and the repository it names is not a plain https://github.com/owner/name URL, so this repository cannot be told apart from it and is not listed separately. If it is a different plugin, giving it a package name of its own lets the catalog judge it on its own.`
}
