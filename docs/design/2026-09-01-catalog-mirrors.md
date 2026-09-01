# Catalog mirrors and origin racing — design

Status: **specified 2026-09-01, not yet implemented.** The catalog
publishes to npm alongside GitHub Pages; the Host races a cheap pointer
request across several origins and downloads the bulk from whichever
answers first. The authority spec
(`2026-08-18-dsh-plugin-shop-design.md` §5.1 and its threat-model row on
catalog man-in-the-middle) is amended in the same change. English only,
per convention.

## 0. The problem

A user in mainland China reported the shop taking minutes to open. The
first hypothesis — 8897 entries in a 6.5 MB `plugins.json` is simply too
much data, so shard it and load the top of the shelf first — turned out
to be wrong. The measurements in §1 put every stage except the network
in the tens of milliseconds, and put the network at **65.7 seconds for
1.48 MB**, against 1.2 seconds for the identical bytes over a proxy.

Sharding divides bytes. This is not a bytes problem, and sharding would
have made it worse: the same total payload over more round trips, each
paying the same penalty. That finding is what this design replaces the
sharding idea with, and §5 records it so the idea is not revived without
new evidence.

## 1. Evidence gathered before design

Measured on a China-side machine, not inferred. Where a proxy is
involved it is named; `direct` means `curl --noproxy '*'` or a Node
`fetch` with no dispatcher.

- **The published file is already compressed in transit.** GitHub Pages
  serves the 6,532,788-byte `plugins.json` as **1,476,314 bytes** of
  gzip, and Node's `fetch` negotiates it without being asked.
- **Everything except the network is fast.** Integrity hash 12 ms,
  `JSON.parse` 28 ms, re-serialize 14 ms. The real `loadCatalog` —
  decompress, parse, zod-validate 8897 entries, verify sha256 — is
  **135 ms** cold and 65 ms against the warm disk cache.
- **The network dominates everything else.** Node `fetch`, identical
  1,476,314 gzip bytes, identical machine: **1,218 ms** through a proxy,
  **65,744 ms** direct. Same bytes, 54×.
- **Host throughput, direct, same box.** Decimal MB throughout, one
  sample each; the slow rows vary by tens of percent between runs, the
  fast ones barely at all.

  | Origin | Bytes | Time | Throughput |
  |---|---|---|---|
  | `registry.npmmirror.com` | 4,174,769 | 0.33 s | **12.53 MB/s** |
  | `registry.npmjs.org` | 4,174,769 | 2.09 s | 1.99 MB/s |
  | `unpkg.com` | 1,598,160 | 1.90 s | 0.84 MB/s |
  | `cdnjs.cloudflare.com` | 732,633 | 1.47 s | 0.50 MB/s |
  | `cdn.jsdelivr.net` | 1,494,134 | 48.55 s | 0.03 MB/s |
  | `LivXue.github.io` (current) | 1,476,314 | 53.70 s | **0.03 MB/s** |

- **The npm mirror beats the proxy.** The same GitHub Pages file through
  the proxy is 1,476,314 B in 1.03 s (1.43 MB/s), so npmmirror direct is
  **8.8× faster than the current origin through a proxy**. This is what
  removes proxy support from scope (§5).
- **The mirror is current.** `0.6.0-beta.2`, published to npm at
  15:13 UTC, was already on npmmirror when checked the same hour, with
  identical `dist-tags` and version count.
- **The mirror rewrites `dist.tarball` to its own host.** Resolving
  `latest` against npmmirror returns a tarball URL already pointing at
  npmmirror, so an origin needs no per-host URL construction.
- **`registry/<pkg>/latest` is cheap.** 13.5 KB in 0.17 s, and it
  carries `dist.integrity` (sha512) and the registry signature.
- **npmmirror's file-path API is whitelist-gated.** `…/<version>/files/…`
  returns `403 … not allow to unpkg files` for a package not on the cnpm
  whitelist. The tarball path has no such gate, so the design uses the
  tarball.
- **npmmirror syncs on demand, and the sync can be triggered.**
  `PUT registry-direct.npmmirror.com/-/package/<pkg>/syncs` returns
  `201 {"ok":true,"id":…,"state":"waiting"}`; polling that id reaches
  `processing` with a log URL. Without this the first requester of each
  new version pays the sync — and that first requester is exactly the
  user this design exists for.
