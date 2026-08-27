import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { PrismaSubscriptionAccessStore } from '@vpn-platform/orchestration-store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('subscription access maintenance', () => {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL as string,
  });
  const store = new PrismaSubscriptionAccessStore(prisma, 'p'.repeat(43));

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  it('materializes natural expiry once and schedules every serving lifecycle without revoking identities', async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        telegramUserId: `91${suffix.replaceAll('-', '').slice(0, 20)}`,
      },
    });
    const plan = await prisma.plan.create({
      data: {
        code: `expiry-${suffix}`,
        name: 'Expiry integration',
        priceMinor: 20000,
        currency: 'RUB',
        deviceLimit: 3,
      },
    });
    const expiresAt = new Date('2000-01-01T00:00:00.000Z');
    const subscription = await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: 'ACTIVE',
        startsAt: new Date('1999-01-01T00:00:00.000Z'),
        expiresAt,
      },
    });
    const device = await prisma.device.create({
      data: {
        userId: user.id,
        subscriptionTokenHash: randomUUID(),
      },
    });
    const nodes = await Promise.all(
      (['HEALTHY', 'DRAINING', 'DISABLED', 'QUARANTINED'] as const).map(
        (status) =>
          prisma.node.create({
            data: {
              name: `expiry-${status}-${suffix}`,
              provider: 'integration',
              locationLabel: 'integration',
              status,
            },
          }),
      ),
    );
    const grants = await Promise.all(
      nodes.slice(0, 3).map((node, index) =>
        prisma.nodeAccessGrant.create({
          data: {
            nodeId: node.id,
            deviceId: device.id,
            status: 'ACTIVE',
            dataPlaneCredentialHash: randomUUID(),
            dataPlaneCredentialDerivationVersion: 1,
            expiresAt:
              index === 0 ? new Date('2099-01-01T00:00:00.000Z') : expiresAt,
          },
        }),
      ),
    );

    await expect(store.materializeExpiredSubscriptions(10)).resolves.toEqual({
      processed: 1,
      failed: 0,
    });
    await expect(store.materializeExpiredSubscriptions(10)).resolves.toEqual({
      processed: 0,
      failed: 0,
    });
    await expect(
      prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
    ).resolves.toMatchObject({ status: 'EXPIRED' });

    const persistedGrants = await prisma.nodeAccessGrant.findMany({
      where: { id: { in: grants.map((grant) => grant.id) } },
      orderBy: { nodeId: 'asc' },
    });
    expect(persistedGrants).toHaveLength(3);
    expect(persistedGrants.every((grant) => grant.status === 'ACTIVE')).toBe(
      true,
    );
    expect(
      persistedGrants.every(
        (grant) => grant.expiresAt.getTime() === expiresAt.getTime(),
      ),
    ).toBe(true);
    expect(
      await prisma.nodeSyncJob.count({
        where: { nodeId: { in: nodes.map((node) => node.id) } },
      }),
    ).toBe(3);
    await expect(
      prisma.nodeSyncJob.count({ where: { nodeId: nodes[3]!.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.auditEvent.count({
        where: { action: 'subscription.expired', entityId: subscription.id },
      }),
    ).resolves.toBe(1);
    await prisma.node.update({
      where: { id: nodes[0]!.id },
      data: { status: 'DISABLED' },
    });
  });

  it('normalizes a stale grant to the effective replacement entitlement instead of the expired subscription', async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        telegramUserId: `90${suffix.replaceAll('-', '').slice(0, 20)}`,
      },
    });
    const plan = await prisma.plan.create({
      data: {
        code: `replacement-${suffix}`,
        name: 'Replacement entitlement integration',
        priceMinor: 20000,
        currency: 'RUB',
        deviceLimit: 1,
      },
    });
    const expiredSubscription = await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: 'EXPIRED',
        startsAt: new Date('1999-01-01T00:00:00.000Z'),
        expiresAt: new Date('2000-01-01T00:00:00.000Z'),
      },
    });
    const replacementExpiry = new Date('2099-01-01T00:00:00.000Z');
    const replacementSubscription = await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: 'ACTIVE',
        startsAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: replacementExpiry,
      },
    });
    const device = await prisma.device.create({
      data: { userId: user.id, subscriptionTokenHash: randomUUID() },
    });
    const node = await prisma.node.create({
      data: {
        name: `replacement-${suffix}`,
        provider: 'integration',
        locationLabel: 'integration',
        status: 'HEALTHY',
      },
    });
    const grant = await prisma.nodeAccessGrant.create({
      data: {
        nodeId: node.id,
        deviceId: device.id,
        status: 'ACTIVE',
        dataPlaneCredentialHash: randomUUID(),
        dataPlaneCredentialDerivationVersion: 1,
        expiresAt: new Date('2100-01-01T00:00:00.000Z'),
      },
    });

    await expect(store.materializeExpiredSubscriptions(10)).resolves.toEqual({
      processed: 1,
      failed: 0,
    });
    await expect(
      prisma.nodeAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
    ).resolves.toMatchObject({
      status: 'ACTIVE',
      expiresAt: replacementExpiry,
      desiredVersion: 1,
      appliedVersion: 0,
    });
    await expect(
      prisma.nodeSyncJob.count({ where: { nodeId: node.id } }),
    ).resolves.toBe(1);
    await expect(
      prisma.subscription.findUniqueOrThrow({
        where: { id: expiredSubscription.id },
      }),
    ).resolves.toMatchObject({ status: 'EXPIRED' });

    await prisma.$transaction([
      prisma.subscription.update({
        where: { id: replacementSubscription.id },
        data: { status: 'EXPIRED' },
      }),
      prisma.node.update({
        where: { id: node.id },
        data: { status: 'DISABLED' },
      }),
    ]);
  });

  it('rebuilds current desired grants by lifecycle and never resurrects a revoked identity', async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        telegramUserId: `92${suffix.replaceAll('-', '').slice(0, 20)}`,
      },
    });
    const plan = await prisma.plan.create({
      data: {
        code: `reconcile-${suffix}`,
        name: 'Reconcile integration',
        priceMinor: 20000,
        currency: 'RUB',
        deviceLimit: 3,
      },
    });
    const expiresAt = new Date('2099-01-01T00:00:00.000Z');
    const subscription = await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: 'ACTIVE',
        startsAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt,
      },
    });
    const device = await prisma.device.create({
      data: {
        userId: user.id,
        subscriptionTokenHash: randomUUID(),
      },
    });
    const revokedDevice = await prisma.device.create({
      data: {
        userId: user.id,
        subscriptionTokenHash: randomUUID(),
      },
    });
    const nodes = await Promise.all(
      (['HEALTHY', 'DRAINING', 'DISABLED', 'QUARANTINED'] as const).map(
        (status) =>
          prisma.node.create({
            data: {
              name: `reconcile-${status}-${suffix}`,
              provider: 'integration',
              locationLabel: 'integration',
              status,
            },
          }),
      ),
    );
    for (const node of nodes.slice(1, 3)) {
      await prisma.nodeAccessGrant.create({
        data: {
          nodeId: node.id,
          deviceId: device.id,
          status: 'ACTIVE',
          dataPlaneCredentialHash: randomUUID(),
          dataPlaneCredentialDerivationVersion: 1,
          expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        },
      });
    }
    const revokedGrant = await prisma.nodeAccessGrant.create({
      data: {
        nodeId: nodes[0]!.id,
        deviceId: revokedDevice.id,
        status: 'REVOKED',
        revokedAt: new Date(),
        dataPlaneCredentialHash: randomUUID(),
        dataPlaneCredentialDerivationVersion: 1,
        expiresAt,
      },
    });

    await expect(store.reconcileAccess(10)).resolves.toEqual({
      processed: 3,
      failed: 0,
    });
    await expect(store.reconcileAccess(10)).resolves.toEqual({
      processed: 0,
      failed: 0,
    });

    const reconciledGrants = await prisma.nodeAccessGrant.findMany({
      where: { deviceId: device.id },
      orderBy: { nodeId: 'asc' },
    });
    expect(reconciledGrants).toHaveLength(3);
    expect(reconciledGrants.map((grant) => grant.status).sort()).toEqual([
      'ACTIVE',
      'ACTIVE',
      'PENDING',
    ]);
    expect(
      reconciledGrants.every(
        (grant) => grant.expiresAt.getTime() === expiresAt.getTime(),
      ),
    ).toBe(true);
    await expect(
      prisma.nodeAccessGrant.findUniqueOrThrow({
        where: { id: revokedGrant.id },
      }),
    ).resolves.toMatchObject({ status: 'REVOKED' });
    await expect(
      prisma.nodeAccessGrant.count({ where: { nodeId: nodes[3]!.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.nodeSyncJob.count({
        where: { nodeId: { in: nodes.map((node) => node.id) } },
      }),
    ).resolves.toBe(3);
    await prisma.$transaction([
      prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: 'EXPIRED' },
      }),
      prisma.node.update({
        where: { id: nodes[0]!.id },
        data: { status: 'DISABLED' },
      }),
    ]);
  });

  it('revokes cancelled access on every serving lifecycle without reopening quarantine', async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { telegramUserId: `94${suffix.replaceAll('-', '').slice(0, 20)}` },
    });
    const plan = await prisma.plan.create({
      data: {
        code: `cancelled-${suffix}`,
        name: 'Cancelled integration',
        priceMinor: 20000,
        currency: 'RUB',
        deviceLimit: 1,
      },
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
              name: `cancelled-${index}-${suffix}`,
              provider: 'integration',
              locationLabel: 'integration',
              status,
            },
          }),
      ),
    );
    const grants = await Promise.all(
      nodes.map((node) =>
        prisma.nodeAccessGrant.create({
          data: {
            nodeId: node.id,
            deviceId: device.id,
            status: 'ACTIVE',
            dataPlaneCredentialHash: randomUUID(),
            dataPlaneCredentialDerivationVersion: 1,
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          },
        }),
      ),
    );
    const cancelledAt = new Date();
    await prisma.$transaction([
      prisma.nodeAccessGrant.update({
        where: { id: grants[3]!.id },
        data: { status: 'REVOKED', revokedAt: cancelledAt },
      }),
      prisma.node.update({
        where: { id: nodes[3]!.id },
        data: { status: 'QUARANTINED' },
      }),
      prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: 'CANCELLED', cancelledAt },
      }),
    ]);

    await expect(store.reconcileAccess(10)).resolves.toEqual({
      processed: 3,
      failed: 0,
    });
    await expect(store.reconcileAccess(10)).resolves.toEqual({
      processed: 0,
      failed: 0,
    });
    const persisted = await prisma.nodeAccessGrant.findMany({
      where: { id: { in: grants.map((grant) => grant.id) } },
    });
    expect(
      persisted.every(
        (grant) => grant.status === 'REVOKED' && grant.revokedAt !== null,
      ),
    ).toBe(true);
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
          action: 'node-access.reconciled',
          entityId: { in: nodes.slice(0, 3).map((node) => node.id) },
        },
      }),
    ).resolves.toBe(3);
    await prisma.node.update({
      where: { id: nodes[0]!.id },
      data: { status: 'DISABLED' },
    });
  });

  it('renews the existing grant identity and schedules its new deadline', async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { telegramUserId: `95${suffix.replaceAll('-', '').slice(0, 20)}` },
    });
    const plan = await prisma.plan.create({
      data: {
        code: `renewal-${suffix}`,
        name: 'Renewal integration',
        priceMinor: 20000,
        currency: 'RUB',
        deviceLimit: 1,
      },
    });
    const subscription = await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: 'ACTIVE',
        startsAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
    const device = await prisma.device.create({
      data: { userId: user.id, subscriptionTokenHash: randomUUID() },
    });
    const node = await prisma.node.create({
      data: {
        name: `renewal-${suffix}`,
        provider: 'integration',
        locationLabel: 'integration',
        status: 'HEALTHY',
      },
    });
    const grant = await prisma.nodeAccessGrant.create({
      data: {
        nodeId: node.id,
        deviceId: device.id,
        status: 'ACTIVE',
        dataPlaneCredentialHash: randomUUID(),
        dataPlaneCredentialDerivationVersion: 1,
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
    const renewedUntil = new Date('2099-01-01T00:00:00.000Z');
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { expiresAt: renewedUntil },
    });

    await expect(store.reconcileNodeBeforeHealthy(node.id)).resolves.toBe(true);
    await expect(
      prisma.nodeAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
    ).resolves.toMatchObject({
      id: grant.id,
      dataPlaneCredentialHash: grant.dataPlaneCredentialHash,
      status: 'ACTIVE',
      expiresAt: renewedUntil,
      desiredVersion: 1,
      appliedVersion: 0,
    });
    await expect(
      prisma.nodeAccessGrant.count({ where: { deviceId: device.id } }),
    ).resolves.toBe(1);
    await prisma.$transaction([
      prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: 'EXPIRED' },
      }),
      prisma.node.update({
        where: { id: node.id },
        data: { status: 'DISABLED' },
      }),
    ]);
  });

  it('creates a new monotonic delivery after the previous operation failed', async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { telegramUserId: `96${suffix.replaceAll('-', '').slice(0, 20)}` },
    });
    const plan = await prisma.plan.create({
      data: {
        code: `failed-delivery-${suffix}`,
        name: 'Failed delivery integration',
        priceMinor: 20000,
        currency: 'RUB',
        deviceLimit: 1,
      },
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
        name: `failed-delivery-${suffix}`,
        provider: 'integration',
        locationLabel: 'integration',
        status: 'HEALTHY',
        desiredConfigVersion: 1,
      },
    });
    const grant = await prisma.nodeAccessGrant.create({
      data: {
        nodeId: node.id,
        deviceId: device.id,
        status: 'PENDING',
        dataPlaneCredentialHash: randomUUID(),
        dataPlaneCredentialDerivationVersion: 1,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        desiredVersion: 1,
      },
    });
    const failedJob = await prisma.nodeSyncJob.create({
      data: {
        nodeId: node.id,
        nodeAccessGrantId: grant.id,
        targetVersion: 1,
        idempotencyKey: `failed-delivery:${suffix}`,
        status: 'FAILED',
        attempts: 5,
        lastErrorCode: 'DELIVERY_FAILED',
        completedAt: new Date(),
      },
    });

    await expect(store.reconcileNodeBeforeHealthy(node.id)).resolves.toBe(true);
    await expect(
      prisma.nodeAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
    ).resolves.toMatchObject({
      status: 'PENDING',
      desiredVersion: 2,
      appliedVersion: 0,
    });
    await expect(
      prisma.nodeSyncJob.findUniqueOrThrow({ where: { id: failedJob.id } }),
    ).resolves.toMatchObject({ status: 'FAILED', targetVersion: 1 });
    await expect(
      prisma.nodeSyncJob.count({ where: { nodeId: node.id } }),
    ).resolves.toBe(2);
    await expect(store.reconcileNodeBeforeHealthy(node.id)).resolves.toBe(
      false,
    );
    await prisma.$transaction([
      prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: 'EXPIRED' },
      }),
      prisma.node.update({
        where: { id: node.id },
        data: { status: 'DISABLED' },
      }),
    ]);
  });

  it('runs event-driven reconciliation before a disabled node returns to HEALTHY', async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { telegramUserId: `97${suffix.replaceAll('-', '').slice(0, 20)}` },
    });
    const plan = await prisma.plan.create({
      data: {
        code: `healthy-transition-${suffix}`,
        name: 'Healthy transition integration',
        priceMinor: 20000,
        currency: 'RUB',
        deviceLimit: 1,
      },
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
        name: `healthy-transition-${suffix}`,
        provider: 'integration',
        locationLabel: 'integration',
        status: 'DISABLED',
      },
    });

    await expect(
      prisma.nodeAccessGrant.count({
        where: { nodeId: node.id, deviceId: device.id },
      }),
    ).resolves.toBe(0);
    await expect(store.reconcileNodeBeforeHealthy(node.id)).resolves.toBe(true);
    await expect(
      prisma.nodeAccessGrant.findUniqueOrThrow({
        where: { nodeId_deviceId: { nodeId: node.id, deviceId: device.id } },
      }),
    ).resolves.toMatchObject({ status: 'PENDING', desiredVersion: 1 });
    await expect(
      prisma.nodeSyncJob.count({ where: { nodeId: node.id } }),
    ).resolves.toBe(1);
    await expect(
      prisma.node.update({
        where: { id: node.id },
        data: { status: 'HEALTHY' },
      }),
    ).rejects.toThrow(
      'Node cannot return to HEALTHY until pending access updates are reconciled',
    );
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: 'EXPIRED' },
    });
  });

  it('advances expiry batches past a persistent per-node failure', async () => {
    const suffix = randomUUID();
    const plan = await prisma.plan.create({
      data: {
        code: `expiry-fairness-${suffix}`,
        name: 'Expiry fairness integration',
        priceMinor: 20000,
        currency: 'RUB',
        deviceLimit: 1,
      },
    });
    const [firstUser, secondUser] = await Promise.all([
      prisma.user.create({
        data: {
          telegramUserId: `98${suffix.replaceAll('-', '').slice(0, 20)}`,
        },
      }),
      prisma.user.create({
        data: {
          telegramUserId: `99${suffix.replaceAll('-', '').slice(0, 20)}`,
        },
      }),
    ]);
    const expiresAt = new Date('2000-01-01T00:00:00.000Z');
    const [firstSubscription, secondSubscription] = await Promise.all([
      prisma.subscription.create({
        data: {
          id: '00000000-0000-4000-8000-0000000000e1',
          userId: firstUser.id,
          planId: plan.id,
          status: 'ACTIVE',
          startsAt: new Date('1999-01-01T00:00:00.000Z'),
          expiresAt,
        },
      }),
      prisma.subscription.create({
        data: {
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffe1',
          userId: secondUser.id,
          planId: plan.id,
          status: 'ACTIVE',
          startsAt: new Date('1999-01-01T00:00:00.000Z'),
          expiresAt,
        },
      }),
    ]);
    const [firstDevice, secondDevice] = await Promise.all([
      prisma.device.create({
        data: { userId: firstUser.id, subscriptionTokenHash: randomUUID() },
      }),
      prisma.device.create({
        data: { userId: secondUser.id, subscriptionTokenHash: randomUUID() },
      }),
    ]);
    const [failingNode, healthyNode] = await Promise.all([
      prisma.node.create({
        data: {
          name: `expiry-fairness-failing-${suffix}`,
          provider: 'integration',
          locationLabel: 'integration',
          status: 'HEALTHY',
          desiredConfigVersion: 2_147_483_647,
        },
      }),
      prisma.node.create({
        data: {
          name: `expiry-fairness-healthy-${suffix}`,
          provider: 'integration',
          locationLabel: 'integration',
          status: 'HEALTHY',
        },
      }),
    ]);
    await Promise.all([
      prisma.nodeAccessGrant.create({
        data: {
          nodeId: failingNode.id,
          deviceId: firstDevice.id,
          status: 'ACTIVE',
          dataPlaneCredentialHash: randomUUID(),
          dataPlaneCredentialDerivationVersion: 1,
          expiresAt,
        },
      }),
      prisma.nodeAccessGrant.create({
        data: {
          nodeId: healthyNode.id,
          deviceId: secondDevice.id,
          status: 'ACTIVE',
          dataPlaneCredentialHash: randomUUID(),
          dataPlaneCredentialDerivationVersion: 1,
          expiresAt,
        },
      }),
    ]);
    const fairStore = new PrismaSubscriptionAccessStore(prisma, 'p'.repeat(43));

    await expect(fairStore.materializeExpiredSubscriptions(1)).resolves.toEqual(
      {
        processed: 1,
        failed: 1,
      },
    );
    await expect(fairStore.materializeExpiredSubscriptions(1)).resolves.toEqual(
      {
        processed: 1,
        failed: 0,
      },
    );
    await expect(
      prisma.subscription.findUniqueOrThrow({
        where: { id: firstSubscription.id },
      }),
    ).resolves.toMatchObject({ status: 'EXPIRED' });
    await expect(
      prisma.subscription.findUniqueOrThrow({
        where: { id: secondSubscription.id },
      }),
    ).resolves.toMatchObject({ status: 'EXPIRED' });
    await expect(
      prisma.nodeSyncJob.count({ where: { nodeId: healthyNode.id } }),
    ).resolves.toBe(1);
    await prisma.node.updateMany({
      where: { id: { in: [failingNode.id, healthyNode.id] } },
      data: { status: 'DISABLED' },
    });
  });

  it('advances the bounded cursor past a persistent failure without starving later nodes', async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        telegramUserId: `93${suffix.replaceAll('-', '').slice(0, 20)}`,
      },
    });
    const plan = await prisma.plan.create({
      data: {
        code: `isolated-${suffix}`,
        name: 'Isolated failure integration',
        priceMinor: 20000,
        currency: 'RUB',
        deviceLimit: 1,
      },
    });
    await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: 'ACTIVE',
        startsAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    const device = await prisma.device.create({
      data: {
        userId: user.id,
        subscriptionTokenHash: randomUUID(),
      },
    });
    const [failingNode, healthyNode] = await Promise.all([
      prisma.node.create({
        data: {
          id: '00000000-0000-4000-8000-0000000000f1',
          name: `isolated-failing-${suffix}`,
          provider: 'integration',
          locationLabel: 'integration',
          status: 'HEALTHY',
          desiredConfigVersion: 2_147_483_647,
        },
      }),
      prisma.node.create({
        data: {
          id: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
          name: `isolated-healthy-${suffix}`,
          provider: 'integration',
          locationLabel: 'integration',
          status: 'HEALTHY',
        },
      }),
    ]);

    const fairStore = new PrismaSubscriptionAccessStore(prisma, 'p'.repeat(43));
    await expect(fairStore.reconcileAccess(1)).resolves.toEqual({
      processed: 0,
      failed: 1,
    });
    await expect(
      prisma.nodeAccessGrant.count({
        where: { nodeId: healthyNode.id, deviceId: device.id },
      }),
    ).resolves.toBe(0);
    let healthyGrantCreated = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await fairStore.reconcileAccess(1);
      healthyGrantCreated =
        (await prisma.nodeAccessGrant.count({
          where: { nodeId: healthyNode.id, deviceId: device.id },
        })) === 1;
      if (healthyGrantCreated) break;
    }
    expect(healthyGrantCreated).toBe(true);
    await expect(
      prisma.nodeAccessGrant.count({
        where: { nodeId: healthyNode.id, deviceId: device.id },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.nodeAccessGrant.count({
        where: { nodeId: failingNode.id, deviceId: device.id },
      }),
    ).resolves.toBe(0);
  });
});
