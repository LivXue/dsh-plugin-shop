/** The install flow as the tab hands it to a panel. The flows are a page
 * store's install registry (page-store.ts), begun through flow-registry.ts's
 * `beginInstall` and rendered through `useRegistryFlows` (useFlows.ts). */

import type { InstallArgs } from '../host/index.ts'
import type { KeyedFlow } from './useFlows.ts'

/** One entry's install flow, as the tab hands it to a panel. */
export type InstallFlow = KeyedFlow<InstallArgs>
