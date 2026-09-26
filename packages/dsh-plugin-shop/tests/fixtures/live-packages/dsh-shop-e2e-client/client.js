// Registers a factory and nothing else: the e2e asserts that the shop
// reported `reload` and that the reload delivered this file, not that this
// component renders. Keeping it inert means a harness change to the component
// contract cannot fail this suite for an unrelated reason. The flag is the
// delivery proof: set as the page evaluates the file, apart from any contract.
window.__dshShopE2eClient = true
window.__ModuleLoader__.load({ id: 'dsh-shop-e2e-client', factory: () => ({ apply() {} }) })
