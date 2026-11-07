# Reporting a failure, and a catalogue that keeps up — design

Status: **released 2026-11-06 as 0.9.2**; the §2 amendment of the same day (the
shop's version in the report) is released in 0.9.3 (2026-11-07). Two borrowings from the market scan of that day:
dshplugin/dsh-plugin-hub files failures as prefilled GitHub issues, and
kingOfSoySauce/dsh-skin-market re-reads its catalogue when the page comes back
to the front. English only, per convention.

## 1. A failed install can be reported where the plugin lives

A shop failure ends in a log and a sentence. The reader's next step — copy the
log, find the repository, open a new issue, paste, describe what they did —
is where most reports die. The failed panel now offers one link to the
plugin's own `issues/new`, with the title and body filled in.

**Which repository.** `CatalogEntry.repo` holds `owner/slug` for a github
source; an npm source holds `repository`, an author-written URL. `githubSlugOf`
reads both — the `https://`, `git+https://`, `git@github.com:` and `github:o/s`
forms npm actually stores — and answers null for anything else, including a
GitLab URL and a `..` traversal. **A report filed on the wrong repository is
worse than no link**, so a value that is not recognisably GitHub produces no
link at all.

**What the body says.** What the reader did (`install`/`update`, name and
version, channel), the host's published detail, the last 20 log lines, and the
shop's version. It never claims a harness version: the body carries a
`<!-- paste the output of dsh --version -->` marker for the reporter, because a
guessed version sends the report down the wrong path. An HTML comment at the
top says the shop filled in what it knows and invites edits.

**What it never carries.** The transport detail (the tab never renders it, and
a URL is a worse place), and ANSI sequences — a rendered log has no colours
and a pasted one should not either.

**Length.** A URL survives about 8 KiB, and Chinese costs nine encoded
characters per character. The detail is cut to its first 1,200 characters and
the log to the last 1,500 of its last 20 lines; the longer of the two then
gives up a fifth at a time until the ENCODED body fits 6,000 characters — the
detail keeping its start, where the host states the cause, the log its end,
where the failure is — and each cut is marked `… (truncated)`. The environment
block and the log's fences are never cut. A failure whose log is enormous
still yields an openable link.

*Amended 2026-11-06, after review:* the whole body used to be cut from its
end, which took the environment block — the shop's version and the
`dsh --version` marker — out of exactly the long non-ASCII reports the zh UI
produces, and the 1,500 clip kept the log's start, against the rule that its
last lines are the interesting ones.

## 2. Where the link is offered

The install panel's `failed` branch, for both the Install and the Update
variant — the two paths a reader most often needs to report. The uninstall
panel keeps its current copy: it is the same machinery, but the failure is
rarer and its repository is not always known from the row.

The card and the outdated row pass the slug they can see: the card from its
catalogue entry, the row from its entry (falling back to the row's own `repo`).

**Amended 2026-11-06: the shop's version is handed down too.** §1 puts it in
the body and `failureReportUrl` takes it, but no panel was ever given it, so
0.9.2 filed every report as `dsh-plugin-shop: unknown`. Only `present.test.ts`
passed one, by calling the builder directly. The tab now hands every panel
that builds a link — the card's two and the outdated row's — the version
`shop/version` answers as `installed`, the one the header prints. Until that
check answers, the line still reads `unknown`: a guessed version would send
the report down the wrong path, which is also why the body never claims a
harness version.

## 3. The catalogue refreshes when the tab comes back

A shop left open in a background tab showed the catalogue it loaded that
morning for the rest of the day. The tab now listens for `visibilitychange`
and `focus` and asks again — throttled to one refresh per
`FOCUS_REFRESH_MS` (5 minutes), skipped while another load is in flight, and
only when the document is visible. A reader switching between windows spends
no request; one returning after a while sees what was published meanwhile.

The refresh is the existing `refresh` request: the stale shelf stays on screen
until the answer lands, and a failed refresh keeps it — both behaviours the
shop already had.

## 4. Tests and release

- `present.test.ts`: `githubSlugOf` over every URL form, another host, a
  traversal, and the empty cases; `failureReportUrl`'s title, body, ANSI
  stripping, log clipping, the update verb, the encoded-length bound, and null
  when there is nowhere honest to file.
- `ShopTab.client.spec.tsx`: the link on a failed install against the fixture's
  repository, its absence when the entry names none, and the focus refresh —
  none inside the window, one request past it, with the stale shelf kept.
- `ShopTab.client.spec.tsx`, 2026-11-06: the version the header shows is in the
  body built by the card's panel on a failed install, and by the outdated row's
  and the card's on a failed update — the rendered check the 0.9.2 defect
  lacked. The host's `latest` differs from the running version there, so a
  panel handed the wrong one fails too.
- `present.test.ts`, 2026-11-06: a body that has to be cut keeps its
  environment block, a closed log fence before it and the encoded bound, and
  loses the log's oldest lines first.

Client-only: no catalogue field changes, so this rides the next shop release
without a beta-first requirement of its own.
