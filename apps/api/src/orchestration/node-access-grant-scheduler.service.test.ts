import { describe, expect, it, vi } from 'vitest';

import { NodeAccessGrantScheduler } from './node-access-grant-scheduler.service';

describe('NodeAccessGrantScheduler', () => {
  it('keeps grant, job, outbox, and audit writes in one transaction', async () => {
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'device-1' }])
        .mockResolvedValueOnce([{ id: 'node-1', status: 'HEALTHY' }]),
      node: {
        update: vi.fn().mockResolvedValue({ desiredConfigVersion: 4 }),
      },
      nodeAccessGrant: {
        create: vi.fn(async (args: { data: { id: string } }) => ({
          id: args.data.id,
        })),
      },
      nodeSyncJob: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'job-1' }),
      },
      outboxEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'event-1' }),
      },
      auditEvent: {
        create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };
    const prisma = {
      $transaction: vi.fn(
        async (callback: (client: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    const credentials = {
      derive: vi.fn().mockReturnValue('derived-credential'),
      hash: vi.fn().mockReturnValue('credential-hash'),
    };
    const scheduler = new NodeAccessGrantScheduler(
      prisma as never,
      credentials as never,
    );
    const expiresAt = new Date('2026-08-26T00:00:00.000Z');

    const result = await scheduler.schedule({
      nodeId: 'node-1',
      deviceId: 'device-1',
      expiresAt,
      syncJobIdempotencyKey: 'sync-1',
      outboxEventIdempotencyKey: 'outbox-1',
      actorUserId: 'user-1',
    });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(transaction.$executeRaw).toHaveBeenCalledTimes(2);
    expect(transaction.$executeRaw.mock.calls.map((call) => call[1])).toEqual([
      'node-sync-job:sync-1',
      'outbox-event:outbox-1',
    ]);
    expect(transaction.node.update).toHaveBeenCalledWith({
      where: { id: 'node-1' },
      data: { desiredConfigVersion: { increment: 1 } },
      select: { desiredConfigVersion: true },
    });
    const grantId = result.nodeAccessGrantId;
    expect(credentials.derive).toHaveBeenCalledWith({
      grantId,
      deviceId: 'device-1',
      nodeId: 'node-1',
    });
    expect(credentials.hash).toHaveBeenCalledWith('derived-credential');
    expect(transaction.nodeAccessGrant.create).toHaveBeenCalledWith({
      data: {
        id: grantId,
        nodeId: 'node-1',
        deviceId: 'device-1',
        dataPlaneCredentialHash: 'credential-hash',
        dataPlaneCredentialDerivationVersion: 1,
        expiresAt,
        desiredVersion: 4,
      },
    });
    expect(transaction.nodeSyncJob.create).toHaveBeenCalledWith({
      data: {
        nodeId: 'node-1',
        nodeAccessGrantId: grantId,
        targetVersion: 4,
        idempotencyKey: 'sync-1',
      },
    });
    expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        topic: 'node-sync.requested',
        aggregateType: 'NodeAccessGrant',
        aggregateId: grantId,
        payload: {
          nodeAccessGrantId: grantId,
          nodeSyncJobId: 'job-1',
          targetVersion: 4,
        },
        idempotencyKey: 'outbox-1',
      },
    });
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: {
        actorUserId: 'user-1',
        action: 'node-access-grant.scheduled',
        entityType: 'NodeAccessGrant',
        entityId: grantId,
        metadata: {
          nodeId: 'node-1',
          nodeSyncJobId: 'job-1',
          targetVersion: 4,
        },
      },
    });
    expect(result).toEqual({
      nodeAccessGrantId: grantId,
      nodeSyncJobId: 'job-1',
      outboxEventId: 'event-1',
      targetVersion: 4,
    });
  });

  it('returns the existing operation without deriving or writing again', async () => {
    const existingSyncJob = {
      id: 'job-1',
      nodeId: 'node-1',
      nodeAccessGrantId: 'grant-1',
      targetVersion: 4,
      nodeAccessGrant: { deviceId: 'device-1' },
    };
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      $queryRaw: vi.fn(),
      node: { update: vi.fn() },
      nodeAccessGrant: { create: vi.fn() },
      nodeSyncJob: {
        findUnique: vi.fn().mockResolvedValue(existingSyncJob),
        create: vi.fn(),
      },
      outboxEvent: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'event-1',
          aggregateId: 'grant-1',
        }),
        create: vi.fn(),
      },
      auditEvent: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(
        async (callback: (client: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    const credentials = { derive: vi.fn(), hash: vi.fn() };
    const scheduler = new NodeAccessGrantScheduler(
      prisma as never,
      credentials as never,
    );

    await expect(
      scheduler.schedule({
        nodeId: 'node-1',
        deviceId: 'device-1',
        expiresAt: new Date('2026-08-26T00:00:00.000Z'),
        syncJobIdempotencyKey: 'sync-1',
        outboxEventIdempotencyKey: 'outbox-1',
      }),
    ).resolves.toEqual({
      nodeAccessGrantId: 'grant-1',
      nodeSyncJobId: 'job-1',
      outboxEventId: 'event-1',
      targetVersion: 4,
    });
    expect(transaction.$queryRaw).not.toHaveBeenCalled();
    expect(transaction.node.update).not.toHaveBeenCalled();
    expect(transaction.nodeAccessGrant.create).not.toHaveBeenCalled();
    expect(transaction.nodeSyncJob.create).not.toHaveBeenCalled();
    expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
    expect(transaction.auditEvent.create).not.toHaveBeenCalled();
    expect(credentials.derive).not.toHaveBeenCalled();
    expect(credentials.hash).not.toHaveBeenCalled();
  });
});
