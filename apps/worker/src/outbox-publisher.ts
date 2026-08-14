import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import { nodeSyncRequestedEventSchema } from '@vpn-platform/contracts';
import type { JobsOptions, Queue } from 'bullmq';
import type { Logger } from 'pino';

export type ClaimedOutboxEvent = {
  id: string;
  topic: string;
  payload: Prisma.JsonValue;
  leaseToken: string;
};

export interface OutboxStore {
  reclaimExpiredLeases(): Promise<number>;
  claimNext(leaseOwner: string): Promise<ClaimedOutboxEvent | null>;
  markPublished(
    id: string,
    leaseOwner: string,
    leaseToken: string,
  ): Promise<boolean>;
  retry(
    id: string,
    leaseOwner: string,
    leaseToken: string,
    errorCode: string,
  ): Promise<boolean>;
}

type PublisherQueue = Pick<Queue, 'add'>;

export class PrismaOutboxStore implements OutboxStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly leaseDurationMs: number,
    private readonly retryDelayMs: number,
    private readonly maxAttempts: number,
    private readonly eventIds?: readonly string[],
  ) {}

  async reclaimExpiredLeases(): Promise<number> {
    const eventScope = this.eventScope();
    const count = await this.prisma.$executeRaw`
      UPDATE "OutboxEvent"
      SET status = CASE WHEN attempts >= ${this.maxAttempts}
                        THEN 'FAILED'::"OutboxEventStatus"
                        ELSE 'PENDING'::"OutboxEventStatus" END,
          "nextAttemptAt" = CASE WHEN attempts >= ${this.maxAttempts}
                                 THEN NULL
                                 ELSE clock_timestamp() END,
          "lastErrorCode" = CASE WHEN attempts >= ${this.maxAttempts}
                                 THEN COALESCE("lastErrorCode", 'OUTBOX_LEASE_EXPIRED')
                                 ELSE "lastErrorCode" END,
          "leaseOwner" = NULL,
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = clock_timestamp()
      WHERE ((status = 'PROCESSING' AND "leaseExpiresAt" <= clock_timestamp())
             OR (status = 'PENDING' AND attempts >= ${this.maxAttempts}))
        ${eventScope}
    `;
    return count;
  }

  async claimNext(leaseOwner: string): Promise<ClaimedOutboxEvent | null> {
    const leaseToken = randomUUID();
    const eventScope = this.eventScope();
    const rows = await this.prisma.$queryRaw<ClaimedOutboxEvent[]>`
      WITH candidate AS (
        SELECT id
        FROM "OutboxEvent"
        WHERE status = 'PENDING'
          AND attempts < ${this.maxAttempts}
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= clock_timestamp())
          ${eventScope}
        ORDER BY "createdAt", id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "OutboxEvent" AS event
      SET status = 'PROCESSING',
          attempts = event.attempts + 1,
          "nextAttemptAt" = NULL,
          "leaseOwner" = ${leaseOwner},
          "leaseToken" = CAST(${leaseToken} AS uuid),
          "leaseExpiresAt" = clock_timestamp() + (${this.leaseDurationMs} * interval '1 millisecond'),
          "updatedAt" = clock_timestamp()
      FROM candidate
      WHERE event.id = candidate.id
      RETURNING event.id, event.topic, event.payload, event."leaseToken"::text AS "leaseToken"
    `;
    return rows[0] ?? null;
  }

  private eventScope(): Prisma.Sql {
    if (this.eventIds === undefined) return Prisma.empty;
    if (this.eventIds.length === 0) return Prisma.sql`AND FALSE`;
    return Prisma.sql`AND id IN (${Prisma.join(
      this.eventIds.map((id) => Prisma.sql`CAST(${id} AS uuid)`),
    )})`;
  }

  async markPublished(
    id: string,
    leaseOwner: string,
    leaseToken: string,
  ): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE "OutboxEvent"
      SET status = 'PUBLISHED',
          "publishedAt" = clock_timestamp(),
          "leaseOwner" = NULL,
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = clock_timestamp()
      WHERE id = CAST(${id} AS uuid)
        AND status = 'PROCESSING'
        AND "leaseOwner" = ${leaseOwner}
        AND "leaseToken" = CAST(${leaseToken} AS uuid)
        AND "leaseExpiresAt" > clock_timestamp()
    `;
    return count === 1;
  }

  async retry(
    id: string,
    leaseOwner: string,
    leaseToken: string,
    errorCode: string,
  ): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE "OutboxEvent"
      SET status = CASE WHEN attempts >= ${this.maxAttempts}
                        THEN 'FAILED'::"OutboxEventStatus"
                        ELSE 'PENDING'::"OutboxEventStatus" END,
          "nextAttemptAt" = CASE WHEN attempts >= ${this.maxAttempts}
                                 THEN NULL
                                 ELSE clock_timestamp() + (${this.retryDelayMs} * interval '1 millisecond') END,
          "lastErrorCode" = ${errorCode},
          "leaseOwner" = NULL,
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = clock_timestamp()
      WHERE id = CAST(${id} AS uuid)
        AND status = 'PROCESSING'
        AND "leaseOwner" = ${leaseOwner}
        AND "leaseToken" = CAST(${leaseToken} AS uuid)
        AND "leaseExpiresAt" > clock_timestamp()
    `;
    return count === 1;
  }
}

