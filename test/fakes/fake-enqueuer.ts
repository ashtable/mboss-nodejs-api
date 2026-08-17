import type { EnqueueRequest, WorkflowEnqueuer } from '../../src/enqueue/types.js';

/** Records what would have gone to DBOS, in call order. */
export class FakeEnqueuer implements WorkflowEnqueuer {
  readonly calls: EnqueueRequest[] = [];

  async enqueue(request: EnqueueRequest): Promise<void> {
    this.calls.push(request);
  }
}
