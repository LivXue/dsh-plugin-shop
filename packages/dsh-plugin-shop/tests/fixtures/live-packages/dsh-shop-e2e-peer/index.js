// The harness-compatibility e2e fixture. Its package.json declares peers
// this test's profile never installs (autoInstallPeers: false in the
// profile's own pnpm-workspace.yaml, same as every real dsh profile), and the
// verdict judges them in two stages (design 2026-09-01 §9.1):
// `@dsh-shop-e2e/absent-peer` is provided by nothing, so the badge names it;
// `@deepseek-ai/dsh-client-store` — the real module whose absence broke a
// real user's harness on the 0.1.1-rc.2 line — has no package on disk
// either, but the web client's module table seeds it, so the badge must NOT
// name it; and `@deepseek-ai/dsh-llm` is a package the harness itself
// ships — through the link farm on 0.1.5, through its runtime resolution on
// 0.1.7, which keeps no link farm (§11) — so the badge must not name it
// either. It also declares a `dsh.compatibility` this harness does not
// meet. tests/fixtures/catalog-server.ts carries the same facts, and the
// e2e's assertions rest on those; nothing this module does at runtime is
// part of that proof.
//
// The patch is the same plain `- id:` / `name:` row as the dsh-shop-e2e-live
// fixture — the only form the shop's hot tree can mount without a restart —
// so the install this fixture drives reaches its terminal done state
// without needing one. That is what "warn, never block" comes down to here:
// a real peer-dependency absence only warns during the profile's pnpm
// install, it never fails it, and a no-op apply is the honest minimal entry
// for a fixture that is not itself under test (the loader imports and
// applies every entry it activates).
module.exports = { apply() {} }
