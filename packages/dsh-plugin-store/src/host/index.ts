/** StoreGateway: the Host half of dsh-plugin-store (§5.1). */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** Test-only injection points; production callers pass nothing. Forward-declared
 * here so `src/index.ts` can re-export it; Task 4 fills the fields. */
export interface StoreGatewayOptions {}

/** Remote-only service exposing the five store methods of §7.3. */
export class StoreGateway extends TypertRemoteService {
  constructor(ctx: Context, _options: StoreGatewayOptions = {}) {
    super(ctx, 'store')
  }
}

export default StoreGateway
