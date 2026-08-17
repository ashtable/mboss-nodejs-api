import type { DBOSClient } from '@dbos-inc/dbos-sdk';

import type { EnqueueRequest, WorkflowEnqueuer } from './types.js';

/**
 * The only file in this service that talks to DBOS.
 *
 * Two properties of `enqueue` the worker has to be built around. Enqueuing a workflow id that
 * already exists returns a handle to the existing workflow instead of starting a second one, but
 * only when the workflow's name and class match — so the worker must register these workflows as
 * free functions via `DBOS.registerWorkflow`, never as static methods of a class, or the second
 * enqueue of a repeat signup throws on the class-name mismatch. And a colliding enqueue keeps the
 * first call's arguments; ours are all derived from the id in the workflow id, so nothing
 * time-varying may ever be added to them.
 */
export class DbosEnqueuer implements WorkflowEnqueuer {
  constructor(private readonly client: DBOSClient) {}

  async enqueue(request: EnqueueRequest): Promise<void> {
    await this.client.enqueue(
      {
        workflowName: request.workflowName,
        queueName: request.queueName,
        // Omitted for a test send, which is meant to be repeatable: the SDK then generates an id.
        ...(request.workflowID === undefined ? {} : { workflowID: request.workflowID }),
      },
      request.args,
    );
  }
}
