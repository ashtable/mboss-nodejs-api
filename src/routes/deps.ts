import type { LinkKeyRing } from '@mboss/core/signed-links';

import type { WorkflowEnqueuer } from '../enqueue/types.js';
import type { Store } from '../store/types.js';

/**
 * What every route module is handed. `now` is injected rather than read from the clock so the
 * 24h resend rule can be tested at a fixed instant instead of by arithmetic on fixtures.
 */
export interface RouteDeps {
  store: Store;
  enqueuer: WorkflowEnqueuer;
  keyRing: LinkKeyRing;
  now: () => Date;
}
