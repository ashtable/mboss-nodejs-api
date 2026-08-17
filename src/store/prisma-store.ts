import { Prisma, type PrismaClient } from '@prisma/client';

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
} from './types.js';

/** Postgres' unique-violation code, as Prisma reports it. */
const UNIQUE_VIOLATION = 'P2002';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}

const NO_DELIVERIES: DeliveryCounts = { pending: 0, sent: 0, failed: 0, skipped: 0 };

export class PrismaStore implements Store {
  constructor(private readonly prisma: PrismaClient) {}

  // --- task 7 ---

  async findOrCreateSubscriber(
    email: string,
  ): Promise<{ subscriber: SubscriberRow; created: boolean }> {
    const existing = await this.prisma.subscriber.findUnique({ where: { email } });
    if (existing) return { subscriber: existing, created: false };

    try {
      return {
        subscriber: await this.prisma.subscriber.create({ data: { email } }),
        created: true,
      };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Two signups for one address raced between the read and the write. The unique index on
      // email is what decided it; re-reading is how this request learns who won.
      const raced = await this.prisma.subscriber.findUniqueOrThrow({ where: { email } });
      return { subscriber: raced, created: false };
    }
  }

  async findSubscriberById(id: string): Promise<SubscriberRow | null> {
    return this.prisma.subscriber.findUnique({ where: { id } });
  }

  /**
   * Sets the status, stamps the timestamp of the state being entered and clears the other one, so
   * at most one of `pausedAt` / `unsubscribedAt` is ever set and it says since when the subscriber
   * has been where they are. Left to accumulate, they would be a partial history that no column
   * says how to read: a stale `pausedAt` on an unsubscribed row is indistinguishable from a
   * current one, and a reader would need a rule about which column outranks which.
   * `tokenVersion` is untouched: leaving the list does not revoke the link that got you here.
   */
  async setSubscriberStatus(id: string, status: ManageStatus): Promise<SubscriberRow> {
    const timestamps = {
      subscribed: { pausedAt: null, unsubscribedAt: null },
      paused: { pausedAt: new Date(), unsubscribedAt: null },
      unsubscribed: { pausedAt: null, unsubscribedAt: new Date() },
    }[status];

    return this.prisma.subscriber.update({ where: { id }, data: { status, ...timestamps } });
  }

  // --- task 8 ---

