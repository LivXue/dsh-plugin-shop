// The restart-fallback e2e fixture: its patch row carries a `config:` block,
// a perfectly valid bundle-layer patch that the hot tree cannot replicate —
// parseSimplePatch rejects any row that is not a plain `- id:` / `name:`
// pair, so the shop reports the install as done with the bilingual restart
// reason ("restart required") instead of mounting it. The apply never runs
// in the hot path (the mount is refused before the module is imported); it
// runs at the next boot, when the bundle layer activates the row normally.
module.exports = { apply() {} }
