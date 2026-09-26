// The update e2e fixture, version 2.0.0 — the version the catalog offers.
// `../v1` is the same package at 1.0.0, installed before dsh boots, and its
// header says what the activation log records and why. The two files differ
// in `VERSION` alone.
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')

const VERSION = '2.0.0'

module.exports = {
  apply() {
    const home = process.env.DSH_HOME
    if (home !== undefined) appendFileSync(join(home, 'dsh-shop-e2e-update.activations'), `${VERSION}\n`)
  },
}
