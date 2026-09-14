// The activation e2e fixture. Its reason for existing is the `dsh.client`
// declaration in package.json: the three older live fixtures declare only
// `dsh.bundle`, so every hot-mount assertion in this suite was made about a
// package with no browser half — which is exactly the blind spot the
// reload/restart confusion of 2026-09-11 came through.
module.exports = { apply() {} }
