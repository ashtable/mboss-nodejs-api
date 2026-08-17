import type { BroadcastStatus, DeliveryStatus, SubscriberStatus } from '@mboss/zod';

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
 * An in-memory `Store`. Its conditional-update semantics are mirrored deliberately: `flipDelivery`
 * and `markBounced` are the two methods whose whole point is that they do nothing when the row has
 * already moved, and a double that flipped unconditionally would let the hermetic suite prove
 * something the real service does not do.
 *
 * Ids are sequential and predictable so tests can assert on the workflow ids built from them.
 */
export class FakeStore implements Store {
  readonly subscribers: SubscriberRow[] = [];
  readonly broadcasts: BroadcastRow[] = [];
  readonly deliveries: DeliveryRow[] = [];

  /** Recorded in call order, so a test can assert the snapshot was written before the enqueue. */
  readonly writes: string[] = [];

  /** Only the bounce path stamps a timestamp the routes never read back. */
  readonly bouncedAt = new Map<string, Date>();

  private subscriberSeq = 0;
  private broadcastSeq = 0;
  private deliverySeq = 0;
  private clock = Date.UTC(2026, 0, 1);

  /** Distinct, ascending `createdAt` values unless a test asks for a specific one. */
  private nextCreatedAt(): Date {
    this.clock += 1000;
    return new Date(this.clock);
  }

  seedSubscriber(overrides: Partial<SubscriberRow> & { email: string }): SubscriberRow {
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

  seedDelivery(broadcastId: string, subscriberId: string, status: DeliveryStatus): void {
    this.deliverySeq += 1;
    this.deliveries.push({
      id: `del_${String(this.deliverySeq).padStart(4, '0')}`,
      broadcastId,
      subscriberId,
      status,
      error: null,
    });
  }

  // --- task 7 ---

  async findOrCreateSubscriber(
    email: string,
  ): Promise<{ subscriber: SubscriberRow; created: boolean }> {
    const existing = this.subscribers.find((row) => row.email === email);
    if (existing) return { subscriber: existing, created: false };
    return { subscriber: this.seedSubscriber({ email }), created: true };
  }

  async findSubscriberById(id: string): Promise<SubscriberRow | null> {
    return this.subscribers.find((row) => row.id === id) ?? null;
  }

  async resubscribe(id: string): Promise<SubscriberRow> {
    const row = this.require(id);
    row.status = 'subscribed';
    return row;
  }

  async setSubscriberStatus(id: string, status: ManageStatus): Promise<SubscriberRow> {
    const row = this.require(id);
    row.status = status;
    return row;
  }

  // --- task 8 ---

  async listSubscribers(query: SubscriberPageQuery): Promise<Page<SubscriberRow>> {
    const needle = query.q?.toLowerCase();
    const matching = this.subscribers
      .filter((row) => query.status === undefined || row.status === query.status)
      .filter((row) => needle === undefined || row.email.toLowerCase().includes(needle))
      .sort(byCreatedAtThenIdDescending);

    const after = query.after;
    const remaining =
      after === undefined
        ? matching
        : matching.filter(
            (row) =>
              row.createdAt.getTime() < after.createdAt.getTime() ||
              (row.createdAt.getTime() === after.createdAt.getTime() && row.id < after.id),
          );

    return { rows: remaining.slice(0, query.limit), hasMore: remaining.length > query.limit };
  }

  async countSentDeliveriesFor(subscriberIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const delivery of this.deliveries) {
      if (delivery.status !== 'sent' || !subscriberIds.includes(delivery.subscriberId)) continue;
      counts.set(delivery.subscriberId, (counts.get(delivery.subscriberId) ?? 0) + 1);
    }
    return counts;
  }

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

  async createBroadcastWithSnapshot(input: CreateBroadcastInput): Promise<BroadcastRow> {
    const members = this.subscribers.filter((row) => input.audience.includes(row.status));
    const broadcast = this.seedBroadcast({
      subject: input.subject,
      bodyMarkdown: input.bodyMarkdown,
      audience: input.audience,
      teaserImageUrl: input.teaserImageUrl,
      createdBy: input.createdBy,
      recipientCount: members.length,
    });

    for (const member of members) this.seedDelivery(broadcast.id, member.id, 'pending');
    this.writes.push(`broadcast:${broadcast.id}`);
    return broadcast;
  }

  async listBroadcasts(): Promise<BroadcastListRowData[]> {
    return [...this.broadcasts]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((broadcast) => {
        const counts = this.countFor(broadcast.id);
        return { broadcast, sentCount: counts.sent, failedCount: counts.failed };
      });
  }

  async findBroadcastById(id: string): Promise<BroadcastRow | null> {
    return this.broadcasts.find((row) => row.id === id) ?? null;
  }

  async countDeliveries(broadcastId: string): Promise<DeliveryCounts> {
    return this.countFor(broadcastId);
  }

  // --- task 9 ---

  async listPendingRecipients(
    broadcastId: string,
    after: string | undefined,
    limit: number,
  ): Promise<Page<RecipientRow>> {
    const pending = this.deliveries
      .filter((row) => row.broadcastId === broadcastId && row.status === 'pending')
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

  async flipDelivery(
    broadcastId: string,
    subscriberId: string,
    status: TerminalDeliveryStatus,
    error: string | undefined,
  ): Promise<DeliveryStatus | null> {
    const delivery = this.deliveries.find(
      (row) => row.broadcastId === broadcastId && row.subscriberId === subscriberId,
    );
    if (!delivery) return null;

    if (delivery.status === 'pending') {
      delivery.status = status;
      delivery.error = error ?? null;
    }
    return delivery.status;
  }

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

  async recordConfirmationSent(id: string, at: Date): Promise<Date | null> {
    const row = this.subscribers.find((subscriber) => subscriber.id === id);
    if (!row) return null;

    row.confirmationEmailSentAt = at;
    return at;
  }

  async markBounced(email: string, at: Date): Promise<boolean> {
    const row = this.subscribers.find((subscriber) => subscriber.email === email);
    if (!row || row.status === 'bounced') return false;

    row.status = 'bounced';
    row.tokenVersion += 1;
    this.bouncedAt.set(row.id, at);
    return true;
  }

  private countFor(broadcastId: string): DeliveryCounts {
    const counts: DeliveryCounts = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const delivery of this.deliveries) {
      if (delivery.broadcastId === broadcastId) counts[delivery.status] += 1;
    }
    return counts;
  }

  private require(id: string): SubscriberRow {
    const row = this.subscribers.find((subscriber) => subscriber.id === id);
    if (!row) throw new Error(`fake store has no subscriber ${id}`);
    return row;
  }
}

function byCreatedAtThenIdDescending(a: SubscriberRow, b: SubscriberRow): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : -1;
}
