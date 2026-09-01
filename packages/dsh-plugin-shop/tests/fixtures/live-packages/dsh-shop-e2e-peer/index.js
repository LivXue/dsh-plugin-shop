// The harness-compatibility e2e fixture: its package.json declares a peer
// dependency, @deepseek-ai/dsh-client-store — the real module whose absence
// broke a real user's harness on the 0.1.1-rc.2 line — that this test's
// profile never installs (autoInstallPeers: false in the profile's own
// pnpm-workspace.yaml, same as every real dsh profile). The host's
// nodeResolver (src/host/peers.ts) therefore reports it missing, which is
// what the e2e's badge and install-gate-warning assertions rest on; nothing
// this module does at runtime is part of that proof.
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
