// The update e2e fixture, version 1.0.0 — installed before dsh boots, so this
// is the code the boot composition imports. `../v2` is the same package at
// 2.0.0, and the catalog offers that one.
//
// Every activation appends `VERSION` to a file under DSH_HOME. The value is
// read from MODULE SCOPE, never from package.json, so a line reports the code
// that actually ran rather than the version on disk. That distinction is the
// whole fixture: Node caches an imported module by its URL, an update
// rewrites the files at the same URL, and a mount of the new version would
// quietly re-run this one — which is what the shop reported as `live`.
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')

const VERSION = '1.0.0'

module.exports = {
  apply() {
    const home = process.env.DSH_HOME
    if (home !== undefined) appendFileSync(join(home, 'dsh-shop-e2e-update.activations'), `${VERSION}\n`)
  },
}