- **Daily data packages are an established npm pattern.** `caniuse-db`:
  1887 versions over 4564 days, 2.9 per week. The catalog would publish
  ~7 per week at 1.53 MB gzip (`plugins.json` 1.38 MB + `stars.json`
  0.15 MB).

## 2. What is published

A second artifact of the same build: the npm package
**`dsh-plugin-shop-catalog`**, containing the `dist/v1/` tree that Pages
already serves, byte for byte.

```
package/
  package.json
  README.md
  index.js          resolves the bundled paths; exports read helpers
  v1/index.json
  v1/plugins.<sha256>.json
  v1/stars.<sha256>.json
```

**One build, two transports.** The publish step packs artifacts the
build has already written. A second code path producing a second
artifact would be free to drift from the first, and nothing downstream
could tell which one was wrong.

**It is a real package, not a CDN parking spot.** The cnpm whitelist
rejects packages that are not genuine npm libraries but use the mirror
to distribute data files, and that objection is correct in spirit even
though the tarball path this design uses is not whitelist-gated. The
package earns its place by being consumable: `index.js`, a README, and a
genuine use — any dsh tooling can depend on it to read the catalog
without reimplementing the fetch. Its consumer is a real tool, which is
the distinction the whitelist is drawing.

### Version

`YYYY.MMDD.N` — `2026.901.0`, `2026.901.1` for a second build the same
day. Valid semver, monotonic across month and year boundaries
(`2026.1015.0 > 2026.901.0`, `2027.101.0 > 2026.1231.0`), and the build
date reads straight off it. Clients resolve `latest` and never parse it.

### When it publishes

When `plugins.sha256` or `stars.sha256` differs from the published
`latest`. In practice this is daily: 15,678 tracked repositories do not
go a day without a star changing, so the content-addressed skip saves
little. The honest figure is ~7 publishes per week, 2.4× `caniuse-db`.

If that volume ever becomes a problem the escape hatch is to split the
two artifacts into two packages — plugins (~2–3/week) and stars (daily,
0.15 MB), halving the yearly footprint. That mirrors the sidecar split
the catalog already has, and it is deliberately not built now.

### After publishing

CI triggers the npmmirror sync and waits for the task to leave
`waiting`, so the first Chinese reader of a new version does not pay for
the mirror's cold cache.

## 3. How an origin is chosen

An origin produces a `CatalogSnapshot`; the two transports differ only
in how they get there.

```
Origin
  probe()      -> Pointer                cheap: index.json (~400 B) | latest (13.5 KB)
  fetchData(p) -> { plugins, stars }
```

The npm transport resolves `latest`, downloads `dist.tarball`, and
extracts `v1/`. The extracted `v1/index.json` **is** the existing
pointer, so past the transport boundary the cache and validation layers
cannot tell the two apart and do not change.

### The race

```
        npm  @ registry.npmmirror.com
        npm  @ registry.npmjs.org         probe all in parallel
        npm  @ registry from ~/.npmrc     -> first to answer wins
        HTTP @ LivXue.github.io/v1/       -> bulk fetch from the winner
                                          -> on failure, next by finish order
```

**Every load races; no winner is cached.** Caching the winner needs a
state file, a staleness policy, and a re-probe trigger — three things
that can be wrong — to save two requests of a few hundred bytes each,
once per boot (the 5-minute disk-cache freshness window suppresses the
rest). Racing every time is self-healing instead: a link that changes is
followed with no invalidation logic at all.

Racing also makes a wrong candidate free, which is why reading
`registry=` out of `~/.npmrc` is worth doing. A user who has configured
a mirror gets it honoured; a bad guess loses a 400-byte request.

**An explicit override disables the race.** When `DSH_SHOP_CATALOG_URL`
or a row-level `catalogUrl` is set, that origin is used alone. Racing an
explicit choice against the defaults would make the e2e fixture
nondeterministic and would silently defeat "point the shop at my own
mirror", which the README documents.

### Origins may disagree

Mirrors lag by minutes and the two transports publish at different
moments, so the winner may serve a slightly older build. This is
immaterial for a daily snapshot, it is already visible — `builtAt` is
rendered — and the `stale` flag already exists for the case that
matters.

