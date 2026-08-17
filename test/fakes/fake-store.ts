import type {
  BroadcastStatus,
  DeliveryStatus,
  SubscriberStatus,
} from '@mboss/zod';

import type {
  BroadcastListRowData,
  BroadcastRow,
  CreateBroadcastInput,
  DeliveryCounts,
  ManageStatus,
  Page,
  RecipientRow,
  Store,
  SubscriberPageQuery,
  SubscriberRow,
  TerminalDeliveryStatus,
} from '../../src/store/types.js';

interface DeliveryRow {
  id: string;
  broadcastId: string;
  subscriberId: string;
  status: DeliveryStatus;
  error: string | null;
}

/**
 * An in-memory `Store`. Its
 * conditional-update semantics are
 * mirrored deliberately: `flipDelivery`
 * and `markBounced` are the two methods
 * whose whole point is that they do
 * nothing when the row has already
 * moved, and a double that flipped
 * unconditionally would let the
 * hermetic suite prove something the
 * real service does not do.
 *
 * Ids are sequential and predictable
 * so tests can assert on the workflow
 * ids built from them.
 */
export class FakeStore implements Store {
  readonly subscribers: SubscriberRow[] = [];
  readonly broadcasts: BroadcastRow[] = [];
  readonly deliveries: DeliveryRow[] = [];

  /**
   * Recorded in call order, so a test
   * can assert the snapshot was written
   * before the enqueue.
   */
  readonly writes: string[] = [];

  /**
   * Only the bounce path stamps a
   * timestamp the routes never read
   * back.
   */
  readonly bouncedAt = new Map<string, Date>();

  private subscriberSeq = 0;
  private broadcastSeq = 0;
  private deliverySeq = 0;
  private clock = Date.UTC(2026, 0, 1);

  /**
   * Distinct, ascending `createdAt`
   * values unless a test asks for a
   * specific one.
   */
  private nextCreatedAt(): Date {
    this.clock += 1000;
    return new Date(this.clock);
  }

  /**
   * Inserts a subscriber with
   * sequential defaults, any of which
   * a test can override.
   */
  seedSubscriber(
    overrides: Partial<SubscriberRow> & { email: string },
  ): SubscriberRow {
    this.subscriberSeq += 1;
    const row: SubscriberRow = {
      id: `sub_${this.subscriberSeq}`,
      status: 'subscribed',
      source: 'email',
      tokenVersion: 1,
      confirmationEmailSentAt: null,
      createdAt: this.nextCreatedAt(),
      ...overrides,
    };
    this.subscribers.push(row);
    return row;
  }

  /**
   * Inserts a broadcast with
   * sequential defaults, any of which
   * a test can override.
   */
  seedBroadcast(overrides: Partial<BroadcastRow> = {}): BroadcastRow {
    this.broadcastSeq += 1;
    const row: BroadcastRow = {
      id: `bc_${this.broadcastSeq}`,
      subject: 'Subject',
      bodyMarkdown: 'Body',
      audience: ['subscribed'],
      teaserImageUrl: null,
      status: 'draft',
      createdBy: 'admin@example.com',
      recipientCount: null,
      createdAt: this.nextCreatedAt(),
      startedAt: null,
      completedAt: null,
      ...overrides,
    };
    this.broadcasts.push(row);
    return row;
  }

  /**
   * Inserts one delivery row for a
   * broadcast/subscriber pair.
   */
  seedDelivery(
    broadcastId: string,
    subscriberId: string,
    status: DeliveryStatus,
  ): void {
    this.deliverySeq += 1;
    this.deliveries.push({
      id: `del_${String(this.deliverySeq).padStart(4, '0')}`,
      broadcastId,
      subscriberId,
      status,
      error: null,
    });
  }

  // --- the public waitlist ---

  /**
   * Returns the existing row on a
   * repeat email, else seeds a new one.
   */
  async findOrCreateSubscriber(
    email: string,
  ): Promise<{ subscriber: SubscriberRow; created: boolean }> {
    const existing = this.subscribers.find((row) => row.email === email);
    if (existing) return { subscriber: existing, created: false };
    return { subscriber: this.seedSubscriber({ email }), created: true };
  }

