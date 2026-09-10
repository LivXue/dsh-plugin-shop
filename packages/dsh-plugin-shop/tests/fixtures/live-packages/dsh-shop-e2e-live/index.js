// The hot-mount e2e fixture: its patch is a plain `- id:` / `name:` row — the
// only form the shop's hot tree can mount without a restart — and a no-op
// apply is the honest minimal entry (same reasoning as the hello fixture:
// the loader imports and applies every entry it activates).
//
// Liveness is proved through the LOADER INVENTORY, not an HTTP route: the
// harness bundles no plugin-side HTTP router (`@cordisjs/plugin-http` /
// `ctx.router` is absent from the dsh bundles), so a fixture this simple
// cannot register a route from `apply()`. The inventory — the strict read of
// what the loader actually mounted — lists this entry (id
// `include:typert-gateway:mkt-e2e-live`: the shop mounts the hot tree from
// its own ctx, a subtree of the gateway include, and the `mkt-` row id
// survives at the end of the chain) as enabled, with its root fiber in the
// active phase, while the fiber runs, and drops it once the shop's hot
// uninstall disposes the fiber. The e2e asserts exactly those two facts.
// HOW it reads them out of the DOM is deliberately not restated here: the
// harness has renamed that markup twice, this comment carried the dead
// spelling through both, and web-full-flow.e2e.ts's contract header owns it.
module.exports = { apply() {} }
