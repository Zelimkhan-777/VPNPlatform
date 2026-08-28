import type { INestApplication } from '@nestjs/common';
import {
  cabinetOverviewSchema,
  issuedCabinetDeviceSchema,
} from '@vpn-platform/contracts';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrchestrationService } from '../../src/orchestration/orchestration.service';
import { PrismaService } from '../../src/database/prisma.service';
import { authSessionPepper, createInfrastructureTestApp } from './fixture';

describe('infrastructure cabinet', () => {
  let app: INestApplication;
  let issuanceNodeId: string;

  beforeAll(async () => {
    app = await createInfrastructureTestApp();
    const prisma = app.get(PrismaService);
    const node = await prisma.node.create({
      data: {
        name: `cabinet-issuance-${randomUUID()}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
      },
    });
    issuanceNodeId = node.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns 503 and spends no device slot when no HEALTHY node exists', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const secret = createHash('sha256')
      .update(`no-healthy:${suffix}`)
      .digest('base64url');
    const plan = await prisma.plan.create({
      data: {
        code: `no-healthy-${suffix}`,
        name: 'No healthy node integration',
        priceMinor: 1,
        currency: 'RUB',
        deviceLimit: 1,
      },
    });
    const user = await prisma.user.create({
      data: { telegramUserId: `0${suffix.replaceAll('-', '').slice(0, 20)}` },
    });

    try {
      await prisma.$transaction([
        prisma.subscription.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: 'ACTIVE',
            startsAt: new Date(),
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          },
        }),
        prisma.userSession.create({
          data: {
            userId: user.id,
            tokenHash: createHmac('sha256', authSessionPepper)
              .update(secret)
              .digest('hex'),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
        prisma.node.update({
          where: { id: issuanceNodeId },
          data: { status: 'DISABLED' },
        }),
      ]);

      await request(app.getHttpServer())
        .post('/cabinet/devices')
        .set('cookie', `vpn_platform_session=${secret}`)
        .set('origin', 'https://app.example.test')
        .set('idempotency-key', randomUUID())
        .send({ displayName: 'Must not consume a slot' })
        .expect(503);

      await expect(
        prisma.device.count({ where: { userId: user.id } }),
      ).resolves.toBe(0);
      await expect(
        prisma.nodeAccessGrant.count({
          where: { device: { userId: user.id } },
        }),
      ).resolves.toBe(0);
    } finally {
      await prisma.node.update({
        where: { id: issuanceNodeId },
        data: { status: 'HEALTHY' },
      });
      await prisma.userSession.deleteMany({ where: { userId: user.id } });
      await prisma.subscription.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.plan.delete({ where: { id: plan.id } });
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
        expiresAt: new Date(Date.now() + 60_000),
        syncJobIdempotencyKey: `scheduled-sync-${suffix}`,
        outboxEventIdempotencyKey: `scheduled-outbox-${suffix}`,
      });
      await expect(
        orchestration.scheduleNodeAccessGrant({
          nodeId: node.id,
          deviceId: scheduledDevice.id,
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
    const firstSecret = 'a'.repeat(43);
    const secondSecret = 'b'.repeat(43);
    let planId: string | undefined;
    let firstUserId: string | undefined;
    let secondUserId: string | undefined;

    const hashSession = (secret: string) =>
      createHmac('sha256', authSessionPepper).update(secret).digest('hex');

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
    const secret = 'e'.repeat(43);
    const idempotencyKey = randomUUID();
    let subscriptionId: string | undefined;
    let planId: string | undefined;
    let userId: string | undefined;
    let extraNodeId: string | undefined;

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
            tokenHash: createHmac('sha256', authSessionPepper)
              .update(secret)
              .digest('hex'),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ]);
      subscriptionId = subscription.id;
      const extraNode = await prisma.node.create({
        data: {
          name: `issuance-second-${suffix}`,
          provider: 'integration-test',
          locationLabel: 'integration-test',
          status: 'HEALTHY',
        },
      });
      extraNodeId = extraNode.id;
      const healthyNodeCount = await prisma.node.count({
        where: { status: 'HEALTHY' },
      });
      expect(healthyNodeCount).toBeGreaterThanOrEqual(2);

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
      const issuedDevice = await prisma.device.findFirstOrThrow({
        where: { userId, status: 'ACTIVE' },
      });
      const issuedGrants = await prisma.nodeAccessGrant.findMany({
        where: { deviceId: issuedDevice.id },
      });
      expect(issuedGrants).toHaveLength(healthyNodeCount);
      expect(
        issuedGrants.every(
          (grant) => grant.status === 'PENDING' && grant.appliedVersion === 0,
        ),
      ).toBe(true);
      await expect(
        prisma.nodeSyncJob.count({
          where: { nodeAccessGrant: { deviceId: issuedDevice.id } },
        }),
      ).resolves.toBe(healthyNodeCount);
      await expect(
        prisma.outboxEvent.count({
          where: { aggregateId: { in: issuedGrants.map((grant) => grant.id) } },
        }),
      ).resolves.toBe(healthyNodeCount);

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
        const grants = await prisma.nodeAccessGrant.findMany({
          where: { device: { userId } },
          select: { id: true },
        });
        const grantIds = grants.map((grant) => grant.id);
        await prisma.outboxEvent.deleteMany({
          where: { aggregateId: { in: grantIds } },
        });
        await prisma.nodeSyncJob.deleteMany({
          where: { nodeAccessGrantId: { in: grantIds } },
        });
        await prisma.nodeAccessGrant.deleteMany({
          where: { id: { in: grantIds } },
        });
        await prisma.device.deleteMany({ where: { userId } });
        await prisma.subscription.deleteMany({ where: { userId } });
      }
      if (planId) {
        await prisma.plan.delete({ where: { id: planId } });
      }
      if (extraNodeId) {
        await prisma.node.delete({ where: { id: extraNodeId } });
      }
    }
  });

  it('rolls back the device slot and every desired-state write after a late grant scheduling failure', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const secret = createHash('sha256')
      .update(`issuance-rollback:${suffix}`)
      .digest('base64url');

    const plan = await prisma.plan.create({
      data: {
        code: `issuance-rollback-${suffix}`,
        name: 'Issuance rollback plan',
        priceMinor: 1,
        currency: 'RUB',
        deviceLimit: 1,
      },
    });
    const user = await prisma.user.create({
      data: { telegramUserId: `6${suffix.replaceAll('-', '').slice(0, 20)}` },
    });
    const failingNode = await prisma.node.create({
      data: {
        name: `issuance-overflow-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
        desiredConfigVersion: 2_147_483_647,
      },
    });
    const sharedVersionBefore = (
      await prisma.node.findUniqueOrThrow({ where: { id: issuanceNodeId } })
    ).desiredConfigVersion;

    try {
      await prisma.$transaction([
        prisma.subscription.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: 'ACTIVE',
            startsAt: new Date(),
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          },
        }),
        prisma.userSession.create({
          data: {
            userId: user.id,
            tokenHash: createHmac('sha256', authSessionPepper)
              .update(secret)
              .digest('hex'),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ]);

      await request(app.getHttpServer())
        .post('/cabinet/devices')
        .set('cookie', `vpn_platform_session=${secret}`)
        .set('origin', 'https://app.example.test')
        .set('idempotency-key', randomUUID())
        .send({ displayName: 'Must roll back' })
        .expect(500);

      await expect(
        prisma.device.count({ where: { userId: user.id } }),
      ).resolves.toBe(0);
      await expect(
        prisma.nodeAccessGrant.count({
          where: { device: { userId: user.id } },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.auditEvent.count({ where: { actorUserId: user.id } }),
      ).resolves.toBe(0);
      await expect(
        prisma.node.findUniqueOrThrow({ where: { id: issuanceNodeId } }),
      ).resolves.toMatchObject({
        desiredConfigVersion: sharedVersionBefore,
      });
    } finally {
      await prisma.userSession.deleteMany({ where: { userId: user.id } });
      await prisma.subscription.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.plan.delete({ where: { id: plan.id } });
      await prisma.node.delete({ where: { id: failingNode.id } });
    }
  });

  it('serializes different device issuance keys at a one-device limit', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const secret = '9'.repeat(43);
    let planId: string | undefined;
    let userId: string | undefined;

    try {
      const plan = await prisma.plan.create({
        data: {
          code: `issuance-race-${suffix}`,
          name: 'Issuance race integration plan',
          priceMinor: 1,
          currency: 'RUB',
          deviceLimit: 1,
        },
      });
      planId = plan.id;
      const user = await prisma.user.create({
        data: { telegramUserId: `7${suffix.replaceAll('-', '').slice(0, 20)}` },
      });
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
      await prisma.userSession.create({
        data: {
          userId: user.id,
          tokenHash: createHmac('sha256', authSessionPepper)
            .update(secret)
            .digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const firstKey = randomUUID();
      const secondKey = randomUUID();
      const attempts = [
        { key: firstKey, displayName: 'Concurrent first' },
        { key: secondKey, displayName: 'Concurrent second' },
      ];
      const issue = (attempt: (typeof attempts)[number]) =>
        request(app.getHttpServer())
          .post('/cabinet/devices')
          .set('cookie', `vpn_platform_session=${secret}`)
          .set('origin', 'https://app.example.test')
          .set('idempotency-key', attempt.key)
          .send({ displayName: attempt.displayName });
      const responses = await Promise.all(attempts.map(issue));
      expect(responses.map((response) => response.status).sort()).toEqual([
        201, 409,
      ]);
      expect(
        await prisma.device.count({
          where: { userId: user.id, status: 'ACTIVE' },
        }),
      ).toBe(1);
      expect(
        await prisma.auditEvent.count({
          where: { actorUserId: user.id, action: 'device.issued' },
        }),
      ).toBe(1);

      const winnerIndex = responses.findIndex(
        (response) => response.status === 201,
      );
      if (winnerIndex < 0) {
        throw new Error('One concurrent issuance must succeed');
      }
      const winner = issuedCabinetDeviceSchema.parse(
        responses[winnerIndex]?.body,
      );
      const retry = await issue(
        attempts[winnerIndex] as (typeof attempts)[number],
      );
      expect(retry.status).toBe(201);
      expect(issuedCabinetDeviceSchema.parse(retry.body)).toEqual(winner);
      expect(JSON.stringify(retry.body)).toContain(winner.subscriptionUrl);
      expect(
        await prisma.device.count({
          where: { userId: user.id, status: 'ACTIVE' },
        }),
      ).toBe(1);
      expect(
        await prisma.auditEvent.count({
          where: { actorUserId: user.id, action: 'device.issued' },
        }),
      ).toBe(1);
    } finally {
      if (userId) {
        await prisma.userSession.deleteMany({ where: { userId } });
        const grants = await prisma.nodeAccessGrant.findMany({
          where: { device: { userId } },
          select: { id: true },
        });
        const grantIds = grants.map((grant) => grant.id);
        await prisma.outboxEvent.deleteMany({
          where: { aggregateId: { in: grantIds } },
        });
        await prisma.nodeSyncJob.deleteMany({
          where: { nodeAccessGrantId: { in: grantIds } },
        });
        await prisma.nodeAccessGrant.deleteMany({
          where: { id: { in: grantIds } },
        });
        await prisma.device.deleteMany({ where: { userId } });
        await prisma.subscription.deleteMany({ where: { userId } });
        // The audit record is append-only and deliberately retains its actor.
      }
      if (planId) await prisma.plan.deleteMany({ where: { id: planId } });
    }
  });

  it('rejects device issuance if the subscription expires while its advisory lock is held', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const secret = 'f'.repeat(43);
    const expiresAt = new Date(Date.now() + 1_500);
    let planId: string | undefined;
    let userId: string | undefined;
    let releaseLock: (() => void) | undefined;
    let heldLock: Promise<void> | undefined;

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
            tokenHash: createHmac('sha256', authSessionPepper)
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

  it('revokes one owned device and schedules each affected node exactly once', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID();
    const ownerSecret = createHash('sha256')
      .update(`revocation-owner:${suffix}`)
      .digest('base64url');
    const otherSecret = createHash('sha256')
      .update(`revocation-other:${suffix}`)
      .digest('base64url');
    const [owner, otherUser] = await prisma.$transaction([
      prisma.user.create({
        data: {
          telegramUserId: `81${suffix.replaceAll('-', '').slice(0, 20)}`,
        },
      }),
      prisma.user.create({
        data: {
          telegramUserId: `82${suffix.replaceAll('-', '').slice(0, 20)}`,
        },
      }),
    ]);
    await prisma.$transaction([
      prisma.userSession.create({
        data: {
          userId: owner.id,
          tokenHash: createHmac('sha256', authSessionPepper)
            .update(ownerSecret)
            .digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
      prisma.userSession.create({
        data: {
          userId: otherUser.id,
          tokenHash: createHmac('sha256', authSessionPepper)
            .update(otherSecret)
            .digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ]);
    const device = await prisma.device.create({
      data: {
        userId: owner.id,
        displayName: 'Revocation integration device',
        subscriptionTokenHash: `revocation-feed-${suffix}`,
      },
    });
    const node = await prisma.node.create({
      data: {
        name: `revocation-${suffix}`,
        provider: 'integration-test',
        locationLabel: 'integration-test',
        status: 'HEALTHY',
      },
    });
    const grant = await prisma.nodeAccessGrant.create({
      data: {
        nodeId: node.id,
        deviceId: device.id,
        status: 'ACTIVE',
        dataPlaneCredentialHash: `revocation-credential-${suffix}`,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    const revoke = (secret: string) =>
      request(app.getHttpServer())
        .post(`/cabinet/devices/${device.id}/revoke`)
        .set('cookie', `vpn_platform_session=${secret}`)
        .set('origin', 'https://app.example.test');

    await revoke(otherSecret).expect(404);
    await expect(
      prisma.device.findUniqueOrThrow({ where: { id: device.id } }),
    ).resolves.toMatchObject({ status: 'ACTIVE', revokedAt: null });

    const responses = await Promise.all([
      revoke(ownerSecret),
      revoke(ownerSecret),
    ]);
    expect(responses.map((response) => response.status)).toEqual([204, 204]);

    const [revokedDevice, revokedGrant, updatedNode, syncJobs, outboxEvents] =
      await Promise.all([
        prisma.device.findUniqueOrThrow({ where: { id: device.id } }),
        prisma.nodeAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
        prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
        prisma.nodeSyncJob.findMany({ where: { nodeAccessGrantId: grant.id } }),
        prisma.outboxEvent.findMany({ where: { aggregateId: grant.id } }),
      ]);
    expect(revokedDevice.status).toBe('REVOKED');
    expect(revokedDevice.revokedAt).toBeInstanceOf(Date);
    expect(revokedGrant).toMatchObject({
      status: 'REVOKED',
      desiredVersion: 1,
    });
    expect(revokedGrant.revokedAt).toEqual(revokedDevice.revokedAt);
    expect(updatedNode.desiredConfigVersion).toBe(1);
    expect(syncJobs).toHaveLength(1);
    expect(syncJobs[0]).toMatchObject({
      nodeId: node.id,
      targetVersion: 1,
      status: 'PENDING',
    });
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0]).toMatchObject({
      topic: 'node-sync.requested',
      status: 'PENDING',
      payload: {
        nodeAccessGrantId: grant.id,
        nodeSyncJobId: syncJobs[0]?.id,
        targetVersion: 1,
      },
    });
    await expect(
      prisma.auditEvent.count({
        where: {
          actorUserId: owner.id,
          action: { in: ['device.revoked', 'node-access-grant.revoked'] },
        },
      }),
    ).resolves.toBe(2);
  });
});