  /** Looks up a subscriber by id, or null. */
  async findSubscriberById(id: string): Promise<SubscriberRow | null> {
    return this.subscribers.find((row) => row.id === id) ?? null;
  }

  /**
   * Sets the status. `SubscriberRow`
   * carries no `pausedAt` /
   * `unsubscribedAt` columns for the
   * fake to stamp — those never reach
   * a route, so there is nothing here
   * to mirror.
   */
  async setSubscriberStatus(
    id: string,
    status: ManageStatus,
  ): Promise<SubscriberRow> {
    const row = this.require(id);
    row.status = status;
    return row;
  }

  // --- the admin console ---

  /**
   * Filters, sorts newest first, and
   * applies the keyset page the
   * query's `after` cursor asks for.
   */
  async listSubscribers(
    query: SubscriberPageQuery,
  ): Promise<Page<SubscriberRow>> {
    const needle = query.q?.toLowerCase();
    const matching = this.subscribers
      .filter(
        (row) => query.status === undefined || row.status === query.status,
      )
      .filter(
        (row) =>
          needle === undefined || row.email.toLowerCase().includes(needle),
      )
      .sort(byCreatedAtThenIdDescending);

    const after = query.after;
    const remaining =
      after === undefined
        ? matching
        : matching.filter(
            (row) =>
              row.createdAt.getTime() < after.createdAt.getTime() ||
              (row.createdAt.getTime() === after.createdAt.getTime() &&
                row.id < after.id),
          );

    return {
      rows: remaining.slice(0, query.limit),
      hasMore: remaining.length > query.limit,
    };
  }

