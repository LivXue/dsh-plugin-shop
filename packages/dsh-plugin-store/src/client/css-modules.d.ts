/** CSS modules consumed by the browser half (StoreTab.module.css). The tsdown
 * client pipeline maps each local class to a content-derived name at build
 * time (tsdown.client.config.ts); vite stubs the import in tests. Only the
 * keys are relied on, so both shapes type as a plain string map. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
