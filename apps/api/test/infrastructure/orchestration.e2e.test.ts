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

import { PrismaService } from '../../src/database/prisma.service';
import { NodeAgentCredentialService } from '../../src/orchestration/node-agent-credential.service';
import { OrchestrationService } from '../../src/orchestration/orchestration.service';
import { authenticatedNodeId, createInfrastructureTestApp } from './fixture';

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
      await orchestration.scheduleNodeAccessGrant({
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
        expect.arrayContaining([
          expect.objectContaining({ status: 'PENDING' }),
        ]),
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
      const leaseToken = await orchestration.claimNodeSyncJob(
        revokeJob.id,
        `disabled-sync-worker-${suffix}`,
      );
      expect(leaseToken).toEqual(expect.any(String));
      await expect(
        orchestration.completeNodeSyncJob(
          revokeJob.id,
          `disabled-sync-worker-${suffix}`,
          leaseToken as string,
        ),
      ).resolves.toBe(true);
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

      const leaseToken = await orchestration.claimNodeSyncJob(
        quarantined.nodeSyncJobId as string,
        `quarantine-worker-${suffix}`,
      );
      await expect(
        orchestration.completeNodeSyncJob(
          quarantined.nodeSyncJobId as string,
          `quarantine-worker-${suffix}`,
          leaseToken as string,
        ),
      ).resolves.toBe(true);
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

  it('runs the local pull, simulated apply, and acknowledgement lifecycle', async () => {
    const prisma = app.get(PrismaService);
    const credentials = app.get(NodeAgentCredentialService);
    const orchestration = app.get(OrchestrationService);
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
      const leaseToken = await orchestration.claimNodeSyncJob(
        syncJob.id,
        `node-agent-runner-${suffix}`,
      );
      if (!leaseToken) throw new Error('Integration sync job was not claimed');
      await expect(
        orchestration.completeNodeSyncJob(
          syncJob.id,
          `node-agent-runner-${suffix}`,
          leaseToken,
        ),
      ).resolves.toBe(true);
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