  /**
   * Counts `sent` deliveries per
   * subscriber id; a missing key
   * means zero.
   */
  async countSentDeliveriesFor(
    subscriberIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const delivery of this.deliveries) {
      if (
        delivery.status !== 'sent' ||
        !subscriberIds.includes(delivery.subscriberId)
      )
        continue;
      counts.set(
        delivery.subscriberId,
        (counts.get(delivery.subscriberId) ?? 0) + 1,
      );
    }
    return counts;
  }

  /**
   * Tallies subscribers by status;
   * every status is present, even
   * at zero.
   */
  async countSubscribersByStatus(): Promise<Record<SubscriberStatus, number>> {
    const counts: Record<SubscriberStatus, number> = {
      subscribed: 0,
      paused: 0,
      unsubscribed: 0,
      bounced: 0,
    };
    for (const row of this.subscribers) counts[row.status] += 1;
    return counts;
  }

  /**
   * Snapshots the audience into pending
   * deliveries and stamps
   * `recipientCount`, mirroring the
   * real store's one-transaction
   * contract.
   */
  async createBroadcastWithSnapshot(
    input: CreateBroadcastInput,
  ): Promise<BroadcastRow> {
    const members = this.subscribers.filter((row) =>
      input.audience.includes(row.status),
    );

    // The real store stamps `startedAt`
    // with its own clock; here it is the
    // row's own createdAt, which keeps
    // the fake deterministic while
    // modelling the same "created means
    // started".
    const createdAt = this.nextCreatedAt();
    const broadcast = this.seedBroadcast({
      subject: input.subject,
      bodyMarkdown: input.bodyMarkdown,
      audience: input.audience,
      teaserImageUrl: input.teaserImageUrl,
      createdBy: input.createdBy,
      recipientCount: members.length,
      status: 'sending',
      createdAt,
      startedAt: createdAt,
    });

    for (const member of members)
      this.seedDelivery(broadcast.id, member.id, 'pending');
    this.writes.push(`broadcast:${broadcast.id}`);
    return broadcast;
  }

  /**
   * Lists broadcasts newest first,
   * with each one's sent/failed
   * counts attached.
   */
  async listBroadcasts(): Promise<BroadcastListRowData[]> {
    return [...this.broadcasts]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((broadcast) => {
        const counts = this.countFor(broadcast.id);
        return {
          broadcast,
          sentCount: counts.sent,
          failedCount: counts.failed,
        };
      });
  }

  /** Looks up a broadcast by id, or null. */
  async findBroadcastById(id: string): Promise<BroadcastRow | null> {
    return this.broadcasts.find((row) => row.id === id) ?? null;
  }

  /**
   * Delivery counts for one
   * broadcast, by status.
   */
  async countDeliveries(broadcastId: string): Promise<DeliveryCounts> {
    return this.countFor(broadcastId);
  }

  // --- the worker's internal surface ---

  /**
   * Pending deliveries for a
   * broadcast, keyset-paged by
   * delivery id and joined to each
   * subscriber's current row.
   */
  async listPendingRecipients(
    broadcastId: string,
    after: string | undefined,
    limit: number,
  ): Promise<Page<RecipientRow>> {
    const pending = this.deliveries
      .filter(
        (row) => row.broadcastId === broadcastId && row.status === 'pending',
      )
      .filter((row) => after === undefined || row.id > after)
      .sort((a, b) => (a.id < b.id ? -1 : 1));

    const rows = pending.slice(0, limit).map((delivery) => {
      const subscriber = this.require(delivery.subscriberId);
      return {
        deliveryId: delivery.id,
        subscriberId: subscriber.id,
        email: subscriber.email,
        tokenVersion: subscriber.tokenVersion,
        currentStatus: subscriber.status,
      };
    });

    return { rows, hasMore: pending.length > limit };
  }

  /**
   * Flips a pending delivery to a
   * terminal status; a delivery
   * already flipped is left alone,
   * matching the real store's single
   * conditional UPDATE.
   */
  async flipDelivery(
    broadcastId: string,
    subscriberId: string,
    status: TerminalDeliveryStatus,
    error: string | undefined,
  ): Promise<DeliveryStatus | null> {
    const delivery = this.deliveries.find(
      (row) =>
        row.broadcastId === broadcastId && row.subscriberId === subscriberId,
    );
    if (!delivery) return null;

    if (delivery.status === 'pending') {
      delivery.status = status;
      delivery.error = error ?? null;
    }
    return delivery.status;
  }

  /**
   * Marks a broadcast complete; one
   * already completed keeps its
   * original status and timestamp.
   */
  async markBroadcastComplete(
    id: string,
    status: 'sent' | 'failed',
    at: Date,
  ): Promise<BroadcastStatus | null> {
    const broadcast = this.broadcasts.find((row) => row.id === id);
    if (!broadcast) return null;

    if (broadcast.completedAt === null) {
      broadcast.status = status;
      broadcast.completedAt = at;
    }
    return broadcast.status;
  }

  /**
   * Stamps when a confirmation email
   * was sent, or null for an unknown
   * subscriber.
   */
  async recordConfirmationSent(id: string, at: Date): Promise<Date | null> {
    const row = this.subscribers.find((subscriber) => subscriber.id === id);
    if (!row) return null;

    row.confirmationEmailSentAt = at;
    return at;
  }

  /**
   * Flips a subscriber to bounced and
   * bumps its token version; one
   * already bounced is left alone, so
   * a retried webhook does not revoke
   * links twice.
   */
  async markBounced(email: string, at: Date): Promise<boolean> {
    const row = this.subscribers.find(
      (subscriber) => subscriber.email === email,
    );
    if (!row || row.status === 'bounced') return false;

    row.status = 'bounced';
    row.tokenVersion += 1;
    this.bouncedAt.set(row.id, at);
    return true;
  }

  /**
   * Shared by `countDeliveries` and
   * `listBroadcasts`.
   */
  private countFor(broadcastId: string): DeliveryCounts {
    const counts: DeliveryCounts = {
      pending: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    };
    for (const delivery of this.deliveries) {
      if (delivery.broadcastId === broadcastId) counts[delivery.status] += 1;
    }
    return counts;
  }

  /**
   * Looks up a subscriber by id;
   * throws if missing.
   */
  private require(id: string): SubscriberRow {
    const row = this.subscribers.find((subscriber) => subscriber.id === id);
    if (!row) throw new Error(`fake store has no subscriber ${id}`);
    return row;
  }
}

/**
 * The same tie-break as the real
 * store: newest first, then id
 * descending.
 */
function byCreatedAtThenIdDescending(
  a: SubscriberRow,
  b: SubscriberRow,
): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : -1;
}
