import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { Queue, QueueEvents, Worker } from 'bullmq';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redisConnection } from './main';
import {
  NodeSyncProcessor,
  PrismaNodeSyncStore,
  runNodeSyncLeaseReclaimer,
} from './node-sync-processor';

async function createActivatedRouteJob(
  prisma: PrismaClient,
  suffix: string,
  options: { includeGrant?: boolean } = {},
) {
  const node = await prisma.node.create({
    data: {
      name: `route-sync-${suffix}`,
      provider: 'integration-test',
      locationLabel: 'integration-test',
      status: 'HEALTHY',
      desiredConfigVersion: 1,
    },
  });
  const endpoint = await prisma.endpoint.create({
    data: {
      nodeId: node.id,
      host: `route-${suffix.slice(0, 8)}.example.test`,
      addressKind: 'HOSTNAME',
      port: 443,
    },
  });
  const profile = await prisma.connectionProfile.create({
    data: {
      nodeId: node.id,
      version: 1,
      status: 'ACTIVE',
      protocolKind: 'VLESS',
      transportKind: 'TCP',
      securityKind: 'TLS',
      clientCompatibility: 'HAPP',
    },
  });
  await prisma.vlessTcpTlsPublicConfig.create({
    data: {
      connectionProfileId: profile.id,
      tlsServerName: `route-${suffix.slice(0, 8)}.example.test`,
      displayName: 'Worker route',
    },
  });
  await prisma.endpointConnectionProfile.create({
    data: {
      endpointId: endpoint.id,
      connectionProfileId: profile.id,
      nodeId: node.id,
    },
  });
  const syncJob = await prisma.nodeSyncJob.create({
    data: {
      nodeId: node.id,
      routeEndpointId: endpoint.id,
      routeConnectionProfileId: profile.id,
      targetVersion: 1,
      idempotencyKey: `route-sync-${suffix}`,
    },
  });
  await prisma.outboxEvent.create({
    data: {
      topic: 'node-sync.requested',
      aggregateType: 'ConnectionRoute',
      aggregateId: endpoint.id,
      payload: {
        routeEndpointId: endpoint.id,
        routeConnectionProfileId: profile.id,
        nodeSyncJobId: syncJob.id,
        targetVersion: 1,
      },
      idempotencyKey: `route-sync-outbox-${suffix}`,
    },
  });
  await prisma.endpointConnectionProfile.update({
    where: {
      endpointId_connectionProfileId: {
        endpointId: endpoint.id,
        connectionProfileId: profile.id,
      },
    },
    data: { activationVersion: 1 },
  });
  const command = {
    routeEndpointId: endpoint.id,
    routeConnectionProfileId: profile.id,
    nodeSyncJobId: syncJob.id,
    targetVersion: 1,
  };
  if (!options.includeGrant) {
    return { node, endpoint, profile, syncJob, command };
  }
  const user = await prisma.user.create({
    data: { telegramUserId: `94${suffix.replaceAll('-', '').slice(0, 20)}` },
  });
  const device = await prisma.device.create({
    data: {
      userId: user.id,
      subscriptionTokenHash: `route-grant-${suffix}`,
    },
  });
  const grant = await prisma.nodeAccessGrant.create({
    data: {
      nodeId: node.id,
      deviceId: device.id,
      dataPlaneCredentialHash: `route-grant-${suffix}`,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      desiredVersion: 1,
    },
  });
  const grantJob = await prisma.nodeSyncJob.create({
    data: {
      nodeId: node.id,
      nodeAccessGrantId: grant.id,
      targetVersion: 1,
      idempotencyKey: `route-grant-${suffix}`,
    },
  });
  return {
    node,
    endpoint,
    profile,
    syncJob,
    command,
    grantJob,
    grantCommand: {
      nodeAccessGrantId: grant.id,
      nodeSyncJobId: grantJob.id,
      targetVersion: 1,
    },
  };
}

