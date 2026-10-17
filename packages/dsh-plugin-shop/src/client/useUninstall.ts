/** The uninstall flows as the tab hands them to a panel and to the shadowed
 * rows. The flows are a page store's uninstall registry (page-store.ts),
 * begun through flow-registry.ts's `beginUninstall` and rendered through
 * `useRegistryFlows` (useFlows.ts). */

import type { KeyedFlow, UseKeyedFlows } from './useFlows.ts'

/** One entry's uninstall flow, as the tab hands it to a panel. */
export type UninstallFlow = KeyedFlow<{ name: string }>
export type UseUninstallFlows = UseKeyedFlows<{ name: string }>
