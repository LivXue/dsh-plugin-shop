# Catalog transfer budget and payload shape — proposal

Status: **proposed 2026-10-31, not implemented.** This is the capacity half of
issue #116; the failure it reported was a name-grammar bug, fixed and live on
2026-10-30 (`ca5de37`, PR #117). Nothing here blocked that fix.

The 2026-09-01 catalog-mirrors record chose the npm transport over sharding on
measurements taken at a **1.48 MB gzip** payload. The payload is now **4.80 MB
gzip** (21.36 MB decoded, 21,757 listings), and the assumptions behind that
record no longer all hold at this size. This document re-takes the
measurements, states which assumptions broke, lists the options with what
each costs, and suggests an order. The decisions in §5 are the maintainer's.

## 1. Measurements (2026-10-30/31)

**Payload.** The live v1 files, fetched from `LivXue.github.io` and
`registry.npmmirror.com` on 2026-10-30/31. Decimal MB throughout.

| Item | Value |
|---|---|
| listings | 21,757 (built `2026-10-30T19:36:56.808Z`) |
| decoded | 21,356,448 B |
| on the wire | 4,799,240 B (gzip; the clients negotiate it) |
| per listing | ~981 B decoded |
| growth | 15,872 (10-19) → 21,268 (10-29) → 21,493 (10-30 07:40) → 21,757 (10-30 19:36); 250–540 listings/day over that span |
| yesterday's build | 20,851,567 B decoded / 4,536,954 B gzip at level 6 (the file #116 measured) |

**Field shares of the gzip**, measured by deleting each key from every entry
and re-compressing (level 6; the server's own level differs by ~2.5%):

| Field | gzip bytes | share |
|---|---:|---:|
| `catalog` | 1,993,344 | 42.6% |
| `integrity` | 860,881 | 18.4% |
| `dshPeers` | 267,305 | 5.7% |
| `publishedAt` | 242,402 | 5.2% |
| `icon` | 202,145 | 4.3% |
| `repository` | 167,722 | 3.6% |
| `installSize` | 121,272 | 2.6% |
| `name` | 109,049 | 2.3% |
| `peers` | 94,095 | 2.0% |
| `version` | 92,764 | 2.0% |

`catalog` and `integrity` alone are **61%** of the wire. The keys that repeat
structure compress away: eliding the 21,735 empty `capabilities` arrays saves
609 KB decoded but **13 KB gzip**, and `dshPeers` is already omitted when
absent (12,119 entries carry no key), not serialised as `null`.

**Timings, this host (2026-10-30).**

| Path | Result |
|---|---|
| `undici` (the shop's `fetch`), direct, first 2 MB | 13.9 s (~144 KB/s) |
| the same, `NODE_USE_ENV_PROXY=1` | 0.76 s |
| `curl --compressed` through the host proxy, the whole 4.7 MB file | 1.14 s |
| real `loadCatalog`, http origin only, no cache | threw at **30,540 ms** (`TransportError`, the 30 s commit budget) |
| real `loadCatalog`, full origin race, the rebuilt catalog | **1,485 ms**, 21,757 entries (the npm origin won) |

The 30 s budget is a floor of **160 KB/s** for the 4.80 MB body. The
2026-09-01 record measured GitHub Pages direct at **0.03 MB/s** on a
China-side machine; at that rate the body needs ~160 s. Gzip is what keeps
this survivable at all: the same file uncompressed is 21 MB.

**The npm transport's own payload.** `dsh-plugin-shop-catalog@2026.1029.2`'s
tarball is **7,365,605 B**, and its contents are `plugins.json` (20,851,567 B
decoded), `icons.json` (5,953,375 B decoded / **3,227,462 B gzip** on the
wire) and `stars.json` (717,509 B decoded). The shop's client does not read
`icons` (its pointer schema strips the key), but the npm origin downloads the
whole tarball, so every npm-origin read now pays for it.

**Caps.** `MAX_BODY_BYTES` is 64 MB decoded (`origin.ts:52`); the npm tarball
cap is 32 MB compressed (`MAX_PACKAGE_BYTES`) and inflates under 64 MB
(`MAX_INFLATED_BYTES`). At 250–540 listings/day the decoded body reaches 64 MB
in roughly three to six months.

## 2. Assumptions that no longer hold

1. **"The commit budget is generous against every measured origin."** It was
   sized for 1.5 MB (`COMMIT_TIMEOUT_MS`'s comment owns the constant and its
   arithmetic). The body is 3.2× that, and the measured direct-link floor is
   far below the 160 KB/s the budget now implies.
2. **"A fast probe predicts a fast bulk."** Probes are 676 B (GitHub's
   `index.json`) and 13.5 KB (npm's `latest`). The race commits to the first
   probe that answers and then downloads everything from that handle; `file()`
   never falls through to another origin — `race.ts:15` states the split is
   intentional. A fast small-file origin with a slow bulk is exactly the
   GitHub-Pages-direct case the npm transport exists to avoid.
3. **"The npm transport is the smaller, faster download."** In mainland China
   it usually is (the 2026-09-01 record measured npmmirror at 12.53 MB/s), but
   it is now 7.37 MB against the http origin's 4.80 MB, and the icons sidecar
   is most of the difference.
4. **"A cached shop opens instantly."** It does only for `FRESH_MS` (5 min,
   `catalog.ts:30`). After that the first paint waits for the network attempt
   and only then degrades to the cache (`cachedOrThrow`, `catalog.ts:586`).

## 3. Options

Each option is stated with what it fixes, what it costs, and whether it needs
a client release.

### A. Reshape the commit budget

- **(a) Raise the fixed value**, e.g. 30 s → 120 s.
  Fixes: a slow-but-working body on a cold cache. Costs: a black-holed origin
  holds the shelf for two minutes before the cache is served; the number is
  still a guess against a growing payload.
- **(b) Size the deadline by the body**, e.g. `max(30 s, declared bytes /
  100 KB/s)`. Fixes the "grows until the budget is wrong again" problem for
  the http origin. Costs: the pointer read (`npmOrigin.pointer()`, which is a
  tarball download) has no declared size until its headers arrive, so the
  budget must be applied inside the origin or split into two phases.
- **(c) Stall watchdog plus a high ceiling** — reset a timer on every chunk;
  abort after N seconds without a byte, with a hard cap (e.g. 10 min).
  Fixes both: a progressing slow transfer completes, and a dead origin is
  abandoned on the same schedule as today. Costs: `withCommitBudget` becomes a
  progress-aware wrapper, which is more code than a constant, and the tests
  must drive a clock to prove the reset.

  Recommended shape: **(c)**, because it preserves the property the budget
  exists for (a stalled origin does not park the race) while removing the
  rate assumption from a payload that grows daily.

### B. Fall through to another origin when the bulk read fails

Today a `TransportError` from `file()` goes straight to the cache
(`catalog.ts:641-648`); the other origins have already answered their probes
and are sitting unused. Fetching the same file name from the next settled
handle is safe: the bytes are bound to the pointer's sha256, and a mismatch
is a loud throw either way, so a mirror cannot substitute content.

- Fixes: the failure #116 nearly became — a fast probe on a slow bulk origin
  with a healthy npm origin standing by.
- Costs: the race's "one commit, one download" simplicity; a failed body is
  now paid for twice on a bad day; the second origin's `file()` may itself be
  a bulk read (npm) and needs the same budget.
- Needs a client release: **yes** (host code only — the client bundle carries
  the host half, so this ships with the shop package, not a catalog change).

### C. Serve the cache first, refresh behind it

Return the cached snapshot immediately when one exists, and refresh in the
background; the client re-reads when the refresh settles, or the next open
picks it up.

- Fixes: every open after `FRESH_MS` waiting on a slow network before showing
  anything — the "stale while revalidate" half the spec's failure table
  implies but does not implement.
- Costs: a client-side state change (when to re-read), and the shelf briefly
  shows a catalog one build old; the RPC shape can stay the same if the client
  asks again.
- Needs a client release: **yes**.

### D. Split the payload by field, behind a new pointer key

Keep `plugins.<sha>.json` exactly as it is for every installed client, and add
a second content-addressed file the new client prefers: the fields a shelf
needs to render and sort (`name`, `version`, `catalog`, `tier`, `source`,
`repo`, `tarball`, flags), leaving the detail-only fields — `integrity`,
`publishedAt`, the size keys, `peers`/`dshPeers`, `publisher` — to the detail
path.

- Fixes: the wire cost of the two heaviest fields. `integrity` alone is 0.86 MB
  gzip; a shelf file without it, `publishedAt` and the size keys is roughly
  half of today's 4.8 MB.
- Costs: a second artifact to publish and cache, a pointer key and a client
  switch, and a migration story for when the old file can stop being
  published (`schemaVersion` cannot carry this: a higher number makes old
  clients refuse the catalog outright).
- Cannot be done by **removing** keys from today's file: `integrity`,
  `publishedAt`, `repository` and `catalog.capabilities` are required by the
  installed clients' schema, and one missing key fails the whole file.
- Needs a client release: **yes, first**; the producer may only stop writing
  the old file after the installed base has moved.

### E. Shard by category or letter

The 2026-09-01 record rejected this on measured grounds: the bottleneck was
the link, and sharding adds round trips to a link that punishes them. At 21 MB
that conclusion deserves a re-measurement, not a reversal by assertion.

What would reopen it: a measurement showing bytes (not latency or throughput
per connection) dominate the first paint, and a design for search, sort and
the shelf count, which today read every entry. A shop that fetches one
category cannot answer "search all plugins" without either a server-side
query or the full set.

### F. The npm tarball's icons weight

The tarball is 7.37 MB, of which the icons sidecar is 3.23 MB gzip, and the
shop client does not read it. The 2026-09-01 record's §2 already names the
escape hatch — split plugins and stars into two packages — and deliberately
did not build it; icons now make the same argument with a third artifact.

- Options: accept it (npm is usually the fast path); split the npm package so
  the shop's origin downloads plugins + stars only; or have the shop's npm
  origin fetch icons from http when it needs them (it does not).
- Needs a client release: only if the origin stops expecting one tarball.

### G. Proxy support in the Host's fetch

The 2026-09-01 record §5 declined this deliberately: `NODE_USE_ENV_PROXY` is
read at process start and a plugin cannot set it after boot. It stays declined
unless the npm transport itself fails for a user — the measurement that would
reopen it is a user whose npm registry is reachable but whose npm *transport*
is not.

## 4. Suggested order

1. **B, then A(c).** Both are host-shell changes with no wire-format change
   and no catalog rebuild needed; together they remove the two ways a healthy
   link still fails the shelf.
2. **C.** Needs a client release and a small RPC/state decision; it fixes the
   wait, not the failure.
3. **D**, then **F**, when a client release is in scope anyway.
4. **E** only with the measurement above.

## 5. Decisions requested

- Is a shop client release in scope for C and D?
- For A: accept a watchdog interval of N seconds (a suggestion: 15 s without
  a byte), and a hard ceiling (a suggestion: 10 min)?
- For F: accept the icons weight in the npm tarball, or split the package?

## 6. What would change this proposal

- A measurement showing a stalled origin is rare enough that the current
  fixed budget never fires in practice.
- A catalog whose growth flattens, which would make A(a) sufficient and D
  unnecessary.
- A client release that makes `schemaVersion` negotiation possible, which
  would let the producer retire fields without a parallel file.
