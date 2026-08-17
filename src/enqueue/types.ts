/**
 * Mirrors `DBOSClient.enqueue`'s own shape so the
 * recording double under `test/` captures exactly
 * what would have reached DBOS.
 *
 * There is deliberately no `deduplicationID` and
 * no `duplicationPolicy`. A deduplication id is
 * scoped to its queue and is cleared when the
 * workflow reaches a terminal state, so a repeat
 * signup after the first confirmation finished
 * would enqueue a second email. A workflow id is
 * permanent: enqueuing an id that already exists
 * returns a handle to the existing workflow
 * whatever state it is in, which is the
 * idempotency this service actually needs.
 */
export interface EnqueueRequest {
  workflowName: string;
  queueName: string;
  workflowID?: string;
  args: unknown;
}

/**
 * The seam between the routes and DBOS:
 * production wires a real client, tests wire a
 * recording double, and handlers depend on
 * nothing more than this.
 */
export interface WorkflowEnqueuer {
  enqueue(request: EnqueueRequest): Promise<void>;
}
