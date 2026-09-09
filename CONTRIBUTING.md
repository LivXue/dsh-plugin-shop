# Contributing

English | [中文](CONTRIBUTING.zh.md)

Three different things bring people here, and they share nothing but this page.
Pick the one that matches you.

| I want to | Read |
|---|---|
| correct a listing decision a classifier got wrong | [1. Correct a verdict](#1-correct-a-verdict) |
| get my own plugin into the catalog | [2. Get a plugin listed](#2-get-a-plugin-listed) |
| change the pipeline itself | [3. Change the pipeline](#3-change-the-pipeline) |

## 1. Correct a verdict

The cheapest contribution here is one line of YAML. It needs no TypeScript, no
network, and no local build.

Review in this project is automated. The classifier decides **presentation** —
which category a listing appears under, and whether the shelf advertises a name
that looks like a competing plugin market. It never decides what is *in* the
catalog; that is the gate's job, and fixtures drive every rule of it. So a wrong
call changes what a browser sees, never what the catalog holds, and correcting
it means editing the row that recorded it.

Every build publishes what it decided on its own:

> <https://LivXue.github.io/dsh-plugin-shop/v1/report.md>

The header of that report names every listing withheld from the shelf on a
classifier verdict with no human behind it. That list is the to-do list.

Three files hold verdicts:

| File | Decides |
|---|---|
| `registry/categories.yml` | the category of a listing whose author declared none |
| `registry/markets.yml` | whether a shop-like name really is a competing dsh plugin market |
| `registry/denied.yml` | permanent exclusion, with the reason stated in the entry |

Find the row and edit it. `categories.yml` is over 19,000 lines — `grep -n` it,
do not scroll:

```sh
grep -n 'dsh-your-plugin' registry/categories.yml
pnpm test          # offline; nothing in this lane needs the harvest
```

**A recorded verdict is never re-asked.** That is what makes the edit worth
making: the build does not revisit a row that already exists, so your one line
is the answer from then on. It is also why a careless one is permanent — say in
the pull request what you actually checked.

One exception: if a plugin is malicious, do **not** open a public pull request
adding it to `denied.yml`. Report it privately — see [SECURITY.md](SECURITY.md)
for why.

## 2. Get a plugin listed

You do not contribute to this repository to get listed. The catalog harvests by
keyword: add `dsh-plugin` or `deepseek-harness` to your `package.json` keywords
and publish to npm, and the next daily build picks it up. A plugin that never
publishes to npm is listed from its GitHub repository instead — the same keyword
as a repository *topic*, plus a root `package.json` carrying a `name` and
`dsh.bundle`. Every field is documented in [docs/schema.md](docs/schema.md).

**Published, and still not on the shelf?** Look it up before asking. Every
rejection is published, with a reason and an author-readable detail:

```sh
curl -s https://LivXue.github.io/dsh-plugin-shop/v1/report.md | grep '| your-package-name |'
```

Read the **Detail** column rather than the Reason. The reason codes are few and
knowingly broader than their names: `no-manifest` is the code for every way a
manifest we *did* read cannot be listed — refused for its size, unreadable, a
name outside the bundle-name grammar, a field past its bound — so it can say
"no manifest" about a `package.json` you certainly wrote. The detail is the
accurate half and says which bound was crossed.

Open the *Plugin not listed* issue when the detail is wrong about your package,
or when your name appears in neither the catalog nor the rejection table.

## 3. Change the pipeline

Read two files first. [`docs/design/`](docs/design/) is the specification and it
is the authority: code, tests and prose follow it, and when they disagree either
the spec wins or the spec is amended in the same change. Amending it is normal.
`CLAUDE.md` is the working agreement — the invariants, the conventions, and the
measurements behind them.

Then four things that will otherwise cost you an afternoon.

**A pure core, an impure shell.** The modules `CLAUDE.md` names as pure —
`gate.ts`, `tier.ts`, `emit.ts`, `pipeline.ts` and their siblings — take no
clock, no network, no filesystem, no environment, and no locale. Every policy
decision lives there, which is why fixtures can drive all of it. A decision that
migrates into the shell becomes untestable. If a pure module needs the time,
take it as a parameter.

**The tests never touch the network.** `pnpm test` covers every policy decision
offline. `pnpm build:catalog` is the real harvest — thousands of live npm and
GitHub requests, several minutes. Do not run it to check that a change compiles.
Run it when you have changed the fetching or writing layer and need to see it
work end to end.

**`registry/schema/plugin-entry.schema.json` is generated.** The zod schema is
the single definition of the catalog section; run `pnpm emit:schema` and never
hand-edit the JSON. A freshness test guards it.

**A fork pull request loses the secrets, on purpose.** GitHub does not hand
repository secrets to a `pull_request` event from a fork, so your run has no LLM
key and no stars token. The catalog workflow is written for exactly that: the
harvest goes unauthenticated and the classification step skips itself. A skipped
classification in your run is the design, not your mistake. Every write step is
gated off as well, so a pull request run is a full dry run that publishes
nothing.

Two conventions before review comments find them. User-facing docs are bilingual
pairs (`X.md` and `X.zh.md`, linked both ways, the Chinese stating the same
facts in its own register rather than translating word for word), while design
documents and specs are English only. And every rejection `detail` you write is
published to a plugin author trying to find out why their package is not listed
— a wrong or misattributed reason is a defect, not a wording nit.

## Everything else

- Be decent to each other: [Code of Conduct](CODE_OF_CONDUCT.md), reachable at
  <xuedizhan17@mails.ucas.ac.cn>.
- Vulnerabilities and malicious plugins go [privately](SECURITY.md), never to a
  public issue.
- Contributions are licensed under [Apache-2.0](LICENSE), like the rest of the
  project.
