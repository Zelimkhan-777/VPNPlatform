import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  cabinetOverviewSchema,
  issuedCabinetDeviceSchema,
  nodeAgentConfigurationSnapshotSchema,
  readinessResponseSchema,
  subscriptionFeedSchema,
} from '@vpn-platform/contracts';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { NodeAgentCredentialService } from '../src/orchestration/node-agent-credential.service';
import { OrchestrationService } from '../src/orchestration/orchestration.service';
import { RedisService } from '../src/redis/redis.service';

function authenticatedNodeId(
  credentials: NodeAgentCredentialService,
  secret: string,
): Promise<string | null> {
  return credentials.withAuthenticatedNodeTransaction(secret, (nodeId) =>
    Promise.resolve(nodeId),
  );
}

describe('infrastructure readiness', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const testingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = testingModule.createNestApplication(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('executes PostgreSQL SELECT 1 and Redis PING through readiness', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect(readinessResponseSchema.parse(response.body)).toEqual({
      status: 'ready',
      dependencies: { postgres: 'up', redis: 'up' },
    });
  });

  it('serializes concurrent idempotent desired-state scheduling', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const suffix = randomUUID();
    const telegramUserId = suffix.replaceAll('-', '');
    const syncJobIdempotencyKey = `concurrent-sync-${suffix}`;
    const outboxEventIdempotencyKey = `concurrent-outbox-${suffix}`;
    let planId: string | undefined;
    let userId: string | undefined;
    let deviceId: string | undefined;
    let nodeId: string | undefined;

    try {
      const plan = await prisma.plan.create({
        data: {
          code: `concurrent-${suffix}`,
          name: 'Concurrent integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 1,
        },
      });
      planId = plan.id;
      const user = await prisma.user.create({ data: { telegramUserId } });
      userId = user.id;
      await prisma.subscription.create({
        data: {
          userId: user.id,
          planId: plan.id,
          status: 'ACTIVE',
          startsAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const device = await prisma.device.create({
        data: {
          userId: user.id,
          displayName: 'Concurrent integration device',
          subscriptionTokenHash: `concurrent-feed-hash-${suffix}`,
        },
      });
      deviceId = device.id;
      const node = await prisma.node.create({
        data: {
          name: `concurrent-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      });
      nodeId = node.id;
      const input = {
        nodeId: node.id,
        deviceId: device.id,
        dataPlaneCredentialHash: `concurrent-credential-hash-${suffix}`,
        expiresAt: new Date(Date.now() + 60_000),
        syncJobIdempotencyKey,
        outboxEventIdempotencyKey,
      };

      const [first, second] = await Promise.all([
        orchestration.scheduleNodeAccessGrant(input),
        orchestration.scheduleNodeAccessGrant(input),
      ]);

      expect(second).toEqual(first);
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({ desiredConfigVersion: 1 });
      await expect(
        prisma.nodeAccessGrant.count({ where: { deviceId: device.id } }),
      ).resolves.toBe(1);
      await expect(
        prisma.nodeSyncJob.count({
          where: { idempotencyKey: syncJobIdempotencyKey },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.outboxEvent.count({
          where: { idempotencyKey: outboxEventIdempotencyKey },
        }),
      ).resolves.toBe(1);
    } finally {
      await prisma.nodeSyncJob.deleteMany({
        where: { idempotencyKey: syncJobIdempotencyKey },
      });
      await prisma.outboxEvent.deleteMany({
        where: { idempotencyKey: outboxEventIdempotencyKey },
      });
      if (deviceId) {
        await prisma.nodeAccessGrant.deleteMany({ where: { deviceId } });
      }
      if (userId) {
        await prisma.subscription.deleteMany({ where: { userId } });
        await prisma.device.deleteMany({ where: { userId } });
      }
      if (nodeId) {
        await prisma.node.delete({ where: { id: nodeId } });
      }
      if (userId) {
        await prisma.user.delete({ where: { id: userId } });
      }
      if (planId) {
        await prisma.plan.delete({ where: { id: planId } });
      }
    }
  });

  it('orders concurrent desired-state scheduling for different devices', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const suffix = randomUUID();
    const telegramUserId = suffix.replaceAll('-', '');
    let userId: string | undefined;
    let nodeId: string | undefined;
    let outboxEventIds: string[] = [];

    try {
      const user = await prisma.user.create({ data: { telegramUserId } });
      userId = user.id;
      const [firstDevice, secondDevice] = await prisma.$transaction([
        prisma.device.create({
          data: {
            userId: user.id,
            displayName: 'First concurrent integration device',
            subscriptionTokenHash: `first-concurrent-feed-hash-${suffix}`,
          },
        }),
        prisma.device.create({
          data: {
            userId: user.id,
            displayName: 'Second concurrent integration device',
            subscriptionTokenHash: `second-concurrent-feed-hash-${suffix}`,
          },
        }),
      ]);
      const node = await prisma.node.create({
        data: {
          name: `different-concurrent-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      });
      nodeId = node.id;
      const expiresAt = new Date(Date.now() + 60_000);

      const [first, second] = await Promise.all([
        orchestration.scheduleNodeAccessGrant({
          nodeId: node.id,
          deviceId: firstDevice.id,
          dataPlaneCredentialHash: `first-concurrent-credential-hash-${suffix}`,
          expiresAt,
          syncJobIdempotencyKey: `first-concurrent-sync-${suffix}`,
          outboxEventIdempotencyKey: `first-concurrent-outbox-${suffix}`,
        }),
        orchestration.scheduleNodeAccessGrant({
          nodeId: node.id,
          deviceId: secondDevice.id,
          dataPlaneCredentialHash: `second-concurrent-credential-hash-${suffix}`,
          expiresAt,
          syncJobIdempotencyKey: `second-concurrent-sync-${suffix}`,
          outboxEventIdempotencyKey: `second-concurrent-outbox-${suffix}`,
        }),
      ]);
      outboxEventIds = [first.outboxEventId, second.outboxEventId];

      expect([first.targetVersion, second.targetVersion].sort()).toEqual([
        1, 2,
      ]);
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({ desiredConfigVersion: 2 });
      await expect(
        prisma.nodeAccessGrant.count({ where: { nodeId: node.id } }),
      ).resolves.toBe(2);
      await expect(
        prisma.nodeSyncJob.count({ where: { nodeId: node.id } }),
      ).resolves.toBe(2);
      await expect(
        prisma.outboxEvent.count({ where: { id: { in: outboxEventIds } } }),
      ).resolves.toBe(2);
    } finally {
      if (nodeId) {
        await prisma.nodeSyncJob.deleteMany({ where: { nodeId } });
      }
      if (outboxEventIds.length > 0) {
        await prisma.outboxEvent.deleteMany({
          where: { id: { in: outboxEventIds } },
        });
      }
      if (nodeId) {
        await prisma.nodeAccessGrant.deleteMany({ where: { nodeId } });
      }
      if (userId) {
        await prisma.device.deleteMany({ where: { userId } });
      }
      if (nodeId) {
        await prisma.node.delete({ where: { id: nodeId } });
      }
      if (userId) {
        await prisma.user.delete({ where: { id: userId } });
      }
    }
  });

  it('fences stale workers after a lease is reclaimed', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const suffix = randomUUID();
    const telegramUserId = suffix.replaceAll('-', '');
    let userId: string | undefined;
    let deviceId: string | undefined;
    let nodeId: string | undefined;
    let grantId: string | undefined;
    let nodeSyncJobId: string | undefined;
    let outboxEventId: string | undefined;

    try {
      const user = await prisma.user.create({ data: { telegramUserId } });
      userId = user.id;
      const device = await prisma.device.create({
        data: {
          userId: user.id,
          displayName: 'Lease fencing integration device',
          subscriptionTokenHash: `lease-fencing-feed-hash-${suffix}`,
        },
      });
      deviceId = device.id;
      const node = await prisma.node.create({
        data: {
          name: `lease-fencing-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      });
      nodeId = node.id;
      const grant = await prisma.nodeAccessGrant.create({
        data: {
          nodeId: node.id,
          deviceId: device.id,
          dataPlaneCredentialHash: `lease-fencing-credential-hash-${suffix}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      grantId = grant.id;
      const syncJob = await prisma.nodeSyncJob.create({
        data: {
          nodeId: node.id,
          nodeAccessGrantId: grant.id,
          targetVersion: 0,
          idempotencyKey: `lease-fencing-sync-${suffix}`,
        },
      });
      nodeSyncJobId = syncJob.id;
      const outboxEvent = await prisma.outboxEvent.create({
        data: {
          topic: 'node-sync.requested',
          aggregateType: 'NodeAccessGrant',
          aggregateId: grant.id,
          payload: { nodeAccessGrantId: grant.id },
          idempotencyKey: `lease-fencing-outbox-${suffix}`,
        },
      });
      outboxEventId = outboxEvent.id;
      const claimedAt = new Date('2026-08-11T08:00:00.000Z');
      const expiredAt = new Date('2026-08-11T08:00:30.000Z');

      const staleNodeSyncToken = await orchestration.claimNodeSyncJob(
        syncJob.id,
        'worker-a',
        claimedAt,
      );
      const staleOutboxToken = await orchestration.claimOutboxEvent(
        outboxEvent.id,
        'worker-a',
        claimedAt,
      );
      expect(staleNodeSyncToken).toEqual(expect.any(String));
      expect(staleOutboxToken).toEqual(expect.any(String));
      await expect(
        orchestration.completeNodeSyncJob(
          syncJob.id,
          'worker-b',
          staleNodeSyncToken as string,
          claimedAt,
        ),
      ).resolves.toBe(false);
      await expect(
        orchestration.publishOutboxEvent(
          outboxEvent.id,
          'worker-b',
          staleOutboxToken as string,
          claimedAt,
        ),
      ).resolves.toBe(false);
      await expect(
        orchestration.reclaimExpiredLeases(expiredAt),
      ).resolves.toEqual({ nodeSyncJobs: 1, outboxEvents: 1 });

      const currentNodeSyncToken = await orchestration.claimNodeSyncJob(
        syncJob.id,
        'worker-b',
        expiredAt,
      );
      const currentOutboxToken = await orchestration.claimOutboxEvent(
        outboxEvent.id,
        'worker-b',
        expiredAt,
      );
      expect(currentNodeSyncToken).toEqual(expect.any(String));
      expect(currentOutboxToken).toEqual(expect.any(String));
      expect(currentNodeSyncToken).not.toBe(staleNodeSyncToken);
      expect(currentOutboxToken).not.toBe(staleOutboxToken);
      await expect(
        orchestration.completeNodeSyncJob(
          syncJob.id,
          'worker-a',
          staleNodeSyncToken as string,
          expiredAt,
        ),
      ).resolves.toBe(false);
      await expect(
        orchestration.publishOutboxEvent(
          outboxEvent.id,
          'worker-a',
          staleOutboxToken as string,
          expiredAt,
        ),
      ).resolves.toBe(false);
      await expect(
        orchestration.completeNodeSyncJob(
          syncJob.id,
          'worker-b',
          currentNodeSyncToken as string,
          expiredAt,
        ),
      ).resolves.toBe(true);
      await expect(
        orchestration.publishOutboxEvent(
          outboxEvent.id,
          'worker-b',
          currentOutboxToken as string,
          expiredAt,
        ),
      ).resolves.toBe(true);
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({ where: { id: syncJob.id } }),
      ).resolves.toMatchObject({ status: 'SUCCEEDED', completedAt: expiredAt });
      await expect(
        prisma.outboxEvent.findUniqueOrThrow({ where: { id: outboxEvent.id } }),
      ).resolves.toMatchObject({ status: 'PUBLISHED', publishedAt: expiredAt });
      await expect(
        prisma.nodeSyncJob.update({
          where: { id: syncJob.id },
          data: { lastErrorCode: 'LATE_MUTATION' },
        }),
      ).rejects.toThrow('NodeSyncJob terminal state is immutable');
      await expect(
        prisma.outboxEvent.update({
          where: { id: outboxEvent.id },
          data: { lastErrorCode: 'LATE_MUTATION' },
        }),
      ).rejects.toThrow('OutboxEvent terminal state is immutable');
    } finally {
      if (nodeSyncJobId) {
        await prisma.nodeSyncJob.delete({ where: { id: nodeSyncJobId } });
      }
      if (outboxEventId) {
        await prisma.outboxEvent.delete({ where: { id: outboxEventId } });
      }
      if (grantId) {
        await prisma.nodeAccessGrant.delete({ where: { id: grantId } });
      }
      if (deviceId) {
        await prisma.device.delete({ where: { id: deviceId } });
      }
      if (nodeId) {
        await prisma.node.delete({ where: { id: nodeId } });
      }
      if (userId) {
        await prisma.user.delete({ where: { id: userId } });
      }
    }
  });

  it('stops retrying terminal work after the configured attempt limit', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const suffix = randomUUID();
    const telegramUserId = suffix.replaceAll('-', '');
    let userId: string | undefined;
    let deviceId: string | undefined;
    let nodeId: string | undefined;
    let nodeAccessGrantId: string | undefined;
    let nodeSyncJobId: string | undefined;
    let outboxEventId: string | undefined;

    try {
      const user = await prisma.user.create({ data: { telegramUserId } });
      userId = user.id;
      const device = await prisma.device.create({
        data: {
          userId: user.id,
          displayName: 'Retry limit integration device',
          subscriptionTokenHash: `retry-limit-feed-hash-${suffix}`,
        },
      });
      deviceId = device.id;
      const node = await prisma.node.create({
        data: {
          name: `retry-limit-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      });
      nodeId = node.id;
      const scheduled = await orchestration.scheduleNodeAccessGrant({
        nodeId: node.id,
        deviceId: device.id,
        dataPlaneCredentialHash: `retry-limit-credential-hash-${suffix}`,
        expiresAt: new Date(Date.now() + 60_000),
        syncJobIdempotencyKey: `retry-limit-sync-${suffix}`,
        outboxEventIdempotencyKey: `retry-limit-outbox-${suffix}`,
      });
      nodeAccessGrantId = scheduled.nodeAccessGrantId;
      nodeSyncJobId = scheduled.nodeSyncJobId;
      outboxEventId = scheduled.outboxEventId;

      let nodeSyncNow = new Date('2026-08-11T09:00:00.000Z');
      for (let attempt = 1; attempt < 5; attempt += 1) {
        const token = await orchestration.claimNodeSyncJob(
          scheduled.nodeSyncJobId,
          'worker-a',
          nodeSyncNow,
        );
        expect(token).toEqual(expect.any(String));
        const nextAttemptAt = new Date(nodeSyncNow.getTime() + 1_000);
        await expect(
          orchestration.retryNodeSyncJob(
            scheduled.nodeSyncJobId,
            'worker-a',
            token as string,
            nextAttemptAt,
            'NETWORK_ERROR',
            nodeSyncNow,
          ),
        ).resolves.toBe(true);
        nodeSyncNow = nextAttemptAt;
      }
      const finalNodeSyncToken = await orchestration.claimNodeSyncJob(
        scheduled.nodeSyncJobId,
        'worker-a',
        nodeSyncNow,
      );
      expect(finalNodeSyncToken).toEqual(expect.any(String));
      await expect(
        orchestration.retryNodeSyncJob(
          scheduled.nodeSyncJobId,
          'worker-a',
          finalNodeSyncToken as string,
          new Date(nodeSyncNow.getTime() + 1_000),
          'NETWORK_ERROR',
          nodeSyncNow,
        ),
      ).resolves.toBe(true);
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({
          where: { id: scheduled.nodeSyncJobId },
        }),
      ).resolves.toMatchObject({
        status: 'FAILED',
        attempts: 5,
        lastErrorCode: 'NETWORK_ERROR',
        completedAt: nodeSyncNow,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      });
      await expect(
        orchestration.claimNodeSyncJob(
          scheduled.nodeSyncJobId,
          'worker-a',
          nodeSyncNow,
        ),
      ).resolves.toBeNull();

      let outboxNow = new Date('2026-08-11T10:00:00.000Z');
      for (let attempt = 1; attempt < 5; attempt += 1) {
        const token = await orchestration.claimOutboxEvent(
          scheduled.outboxEventId,
          'worker-a',
          outboxNow,
        );
        expect(token).toEqual(expect.any(String));
        const nextAttemptAt = new Date(outboxNow.getTime() + 1_000);
        await expect(
          orchestration.retryOutboxEvent(
            scheduled.outboxEventId,
            'worker-a',
            token as string,
            nextAttemptAt,
            'NETWORK_ERROR',
            outboxNow,
          ),
        ).resolves.toBe(true);
        outboxNow = nextAttemptAt;
      }
      const finalOutboxToken = await orchestration.claimOutboxEvent(
        scheduled.outboxEventId,
        'worker-a',
        outboxNow,
      );
      expect(finalOutboxToken).toEqual(expect.any(String));
      await expect(
        orchestration.retryOutboxEvent(
          scheduled.outboxEventId,
          'worker-a',
          finalOutboxToken as string,
          new Date(outboxNow.getTime() + 1_000),
          'NETWORK_ERROR',
          outboxNow,
        ),
      ).resolves.toBe(true);
      await expect(
        prisma.outboxEvent.findUniqueOrThrow({
          where: { id: scheduled.outboxEventId },
        }),
      ).resolves.toMatchObject({
        status: 'FAILED',
        attempts: 5,
        lastErrorCode: 'NETWORK_ERROR',
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      });
      await expect(
        orchestration.claimOutboxEvent(
          scheduled.outboxEventId,
          'worker-a',
          outboxNow,
        ),
      ).resolves.toBeNull();
      await expect(
        prisma.nodeSyncJob.update({
          where: { id: scheduled.nodeSyncJobId },
          data: { lastErrorCode: 'LATE_MUTATION' },
        }),
      ).rejects.toThrow('NodeSyncJob terminal state is immutable');
      await expect(
        prisma.outboxEvent.update({
          where: { id: scheduled.outboxEventId },
          data: { lastErrorCode: 'LATE_MUTATION' },
        }),
      ).rejects.toThrow('OutboxEvent terminal state is immutable');
    } finally {
      if (nodeSyncJobId) {
        await prisma.nodeSyncJob.delete({ where: { id: nodeSyncJobId } });
      }
      if (outboxEventId) {
        await prisma.outboxEvent.delete({ where: { id: outboxEventId } });
      }
      if (nodeAccessGrantId) {
        await prisma.nodeAccessGrant.delete({
          where: { id: nodeAccessGrantId },
        });
      }
      if (deviceId) {
        await prisma.device.delete({ where: { id: deviceId } });
      }
      if (nodeId) {
        await prisma.node.delete({ where: { id: nodeId } });
      }
      if (userId) {
        await prisma.user.delete({ where: { id: userId } });
      }
    }
  });

  it('records only succeeded node configuration acknowledgements', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const credentials = app.get(NodeAgentCredentialService);
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { telegramUserId: suffix.replaceAll('-', '') },
    });
    const device = await prisma.device.create({
      data: {
        userId: user.id,
        subscriptionTokenHash: `config-acknowledgement-feed-${suffix}`,
      },
    });
    const node = await prisma.node.create({
      data: {
        name: `config-acknowledgement-${suffix}`,
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
        dataPlaneCredentialHash: `config-acknowledgement-credential-${suffix}`,
        expiresAt: new Date('2026-09-01T00:00:00.000Z'),
        desiredVersion: 1,
      },
    });
    const otherNode = await prisma.node.create({
      data: {
        name: `config-acknowledgement-other-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
        desiredConfigVersion: 1,
      },
    });
    const otherGrant = await prisma.nodeAccessGrant.create({
      data: {
        nodeId: otherNode.id,
        deviceId: device.id,
        dataPlaneCredentialHash: `config-acknowledgement-other-credential-${suffix}`,
        expiresAt: new Date('2026-09-01T00:00:00.000Z'),
        desiredVersion: 1,
      },
    });
    const syncJob = await prisma.nodeSyncJob.create({
      data: {
        nodeId: node.id,
        nodeAccessGrantId: grant.id,
        targetVersion: 1,
        idempotencyKey: `config-acknowledgement-sync-${suffix}`,
      },
    });
    const now = new Date('2026-08-11T11:00:00.000Z');
    const credential = await credentials.rotate(node.id, now);

    await expect(
      orchestration.acknowledgeNodeConfig(
        {
          nodeId: node.id,
          nodeSyncJobId: syncJob.id,
          targetVersion: 1,
        },
        now,
      ),
    ).rejects.toThrow('Node sync job is not eligible for acknowledgement');
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .send({ nodeSyncJobId: syncJob.id, targetVersion: 1 })
      .expect(401);
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send({ nodeSyncJobId: 'not-a-uuid', targetVersion: -1 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send({ nodeSyncJobId: syncJob.id, targetVersion: 1 })
      .expect(409);
    await expect(
      prisma.node.update({
        where: { id: node.id },
        data: { appliedConfigVersion: 1 },
      }),
    ).rejects.toThrow('Node appliedConfigVersion requires an acknowledgement');

    const leaseToken = await orchestration.claimNodeSyncJob(
      syncJob.id,
      'worker-a',
      now,
    );
    expect(leaseToken).toEqual(expect.any(String));
    await expect(
      orchestration.completeNodeSyncJob(
        syncJob.id,
        'worker-a',
        leaseToken as string,
        now,
      ),
    ).resolves.toBe(true);

    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send({ nodeSyncJobId: syncJob.id, targetVersion: 1 })
      .expect(204);
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send({ nodeSyncJobId: syncJob.id, targetVersion: 1 })
      .expect(204);
    await expect(
      prisma.nodeConfigAcknowledgement.findUniqueOrThrow({
        where: { nodeSyncJobId: syncJob.id },
      }),
    ).resolves.toMatchObject({
      nodeId: node.id,
      targetVersion: 1,
      acknowledgedAt: expect.any(Date),
    });
    await expect(
      prisma.nodeAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
    ).resolves.toMatchObject({ desiredVersion: 1, appliedVersion: 1 });
    await expect(
      prisma.nodeAccessGrant.findUniqueOrThrow({
        where: { id: otherGrant.id },
      }),
    ).resolves.toMatchObject({ desiredVersion: 1, appliedVersion: 0 });
    await expect(
      prisma.node.update({
        where: { id: node.id },
        data: { appliedConfigVersion: 0 },
      }),
    ).rejects.toThrow('Node appliedConfigVersion cannot decrease');
    await expect(
      prisma.nodeConfigAcknowledgement.update({
        where: { nodeSyncJobId: syncJob.id },
        data: { acknowledgedAt: new Date(now.getTime() + 1_000) },
      }),
    ).rejects.toThrow('NodeConfigAcknowledgement is append-only');
    await expect(credentials.revoke(node.id, now)).resolves.toBe(true);
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send({ nodeSyncJobId: syncJob.id, targetVersion: 1 })
      .expect(401);
    const disabledNodeCredential = await credentials.rotate(node.id, now);
    await prisma.node.update({
      where: { id: node.id },
      data: { status: 'DISABLED' },
    });
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${disabledNodeCredential.secret}`)
      .send({ nodeSyncJobId: syncJob.id, targetVersion: 1 })
      .expect(401);
  });

  it('rotates and revokes hashed node-agent credentials', async () => {
    const prisma = app.get(PrismaService);
    const credentials = app.get(NodeAgentCredentialService);
    const suffix = randomUUID();
    const node = await prisma.node.create({
      data: {
        name: `agent-credential-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
      },
    });
    const firstRotationAt = new Date('2026-08-11T12:00:00.000Z');
    const secondRotationAt = new Date('2026-08-11T12:01:00.000Z');

    try {
      const first = await credentials.rotate(node.id, firstRotationAt);
      expect(first.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await expect(
        authenticatedNodeId(credentials, first.secret),
      ).resolves.toBe(node.id);
      await expect(
        authenticatedNodeId(credentials, 'not-a-credential'),
      ).resolves.toBeNull();
      await expect(
        prisma.nodeAgentCredential.findUniqueOrThrow({
          where: { id: first.credentialId },
        }),
      ).resolves.toMatchObject({
        nodeId: node.id,
        secretHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        revokedAt: null,
      });
      await expect(
        prisma.nodeAgentCredential.create({
          data: {
            nodeId: node.id,
            secretHash: 'a'.repeat(64),
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      const second = await credentials.rotate(node.id, secondRotationAt);
      expect(second.secret).not.toBe(first.secret);
      await expect(
        authenticatedNodeId(credentials, first.secret),
      ).resolves.toBeNull();
      await expect(
        authenticatedNodeId(credentials, second.secret),
      ).resolves.toBe(node.id);
      await expect(
        prisma.nodeAgentCredential.findUniqueOrThrow({
          where: { id: first.credentialId },
        }),
      ).resolves.toMatchObject({ revokedAt: secondRotationAt });
      await expect(
        prisma.nodeAgentCredential.count({
          where: { nodeId: node.id, revokedAt: null },
        }),
      ).resolves.toBe(1);

      let releaseOperation: (() => void) | undefined;
      let signalOperationStarted: (() => void) | undefined;
      const operationStarted = new Promise<void>((resolve) => {
        signalOperationStarted = resolve;
      });
      const protectedOperation = credentials.withAuthenticatedNodeTransaction(
        second.secret,
        async () => {
          signalOperationStarted?.();
          await new Promise<void>((resolve) => {
            releaseOperation = resolve;
          });
          return true;
        },
      );
      await operationStarted;
      let revocationCompleted = false;
      const pendingRevocation = credentials
        .revoke(node.id, secondRotationAt)
        .then((result) => {
          revocationCompleted = true;
          return result;
        });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(revocationCompleted).toBe(false);
      releaseOperation?.();
      await expect(protectedOperation).resolves.toBe(true);
      await expect(pendingRevocation).resolves.toBe(true);
      await expect(
        authenticatedNodeId(credentials, second.secret),
      ).resolves.toBeNull();

      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'DISABLED' },
      });
      await expect(
        authenticatedNodeId(credentials, second.secret),
      ).resolves.toBeNull();
      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'HEALTHY' },
      });
      await expect(credentials.revoke(node.id, secondRotationAt)).resolves.toBe(
        false,
      );
    } finally {
      await prisma.nodeAgentCredential.deleteMany({
        where: { nodeId: node.id },
      });
      await prisma.node.delete({ where: { id: node.id } });
    }
  });

  it('returns only the authenticated node lifecycle snapshot', async () => {
    const prisma = app.get(PrismaService);
    const credentials = app.get(NodeAgentCredentialService);
    const suffix = randomUUID();
    let userId: string | undefined;
    let deviceId: string | undefined;
    let nodeId: string | undefined;
    let otherNodeId: string | undefined;

    try {
      const user = await prisma.user.create({
        data: { telegramUserId: suffix.replaceAll('-', '') },
      });
      userId = user.id;
      const device = await prisma.device.create({
        data: {
          userId: user.id,
          subscriptionTokenHash: `snapshot-feed-hash-${suffix}`,
        },
      });
      deviceId = device.id;
      const [node, otherNode] = await prisma.$transaction([
        prisma.node.create({
          data: {
            name: `snapshot-${suffix}`,
            provider: 'integration-test',
            locationLabel: 'integration-test',
            status: 'HEALTHY',
            desiredConfigVersion: 1,
          },
        }),
        prisma.node.create({
          data: {
            name: `snapshot-other-${suffix}`,
            provider: 'integration-test',
            locationLabel: 'integration-test',
            status: 'HEALTHY',
            desiredConfigVersion: 1,
          },
        }),
      ]);
      nodeId = node.id;
      otherNodeId = otherNode.id;
      const expiresAt = new Date('2026-09-01T00:00:00.000Z');
      const [grant] = await prisma.$transaction([
        prisma.nodeAccessGrant.create({
          data: {
            nodeId: node.id,
            deviceId: device.id,
            dataPlaneCredentialHash: `snapshot-credential-hash-${suffix}`,
            expiresAt,
            desiredVersion: 1,
          },
        }),
        prisma.nodeAccessGrant.create({
          data: {
            nodeId: otherNode.id,
            deviceId: device.id,
            dataPlaneCredentialHash: `snapshot-other-credential-hash-${suffix}`,
            expiresAt,
            desiredVersion: 1,
          },
        }),
      ]);
      const credential = await credentials.rotate(node.id);

      await request(app.getHttpServer())
        .post('/node-agent/v1/heartbeats')
        .expect(401);
      await request(app.getHttpServer())
        .post('/node-agent/v1/heartbeats')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(204);
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({
        lastHeartbeatAt: expect.any(Date),
        lastHealthCheckAt: null,
      });

      await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .expect(401);
      const response = await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(200);

      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.body).sort()).toEqual([
        'appliedConfigVersion',
        'desiredConfigVersion',
        'grants',
      ]);
      expect(Object.keys(response.body.grants[0]).sort()).toEqual([
        'appliedVersion',
        'desiredVersion',
        'expiresAt',
        'id',
        'revokedAt',
        'status',
      ]);

      expect(nodeAgentConfigurationSnapshotSchema.parse(response.body)).toEqual(
        {
          desiredConfigVersion: 1,
          appliedConfigVersion: 0,
          grants: [
            {
              id: grant.id,
              status: 'PENDING',
              expiresAt: expiresAt.toISOString(),
              desiredVersion: 1,
              appliedVersion: 0,
              revokedAt: null,
            },
          ],
        },
      );
      expect(response.body.grants[0]).not.toHaveProperty('deviceId');
      expect(response.body.grants[0]).not.toHaveProperty(
        'dataPlaneCredentialHash',
      );

      await expect(credentials.revoke(node.id)).resolves.toBe(true);
      await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(401);
      await request(app.getHttpServer())
        .post('/node-agent/v1/heartbeats')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(401);
      const disabledNodeCredential = await credentials.rotate(node.id);

      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'DISABLED' },
      });
      await request(app.getHttpServer())
        .post('/node-agent/v1/heartbeats')
        .set('authorization', `Bearer ${disabledNodeCredential.secret}`)
        .expect(401);
      await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${disabledNodeCredential.secret}`)
        .expect(401);
    } finally {
      if (nodeId) {
        await prisma.nodeAgentCredential.deleteMany({ where: { nodeId } });
        await prisma.nodeAccessGrant.deleteMany({ where: { nodeId } });
      }
      if (otherNodeId) {
        await prisma.nodeAccessGrant.deleteMany({
          where: { nodeId: otherNodeId },
        });
      }
      if (nodeId) {
        await prisma.node.delete({ where: { id: nodeId } });
      }
      if (otherNodeId) {
        await prisma.node.delete({ where: { id: otherNodeId } });
      }
      if (deviceId) {
        await prisma.device.delete({ where: { id: deviceId } });
      }
      if (userId) {
        await prisma.user.delete({ where: { id: userId } });
      }
    }
  });

  it('persists isolated device access data and rejects a duplicate feed token hash', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const telegramUserId = suffix.replaceAll('-', '');
    const planCode = `integration-${suffix}`;
    const tokenHash = `feed-hash-${suffix}`;
    let userId: string | undefined;
    let planId: string | undefined;
    let deviceId: string | undefined;
    let scheduledDeviceId: string | undefined;
    let failedScheduledDeviceId: string | undefined;
    let nodeId: string | undefined;
    let unrelatedNodeId: string | undefined;
    let nodeAccessGrantId: string | undefined;
    let nodeSyncJobId: string | undefined;
    let outboxEventId: string | undefined;
    let conflictingOutboxEventId: string | undefined;

    try {
      await expect(
        prisma.plan.create({
          data: {
            code: `invalid-plan-${suffix}`,
            name: 'Invalid integration plan',
            priceMinor: 0,
            currency: 'RUB',
            deviceLimit: 1,
          },
        }),
      ).rejects.toThrow('Plan_priceMinor_positive');

      const plan = await prisma.plan.create({
        data: {
          code: planCode,
          name: 'Integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 1,
        },
      });
      planId = plan.id;

      const user = await prisma.user.create({
        data: { telegramUserId },
      });
      userId = user.id;

      await expect(
        prisma.subscription.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: 'ACTIVE',
          },
        }),
      ).rejects.toThrow('Subscription_active_has_access_period');

      await prisma.subscription.create({
        data: {
          userId: user.id,
          planId: plan.id,
          status: 'ACTIVE',
          startsAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      await expect(
        prisma.subscription.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: 'ACTIVE',
            startsAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      await expect(
        prisma.subscription.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: 'PENDING',
            cancelledAt: new Date(),
          },
        }),
      ).rejects.toThrow('Subscription_cancelledAt_matches_status');

      await expect(
        prisma.device.create({
          data: {
            userId: user.id,
            status: 'REVOKED',
            subscriptionTokenHash: `invalid-device-token-${suffix}`,
          },
        }),
      ).rejects.toThrow('Device_revoked_has_timestamp');

      const device = await prisma.device.create({
        data: {
          userId: user.id,
          displayName: 'Integration device',
          subscriptionTokenHash: tokenHash,
        },
      });
      deviceId = device.id;

      const scheduledDevice = await prisma.device.create({
        data: {
          userId: user.id,
          displayName: 'Scheduled integration device',
          subscriptionTokenHash: `scheduled-feed-hash-${suffix}`,
        },
      });
      scheduledDeviceId = scheduledDevice.id;

      const node = await prisma.node.create({
        data: {
          name: `integration-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      });
      nodeId = node.id;

      await expect(
        prisma.node.update({
          where: { id: node.id },
          data: { appliedConfigVersion: 1 },
        }),
      ).rejects.toThrow(
        'Node appliedConfigVersion requires an acknowledgement',
      );

      const orchestration = app.get(OrchestrationService);
      const scheduled = await orchestration.scheduleNodeAccessGrant({
        nodeId: node.id,
        deviceId: scheduledDevice.id,
        dataPlaneCredentialHash: `scheduled-credential-hash-${suffix}`,
        expiresAt: new Date(Date.now() + 60_000),
        syncJobIdempotencyKey: `scheduled-sync-${suffix}`,
        outboxEventIdempotencyKey: `scheduled-outbox-${suffix}`,
      });
      await expect(
        orchestration.scheduleNodeAccessGrant({
          nodeId: node.id,
          deviceId: scheduledDevice.id,
          dataPlaneCredentialHash: `scheduled-credential-hash-${suffix}`,
          expiresAt: new Date(Date.now() + 60_000),
          syncJobIdempotencyKey: `scheduled-sync-${suffix}`,
          outboxEventIdempotencyKey: `scheduled-outbox-${suffix}`,
        }),
      ).resolves.toEqual(scheduled);
      expect(scheduled.targetVersion).toBe(1);
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({ desiredConfigVersion: 1 });
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({
          where: { id: scheduled.nodeSyncJobId },
        }),
      ).resolves.toMatchObject({
        nodeAccessGrantId: scheduled.nodeAccessGrantId,
        targetVersion: 1,
        status: 'PENDING',
      });
      await expect(
        prisma.outboxEvent.findUniqueOrThrow({
          where: { id: scheduled.outboxEventId },
        }),
      ).resolves.toMatchObject({
        aggregateId: scheduled.nodeAccessGrantId,
        status: 'PENDING',
      });

      const failedScheduledDevice = await prisma.device.create({
        data: {
          userId: user.id,
          displayName: 'Failed scheduled integration device',
          subscriptionTokenHash: `failed-scheduled-feed-hash-${suffix}`,
        },
      });
      failedScheduledDeviceId = failedScheduledDevice.id;
      const conflictingOutboxEvent = await prisma.outboxEvent.create({
        data: {
          topic: 'node-sync.requested',
          aggregateType: 'NodeAccessGrant',
          aggregateId: scheduled.nodeAccessGrantId,
          payload: { nodeAccessGrantId: scheduled.nodeAccessGrantId },
          idempotencyKey: `conflicting-outbox-${suffix}`,
        },
      });
      conflictingOutboxEventId = conflictingOutboxEvent.id;
      await expect(
        orchestration.scheduleNodeAccessGrant({
          nodeId: node.id,
          deviceId: failedScheduledDevice.id,
          dataPlaneCredentialHash: `failed-scheduled-credential-hash-${suffix}`,
          expiresAt: new Date(Date.now() + 60_000),
          syncJobIdempotencyKey: `failed-scheduled-sync-${suffix}`,
          outboxEventIdempotencyKey: `conflicting-outbox-${suffix}`,
        }),
      ).rejects.toThrow('Idempotency key does not match the requested grant');
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({ desiredConfigVersion: 1 });
      await expect(
        prisma.nodeAccessGrant.count({
          where: { deviceId: failedScheduledDevice.id },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.nodeSyncJob.findUnique({
          where: { idempotencyKey: `failed-scheduled-sync-${suffix}` },
        }),
      ).resolves.toBeNull();

      const unrelatedNode = await prisma.node.create({
        data: {
          name: `integration-unrelated-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      });
      unrelatedNodeId = unrelatedNode.id;

      const grant = await prisma.nodeAccessGrant.create({
        data: {
          nodeId: node.id,
          deviceId: device.id,
          dataPlaneCredentialHash: `credential-hash-${suffix}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      nodeAccessGrantId = grant.id;

      await expect(
        prisma.nodeAccessGrant.update({
          where: { id: grant.id },
          data: { status: 'ACTIVE', revokedAt: new Date() },
        }),
      ).rejects.toThrow('NodeAccessGrant_active_has_no_revocation_timestamp');

      await expect(
        prisma.nodeAccessGrant.update({
          where: { id: grant.id },
          data: { status: 'REVOKED' },
        }),
      ).rejects.toThrow('NodeAccessGrant_revoked_has_timestamp');

      await expect(
        prisma.nodeSyncJob.create({
          data: {
            nodeId: node.id,
            nodeAccessGrantId: grant.id,
            targetVersion: 0,
            attempts: -1,
            idempotencyKey: `invalid-attempts-${suffix}`,
          },
        }),
      ).rejects.toThrow('NodeSyncJob_attempts_nonnegative');

      await expect(
        prisma.nodeSyncJob.create({
          data: {
            nodeId: node.id,
            nodeAccessGrantId: grant.id,
            targetVersion: 1,
            status: 'SUCCEEDED',
            idempotencyKey: `invalid-succeeded-${suffix}`,
          },
        }),
      ).rejects.toThrow('NodeSyncJob_terminal_has_completion_timestamp');

      await expect(
        prisma.nodeSyncJob.create({
          data: {
            nodeId: node.id,
            nodeAccessGrantId: grant.id,
            targetVersion: 1,
            status: 'PROCESSING',
            leaseOwner: 'worker-a',
            leaseToken: randomUUID(),
            leaseExpiresAt: new Date(Date.now() + 60_000),
            nextAttemptAt: new Date(Date.now() + 60_000),
            idempotencyKey: `invalid-processing-retry-${suffix}`,
          },
        }),
      ).rejects.toThrow('NodeSyncJob_retry_scheduled_only_while_pending');

      await expect(
        prisma.nodeSyncJob.create({
          data: {
            nodeId: node.id,
            nodeAccessGrantId: grant.id,
            targetVersion: 1,
            status: 'FAILED',
            idempotencyKey: `invalid-failed-${suffix}`,
          },
        }),
      ).rejects.toThrow('NodeSyncJob_terminal_has_completion_timestamp');

      const syncJob = await prisma.nodeSyncJob.create({
        data: {
          nodeId: node.id,
          nodeAccessGrantId: grant.id,
          targetVersion: 1,
          idempotencyKey: `sync-${suffix}`,
        },
      });
      nodeSyncJobId = syncJob.id;

      await expect(
        prisma.nodeSyncJob.create({
          data: {
            nodeId: unrelatedNode.id,
            nodeAccessGrantId: grant.id,
            targetVersion: 1,
            idempotencyKey: `invalid-sync-${suffix}`,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });

      const outboxEvent = await prisma.outboxEvent.create({
        data: {
          topic: 'node-sync.requested',
          aggregateType: 'NodeAccessGrant',
          aggregateId: grant.id,
          payload: { nodeAccessGrantId: grant.id },
          idempotencyKey: `outbox-${suffix}`,
        },
      });
      outboxEventId = outboxEvent.id;

      await expect(
        prisma.outboxEvent.create({
          data: {
            topic: 'node-sync.published',
            aggregateType: 'NodeAccessGrant',
            aggregateId: grant.id,
            payload: { nodeAccessGrantId: grant.id },
            status: 'PUBLISHED',
            idempotencyKey: `invalid-published-${suffix}`,
          },
        }),
      ).rejects.toThrow('OutboxEvent_published_has_publication_timestamp');

      await expect(
        prisma.outboxEvent.create({
          data: {
            topic: 'node-sync.processing',
            aggregateType: 'NodeAccessGrant',
            aggregateId: grant.id,
            payload: { nodeAccessGrantId: grant.id },
            status: 'PROCESSING',
            leaseOwner: 'worker-a',
            leaseToken: randomUUID(),
            leaseExpiresAt: new Date(Date.now() + 60_000),
            nextAttemptAt: new Date(Date.now() + 60_000),
            idempotencyKey: `invalid-processing-retry-outbox-${suffix}`,
          },
        }),
      ).rejects.toThrow('OutboxEvent_retry_scheduled_only_while_pending');

      const auditEvent = await prisma.auditEvent.create({
        data: {
          action: 'node-access-grant.created',
          entityType: 'NodeAccessGrant',
          entityId: grant.id,
        },
      });

      await expect(
        prisma.auditEvent.update({
          where: { id: auditEvent.id },
          data: { action: 'node-access-grant.updated' },
        }),
      ).rejects.toThrow('AuditEvent is append-only');

      await expect(
        prisma.auditEvent.delete({ where: { id: auditEvent.id } }),
      ).rejects.toThrow('AuditEvent is append-only');

      await expect(
        prisma.device.create({
          data: {
            userId: user.id,
            subscriptionTokenHash: tokenHash,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    } finally {
      if (nodeSyncJobId) {
        await prisma.nodeSyncJob.delete({ where: { id: nodeSyncJobId } });
      }
      if (outboxEventId) {
        await prisma.outboxEvent.delete({ where: { id: outboxEventId } });
      }
      if (nodeAccessGrantId) {
        await prisma.nodeAccessGrant.delete({
          where: { id: nodeAccessGrantId },
        });
      }
      if (scheduledDeviceId) {
        await prisma.nodeSyncJob.deleteMany({
          where: { idempotencyKey: `scheduled-sync-${suffix}` },
        });
        await prisma.outboxEvent.deleteMany({
          where: { idempotencyKey: `scheduled-outbox-${suffix}` },
        });
        await prisma.nodeAccessGrant.deleteMany({
          where: { deviceId: scheduledDeviceId },
        });
        await prisma.device.delete({ where: { id: scheduledDeviceId } });
      }
      if (conflictingOutboxEventId) {
        await prisma.outboxEvent.delete({
          where: { id: conflictingOutboxEventId },
        });
      }
      if (failedScheduledDeviceId) {
        await prisma.device.delete({ where: { id: failedScheduledDeviceId } });
      }
      if (deviceId) {
        await prisma.device.delete({ where: { id: deviceId } });
      }
      if (nodeId) {
        await prisma.node.delete({ where: { id: nodeId } });
      }
      if (unrelatedNodeId) {
        await prisma.node.delete({ where: { id: unrelatedNodeId } });
      }
      if (userId) {
        await prisma.subscription.deleteMany({ where: { userId } });
        await prisma.user.delete({ where: { id: userId } });
      }
      if (planId) {
        await prisma.plan.delete({ where: { id: planId } });
      }
    }
  });

  it('returns only the authenticated user cabinet overview', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const sessionPepper = process.env.AUTH_SESSION_PEPPER;
    const firstSecret = 'a'.repeat(43);
    const secondSecret = 'b'.repeat(43);
    let planId: string | undefined;
    let firstUserId: string | undefined;
    let secondUserId: string | undefined;

    if (!sessionPepper) {
      throw new Error(
        'AUTH_SESSION_PEPPER is required for this integration test',
      );
    }
    const hashSession = (secret: string) =>
      createHmac('sha256', sessionPepper).update(secret).digest('hex');

    try {
      const plan = await prisma.plan.create({
        data: {
          code: `cabinet-${suffix}`,
          name: 'Cabinet integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 3,
        },
      });
      planId = plan.id;
      const [firstUser, secondUser] = await prisma.$transaction([
        prisma.user.create({
          data: {
            telegramUserId: `1${suffix.replaceAll('-', '').slice(0, 20)}`,
          },
        }),
        prisma.user.create({
          data: {
            telegramUserId: `2${suffix.replaceAll('-', '').slice(0, 20)}`,
          },
        }),
      ]);
      firstUserId = firstUser.id;
      secondUserId = secondUser.id;
      await prisma.$transaction([
        prisma.subscription.create({
          data: {
            userId: firstUser.id,
            planId: plan.id,
            status: 'ACTIVE',
            startsAt: new Date('2026-08-01T00:00:00.000Z'),
            expiresAt: new Date('2026-09-01T00:00:00.000Z'),
          },
        }),
        prisma.device.create({
          data: {
            userId: firstUser.id,
            displayName: 'First user laptop',
            platform: 'windows',
            subscriptionTokenHash: `cabinet-first-device-${suffix}`,
          },
        }),
        prisma.device.create({
          data: {
            userId: secondUser.id,
            displayName: 'Second user phone',
            platform: 'android',
            subscriptionTokenHash: `cabinet-second-device-${suffix}`,
          },
        }),
        prisma.userSession.create({
          data: {
            userId: firstUser.id,
            tokenHash: hashSession(firstSecret),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
        prisma.userSession.create({
          data: {
            userId: secondUser.id,
            tokenHash: hashSession(secondSecret),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ]);

      await request(app.getHttpServer()).get('/cabinet/overview').expect(401);
      const response = await request(app.getHttpServer())
        .get('/cabinet/overview')
        .set('cookie', `vpn_platform_session=${firstSecret}`)
        .expect(200);

      expect(cabinetOverviewSchema.parse(response.body)).toEqual({
        subscription: {
          status: 'ACTIVE',
          planName: 'Cabinet integration plan',
          deviceLimit: 3,
          startsAt: '2026-08-01T00:00:00.000Z',
          expiresAt: '2026-09-01T00:00:00.000Z',
        },
        devices: [
          expect.objectContaining({
            displayName: 'First user laptop',
            platform: 'windows',
            status: 'ACTIVE',
          }),
        ],
      });
      expect(JSON.stringify(response.body)).not.toContain('Second user phone');
      expect(JSON.stringify(response.body)).not.toContain(
        `cabinet-first-device-${suffix}`,
      );
    } finally {
      if (firstUserId || secondUserId) {
        const userIds = [firstUserId, secondUserId].filter(
          (id): id is string => id !== undefined,
        );
        await prisma.userSession.deleteMany({
          where: { userId: { in: userIds } },
        });
        await prisma.device.deleteMany({
          where: { userId: { in: userIds } },
        });
        await prisma.subscription.deleteMany({
          where: { userId: { in: userIds } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: userIds } },
        });
      }
      if (planId) {
        await prisma.plan.delete({ where: { id: planId } });
      }
    }
  });

  it('returns one device and the same URL when a device issuance request is retried', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const sessionPepper = process.env.AUTH_SESSION_PEPPER;
    const secret = 'e'.repeat(43);
    const idempotencyKey = randomUUID();
    let subscriptionId: string | undefined;
    let planId: string | undefined;
    let userId: string | undefined;

    if (!sessionPepper) {
      throw new Error(
        'AUTH_SESSION_PEPPER is required for this integration test',
      );
    }

    try {
      const plan = await prisma.plan.create({
        data: {
          code: `issuance-${suffix}`,
          name: 'Issuance integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 1,
        },
      });
      planId = plan.id;
      const user = await prisma.user.create({
        data: { telegramUserId: `4${suffix.replaceAll('-', '').slice(0, 20)}` },
      });
      userId = user.id;
      const [subscription] = await prisma.$transaction([
        prisma.subscription.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: 'ACTIVE',
            startsAt: new Date('2026-08-01T00:00:00.000Z'),
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          },
        }),
        prisma.userSession.create({
          data: {
            userId: user.id,
            tokenHash: createHmac('sha256', sessionPepper)
              .update(secret)
              .digest('hex'),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ]);
      subscriptionId = subscription.id;

      const issue = () =>
        request(app.getHttpServer())
          .post('/cabinet/devices')
          .set('cookie', `vpn_platform_session=${secret}`)
          .set('origin', 'https://app.example.test')
          .set('idempotency-key', idempotencyKey)
          .send({ displayName: 'Retry-safe laptop' });
      const [first, retry] = await Promise.all([issue(), issue()]);

      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(issuedCabinetDeviceSchema.parse(first.body)).toEqual(
        issuedCabinetDeviceSchema.parse(retry.body),
      );
      expect(
        await prisma.device.count({ where: { userId, status: 'ACTIVE' } }),
      ).toBe(1);

      await prisma.subscription.update({
        where: { id: subscriptionId },
        data: { expiresAt: new Date('2026-08-11T00:00:00.000Z') },
      });
      await issue()
        .set('idempotency-key', randomUUID())
        .send({ displayName: 'Must not be issued after expiry' })
        .expect(409);
      expect(
        await prisma.device.count({ where: { userId, status: 'ACTIVE' } }),
      ).toBe(1);
    } finally {
      if (userId) {
        await prisma.userSession.deleteMany({ where: { userId } });
        await prisma.device.deleteMany({ where: { userId } });
        await prisma.subscription.deleteMany({ where: { userId } });
      }
      if (planId) {
        await prisma.plan.delete({ where: { id: planId } });
      }
    }
  });

  it('rejects device issuance if the subscription expires while its advisory lock is held', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const sessionPepper = process.env.AUTH_SESSION_PEPPER;
    const secret = 'f'.repeat(43);
    const expiresAt = new Date(Date.now() + 1_500);
    let planId: string | undefined;
    let userId: string | undefined;
    let releaseLock: (() => void) | undefined;
    let heldLock: Promise<void> | undefined;

    if (!sessionPepper) {
      throw new Error(
        'AUTH_SESSION_PEPPER is required for this integration test',
      );
    }

    try {
      const plan = await prisma.plan.create({
        data: {
          code: `issuance-expiry-${suffix}`,
          name: 'Issuance expiry integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 1,
        },
      });
      planId = plan.id;
      const user = await prisma.user.create({
        data: { telegramUserId: `5${suffix.replaceAll('-', '').slice(0, 20)}` },
      });
      userId = user.id;
      await prisma.$transaction([
        prisma.subscription.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: 'ACTIVE',
            startsAt: new Date(),
            expiresAt,
          },
        }),
        prisma.userSession.create({
          data: {
            userId: user.id,
            tokenHash: createHmac('sha256', sessionPepper)
              .update(secret)
              .digest('hex'),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ]);

      let signalLockAcquired: (() => void) | undefined;
      const lockAcquired = new Promise<void>((resolve) => {
        signalLockAcquired = resolve;
      });
      heldLock = prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${`cabinet-device:${user.id}`}))
        `;
        signalLockAcquired?.();
        await new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      });
      await lockAcquired;

      const issuance = request(app.getHttpServer())
        .post('/cabinet/devices')
        .set('cookie', `vpn_platform_session=${secret}`)
        .set('origin', 'https://app.example.test')
        .set('idempotency-key', randomUUID())
        .send({ displayName: 'Expired while waiting' });
      const issuanceResponse = issuance.then((response) => response);

      let waitingForLock = false;
      for (let attempts = 0; attempts < 40; attempts += 1) {
        const [lock] = await prisma.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1
            FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
          ) AS waiting
        `;
        if (lock?.waiting) {
          waitingForLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waitingForLock).toBe(true);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 50)),
      );
      releaseLock?.();
      releaseLock = undefined;
      await heldLock;

      expect((await issuanceResponse).status).toBe(409);
      await expect(
        prisma.device.count({ where: { userId: user.id } }),
      ).resolves.toBe(0);
    } finally {
      releaseLock?.();
      await heldLock;
      if (userId) {
        await prisma.userSession.deleteMany({ where: { userId } });
        await prisma.device.deleteMany({ where: { userId } });
        await prisma.subscription.deleteMany({ where: { userId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
      if (planId) {
        await prisma.plan.delete({ where: { id: planId } });
      }
    }
  });

  it('serves an empty feed only to an active device with an active subscription', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const token = 'c'.repeat(43);
    const pepper = process.env.SUBSCRIPTION_TOKEN_PEPPER;
    let planId: string | undefined;
    let userId: string | undefined;

    if (!pepper) {
      throw new Error(
        'SUBSCRIPTION_TOKEN_PEPPER is required for this integration test',
      );
    }

    try {
      const plan = await prisma.plan.create({
        data: {
          code: `feed-${suffix}`,
          name: 'Feed integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 1,
        },
      });
      planId = plan.id;
      const user = await prisma.user.create({
        data: { telegramUserId: `3${suffix.replaceAll('-', '').slice(0, 20)}` },
      });
      userId = user.id;
      await prisma.$transaction([
        prisma.subscription.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: 'ACTIVE',
            startsAt: new Date('2026-08-01T00:00:00.000Z'),
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          },
        }),
        prisma.device.create({
          data: {
            userId: user.id,
            subscriptionTokenHash: createHmac('sha256', pepper)
              .update(token)
              .digest('hex'),
          },
        }),
      ]);

      const response = await request(app.getHttpServer())
        .get(`/sub/${token}`)
        .expect('content-type', /text\/plain; charset=utf-8/)
        .expect(200);
      expect(subscriptionFeedSchema.parse(response.text)).toBe('');
      expect(response.headers['cache-control']).toBe('no-store');

      await request(app.getHttpServer())
        .get(`/sub/${'d'.repeat(43)}`)
        .expect(401);
    } finally {
      if (userId) {
        await prisma.device.deleteMany({ where: { userId } });
        await prisma.subscription.deleteMany({ where: { userId } });
        await prisma.user.delete({ where: { id: userId } });
      }
      if (planId) {
        await prisma.plan.delete({ where: { id: planId } });
      }
    }
  });

  it('enforces the subscription feed limit through Redis', async () => {
    const token = `${randomUUID().replaceAll('-', '')}${'f'.repeat(11)}`;
    const redis = app.get(RedisService);
    await Promise.all([
      redis.delete('subscription-feed:rate-limit:127.0.0.1'),
      redis.delete('subscription-feed:rate-limit:::ffff:127.0.0.1'),
    ]);

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await request(app.getHttpServer()).get(`/sub/${token}`).expect(401);
    }

    await request(app.getHttpServer()).get(`/sub/${token}`).expect(429);
  });
});
