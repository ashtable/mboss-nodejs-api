import type {
  BroadcastStatus,
  DeliveryStatus,
  SubscriberSource,
  SubscriberStatus,
} from '@mboss/zod';

/** The subscriber columns any route needs. `pausedAt`/`unsubscribedAt`/`bouncedAt` never leave the database. */
export interface SubscriberRow {
  id: string;
  email: string;
  status: SubscriberStatus;
  source: SubscriberSource;
  tokenVersion: number;
  confirmationEmailSentAt: Date | null;
  createdAt: Date;
}

/** The three statuses a manage link can put a subscriber into. A bounce is not one of them. */
export type ManageStatus = 'subscribed' | 'paused' | 'unsubscribed';

/** A flip is by definition to a terminal status, so `pending` is not a target. */
export type TerminalDeliveryStatus = Exclude<DeliveryStatus, 'pending'>;

/** Keyset position in the admin subscriber list. `createdAt` alone is not unique. */
export interface SubscriberCursor {
  createdAt: Date;
  id: string;
}

export interface SubscriberPageQuery {
  status?: SubscriberStatus;
  q?: string;
  after?: SubscriberCursor;
  limit: number;
}

/** `hasMore` rather than a cursor: the store deals in rows, the route mints the opaque cursor. */
export interface Page<Row> {
  rows: Row[];
  hasMore: boolean;
}

export interface BroadcastRow {
  id: string;
  subject: string;
  bodyMarkdown: string;
  audience: SubscriberStatus[];
  teaserImageUrl: string | null;
  status: BroadcastStatus;
  createdBy: string;
  recipientCount: number | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface BroadcastListRowData {
  broadcast: BroadcastRow;
  sentCount: number;
  failedCount: number;
}

export interface CreateBroadcastInput {
  subject: string;
  bodyMarkdown: string;
  /** Already filtered to the statuses a broadcast may actually reach. */
  audience: SubscriberStatus[];
  teaserImageUrl: string | null;
  createdBy: string;
}

export interface DeliveryCounts {
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * A pending delivery joined to its subscriber. `deliveryId` is the keyset column and never reaches
 * the wire; `currentStatus` is the subscriber's status now, not the audience it was snapshotted
 * into, which is how the worker notices someone who left the audience mid-broadcast.
 */
export interface RecipientRow {
  deliveryId: string;
  subscriberId: string;
  email: string;
  tokenVersion: number;
  currentStatus: SubscriberStatus;
}

/**
 * Every database access the routes make. Two implementations exist: `PrismaStore` against
 * Postgres, and an in-memory double under `test/`. Handlers know only this interface, which is
 * what keeps the sendKey arithmetic, the audience math and the token checks testable with no
 * database in reach.
 */
export interface Store {
  // --- task 7: the public waitlist ---

  /** Insert-or-read. Handles the unique-email race internally rather than surfacing it. */
  findOrCreateSubscriber(email: string): Promise<{ subscriber: SubscriberRow; created: boolean }>;
  findSubscriberById(id: string): Promise<SubscriberRow | null>;
  /**
   * Sets the status, stamping the timestamp of the state being entered and clearing the other, so
   * at most one of `pausedAt` / `unsubscribedAt` is set and it always names the current state.
   * Never touches `tokenVersion` — leaving the list does not revoke the link that got you here;
   * only a bounce does. Re-subscribing is this same call with `subscribed`, not a separate
   * operation.
   */
  setSubscriberStatus(id: string, status: ManageStatus): Promise<SubscriberRow>;

  // --- task 8: the admin console ---

  listSubscribers(query: SubscriberPageQuery): Promise<Page<SubscriberRow>>;
  /** `sent` delivery counts for the given ids, keyed by id. A missing key means zero. */
  countSentDeliveriesFor(subscriberIds: string[]): Promise<Map<string, number>>;
  countSubscribersByStatus(): Promise<Record<SubscriberStatus, number>>;
  /**
   * One transaction: insert the broadcast, insert one pending delivery per subscriber currently in
   * `audience`, and set `recipientCount` to the number actually inserted. Resolving the audience
   * inside the transaction is what makes the count and the rows agree.
   */
  createBroadcastWithSnapshot(input: CreateBroadcastInput): Promise<BroadcastRow>;
  listBroadcasts(): Promise<BroadcastListRowData[]>;
  findBroadcastById(id: string): Promise<BroadcastRow | null>;
  countDeliveries(broadcastId: string): Promise<DeliveryCounts>;

  // --- task 9: the worker's internal surface ---

  listPendingRecipients(
    broadcastId: string,
    after: string | undefined,
    limit: number,
  ): Promise<Page<RecipientRow>>;
  /**
   * Conditional flip: only a row still `pending` changes. Returns the row's status after the call,
   * or null when the broadcast has no delivery for that subscriber. A read-then-write here would
   * race; one conditional UPDATE is what makes a repeated POST a no-op instead of a double-count.
   */
  flipDelivery(
    broadcastId: string,
    subscriberId: string,
    status: TerminalDeliveryStatus,
    error: string | undefined,
  ): Promise<DeliveryStatus | null>;
  /**
   * Conditional too: a broadcast that already completed keeps the status and timestamp it
   * completed with. Returns the status after the call, or null for an unknown broadcast.
   */
  markBroadcastComplete(
    id: string,
    status: 'sent' | 'failed',
    at: Date,
  ): Promise<BroadcastStatus | null>;
  recordConfirmationSent(id: string, at: Date): Promise<Date | null>;
  /**
   * Conditional: only a subscriber not already `bounced` flips, and only that flip bumps
   * `tokenVersion`. The provider retries webhooks, and an unconditional update would revoke the
   * subscriber's manage links again on every retry.
   */
  markBounced(email: string, at: Date): Promise<boolean>;
}