  async listSubscribers(query: SubscriberPageQuery): Promise<Page<SubscriberRow>> {
    const { after } = query;
    const rows = await this.prisma.subscriber.findMany({
      where: {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.q === undefined ? {} : { email: { contains: query.q, mode: 'insensitive' } }),
        // The keyset is (createdAt, id) because createdAt is not unique.
        ...(after === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One extra row is how the caller learns there is another page without a second count query.
      take: query.limit + 1,
    });

    return { rows: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
  }

  async countSentDeliveriesFor(subscriberIds: string[]): Promise<Map<string, number>> {
    if (subscriberIds.length === 0) return new Map();

    const grouped = await this.prisma.broadcastDelivery.groupBy({
      by: ['subscriberId'],
      where: { subscriberId: { in: subscriberIds }, status: 'sent' },
      _count: { _all: true },
    });

    return new Map(grouped.map((row) => [row.subscriberId, row._count._all]));
  }

  async countSubscribersByStatus(): Promise<Record<SubscriberStatus, number>> {
    const grouped = await this.prisma.subscriber.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    // A grouped count has no row for a status nobody is in, so the zeros start here.
    const counts: Record<SubscriberStatus, number> = {
      subscribed: 0,
      paused: 0,
      unsubscribed: 0,
      bounced: 0,
    };
    for (const row of grouped) counts[row.status] = row._count._all;
    return counts;
  }

  async createBroadcastWithSnapshot(input: CreateBroadcastInput): Promise<BroadcastRow> {
    return this.prisma.$transaction(async (tx) => {
      // The audience is resolved inside the transaction so the count and the rows cannot disagree:
      // a signup landing mid-snapshot is either in both or in neither.
      const members = await tx.subscriber.findMany({
        where: { status: { in: input.audience } },
        select: { id: true },
      });

      // Created `sending`, not `draft`: the only route that creates a broadcast enqueues its send
      // in the same request, so creation is the moment the send starts and there is no draft state
      // to sit in. `startedAt` records that moment for the same reason.
      const broadcast = await tx.broadcast.create({
        data: {
          subject: input.subject,
          bodyMarkdown: input.bodyMarkdown,
          audience: input.audience,
          teaserImageUrl: input.teaserImageUrl,
          createdBy: input.createdBy,
          status: 'sending',
          startedAt: new Date(),
        },
      });

      await tx.broadcastDelivery.createMany({
        data: members.map((member) => ({ broadcastId: broadcast.id, subscriberId: member.id })),
      });

      return tx.broadcast.update({
        where: { id: broadcast.id },
        data: { recipientCount: members.length },
      });
    });
  }

  async listBroadcasts(): Promise<BroadcastListRowData[]> {
    const broadcasts = await this.prisma.broadcast.findMany({ orderBy: { createdAt: 'desc' } });
    if (broadcasts.length === 0) return [];

    const grouped = await this.prisma.broadcastDelivery.groupBy({
      by: ['broadcastId', 'status'],
      where: { broadcastId: { in: broadcasts.map((row) => row.id) } },
      _count: { _all: true },
    });

    const counts = new Map<string, { sent: number; failed: number }>();
    for (const row of grouped) {
      if (row.status !== 'sent' && row.status !== 'failed') continue;
      const entry = counts.get(row.broadcastId) ?? { sent: 0, failed: 0 };
      entry[row.status] = row._count._all;
      counts.set(row.broadcastId, entry);
    }

    return broadcasts.map((broadcast) => ({
      broadcast,
      sentCount: counts.get(broadcast.id)?.sent ?? 0,
      failedCount: counts.get(broadcast.id)?.failed ?? 0,
    }));
  }

  async findBroadcastById(id: string): Promise<BroadcastRow | null> {
    return this.prisma.broadcast.findUnique({ where: { id } });
  }

  async countDeliveries(broadcastId: string): Promise<DeliveryCounts> {
    const grouped = await this.prisma.broadcastDelivery.groupBy({
      by: ['status'],
      where: { broadcastId },
      _count: { _all: true },
    });

    const counts = { ...NO_DELIVERIES };
    for (const row of grouped) counts[row.status] = row._count._all;
    return counts;
  }

  // --- task 9 ---

  async listPendingRecipients(
    broadcastId: string,
    after: string | undefined,
    limit: number,
  ): Promise<Page<RecipientRow>> {
    const deliveries = await this.prisma.broadcastDelivery.findMany({
      where: {
        broadcastId,
        status: 'pending',
        ...(after === undefined ? {} : { id: { gt: after } }),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
      include: {
        subscriber: { select: { id: true, email: true, tokenVersion: true, status: true } },
      },
    });

    return {
      rows: deliveries.slice(0, limit).map((delivery) => ({
        deliveryId: delivery.id,
        subscriberId: delivery.subscriber.id,
        email: delivery.subscriber.email,
        tokenVersion: delivery.subscriber.tokenVersion,
        currentStatus: delivery.subscriber.status,
      })),
      hasMore: deliveries.length > limit,
    };
  }

  async flipDelivery(
    broadcastId: string,
    subscriberId: string,
    status: TerminalDeliveryStatus,
    error: string | undefined,
  ): Promise<DeliveryStatus | null> {
    // One conditional UPDATE, not a read followed by a write: two send steps racing on the same
    // row would both see `pending` in a read-then-write and both claim it.
    await this.prisma.broadcastDelivery.updateMany({
      where: { broadcastId, subscriberId, status: 'pending' },
      data: { status, error: error ?? null },
    });

    const row = await this.prisma.broadcastDelivery.findUnique({
      where: { broadcastId_subscriberId: { broadcastId, subscriberId } },
      select: { status: true },
    });

    return row?.status ?? null;
  }

  async markBroadcastComplete(
    id: string,
    status: 'sent' | 'failed',
    at: Date,
  ): Promise<BroadcastStatus | null> {
    // Conditional on not having completed already, so a replayed final step does not rewrite when
    // the broadcast finished.
    await this.prisma.broadcast.updateMany({
      where: { id, completedAt: null },
      data: { status, completedAt: at },
    });

    const row = await this.prisma.broadcast.findUnique({ where: { id }, select: { status: true } });
    return row?.status ?? null;
  }

  async recordConfirmationSent(id: string, at: Date): Promise<Date | null> {
    const { count } = await this.prisma.subscriber.updateMany({
      where: { id },
      data: { confirmationEmailSentAt: at },
    });

    return count === 0 ? null : at;
  }

  async markBounced(email: string, at: Date): Promise<boolean> {
    // Conditional on not already being bounced. Providers retry webhooks, and bumping tokenVersion
    // on every retry would revoke this subscriber's manage links again and again for one event.
    const { count } = await this.prisma.subscriber.updateMany({
      where: { email, status: { not: 'bounced' } },
      data: { status: 'bounced', bouncedAt: at, tokenVersion: { increment: 1 } },
    });

    return count > 0;
  }
}
