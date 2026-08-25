/** Copy dictionaries for the store Settings tab. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  tab: '插件市场',
} satisfies Record<string, string>

/** Store locale key union. */
export type StoreLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  tab: 'Plugin store',
} satisfies Record<StoreLocaleKey, string>
