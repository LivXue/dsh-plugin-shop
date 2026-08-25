/** Copy dictionaries for the store Settings tab. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  tab: '插件市场',
  tierVerified: '已审核',
  tierVerifiedStale: '审核版本过期',
  tierCommunity: '社区',
  staleLabel: '过期快照',
} satisfies Record<string, string>

/** Store locale key union. */
export type StoreLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  tab: 'Plugin store',
  tierVerified: 'Verified',
  tierVerifiedStale: 'Reviewed version stale',
  tierCommunity: 'Community',
  staleLabel: 'stale snapshot',
} satisfies Record<StoreLocaleKey, string>
