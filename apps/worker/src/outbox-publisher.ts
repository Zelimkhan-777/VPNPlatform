import { nodeSyncRequestedEventSchema } from '@vpn-platform/contracts';
import {
  type OutboxStore,
  PrismaOutboxStore,
} from '@vpn-platform/orchestration-store';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';

import {
  type BullMqJobRetention,
  defaultBullMqJobRetention,
} from './job-retention';

export { PrismaOutboxStore };
export type {
  ClaimedOutboxEvent,
  OutboxStore,
} from '@vpn-platform/orchestration-store';

type PublisherQueue = Pick<Queue, 'add'>;

export class OutboxPublisher {
  constructor(
    private readonly store: OutboxStore,
    private readonly queue: PublisherQueue,
    private readonly leaseOwner: string,
    private readonly logger: Logger,
    private readonly deliveryAttempts = 1,
    private readonly deliveryRetryDelayMs = 0,
    private readonly jobRetention: BullMqJobRetention = defaultBullMqJobRetention,
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
        ...this.jobRetention,
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