const durableJobOptions: JobsOptions = {
  removeOnComplete: false,
  removeOnFail: false,
};

export class OutboxPublisher {
  constructor(
    private readonly store: OutboxStore,
    private readonly queue: PublisherQueue,
    private readonly leaseOwner: string,
    private readonly logger: Logger,
    private readonly deliveryAttempts = 1,
    private readonly deliveryRetryDelayMs = 0,
  ) {}

  async processOne(): Promise<'idle' | 'published' | 'retried' | 'fenced'> {
    await this.store.reclaimExpiredLeases();
    const event = await this.store.claimNext(this.leaseOwner);
    if (!event) return 'idle';

    try {
      if (event.topic !== 'node-sync.requested') {
        throw new UnsupportedTopicError();
      }
      const parsedPayload = nodeSyncRequestedEventSchema.safeParse(
        event.payload,
      );
      if (!parsedPayload.success) throw new InvalidPayloadError();
      const payload = parsedPayload.data;
      await this.queue.add(event.topic, payload, {
        ...durableJobOptions,
        jobId: event.id,
        attempts: this.deliveryAttempts,
        ...(this.deliveryRetryDelayMs > 0
          ? { backoff: { type: 'fixed', delay: this.deliveryRetryDelayMs } }
          : {}),
      });
      const published = await this.store.markPublished(
        event.id,
        this.leaseOwner,
        event.leaseToken,
      );
      if (!published) {
        this.logger.warn(
          { component: 'outbox-publisher', eventId: event.id },
          'Outbox publication was fenced after queue delivery',
        );
        return 'fenced';
      }
      return 'published';
    } catch (error) {
      const errorCode =
        error instanceof UnsupportedTopicError
          ? 'OUTBOX_UNSUPPORTED_TOPIC'
          : error instanceof InvalidPayloadError
            ? 'OUTBOX_INVALID_PAYLOAD'
            : 'OUTBOX_PUBLISH_FAILED';
      const retried = await this.store.retry(
        event.id,
        this.leaseOwner,
        event.leaseToken,
        errorCode,
      );
      this.logger.warn(
        {
          component: 'outbox-publisher',
          eventId: event.id,
          errorCode,
          fenced: !retried,
        },
        'Outbox publication failed',
      );
      return retried ? 'retried' : 'fenced';
    }
  }
}

class UnsupportedTopicError extends Error {}
class InvalidPayloadError extends Error {}
