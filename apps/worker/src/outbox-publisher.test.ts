import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  type ClaimedOutboxEvent,
  OutboxPublisher,
  type OutboxStore,
} from './outbox-publisher';

const event: ClaimedOutboxEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  topic: 'node-sync.requested',
  payload: {
    nodeAccessGrantId: '22222222-2222-4222-8222-222222222222',
    nodeSyncJobId: '33333333-3333-4333-8333-333333333333',
    targetVersion: 1,
  },
  leaseToken: '44444444-4444-4444-8444-444444444444',
};

function storeFor(claimed: ClaimedOutboxEvent | null = event) {
  return {
    reclaimExpiredLeases: vi.fn().mockResolvedValue(0),
    claimNext: vi.fn().mockResolvedValue(claimed),
    markPublished: vi.fn().mockResolvedValue(true),
    retry: vi.fn().mockResolvedValue(true),
  } satisfies OutboxStore;
}

const logger = pino({ enabled: false });

describe('OutboxPublisher', () => {
  it('publishes a validated event with a durable idempotent BullMQ job id', async () => {
    const store = storeFor();
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const publisher = new OutboxPublisher(
      store,
      queue as never,
      'worker-a',
      logger,
    );

    await expect(publisher.processOne()).resolves.toBe('published');
    expect(queue.add).toHaveBeenCalledWith(
      'node-sync.requested',
      event.payload,
      {
        jobId: event.id,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    expect(store.markPublished).toHaveBeenCalledWith(
      event.id,
      'worker-a',
      event.leaseToken,
    );
    expect(store.retry).not.toHaveBeenCalled();
  });

  it('schedules a bounded retry without logging or publishing an invalid payload', async () => {
    const invalidEvent = {
      ...event,
      payload: {
        nodeAccessGrantId: '22222222-2222-4222-8222-222222222222',
        nodeSyncJobId: '33333333-3333-4333-8333-333333333333',
        targetVersion: 1,
        secret: 'must-not-leave-postgres',
      },
    } satisfies ClaimedOutboxEvent;
    const store = storeFor(invalidEvent);
    const queue = { add: vi.fn() };
    const warn = vi.fn();
    const publisher = new OutboxPublisher(store, queue as never, 'worker-a', {
      warn,
    } as never);

    await expect(publisher.processOne()).resolves.toBe('retried');
    expect(queue.add).not.toHaveBeenCalled();
    expect(store.retry).toHaveBeenCalledWith(
      invalidEvent.id,
      'worker-a',
      invalidEvent.leaseToken,
      'OUTBOX_INVALID_PAYLOAD',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.not.objectContaining({
        payload: expect.anything(),
        topic: expect.anything(),
      }),
      'Outbox publication failed',
    );
  });

  it('never serializes an unsupported topic into the warning log', async () => {
    let serializedLog = '';
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        serializedLog += chunk.toString('utf8');
        callback();
      },
    });
    const secretTopic = 'redis://worker:super-secret@example.invalid/0';
    const store = storeFor({ ...event, topic: secretTopic });
    const publisher = new OutboxPublisher(
      store,
      { add: vi.fn() } as never,
      'worker-a',
      pino(destination),
    );

    await expect(publisher.processOne()).resolves.toBe('retried');
    expect(serializedLog).toContain('OUTBOX_UNSUPPORTED_TOPIC');
    expect(serializedLog).not.toContain(secretTopic);
    expect(serializedLog).not.toContain('super-secret');
  });

  it('does not mutate a newer lease after publication is fenced', async () => {
    const store = storeFor();
    store.markPublished.mockResolvedValue(false);
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const publisher = new OutboxPublisher(
      store,
      queue as never,
      'worker-a',
      logger,
    );

    await expect(publisher.processOne()).resolves.toBe('fenced');
    expect(store.retry).not.toHaveBeenCalled();
  });

  it('releases the owned lease for retry when Redis publication fails', async () => {
    const store = storeFor();
    const queue = { add: vi.fn().mockRejectedValue(new Error('redis down')) };
    const publisher = new OutboxPublisher(
      store,
      queue as never,
      'worker-a',
      logger,
    );

    await expect(publisher.processOne()).resolves.toBe('retried');
    expect(store.markPublished).not.toHaveBeenCalled();
    expect(store.retry).toHaveBeenCalledWith(
      event.id,
      'worker-a',
      event.leaseToken,
      'OUTBOX_PUBLISH_FAILED',
    );
  });

  it('returns idle without touching Redis when no event is eligible', async () => {
    const store = storeFor(null);
    const queue = { add: vi.fn() };
    const publisher = new OutboxPublisher(
      store,
      queue as never,
      'worker-a',
      logger,
    );

    await expect(publisher.processOne()).resolves.toBe('idle');
    expect(queue.add).not.toHaveBeenCalled();
  });
});