describe('node-sync BullMQ consumption', () => {
  const redisNamespace = process.env.WORKER_TEST_REDIS_NAMESPACE;
  if (!redisNamespace)
    throw new Error('WORKER_TEST_REDIS_NAMESPACE is required');
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL as string,
  });
  const queueName = `${redisNamespace}-node-sync-${randomUUID()}`;
  const connection = redisConnection(process.env.REDIS_URL as string);
  const queue = new Queue(queueName, { connection });
  const queueEvents = new QueueEvents(queueName, { connection });

  beforeAll(async () => {
    await Promise.all([
      prisma.$connect(),
      queue.waitUntilReady(),
      queueEvents.waitUntilReady(),
    ]);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await Promise.all([
      queueEvents.close(),
      queue.close(),
      prisma.$disconnect(),
    ]);
  });

  it('accepts one durable desired-state command and fences mismatched replays', async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { telegramUserId: `91${suffix.replaceAll('-', '').slice(0, 20)}` },
    });
    const device = await prisma.device.create({
      data: {
        userId: user.id,
        subscriptionTokenHash: `node-sync-consumer-feed-${suffix}`,
      },
    });
    const node = await prisma.node.create({
      data: {
        name: `node-sync-consumer-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
        desiredConfigVersion: 1,
      },
    });
    const grant = await prisma.nodeAccessGrant.create({
      data: {
        nodeId: node.id,
        deviceId: device.id,
        dataPlaneCredentialHash: `node-sync-consumer-credential-${suffix}`,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        desiredVersion: 1,
      },
    });
    const syncJob = await prisma.nodeSyncJob.create({
      data: {
        nodeId: node.id,
        nodeAccessGrantId: grant.id,
        targetVersion: 1,
        idempotencyKey: `node-sync-consumer-${suffix}`,
      },
    });
    const mismatchedSyncJob = await prisma.nodeSyncJob.create({
      data: {
        nodeId: node.id,
        nodeAccessGrantId: grant.id,
        targetVersion: 1,
        idempotencyKey: `node-sync-consumer-mismatch-${suffix}`,
      },
    });
    const exhaustedSyncJob = await prisma.nodeSyncJob.create({
      data: {
        nodeId: node.id,
        nodeAccessGrantId: grant.id,
        targetVersion: 1,
        idempotencyKey: `node-sync-consumer-exhausted-${suffix}`,
        status: 'PROCESSING',
        attempts: 3,
        leaseOwner: 'crashed-consumer',
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
      },
    });
    const command = {
      nodeAccessGrantId: grant.id,
      nodeSyncJobId: syncJob.id,
      targetVersion: 1,
    };
    const processor = new NodeSyncProcessor(
      new PrismaNodeSyncStore(prisma, 5_000, 5_000, 3),
      `consumer-${suffix}`,
      pino({ enabled: false }),
    );
    const consumer = new Worker(queueName, (job) => processor.process(job), {
      connection,
      concurrency: 1,
    });

    try {
      const queued = await queue.add('node-sync.requested', command, {
        jobId: randomUUID(),
        attempts: 4,
        backoff: { type: 'fixed', delay: 5_000 },
        removeOnComplete: { age: 3_600, count: 1 },
        removeOnFail: { age: 3_600, count: 1 },
      });
      await expect(
        queued.waitUntilFinished(queueEvents, 10_000),
      ).resolves.toBeNull();
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({ where: { id: syncJob.id } }),
      ).resolves.toMatchObject({
        status: 'SUCCEEDED',
        attempts: 1,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: expect.any(Date),
      });

      await expect(
        processor.process({ name: 'node-sync.requested', data: command }),
      ).resolves.toBeUndefined();
      await expect(
        processor.process({
          name: 'node-sync.requested',
          data: {
            ...command,
            nodeSyncJobId: mismatchedSyncJob.id,
            nodeAccessGrantId: randomUUID(),
          },
        }),
      ).resolves.toBeUndefined();
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({ where: { id: syncJob.id } }),
      ).resolves.toMatchObject({ status: 'SUCCEEDED', attempts: 1 });

      const originalBullMqJobId = queued.id;
      if (!originalBullMqJobId) {
        throw new Error('BullMQ replay test job id is missing');
      }
      const evictionTrigger = await queue.add('node-sync.requested', command, {
        jobId: randomUUID(),
        removeOnComplete: { age: 3_600, count: 1 },
        removeOnFail: { age: 3_600, count: 1 },
      });
      await expect(
        evictionTrigger.waitUntilFinished(queueEvents, 10_000),
      ).resolves.toBeNull();
      await expect(queue.getJob(originalBullMqJobId)).resolves.toBeUndefined();

      const replayAfterEviction = await queue.add(
        'node-sync.requested',
        command,
        {
          jobId: originalBullMqJobId,
          removeOnComplete: { age: 3_600, count: 1 },
          removeOnFail: { age: 3_600, count: 1 },
        },
      );
      await expect(
        replayAfterEviction.waitUntilFinished(queueEvents, 10_000),
      ).resolves.toBeNull();
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({ where: { id: syncJob.id } }),
      ).resolves.toMatchObject({ status: 'SUCCEEDED', attempts: 1 });

      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({
          where: { id: mismatchedSyncJob.id },
        }),
      ).resolves.toMatchObject({ status: 'PENDING', attempts: 0 });

      await expect(
        processor.process({
          name: 'node-sync.requested',
          data: {
            ...command,
            nodeSyncJobId: exhaustedSyncJob.id,
          },
        }),
      ).resolves.toBeUndefined();
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({
          where: { id: exhaustedSyncJob.id },
        }),
      ).resolves.toMatchObject({
        status: 'FAILED',
        attempts: 3,
        lastErrorCode: 'NODE_SYNC_LEASE_EXPIRED',
        completedAt: expect.any(Date),
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
    } finally {
      await consumer.close();
    }
  });

  it('completes a route-specific sync command against its activation', async () => {
    const suffix = randomUUID();
    const node = await prisma.node.create({
      data: {
        name: `route-sync-consumer-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
        desiredConfigVersion: 1,
      },
    });
    const endpoint = await prisma.endpoint.create({
      data: {
        nodeId: node.id,
        host: 'worker-route.example.test',
        addressKind: 'HOSTNAME',
        port: 443,
      },
    });
    const profile = await prisma.connectionProfile.create({
      data: {
        nodeId: node.id,
        version: 1,
        status: 'ACTIVE',
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      },
    });
    await prisma.vlessTcpTlsPublicConfig.create({
      data: {
        connectionProfileId: profile.id,
        tlsServerName: 'worker-route.example.test',
        displayName: 'Worker route',
      },
    });
    await prisma.endpointConnectionProfile.create({
      data: {
        endpointId: endpoint.id,
        connectionProfileId: profile.id,
        nodeId: node.id,
      },
    });
    const syncJob = await prisma.nodeSyncJob.create({
      data: {
        nodeId: node.id,
        routeEndpointId: endpoint.id,
        routeConnectionProfileId: profile.id,
        targetVersion: 1,
        idempotencyKey: `route-sync-consumer-${suffix}`,
      },
    });
    await prisma.outboxEvent.create({
      data: {
        topic: 'node-sync.requested',
        aggregateType: 'ConnectionRoute',
        aggregateId: endpoint.id,
        payload: {
          routeEndpointId: endpoint.id,
          routeConnectionProfileId: profile.id,
          nodeSyncJobId: syncJob.id,
          targetVersion: 1,
        },
        idempotencyKey: `route-sync-consumer-outbox-${suffix}`,
      },
    });
    const command = {
      routeEndpointId: endpoint.id,
      routeConnectionProfileId: profile.id,
      nodeSyncJobId: syncJob.id,
      targetVersion: 1,
    };
    const processor = new NodeSyncProcessor(
      new PrismaNodeSyncStore(prisma, 5_000, 5_000, 3),
      `route-consumer-${suffix}`,
      pino({ enabled: false }),
    );
    await expect(
      processor.process({ name: 'node-sync.requested', data: command }),
    ).rejects.toThrow('temporarily unavailable');
    await prisma.endpointConnectionProfile.update({
      where: {
        endpointId_connectionProfileId: {
          endpointId: endpoint.id,
          connectionProfileId: profile.id,
        },
      },
      data: { activationVersion: 1 },
    });

    await expect(
      processor.process({ name: 'node-sync.requested', data: command }),
    ).resolves.toBeUndefined();
    await expect(
      prisma.nodeSyncJob.findUniqueOrThrow({ where: { id: syncJob.id } }),
    ).resolves.toMatchObject({
      status: 'SUCCEEDED',
      attempts: 1,
      completedAt: expect.any(Date),
    });
  });

  it.each([
    {
      name: 'a disabled endpoint',
      close: async (
        client: PrismaClient,
        route: {
          node: { id: string };
          endpoint: { id: string };
          profile: { id: string };
        },
      ) => {
        await client.endpoint.update({
          where: { id: route.endpoint.id },
          data: { status: 'DISABLED' },
        });
      },
    },
    {
      name: 'a disabled profile',
      close: async (
        client: PrismaClient,
        route: {
          node: { id: string };
          endpoint: { id: string };
          profile: { id: string };
        },
      ) => {
        await client.connectionProfile.update({
          where: { id: route.profile.id },
          data: { status: 'DISABLED' },
        });
      },
    },
    {
      name: 'a node status change',
      close: async (
        client: PrismaClient,
        route: {
          node: { id: string };
          endpoint: { id: string };
          profile: { id: string };
        },
      ) => {
        await client.node.update({
          where: { id: route.node.id },
          data: { status: 'DRAINING' },
        });
      },
    },
  ])(
    'fails a matching route job after $name without a retryable error',
    async ({ close }) => {
      const suffix = randomUUID();
      const route = await createActivatedRouteJob(prisma, suffix);
      await close(prisma, route);
      await expect(
        prisma.endpointConnectionProfile.findUniqueOrThrow({
          where: {
            endpointId_connectionProfileId: {
              endpointId: route.endpoint.id,
              connectionProfileId: route.profile.id,
            },
          },
          select: { activationVersion: true, lastActivationVersion: true },
        }),
      ).resolves.toEqual({
        activationVersion: null,
        lastActivationVersion: 1,
      });
      const store = new PrismaNodeSyncStore(prisma, 5_000, 5_000, 3);
      const processor = new NodeSyncProcessor(
        store,
        `route-closed-${suffix}`,
        pino({ enabled: false }),
      );

      await expect(
        processor.process({
          name: 'node-sync.requested',
          data: route.command,
        }),
      ).resolves.toBeUndefined();
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({
          where: { id: route.syncJob.id },
        }),
      ).resolves.toMatchObject({
        status: 'FAILED',
        attempts: 0,
        lastErrorCode: 'ROUTE_ACTIVATION_CLOSED',
        completedAt: expect.any(Date),
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      await expect(
        store.claim(route.command, `route-closed-retry-${suffix}`),
      ).resolves.toBe('terminal');
      await expect(
        processor.process({
          name: 'node-sync.requested',
          data: route.command,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it('keeps an unrelated grant claimable after a fail-closed route job', async () => {
    const suffix = randomUUID();
    const route = await createActivatedRouteJob(prisma, suffix, {
      includeGrant: true,
    });
    if (!route.grantJob || !route.grantCommand) {
      throw new Error('Grant job was not created');
    }
    await prisma.endpoint.update({
      where: { id: route.endpoint.id },
      data: { status: 'DISABLED' },
    });
    const store = new PrismaNodeSyncStore(prisma, 5_000, 5_000, 3);
    const processor = new NodeSyncProcessor(
      store,
      `route-grant-${suffix}`,
      pino({ enabled: false }),
    );

    await expect(
      processor.process({
        name: 'node-sync.requested',
        data: route.command,
      }),
    ).resolves.toBeUndefined();
    await expect(
      prisma.nodeSyncJob.findUniqueOrThrow({
        where: { id: route.syncJob.id },
      }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      lastErrorCode: 'ROUTE_ACTIVATION_CLOSED',
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    await expect(
      processor.process({
        name: 'node-sync.requested',
        data: route.grantCommand,
      }),
    ).resolves.toBeUndefined();
    await expect(
      prisma.nodeSyncJob.findUniqueOrThrow({
        where: { id: route.grantJob.id },
      }),
    ).resolves.toMatchObject({
      status: 'SUCCEEDED',
      attempts: 1,
      completedAt: expect.any(Date),
    });
  });

  it('recovers every permitted BullMQ stall and fails exactly at the shared attempt limit', async () => {
    const suffix = randomUUID();
    const maxAttempts = 3;
    const stalledQueueName = `${redisNamespace}-stalls-${suffix}`;
    const stalledQueue = new Queue(stalledQueueName, { connection });
    const stalledQueueEvents = new QueueEvents(stalledQueueName, {
      connection,
    });
    await Promise.all([
      stalledQueue.waitUntilReady(),
      stalledQueueEvents.waitUntilReady(),
    ]);
    const user = await prisma.user.create({
      data: { telegramUserId: `92${suffix.replaceAll('-', '').slice(0, 20)}` },
    });
    const device = await prisma.device.create({
      data: {
        userId: user.id,
        subscriptionTokenHash: `node-sync-stalls-${suffix}`,
      },
    });
    const node = await prisma.node.create({
      data: {
        name: `node-sync-stalls-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
        desiredConfigVersion: 1,
      },
    });
    const grant = await prisma.nodeAccessGrant.create({
      data: {
        nodeId: node.id,
        deviceId: device.id,
        dataPlaneCredentialHash: `node-sync-stalls-${suffix}`,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        desiredVersion: 1,
      },
    });
    const syncJob = await prisma.nodeSyncJob.create({
      data: {
        nodeId: node.id,
        nodeAccessGrantId: grant.id,
        targetVersion: 1,
        idempotencyKey: `node-sync-stalls-${suffix}`,
      },
    });
    const orphanedSyncJob = await prisma.nodeSyncJob.create({
      data: {
        nodeId: node.id,
        nodeAccessGrantId: grant.id,
        targetVersion: 1,
        idempotencyKey: `node-sync-orphan-${suffix}`,
        status: 'PROCESSING',
        attempts: 1,
        leaseOwner: 'orphaned-worker',
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
      },
    });
    const command = {
      nodeAccessGrantId: grant.id,
      nodeSyncJobId: syncJob.id,
      targetVersion: 1,
    };
    const store = new PrismaNodeSyncStore(prisma, 200, 200, maxAttempts);
    const claims: { owner: string; token: string }[] = [];
    const abortController = new AbortController();
    const reclaimer = runNodeSyncLeaseReclaimer(
      store,
      50,
      abortController.signal,
    );
    const stalledConsumer = new Worker(
      stalledQueueName,
      async (job) => {
        const owner = `stalled-${claims.length + 1}`;
        const claim = await store.claim(command, owner);
        if (typeof claim === 'object' && claim) {
          claims.push({ owner, token: claim.leaseToken });
          const redis = await stalledQueue.client;
          await redis.del(`${stalledQueue.toKey(job.id!)}:lock`);
          return new Promise<void>(() => undefined);
        }
      },
      {
        connection,
        concurrency: maxAttempts + 1,
        lockDuration: 200,
        stalledInterval: 200,
        maxStalledCount: maxAttempts,
        skipLockRenewal: true,
      },
    );
    stalledConsumer.on('error', () => undefined);

    try {
      const queued = await stalledQueue.add('node-sync.requested', command, {
        jobId: randomUUID(),
        attempts: maxAttempts + 1,
        backoff: { type: 'fixed', delay: 200 },
        removeOnComplete: false,
        removeOnFail: false,
      });
      try {
        await expect(
          queued.waitUntilFinished(stalledQueueEvents, 10_000),
        ).resolves.toBeNull();
      } catch {
        const state = await queued.getState();
        const persisted = await prisma.nodeSyncJob.findUniqueOrThrow({
          where: { id: syncJob.id },
        });
        throw new Error(
          `stalled diagnostic state=${state} claims=${claims.length} db=${persisted.status}/${persisted.attempts}`,
        );
      }
      expect(claims).toHaveLength(maxAttempts);
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({
          where: { id: orphanedSyncJob.id },
        }),
      ).resolves.toMatchObject({
        status: 'PENDING',
        attempts: 1,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      await expect(
        store.complete(syncJob.id, claims[0]!.owner, claims[0]!.token),
      ).resolves.toBe(false);
      await expect(
        store.retry(
          syncJob.id,
          claims[0]!.owner,
          claims[0]!.token,
          'STALE_LEASE',
        ),
      ).resolves.toBe('fenced');
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({ where: { id: syncJob.id } }),
      ).resolves.toMatchObject({
        status: 'FAILED',
        attempts: maxAttempts,
        lastErrorCode: 'NODE_SYNC_LEASE_EXPIRED',
        completedAt: expect.any(Date),
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      await expect(
        store.claim(command, 'forbidden-fourth-attempt'),
      ).resolves.toBe('terminal');
    } finally {
      abortController.abort();
      await stalledConsumer.close(true);
      await reclaimer;
      await stalledQueue.obliterate({ force: true });
      await Promise.all([stalledQueueEvents.close(), stalledQueue.close()]);
    }
  }, 30_000);
});
