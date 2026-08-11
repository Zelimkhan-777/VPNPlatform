import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { readinessResponseSchema } from '@vpn-platform/contracts';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { NodeAgentCredentialService } from '../src/orchestration/node-agent-credential.service';
import { OrchestrationService } from '../src/orchestration/orchestration.service';

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
    const suffix = randomUUID();
    const node = await prisma.node.create({
      data: {
        name: `config-acknowledgement-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
        desiredConfigVersion: 1,
      },
    });
    const syncJob = await prisma.nodeSyncJob.create({
      data: {
        nodeId: node.id,
        targetVersion: 1,
        idempotencyKey: `config-acknowledgement-sync-${suffix}`,
      },
    });
    const now = new Date('2026-08-11T11:00:00.000Z');

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

    const acknowledgement = await orchestration.acknowledgeNodeConfig(
      {
        nodeId: node.id,
        nodeSyncJobId: syncJob.id,
        targetVersion: 1,
      },
      now,
    );
    expect(acknowledgement).toEqual({
      nodeId: node.id,
      nodeSyncJobId: syncJob.id,
      appliedConfigVersion: 1,
    });
    await expect(
      orchestration.acknowledgeNodeConfig(
        {
          nodeId: node.id,
          nodeSyncJobId: syncJob.id,
          targetVersion: 1,
        },
        now,
      ),
    ).resolves.toEqual(acknowledgement);
    await expect(
      prisma.nodeConfigAcknowledgement.findUniqueOrThrow({
        where: { nodeSyncJobId: syncJob.id },
      }),
    ).resolves.toMatchObject({
      nodeId: node.id,
      targetVersion: 1,
      acknowledgedAt: now,
    });
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
      await expect(credentials.authenticate(first.secret)).resolves.toBe(
        node.id,
      );
      await expect(credentials.authenticate('not-a-credential')).resolves.toBe(
        null,
      );
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
      await expect(credentials.authenticate(first.secret)).resolves.toBeNull();
      await expect(credentials.authenticate(second.secret)).resolves.toBe(
        node.id,
      );
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

      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'DISABLED' },
      });
      await expect(credentials.authenticate(second.secret)).resolves.toBeNull();
      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'HEALTHY' },
      });
      await expect(credentials.revoke(node.id, secondRotationAt)).resolves.toBe(
        true,
      );
      await expect(credentials.authenticate(second.secret)).resolves.toBeNull();
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
});
