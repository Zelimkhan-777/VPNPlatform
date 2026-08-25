import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { PrismaClient } from '@prisma/client';
import { Queue, QueueEvents, Worker } from 'bullmq';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redisConnection } from './main';
import type { BullMqJobRetention } from './job-retention';
import { OutboxPublisher, PrismaOutboxStore } from './outbox-publisher';

describe('transactional outbox publication', () => {
  const redisNamespace = process.env.WORKER_TEST_REDIS_NAMESPACE;
  if (!redisNamespace)
    throw new Error('WORKER_TEST_REDIS_NAMESPACE is required');
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL as string,
  });
  const queueName = `${redisNamespace}-outbox-${randomUUID()}`;
  const queue = new Queue(queueName, {
    connection: redisConnection(process.env.REDIS_URL as string),
  });

  beforeAll(async () => {
    await Promise.all([prisma.$connect(), queue.waitUntilReady()]);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await Promise.all([queue.close(), prisma.$disconnect()]);
  });

  it('publishes valid work and retries an invalid payload without leaking it', async () => {
    const sentinel = await prisma.outboxEvent.create({
      data: {
        topic: 'sentinel.foreign',
        aggregateType: 'Sentinel',
        aggregateId: randomUUID(),
        idempotencyKey: `worker-sentinel-${randomUUID()}`,
        createdAt: new Date('1900-01-01T00:00:00.000Z'),
        payload: { sentinel: true },
      },
    });
    const valid = await prisma.outboxEvent.create({
      data: {
        topic: 'node-sync.requested',
        aggregateType: 'NodeAccessGrant',
        aggregateId: randomUUID(),
        idempotencyKey: `worker-valid-${randomUUID()}`,
        createdAt: new Date('2000-01-01T00:00:00.000Z'),
        payload: {
          nodeAccessGrantId: randomUUID(),
          nodeSyncJobId: randomUUID(),
          targetVersion: 1,
        },
      },
    });
    const store = new PrismaOutboxStore(prisma, 30_000, 5_000, 5, [valid.id]);
    const publisher = new OutboxPublisher(
      store,
      queue,
      `integration-${randomUUID()}`,
      pino({ enabled: false }),
    );

    await expect(publisher.processOne()).resolves.toBe('published');
    const published = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: valid.id },
    });
    expect(published).toMatchObject({
      status: 'PUBLISHED',
      attempts: 1,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(published.publishedAt).toBeInstanceOf(Date);
    const job = await queue.getJob(valid.id);
    expect(job?.name).toBe('node-sync.requested');
    expect(job?.data).toEqual(valid.payload);

    const invalid = await prisma.outboxEvent.create({
      data: {
        topic: 'node-sync.requested',
        aggregateType: 'NodeAccessGrant',
        aggregateId: randomUUID(),
        idempotencyKey: `worker-invalid-${randomUUID()}`,
        createdAt: new Date('2000-01-01T00:00:01.000Z'),
        payload: { secret: 'must-not-be-published' },
      },
    });
    const invalidPublisher = new OutboxPublisher(
      new PrismaOutboxStore(prisma, 30_000, 5_000, 5, [invalid.id]),
      queue,
      `integration-${randomUUID()}`,
      pino({ enabled: false }),
    );

    await expect(invalidPublisher.processOne()).resolves.toBe('retried');
    await expect(queue.getJob(invalid.id)).resolves.toBeUndefined();
    await expect(
      prisma.outboxEvent.findUniqueOrThrow({ where: { id: invalid.id } }),
    ).resolves.toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastErrorCode: 'OUTBOX_INVALID_PAYLOAD',
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    await expect(
      prisma.outboxEvent.findUniqueOrThrow({ where: { id: sentinel.id } }),
    ).resolves.toMatchObject({ status: 'PENDING', attempts: 0 });
    await expect(queue.getJob(sentinel.id)).resolves.toBeUndefined();
  });

  it('fails an expired final lease without granting an extra attempt', async () => {
    const exhausted = await prisma.outboxEvent.create({
      data: {
        topic: 'node-sync.requested',
        aggregateType: 'NodeAccessGrant',
        aggregateId: randomUUID(),
        idempotencyKey: `worker-exhausted-${randomUUID()}`,
        attempts: 4,
        payload: {
          nodeAccessGrantId: randomUUID(),
          nodeSyncJobId: randomUUID(),
          targetVersion: 1,
        },
      },
    });
    const store = new PrismaOutboxStore(prisma, 30_000, 5_000, 5, [
      exhausted.id,
    ]);

    await expect(store.claimNext('crashing-worker')).resolves.toEqual(
      expect.objectContaining({ id: exhausted.id }),
    );
    await prisma.outboxEvent.update({
      where: { id: exhausted.id },
      data: { leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') },
    });

    await expect(store.reclaimExpiredLeases()).resolves.toBe(1);
    await expect(store.claimNext('sixth-worker')).resolves.toBeNull();
    await expect(
      prisma.outboxEvent.findUniqueOrThrow({ where: { id: exhausted.id } }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      attempts: 5,
      lastErrorCode: 'OUTBOX_LEASE_EXPIRED',
      nextAttemptAt: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
  });

  it('evicts completed and failed BullMQ history while preserving PostgreSQL records', async () => {
    const retentionQueueName = `${redisNamespace}-retention-${randomUUID()}`;
    const connection = redisConnection(process.env.REDIS_URL as string);
    const retentionQueue = new Queue(retentionQueueName, { connection });
    const retentionEvents = new QueueEvents(retentionQueueName, { connection });
    const consumer = new Worker(
      retentionQueueName,
      async (job) => {
        if ((job.data as { targetVersion?: number }).targetVersion === 99) {
          throw new Error('expected retention test failure');
        }
      },
      { connection },
    );
    const agePolicy: BullMqJobRetention = {
      removeOnComplete: { age: 1, count: 10 },
      removeOnFail: { age: 1, count: 10 },
    };
    const countPolicy: BullMqJobRetention = {
      removeOnComplete: { age: 3_600, count: 1 },
      removeOnFail: { age: 3_600, count: 1 },
    };
    const eventIds: string[] = [];

    const publish = async (targetVersion: number, policy = agePolicy) => {
      const event = await prisma.outboxEvent.create({
        data: {
          topic: 'node-sync.requested',
          aggregateType: 'NodeAccessGrant',
          aggregateId: randomUUID(),
          idempotencyKey: `worker-retention-${randomUUID()}`,
          payload: {
            nodeAccessGrantId: randomUUID(),
            nodeSyncJobId: randomUUID(),
            targetVersion,
          },
        },
      });
      eventIds.push(event.id);
      const publisher = new OutboxPublisher(
        new PrismaOutboxStore(prisma, 30_000, 5_000, 5, [event.id]),
        retentionQueue,
        `retention-${randomUUID()}`,
        pino({ enabled: false }),
        1,
        0,
        policy,
      );
      await expect(publisher.processOne()).resolves.toBe('published');
      const job = await retentionQueue.getJob(event.id);
      if (!job) throw new Error('Published retention job is missing');
      return { event, job };
    };

    try {
      await Promise.all([
        retentionQueue.waitUntilReady(),
        retentionEvents.waitUntilReady(),
        consumer.waitUntilReady(),
      ]);

      const firstCompleted = await publish(1);
      await expect(
        firstCompleted.job.waitUntilFinished(retentionEvents, 10_000),
      ).resolves.toBeNull();
      await expect(
        retentionQueue.getJob(firstCompleted.event.id),
      ).resolves.toBeDefined();

      await delay(1_100);
      const secondCompleted = await publish(2);
      await expect(
        secondCompleted.job.waitUntilFinished(retentionEvents, 10_000),
      ).resolves.toBeNull();
      await expect(
        retentionQueue.getJob(firstCompleted.event.id),
      ).resolves.toBeUndefined();

      const firstFailed = await publish(99);
      await expect(
        firstFailed.job.waitUntilFinished(retentionEvents, 10_000),
      ).rejects.toThrow();
      await expect(
        retentionQueue.getJob(firstFailed.event.id),
      ).resolves.toBeDefined();

      await delay(1_100);
      const secondFailed = await publish(99);
      await expect(
        secondFailed.job.waitUntilFinished(retentionEvents, 10_000),
      ).rejects.toThrow();
      await expect(
        retentionQueue.getJob(firstFailed.event.id),
      ).resolves.toBeUndefined();

      const countLimitedFirst = await publish(3, countPolicy);
      await expect(
        countLimitedFirst.job.waitUntilFinished(retentionEvents, 10_000),
      ).resolves.toBeNull();
      const countLimitedSecond = await publish(4, countPolicy);
      await expect(
        countLimitedSecond.job.waitUntilFinished(retentionEvents, 10_000),
      ).resolves.toBeNull();
      await expect(
        retentionQueue.getJob(countLimitedFirst.event.id),
      ).resolves.toBeUndefined();

      const persistedEvents = await prisma.outboxEvent.findMany({
        where: { id: { in: eventIds } },
        select: { status: true },
      });
      expect(persistedEvents).toHaveLength(eventIds.length);
      expect(
        persistedEvents.every((event) => event.status === 'PUBLISHED'),
      ).toBe(true);
    } finally {
      await consumer.close();
      await retentionQueue.obliterate({ force: true });
      await Promise.all([retentionEvents.close(), retentionQueue.close()]);
    }
  }, 30_000);
});
