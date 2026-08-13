import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redisConnection } from './main';
import { OutboxPublisher, PrismaOutboxStore } from './outbox-publisher';

describe('transactional outbox publication', () => {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL as string,
  });
  const queueName = `outbox-integration-${randomUUID()}`;
  const queue = new Queue(queueName, {
    connection: redisConnection(process.env.REDIS_URL as string),
  });
  const eventIds: string[] = [];

  beforeAll(async () => {
    await Promise.all([prisma.$connect(), queue.waitUntilReady()]);
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { id: { in: eventIds } } });
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
    eventIds.push(sentinel.id);
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
    eventIds.push(valid.id);
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
    eventIds.push(invalid.id);
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
    eventIds.push(exhausted.id);
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
});