## 4. Integrity and trust

| Transport | Verification |
|---|---|
| HTTP | sha256 from `index.json`, as today |
| npm | npm's `dist.integrity` (sha512) over the tarball, **then** the inner `index.json`'s sha256 over `plugins.json` |

The second npm check is not redundant. It puts the extracted data
through the identical validation path the HTTP transport uses, which is
what lets the cache layer stay untouched — the same content from any
origin lands on the same `plugins.<sha>.json` filename.

**It improves the residual risk the authority spec names.** That spec's
threat table accepts "`index.json` itself being replaced, mitigated only
by HTTPS". The npm transport adds a second anchor: `dist.integrity` is
computed by the registry at publish time and carried in a signed
packument.

**A mirror can serve a stale-but-valid catalog.** It cannot forge one.
This is the same registry the user installs every plugin from, so it is
not a new trust surface — but it is a real one, and naming it is the
point.

### Tar

A read-only parser, ~40 lines: 512-byte headers, collect the entries
under `package/v1/`, reject any name escaping `package/`. It cannot know
all three filenames up front — two carry a content hash — so it returns
the map and the caller selects by the pointer it finds inside. It is a pure function
(bytes to a file map) and belongs in the pure core; the network half
lives in `npm-origin.ts` in the shell. No fourth runtime dependency —
the shop has three (`js-yaml`, `semver`, `zod`) and `zlib` is built in.

## 5. Deliberately not built

- **Sharding the catalog by star count.** The originating request. §0
  and §1 show the bottleneck is the link, not the payload; sharding
  would add round trips to a link that punishes exactly that. Revive it
  only against a measurement showing bytes, not latency, as the cost.
- **Proxy support in the Host's fetch.** Proposed while it looked like a
  cheap win, withdrawn on the numbers: npm direct is 8.8× faster than
  GitHub through a proxy, so it rescues nobody once §3 lands. The only
  remaining case is a link where direct is blocked outright rather than
  slow — a user whose npm cannot reach anything, whose dsh therefore
  cannot install plugins at all. Cost is a fourth dependency (`undici`)
  or ~80 lines of hand-written CONNECT tunnelling; `NODE_USE_ENV_PROXY`
  is read at process start and a plugin cannot set it after boot.
- **Caching the winning origin** (§3).
- **Splitting plugins and stars into two packages** (§2).
- **The cnpm unpkg whitelist.** Being listed would allow plain JSON over
  HTTP with no tar step, but it depends on a third party accepting a PR
  and cannot be a primary path. Worth pursuing later as a simplification.

## 6. Testing

| Layer | What is proven |
|---|---|
| Pure | tar parsing from real tarball bytes; path-escape rejection; race selection through injected probes; pointer normalisation |
| Registry | the pack step's contents; version derivation; the publish-skip decision |
| Host | origin selection through an injected fetch; sha512 mismatch is refused; a winner that fails the bulk fetch falls through to the next |
| E2E | the existing `catalog-server.ts` HTTP fixture, plus an npm-origin fixture serving a real packument and a real tarball |

**The load-bearing assertion:** for one build, the npm transport and the
HTTP transport produce a byte-identical snapshot. That is the §2
property; if it drifts, the design's premise is gone.

Two repository rules bind hard here. **The tar fixture must come from
`npm pack`**, never hand-assembled — a fixture written from the same
assumption as the code agrees with the code, which is how 0.5.0 through
0.5.2 each shipped broken past a green suite. And **fixture arithmetic
must be verified**: a hash or size assertion has to actually hold.

## 7. Release

1. The Host change is a version that alters what the host reads, so it
   goes through the `beta` dist-tag first — the class the channel exists
   for.
2. The catalog package's **first publish is a manual
   `workflow_dispatch`**, before the daily schedule depends on it. The
   publish token is a granular npm token (`whoami` succeeds,
   `/-/npm/v1/user` returns nothing, which is the granular signature),
   and granular tokens bypass 2FA — but that is inference until a real
   publish proves it, and the account has blocked non-interactive
   publishes before.
3. GitHub Pages keeps publishing unchanged throughout. It stays in the
   origin list, so a reader outside China, or any reader when npm is
   unreachable, is unaffected at every step.
