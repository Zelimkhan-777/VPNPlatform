import type { INestApplication } from '@nestjs/common';
import { nodeAgentConfigurationSnapshotSchema } from '@vpn-platform/contracts';
import {
  HttpNodeAgentControlPlane,
  NodeAgentRunner,
  StateFileSimulationAdapter,
} from '@vpn-platform/node-agent';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PrismaNodeSyncStore,
  PrismaOutboxStore,
  PrismaSubscriptionAccessStore,
} from '@vpn-platform/orchestration-store';

import { API_ENVIRONMENT } from '../../src/config/environment';
import { PrismaService } from '../../src/database/prisma.service';
import { NodeAgentConfigurationService } from '../../src/node-agent/node-agent-configuration.service';
import { DataPlaneCredentialService } from '../../src/orchestration/data-plane-credential.service';
import { NodeAgentCredentialService } from '../../src/orchestration/node-agent-credential.service';
import { readNodeSyncJobCommand } from '../../src/orchestration/node-sync-job-harness';
import { OrchestrationService } from '../../src/orchestration/orchestration.service';
import {
  authenticatedNodeId,
  completeInfrastructureNodeSyncJob,
  createInfrastructureTestApp,
} from './fixture';

describe('infrastructure orchestration', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createInfrastructureTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serializes concurrent idempotent desired-state scheduling', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const suffix = randomUUID();
    const telegramUserId = suffix.replaceAll('-', '');
    const syncJobIdempotencyKey = `concurrent-sync-${suffix}`;
    const outboxEventIdempotencyKey = `concurrent-outbox-${suffix}`;
    let userId: string | undefined;
    let planId: string | undefined;
    let deviceId: string | undefined;
    let nodeId: string | undefined;

    try {
      const plan = await prisma.plan.create({
        data: {
          code: `concurrent-${suffix}`,
          name: 'Concurrent integration plan',
          priceMinor: 1,
          currency: 'RUB',
          durationDays: 30,
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
          expiresAt,
          syncJobIdempotencyKey: `first-concurrent-sync-${suffix}`,
          outboxEventIdempotencyKey: `first-concurrent-outbox-${suffix}`,
        }),
        orchestration.scheduleNodeAccessGrant({
          nodeId: node.id,
          deviceId: secondDevice.id,
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

  it('rolls back grant scheduling when the final audit insert fails', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const suffix = randomUUID();
    const syncJobIdempotencyKey = `audit-rollback-sync-${suffix}`;
    const outboxEventIdempotencyKey = `audit-rollback-outbox-${suffix}`;
    const missingActorUserId = randomUUID();
    const user = await prisma.user.create({
      data: { telegramUserId: suffix.replaceAll('-', '') },
    });
    const device = await prisma.device.create({
      data: {
        userId: user.id,
        displayName: 'Audit rollback integration device',
        subscriptionTokenHash: `audit-rollback-feed-hash-${suffix}`,
      },
    });
    const node = await prisma.node.create({
      data: {
        name: `audit-rollback-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
      },
    });

    try {
      await expect(
        orchestration.scheduleNodeAccessGrant({
          nodeId: node.id,
          deviceId: device.id,
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          syncJobIdempotencyKey,
          outboxEventIdempotencyKey,
          actorUserId: missingActorUserId,
        }),
      ).rejects.toMatchObject({ code: 'P2003' });

      const [persistedNode, grantCount, syncJobCount, outboxEventCount] =
        await prisma.$transaction([
          prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
          prisma.nodeAccessGrant.count({
            where: { nodeId: node.id, deviceId: device.id },
          }),
          prisma.nodeSyncJob.count({
            where: { idempotencyKey: syncJobIdempotencyKey },
          }),
          prisma.outboxEvent.count({
            where: { idempotencyKey: outboxEventIdempotencyKey },
          }),
        ]);

      expect(persistedNode.desiredConfigVersion).toBe(0);
      expect(grantCount).toBe(0);
      expect(syncJobCount).toBe(0);
      expect(outboxEventCount).toBe(0);
    } finally {
      await prisma.nodeSyncJob.deleteMany({
        where: { idempotencyKey: syncJobIdempotencyKey },
      });
      await prisma.outboxEvent.deleteMany({
        where: { idempotencyKey: outboxEventIdempotencyKey },
      });
      await prisma.nodeAccessGrant.deleteMany({ where: { nodeId: node.id } });
      await prisma.device.delete({ where: { id: device.id } });
      await prisma.node.delete({ where: { id: node.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it('fences stale workers after a lease is reclaimed', async () => {
    const prisma = app.get(PrismaService);
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
      const device = await prisma.device.create({
        data: {
          userId: user.id,
          displayName: 'Lease fencing integration device',
          subscriptionTokenHash: `lease-fencing-feed-hash-${suffix}`,
        },
      });
      const node = await prisma.node.create({
        data: {
          name: `lease-fencing-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      });
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
      const nodeSyncStore = new PrismaNodeSyncStore(prisma, 30_000, 0, 5);
      const outboxStore = new PrismaOutboxStore(prisma, 30_000, 0, 5, [
        outboxEvent.id,
      ]);
      const { command } = await readNodeSyncJobCommand(prisma, syncJob.id);
      const staleNodeSyncClaim = await nodeSyncStore.claim(command, 'worker-a');
      const staleOutboxClaim = await outboxStore.claimNext('worker-a');
      expect(staleNodeSyncClaim).toEqual(
        expect.objectContaining({ leaseToken: expect.any(String) }),
      );
      expect(staleOutboxClaim).toEqual(
        expect.objectContaining({ leaseToken: expect.any(String) }),
      );
      if (
        !staleNodeSyncClaim ||
        typeof staleNodeSyncClaim !== 'object' ||
        !staleOutboxClaim
      ) {
        throw new Error('Production stores did not claim test work');
      }
      await expect(
        nodeSyncStore.complete(
          syncJob.id,
          'worker-b',
          staleNodeSyncClaim.leaseToken,
        ),
      ).resolves.toBe(false);
      await expect(
        outboxStore.markPublished(
          outboxEvent.id,
          'worker-b',
          staleOutboxClaim.leaseToken,
        ),
      ).resolves.toBe(false);
      const expiredAt = new Date('2000-01-01T00:00:00.000Z');
      await prisma.nodeSyncJob.update({
        where: { id: syncJob.id },
        data: { leaseExpiresAt: expiredAt },
      });
      await prisma.outboxEvent.update({
        where: { id: outboxEvent.id },
        data: { leaseExpiresAt: expiredAt },
      });
      await expect(nodeSyncStore.reclaimExpiredLeases()).resolves.toBe(1);
      await expect(outboxStore.reclaimExpiredLeases()).resolves.toBe(1);

      const currentNodeSyncClaim = await nodeSyncStore.claim(
        command,
        'worker-b',
      );
      const currentOutboxClaim = await outboxStore.claimNext('worker-b');
      expect(currentNodeSyncClaim).toEqual(
        expect.objectContaining({ leaseToken: expect.any(String) }),
      );
      expect(currentOutboxClaim).toEqual(
        expect.objectContaining({ leaseToken: expect.any(String) }),
      );
      if (
        !currentNodeSyncClaim ||
        typeof currentNodeSyncClaim !== 'object' ||
        !currentOutboxClaim
      ) {
        throw new Error('Production stores did not reclaim test work');
      }
      expect(currentNodeSyncClaim.leaseToken).not.toBe(
        staleNodeSyncClaim.leaseToken,
      );
      expect(currentOutboxClaim.leaseToken).not.toBe(
        staleOutboxClaim.leaseToken,
      );
      await expect(
        nodeSyncStore.complete(
          syncJob.id,
          'worker-a',
          staleNodeSyncClaim.leaseToken,
        ),
      ).resolves.toBe(false);
      await expect(
        outboxStore.markPublished(
          outboxEvent.id,
          'worker-a',
          staleOutboxClaim.leaseToken,
        ),
      ).resolves.toBe(false);
      await expect(
        nodeSyncStore.complete(
          syncJob.id,
          'worker-b',
          currentNodeSyncClaim.leaseToken,
        ),
      ).resolves.toBe(true);
      await expect(
        outboxStore.markPublished(
          outboxEvent.id,
          'worker-b',
          currentOutboxClaim.leaseToken,
        ),
      ).resolves.toBe(true);
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({ where: { id: syncJob.id } }),
      ).resolves.toMatchObject({
        status: 'SUCCEEDED',
        completedAt: expect.any(Date),
      });
      await expect(
        prisma.outboxEvent.findUniqueOrThrow({ where: { id: outboxEvent.id } }),
      ).resolves.toMatchObject({
        status: 'PUBLISHED',
        publishedAt: expect.any(Date),
      });
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
        expiresAt: new Date(Date.now() + 60_000),
        syncJobIdempotencyKey: `retry-limit-sync-${suffix}`,
        outboxEventIdempotencyKey: `retry-limit-outbox-${suffix}`,
      });
      nodeAccessGrantId = scheduled.nodeAccessGrantId;
      nodeSyncJobId = scheduled.nodeSyncJobId;
      outboxEventId = scheduled.outboxEventId;

      const nodeSyncStore = new PrismaNodeSyncStore(prisma, 30_000, 0, 5);
      const { command } = await readNodeSyncJobCommand(
        prisma,
        scheduled.nodeSyncJobId,
      );
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const claim = await nodeSyncStore.claim(command, 'worker-a');
        expect(claim).toEqual(
          expect.objectContaining({ leaseToken: expect.any(String) }),
        );
        if (!claim || typeof claim !== 'object') {
          throw new Error('Production node-sync store did not claim work');
        }
        await expect(
          nodeSyncStore.retry(
            scheduled.nodeSyncJobId,
            'worker-a',
            claim.leaseToken,
            'NETWORK_ERROR',
          ),
        ).resolves.toBe(attempt === 5 ? 'failed' : 'retried');
      }
      await expect(
        prisma.nodeSyncJob.findUniqueOrThrow({
          where: { id: scheduled.nodeSyncJobId },
        }),
      ).resolves.toMatchObject({
        status: 'FAILED',
        attempts: 5,
        lastErrorCode: 'NETWORK_ERROR',
        completedAt: expect.any(Date),
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      });
      await expect(nodeSyncStore.claim(command, 'worker-a')).resolves.toBe(
        'terminal',
      );

      const outboxStore = new PrismaOutboxStore(prisma, 30_000, 0, 5, [
        scheduled.outboxEventId,
      ]);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const claim = await outboxStore.claimNext('worker-a');
        expect(claim).toEqual(
          expect.objectContaining({ leaseToken: expect.any(String) }),
        );
        if (!claim) {
          throw new Error('Production outbox store did not claim work');
        }
        await expect(
          outboxStore.retry(
            scheduled.outboxEventId,
            'worker-a',
            claim.leaseToken,
            'NETWORK_ERROR',
          ),
        ).resolves.toBe(true);
      }
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
      await expect(outboxStore.claimNext('worker-a')).resolves.toBeNull();
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
      prisma.nodeAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
    ).resolves.toMatchObject({
      status: 'PENDING',
      desiredVersion: 1,
      appliedVersion: 0,
    });

    await expect(
      orchestration.acknowledgeNodeConfig(
        {
          nodeId: node.id,
          nodeSyncJobId: syncJob.id,
          targetVersion: 1,
          snapshotHash: 'a'.repeat(64),
        },
        now,
      ),
    ).rejects.toThrow('Node sync job is not eligible for acknowledgement');
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .send({
        nodeSyncJobId: syncJob.id,
        targetVersion: 1,
        snapshotHash: 'a'.repeat(64),
      })
      .expect(401);
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send({ nodeSyncJobId: 'not-a-uuid', targetVersion: -1 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send({
        nodeSyncJobId: syncJob.id,
        targetVersion: 1,
        snapshotHash: 'a'.repeat(64),
      })
      .expect(409);
    await expect(
      prisma.node.update({
        where: { id: node.id },
        data: { appliedConfigVersion: 1 },
      }),
    ).rejects.toThrow('Node appliedConfigVersion requires an acknowledgement');

    await expect(
      completeInfrastructureNodeSyncJob(prisma, syncJob.id, 'worker-a'),
    ).resolves.toBeUndefined();

    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send({
        nodeSyncJobId: syncJob.id,
        targetVersion: 1,
        snapshotHash: 'a'.repeat(64),
      })
      .expect(409);
    const deliveredSnapshot = await request(app.getHttpServer())
      .get('/node-agent/v1/configuration')
      .set('authorization', `Bearer ${credential.secret}`)
      .expect(200);
    const acknowledgement = deliveredSnapshot.body.pendingAcknowledgement;
    expect(acknowledgement).toMatchObject({
      nodeSyncJobId: syncJob.id,
      targetVersion: 1,
      snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send(acknowledgement)
      .expect(204);
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${credential.secret}`)
      .send(acknowledgement)
      .expect(204);
    await expect(
      prisma.nodeConfigAcknowledgement.findUniqueOrThrow({
        where: { nodeSyncJobId: syncJob.id },
      }),
    ).resolves.toMatchObject({
      nodeId: node.id,
      targetVersion: 1,
      snapshotHash: acknowledgement.snapshotHash,
      acknowledgedAt: expect.any(Date),
    });
    await expect(
      prisma.nodeAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
    ).resolves.toMatchObject({
      status: 'ACTIVE',
      desiredVersion: 1,
      appliedVersion: 1,
    });
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
      .send(acknowledgement)
      .expect(401);
    const disabledNodeCredential = await credentials.rotate(node.id, now);
    await prisma.node.update({
      where: { id: node.id },
      data: { status: 'DISABLED' },
    });
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${disabledNodeCredential.secret}`)
      .send(acknowledgement)
      .expect(204);
    await prisma.node.update({
      where: { id: node.id },
      data: { status: 'DELETED' },
    });
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${disabledNodeCredential.secret}`)
      .send(acknowledgement)
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

      const disabledActive = await credentials.rotate(
        node.id,
        secondRotationAt,
      );
      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'DISABLED' },
      });
      await expect(
        authenticatedNodeId(credentials, disabledActive.secret),
      ).resolves.toBe(node.id);
      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'DELETED' },
      });
      await expect(
        authenticatedNodeId(credentials, disabledActive.secret),
      ).resolves.toBeNull();
      await expect(credentials.revoke(node.id, secondRotationAt)).resolves.toBe(
        true,
      );
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

  it('derives one stable credential per grant and scopes it to its node', async () => {
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
        subscriptionTokenHash: `credential-feed-${suffix}`,
      },
    });
    const [firstNode, secondNode] = await prisma.$transaction([
      prisma.node.create({
        data: {
          name: `credential-first-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      }),
      prisma.node.create({
        data: {
          name: `credential-second-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      }),
    ]);
    const expiresAt = new Date('2099-01-01T00:00:00.000Z');
    const first = await orchestration.scheduleNodeAccessGrant({
      nodeId: firstNode.id,
      deviceId: device.id,
      expiresAt,
      syncJobIdempotencyKey: `credential-sync-${suffix}`,
      outboxEventIdempotencyKey: `credential-outbox-${suffix}`,
    });
    const repeated = await orchestration.scheduleNodeAccessGrant({
      nodeId: firstNode.id,
      deviceId: device.id,
      expiresAt,
      syncJobIdempotencyKey: `credential-sync-${suffix}`,
      outboxEventIdempotencyKey: `credential-outbox-${suffix}`,
    });
    const second = await orchestration.scheduleNodeAccessGrant({
      nodeId: secondNode.id,
      deviceId: device.id,
      expiresAt,
      syncJobIdempotencyKey: `credential-second-sync-${suffix}`,
      outboxEventIdempotencyKey: `credential-second-outbox-${suffix}`,
    });
    expect(repeated.nodeAccessGrantId).toBe(first.nodeAccessGrantId);
    const [firstGrant] = await prisma.$transaction([
      prisma.nodeAccessGrant.findUniqueOrThrow({
        where: { id: first.nodeAccessGrantId },
      }),
      prisma.nodeAccessGrant.findUniqueOrThrow({
        where: { id: second.nodeAccessGrantId },
      }),
    ]);
    expect(firstGrant.dataPlaneCredentialDerivationVersion).toBe(1);
    const firstNodeCredential = await credentials.rotate(firstNode.id);
    const secondNodeCredential = await credentials.rotate(secondNode.id);
    const [firstSnapshot, secondSnapshot] = await Promise.all([
      request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${firstNodeCredential.secret}`)
        .expect(200),
      request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${secondNodeCredential.secret}`)
        .expect(200),
    ]);
    const firstCredential = firstSnapshot.body.grants[0].dataPlaneCredential;
    const secondCredential = secondSnapshot.body.grants[0].dataPlaneCredential;
    expect(firstCredential).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondCredential).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstCredential).not.toBe(secondCredential);
    expect(firstGrant.dataPlaneCredentialHash).not.toBe(firstCredential);
    expect(
      JSON.stringify(
        await prisma.outboxEvent.findUniqueOrThrow({
          where: { id: first.outboxEventId },
        }),
      ),
    ).not.toContain(firstCredential);
    expect(
      JSON.stringify(
        await prisma.auditEvent.findMany({
          where: { entityId: first.nodeAccessGrantId },
        }),
      ),
    ).not.toContain(firstCredential);
    await prisma.nodeAccessGrant.update({
      where: { id: first.nodeAccessGrantId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    const revoked = await request(app.getHttpServer())
      .get('/node-agent/v1/configuration')
      .set('authorization', `Bearer ${firstNodeCredential.secret}`)
      .expect(200);
    expect(revoked.body.grants[0].dataPlaneCredential).toBeNull();
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
      const syncJob = await prisma.nodeSyncJob.create({
        data: {
          nodeId: node.id,
          nodeAccessGrantId: grant.id,
          targetVersion: 1,
          idempotencyKey: `snapshot-sync-${suffix}`,
          status: 'SUCCEEDED',
          attempts: 1,
          completedAt: new Date(),
        },
      });
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
        'pendingAcknowledgement',
        'routes',
      ]);
      expect(Object.keys(response.body.grants[0]).sort()).toEqual([
        'appliedVersion',
        'dataPlaneCredential',
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
          pendingAcknowledgement: {
            nodeSyncJobId: syncJob.id,
            targetVersion: 1,
            snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
          grants: [
            {
              id: grant.id,
              status: 'PENDING',
              expiresAt: expiresAt.toISOString(),
              desiredVersion: 1,
              appliedVersion: 0,
              revokedAt: null,
              dataPlaneCredential: null,
            },
          ],
          routes: [],
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
        .expect(204);
      await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${disabledNodeCredential.secret}`)
        .expect(200);
      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'DELETED' },
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
        await prisma.nodeConfigDelivery.deleteMany({ where: { nodeId } });
        await prisma.nodeSyncJob.deleteMany({ where: { nodeId } });
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

  it('keeps draining and disabled nodes in access-control sync without new assignment', async () => {
    const prisma = app.get(PrismaService);
    const credentials = app.get(NodeAgentCredentialService);
    const orchestration = app.get(OrchestrationService);
    const suffix = randomUUID();
    let nodeId: string | undefined;
    let deletedNodeId: string | undefined;

    try {
      const user = await prisma.user.create({
        data: { telegramUserId: suffix.replaceAll('-', '') },
      });
      const device = await prisma.device.create({
        data: {
          userId: user.id,
          subscriptionTokenHash: `disabled-sync-feed-${suffix}`,
        },
      });
      const [node, deletedNode] = await prisma.$transaction([
        prisma.node.create({
          data: {
            name: `disabled-sync-${suffix}`,
            provider: 'integration-test',
            locationLabel: 'integration-test',
            status: 'HEALTHY',
          },
        }),
        prisma.node.create({
          data: {
            name: `disabled-sync-deleted-${suffix}`,
            provider: 'integration-test',
            locationLabel: 'integration-test',
            status: 'HEALTHY',
          },
        }),
      ]);
      nodeId = node.id;
      deletedNodeId = deletedNode.id;
      const expiresAt = new Date('2099-01-01T00:00:00.000Z');
      const scheduled = await orchestration.scheduleNodeAccessGrant({
        nodeId: node.id,
        deviceId: device.id,
        expiresAt,
        syncJobIdempotencyKey: `disabled-sync-${suffix}`,
        outboxEventIdempotencyKey: `disabled-sync-outbox-${suffix}`,
      });
      await prisma.nodeAccessGrant.create({
        data: {
          nodeId: deletedNode.id,
          deviceId: device.id,
          status: 'ACTIVE',
          dataPlaneCredentialHash: `disabled-sync-deleted-${suffix}`,
          expiresAt,
        },
      });
      const credential = await credentials.rotate(node.id);
      await expect(
        completeInfrastructureNodeSyncJob(
          prisma,
          scheduled.nodeSyncJobId,
          `disabled-sync-apply-${suffix}`,
        ),
      ).resolves.toBeUndefined();
      const appliedSnapshot = await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(200);
      await request(app.getHttpServer())
        .post('/node-agent/v1/acknowledgements')
        .set('authorization', `Bearer ${credential.secret}`)
        .send(appliedSnapshot.body.pendingAcknowledgement)
        .expect(204);
      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'DRAINING' },
      });
      await request(app.getHttpServer())
        .post('/node-agent/v1/heartbeats')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(204);
      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'DISABLED' },
      });
      await prisma.node.update({
        where: { id: deletedNode.id },
        data: { status: 'DELETED' },
      });
      await request(app.getHttpServer())
        .post('/node-agent/v1/heartbeats')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(204);
      const snapshot = await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(200);
      expect(snapshot.body.grants).toEqual(
        expect.arrayContaining([expect.objectContaining({ status: 'ACTIVE' })]),
      );
      await expect(
        orchestration.scheduleNodeAccessGrant({
          nodeId: node.id,
          deviceId: device.id,
          expiresAt,
          syncJobIdempotencyKey: `disabled-sync-new-${suffix}`,
          outboxEventIdempotencyKey: `disabled-sync-new-outbox-${suffix}`,
        }),
      ).rejects.toThrow('Node access cannot be scheduled for this node');

      await expect(
        orchestration.revokeDeviceAccess(user.id, device.id),
      ).resolves.toBe('revoked');
      const disabledJobs = await prisma.nodeSyncJob.findMany({
        where: { nodeId: node.id },
        orderBy: { targetVersion: 'asc' },
      });
      expect(disabledJobs.length).toBeGreaterThanOrEqual(2);
      await expect(
        prisma.nodeSyncJob.count({ where: { nodeId: deletedNode.id } }),
      ).resolves.toBe(0);
      await expect(
        prisma.nodeAccessGrant.findFirstOrThrow({
          where: { nodeId: deletedNode.id, deviceId: device.id },
        }),
      ).resolves.toMatchObject({ status: 'REVOKED' });
      await expect(
        prisma.node.update({
          where: { id: node.id },
          data: { status: 'HEALTHY' },
        }),
      ).rejects.toThrow(
        'Node cannot return to HEALTHY until pending access updates are reconciled',
      );

      const revokeJob = disabledJobs[disabledJobs.length - 1]!;
      await expect(
        completeInfrastructureNodeSyncJob(
          prisma,
          revokeJob.id,
          `disabled-sync-worker-${suffix}`,
        ),
      ).resolves.toBeUndefined();
      const revokedSnapshot = await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(200);
      expect(revokedSnapshot.body.grants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'REVOKED',
            dataPlaneCredential: null,
          }),
        ]),
      );
      await request(app.getHttpServer())
        .post('/node-agent/v1/acknowledgements')
        .set('authorization', `Bearer ${credential.secret}`)
        .send(revokedSnapshot.body.pendingAcknowledgement)
        .expect(204);
      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'HEALTHY' },
      });
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({ status: 'HEALTHY' });
    } finally {
      for (const id of [nodeId, deletedNodeId]) {
        if (!id) continue;
        await prisma.nodeAgentCredential.deleteMany({ where: { nodeId: id } });
      }
    }
  });

  it('quarantines a node with revoke-all and keeps emergency pull without new assignment', async () => {
    const prisma = app.get(PrismaService);
    const credentials = app.get(NodeAgentCredentialService);
    const orchestration = app.get(OrchestrationService);
    const suffix = randomUUID();
    let nodeId: string | undefined;
    let deletedNodeId: string | undefined;

    try {
      const user = await prisma.user.create({
        data: { telegramUserId: `q${suffix.replaceAll('-', '').slice(0, 31)}` },
      });
      const device = await prisma.device.create({
        data: {
          userId: user.id,
          subscriptionTokenHash: `quarantine-sync-feed-${suffix}`,
        },
      });
      const [node, deletedNode] = await prisma.$transaction([
        prisma.node.create({
          data: {
            name: `quarantine-sync-${suffix}`,
            provider: 'integration-test',
            locationLabel: 'integration-test',
            status: 'HEALTHY',
          },
        }),
        prisma.node.create({
          data: {
            name: `quarantine-sync-deleted-${suffix}`,
            provider: 'integration-test',
            locationLabel: 'integration-test',
            status: 'HEALTHY',
          },
        }),
      ]);
      nodeId = node.id;
      deletedNodeId = deletedNode.id;
      const expiresAt = new Date('2099-01-01T00:00:00.000Z');
      const scheduled = await orchestration.scheduleNodeAccessGrant({
        nodeId: node.id,
        deviceId: device.id,
        expiresAt,
        syncJobIdempotencyKey: `quarantine-sync-${suffix}`,
        outboxEventIdempotencyKey: `quarantine-sync-outbox-${suffix}`,
      });
      await prisma.node.update({
        where: { id: deletedNode.id },
        data: { status: 'DELETED' },
      });
      const credential = await credentials.rotate(node.id);
      await expect(
        prisma.node.update({
          where: { id: node.id },
          data: { status: 'QUARANTINED' },
        }),
      ).rejects.toThrow(
        'Node cannot enter QUARANTINED while live access grants remain',
      );
      await expect(
        orchestration.quarantineNode({
          nodeId: deletedNode.id,
          syncJobIdempotencyKey: `quarantine-deleted-${suffix}`,
          outboxEventIdempotencyKey: `quarantine-deleted-outbox-${suffix}`,
        }),
      ).rejects.toThrow('Node cannot be quarantined');

      const quarantined = await orchestration.quarantineNode({
        nodeId: node.id,
        syncJobIdempotencyKey: `quarantine-emergency-${suffix}`,
        outboxEventIdempotencyKey: `quarantine-emergency-outbox-${suffix}`,
      });
      expect(quarantined.nodeSyncJobId).toEqual(expect.any(String));
      await expect(
        orchestration.quarantineNode({
          nodeId: node.id,
          syncJobIdempotencyKey: `quarantine-emergency-${suffix}`,
          outboxEventIdempotencyKey: `quarantine-emergency-outbox-${suffix}`,
        }),
      ).resolves.toEqual(quarantined);
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({ status: 'QUARANTINED' });
      await expect(
        prisma.nodeAccessGrant.findFirstOrThrow({
          where: { id: scheduled.nodeAccessGrantId },
        }),
      ).resolves.toMatchObject({ status: 'REVOKED' });
      const otherDevice = await prisma.device.create({
        data: {
          userId: user.id,
          subscriptionTokenHash: `quarantine-sync-other-${suffix}`,
        },
      });
      await expect(
        prisma.nodeAccessGrant.create({
          data: {
            nodeId: node.id,
            deviceId: otherDevice.id,
            dataPlaneCredentialHash: `quarantine-live-${suffix}`,
            expiresAt,
          },
        }),
      ).rejects.toThrow('Quarantined node cannot retain live access grants');
      await expect(
        orchestration.scheduleNodeAccessGrant({
          nodeId: node.id,
          deviceId: device.id,
          expiresAt,
          syncJobIdempotencyKey: `quarantine-new-${suffix}`,
          outboxEventIdempotencyKey: `quarantine-new-outbox-${suffix}`,
        }),
      ).rejects.toThrow('Node access cannot be scheduled for this node');

      await request(app.getHttpServer())
        .post('/node-agent/v1/heartbeats')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(204);
      const snapshot = await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(200);
      expect(snapshot.body.grants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: scheduled.nodeAccessGrantId,
            status: 'REVOKED',
            dataPlaneCredential: null,
          }),
        ]),
      );

      await expect(
        completeInfrastructureNodeSyncJob(
          prisma,
          quarantined.nodeSyncJobId as string,
          `quarantine-worker-${suffix}`,
        ),
      ).resolves.toBeUndefined();
      const revokedSnapshot = await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(200);
      await request(app.getHttpServer())
        .post('/node-agent/v1/acknowledgements')
        .set('authorization', `Bearer ${credential.secret}`)
        .send(revokedSnapshot.body.pendingAcknowledgement)
        .expect(204);
      await prisma.node.update({
        where: { id: node.id },
        data: { status: 'HEALTHY' },
      });
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({ status: 'HEALTHY' });
    } finally {
      for (const id of [nodeId, deletedNodeId]) {
        if (!id) continue;
        await prisma.nodeAgentCredential.deleteMany({ where: { nodeId: id } });
      }
    }
  });

  it('reconciles missing access before a disabled node can return to HEALTHY', async () => {
    const prisma = app.get(PrismaService);
    const orchestration = app.get(OrchestrationService);
    const credentials = app.get(NodeAgentCredentialService);
    const suffix = randomUUID();
    const plan = await prisma.plan.create({
      data: {
        code: `healthy-reconcile-${suffix}`,
        name: 'Healthy reconcile integration',
        priceMinor: 1,
        currency: 'RUB',
        durationDays: 30,
        deviceLimit: 1,
      },
    });
    const user = await prisma.user.create({
      data: { telegramUserId: `h${suffix.replaceAll('-', '').slice(0, 20)}` },
    });
    const subscription = await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: 'ACTIVE',
        startsAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    const device = await prisma.device.create({
      data: { userId: user.id, subscriptionTokenHash: randomUUID() },
    });
    const node = await prisma.node.create({
      data: {
        name: `healthy-reconcile-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'DISABLED',
      },
    });

    try {
      const credential = await credentials.rotate(node.id);
      await expect(
        orchestration.restoreNodeToHealthy(node.id),
      ).resolves.toEqual({
        nodeId: node.id,
        status: 'RECONCILIATION_REQUIRED',
      });
      const grant = await prisma.nodeAccessGrant.findUniqueOrThrow({
        where: { nodeId_deviceId: { nodeId: node.id, deviceId: device.id } },
      });
      expect(grant).toMatchObject({
        status: 'PENDING',
        desiredVersion: 1,
        appliedVersion: 0,
      });
      await expect(
        prisma.nodeSyncJob.count({ where: { nodeId: node.id } }),
      ).resolves.toBe(1);
      const syncJob = await prisma.nodeSyncJob.findFirstOrThrow({
        where: { nodeId: node.id, nodeAccessGrantId: grant.id },
      });
      await expect(
        prisma.outboxEvent.count({ where: { aggregateId: grant.id } }),
      ).resolves.toBe(1);
      await expect(
        prisma.node.update({
          where: { id: node.id },
          data: { status: 'HEALTHY' },
        }),
      ).rejects.toThrow(
        'Node cannot return to HEALTHY until pending access updates are reconciled',
      );

      await expect(
        completeInfrastructureNodeSyncJob(
          prisma,
          syncJob.id,
          `healthy-reconcile-worker-${suffix}`,
        ),
      ).resolves.toBeUndefined();
      const snapshot = await request(app.getHttpServer())
        .get('/node-agent/v1/configuration')
        .set('authorization', `Bearer ${credential.secret}`)
        .expect(200);
      await request(app.getHttpServer())
        .post('/node-agent/v1/acknowledgements')
        .set('authorization', `Bearer ${credential.secret}`)
        .send(snapshot.body.pendingAcknowledgement)
        .expect(204);
      await expect(
        orchestration.restoreNodeToHealthy(node.id),
      ).resolves.toEqual({ nodeId: node.id, status: 'HEALTHY' });
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({ status: 'HEALTHY' });
      await expect(
        prisma.auditEvent.count({
          where: { action: 'node.healthy', entityId: node.id },
        }),
      ).resolves.toBe(1);
    } finally {
      await prisma.nodeAgentCredential.deleteMany({
        where: { nodeId: node.id },
      });
      await prisma.subscription.updateMany({
        where: { id: subscription.id, status: 'ACTIVE' },
        data: { status: 'EXPIRED' },
      });
      await prisma.node.updateMany({
        where: { id: node.id, status: { not: 'DELETED' } },
        data: { status: 'DELETED' },
      });
    }
  });

  it('removes explicitly cancelled credentials from the next snapshot on every serving lifecycle', async () => {
    const prisma = app.get(PrismaService);
    const snapshots = app.get(NodeAgentConfigurationService);
    const credentials = app.get(DataPlaneCredentialService);
    const pepper = (
      app.get(API_ENVIRONMENT) as { DATA_PLANE_CREDENTIAL_PEPPER: string }
    ).DATA_PLANE_CREDENTIAL_PEPPER;
    const accessStore = new PrismaSubscriptionAccessStore(prisma, pepper);
    const suffix = randomUUID();
    const plan = await prisma.plan.create({
      data: {
        code: `cancel-snapshot-${suffix}`,
        name: 'Cancelled snapshot integration',
        priceMinor: 1,
        currency: 'RUB',
        durationDays: 30,
        deviceLimit: 1,
      },
    });
    const user = await prisma.user.create({
      data: { telegramUserId: `c${suffix.replaceAll('-', '').slice(0, 20)}` },
    });
    const subscription = await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: 'ACTIVE',
        startsAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    const device = await prisma.device.create({
      data: { userId: user.id, subscriptionTokenHash: randomUUID() },
    });
    const nodes = await Promise.all(
      (['HEALTHY', 'DRAINING', 'DISABLED', 'HEALTHY'] as const).map(
        (status, index) =>
          prisma.node.create({
            data: {
              name: `cancel-snapshot-${index}-${suffix}`,
              provider: 'integration-test',
              locationLabel: 'integration-test',
              status,
            },
          }),
      ),
    );
    const grants: { id: string }[] = [];
    for (const node of nodes) {
      const grantId = randomUUID();
      const credential = credentials.derive({
        grantId,
        deviceId: device.id,
        nodeId: node.id,
      });
      grants.push(
        await prisma.nodeAccessGrant.create({
          data: {
            id: grantId,
            nodeId: node.id,
            deviceId: device.id,
            status: 'ACTIVE',
            dataPlaneCredentialHash: credentials.hash(credential),
            dataPlaneCredentialDerivationVersion: 1,
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          },
        }),
      );
    }
    try {
      await prisma.$transaction([
        prisma.nodeAccessGrant.update({
          where: { id: grants[3]!.id },
          data: { status: 'REVOKED', revokedAt: new Date() },
        }),
        prisma.node.update({
          where: { id: nodes[3]!.id },
          data: { status: 'QUARANTINED' },
        }),
      ]);
      await expect(
        accessStore.cancelSubscriptionAccess(subscription.id),
      ).resolves.toBe('cancelled');
      await expect(
        accessStore.cancelSubscriptionAccess(subscription.id),
      ).resolves.toBe('already-cancelled');

      for (const [index, node] of nodes.entries()) {
        const snapshot = await snapshots.snapshotInTransaction(
          prisma as never,
          node.id,
        );
        expect(snapshot.grants).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: grants[index]!.id,
              status: 'REVOKED',
              dataPlaneCredential: null,
            }),
          ]),
        );
      }
      await expect(
        prisma.nodeSyncJob.count({
          where: { nodeId: { in: nodes.map((node) => node.id) } },
        }),
      ).resolves.toBe(3);
      await expect(
        prisma.outboxEvent.count({
          where: { aggregateId: { in: grants.map((grant) => grant.id) } },
        }),
      ).resolves.toBe(3);
      await expect(
        prisma.auditEvent.count({
          where: {
            action: 'subscription-cancellation.access-revoked',
            entityId: subscription.id,
          },
        }),
      ).resolves.toBe(3);
    } finally {
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: grants.map((grant) => grant.id) } },
      });
      await prisma.nodeSyncJob.deleteMany({
        where: { nodeId: { in: nodes.map((node) => node.id) } },
      });
      await prisma.nodeAccessGrant.deleteMany({
        where: { id: { in: grants.map((grant) => grant.id) } },
      });
      await prisma.node.deleteMany({
        where: { id: { in: nodes.map((node) => node.id) } },
      });
      await prisma.device.delete({ where: { id: device.id } });
      await prisma.subscription.delete({ where: { id: subscription.id } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.plan.delete({ where: { id: plan.id } });
    }
  });

  it('fails closed when a grant outlives its expired entitlement and no replacement exists', async () => {
    const prisma = app.get(PrismaService);
    const snapshots = app.get(NodeAgentConfigurationService);
    const credentials = app.get(DataPlaneCredentialService);
    const pepper = (
      app.get(API_ENVIRONMENT) as { DATA_PLANE_CREDENTIAL_PEPPER: string }
    ).DATA_PLANE_CREDENTIAL_PEPPER;
    const maintenance = new PrismaSubscriptionAccessStore(prisma, pepper);
    const suffix = randomUUID();
    const plan = await prisma.plan.create({
      data: {
        code: `expiry-fail-closed-${suffix}`,
        name: 'Expiry fail-closed integration',
        priceMinor: 1,
        currency: 'RUB',
        durationDays: 30,
        deviceLimit: 1,
      },
    });
    const user = await prisma.user.create({
      data: { telegramUserId: `e${suffix.replaceAll('-', '').slice(0, 20)}` },
    });
    const expiredAt = new Date('2000-01-01T00:00:00.000Z');
    const subscription = await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: 'ACTIVE',
        startsAt: new Date('1999-01-01T00:00:00.000Z'),
        expiresAt: expiredAt,
      },
    });
    const device = await prisma.device.create({
      data: { userId: user.id, subscriptionTokenHash: randomUUID() },
    });
    const node = await prisma.node.create({
      data: {
        name: `expiry-fail-closed-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
      },
    });
    const grantId = randomUUID();
    const dataPlaneCredential = credentials.derive({
      grantId,
      deviceId: device.id,
      nodeId: node.id,
    });
    const grant = await prisma.nodeAccessGrant.create({
      data: {
        id: grantId,
        nodeId: node.id,
        deviceId: device.id,
        status: 'ACTIVE',
        dataPlaneCredentialHash: credentials.hash(dataPlaneCredential),
        dataPlaneCredentialDerivationVersion: 1,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });

    try {
      const unsafeSnapshot = await snapshots.snapshotInTransaction(
        prisma as never,
        node.id,
      );
      expect(unsafeSnapshot.grants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: grant.id,
            dataPlaneCredential,
          }),
        ]),
      );

      await expect(
        maintenance.materializeExpiredSubscriptions(100),
      ).resolves.toEqual({ processed: 1, failed: 0 });
      await expect(
        prisma.nodeAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
      ).resolves.toMatchObject({ expiresAt: expiredAt });
      const safeSnapshot = await snapshots.snapshotInTransaction(
        prisma as never,
        node.id,
      );
      expect(safeSnapshot.grants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: grant.id,
            dataPlaneCredential: null,
          }),
        ]),
      );
    } finally {
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: grant.id },
      });
      await prisma.nodeSyncJob.deleteMany({ where: { nodeId: node.id } });
      await prisma.nodeAccessGrant.deleteMany({ where: { id: grant.id } });
      await prisma.node.delete({ where: { id: node.id } });
      await prisma.device.delete({ where: { id: device.id } });
      await prisma.subscription.delete({ where: { id: subscription.id } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.plan.delete({ where: { id: plan.id } });
    }
  });

  it('runs the local pull, simulated apply, and acknowledgement lifecycle', async () => {
    const prisma = app.get(PrismaService);
    const credentials = app.get(NodeAgentCredentialService);
    const suffix = randomUUID();
    const stateDirectory = await mkdtemp(
      join(tmpdir(), 'vpn-node-agent-integration-'),
    );

    try {
      const user = await prisma.user.create({
        data: {
          telegramUserId: `92${suffix.replaceAll('-', '').slice(0, 20)}`,
        },
      });
      const device = await prisma.device.create({
        data: {
          userId: user.id,
          subscriptionTokenHash: `node-agent-runner-feed-${suffix}`,
        },
      });
      const node = await prisma.node.create({
        data: {
          name: `node-agent-runner-${suffix}`,
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
          dataPlaneCredentialHash: `node-agent-runner-credential-${suffix}`,
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          desiredVersion: 1,
        },
      });
      const syncJob = await prisma.nodeSyncJob.create({
        data: {
          nodeId: node.id,
          nodeAccessGrantId: grant.id,
          targetVersion: 1,
          idempotencyKey: `node-agent-runner-sync-${suffix}`,
        },
      });
      await expect(
        completeInfrastructureNodeSyncJob(
          prisma,
          syncJob.id,
          `node-agent-runner-${suffix}`,
        ),
      ).resolves.toBeUndefined();
      const credential = await credentials.rotate(node.id);

      const server = app.getHttpServer() as { listening?: boolean };
      if (!server.listening) await app.listen(0, '127.0.0.1');
      const statePath = join(stateDirectory, 'state.json');
      const runner = new NodeAgentRunner(
        new HttpNodeAgentControlPlane(
          await app.getUrl(),
          credential.secret,
          5_000,
        ),
        new StateFileSimulationAdapter(statePath),
      );

      await expect(runner.runCycle()).resolves.toBe('acknowledged');
      await expect(runner.runCycle()).resolves.toBe('synchronized');
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
      ).resolves.toMatchObject({
        desiredConfigVersion: 1,
        appliedConfigVersion: 1,
        lastHeartbeatAt: expect.any(Date),
      });
      await expect(
        prisma.nodeAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
      ).resolves.toMatchObject({ desiredVersion: 1, appliedVersion: 1 });
      await expect(
        prisma.nodeConfigAcknowledgement.findUniqueOrThrow({
          where: { nodeSyncJobId: syncJob.id },
        }),
      ).resolves.toMatchObject({ nodeId: node.id, targetVersion: 1 });
      expect(await readFile(statePath, 'utf8')).not.toContain(
        credential.secret,
      );
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
