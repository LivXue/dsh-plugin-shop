// The fixture's patch inserts a loader entry named after this package, and
// the loader imports and applies every entry it activates. The P1 real-install
// test never booted a profile, so the original patch-only fixture never
// needed a module — the web full-flow e2e exposed that a bootable profile
// requires the entry to be a real cordis plugin. A no-op apply is the honest
// minimal entry: the row activates, does nothing, and the boot proceeds.
module.exports = { apply() {} }
