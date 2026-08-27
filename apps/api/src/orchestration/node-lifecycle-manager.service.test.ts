import { describe, expect, it, vi } from 'vitest';

import { NodeLifecycleManager } from './node-lifecycle-manager.service';

function transactionPrisma(transaction: unknown) {
  return {
    $transaction: vi.fn(
      async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
    ),
  };
}

describe('NodeLifecycleManager', () => {
  it.each(['DRAINING', 'DISABLED'])(
    'restores %s to HEALTHY with one status update and audit',
    async (status) => {
      const transaction = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'node-1', status }]),
        node: { update: vi.fn().mockResolvedValue({ id: 'node-1' }) },
        auditEvent: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
      };
      const manager = new NodeLifecycleManager(
        transactionPrisma(transaction) as never,
      );

      await expect(manager.restoreHealthy('node-1', 'user-1')).resolves.toEqual(
        { nodeId: 'node-1', status: 'HEALTHY' },
      );
      expect(transaction.node.update).toHaveBeenCalledWith({
        where: { id: 'node-1' },
        data: { status: 'HEALTHY' },
      });
      expect(transaction.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: 'user-1',
          action: 'node.healthy',
          entityType: 'Node',
          entityId: 'node-1',
          metadata: { previousStatus: status },
        },
      });
    },
  );

  it('keeps repeated HEALTHY restore idempotent without another write', async () => {
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ id: 'node-1', status: 'HEALTHY' }]),
      node: { update: vi.fn() },
      auditEvent: { create: vi.fn() },
    };
    const manager = new NodeLifecycleManager(
      transactionPrisma(transaction) as never,
    );

    await expect(manager.restoreHealthy('node-1')).resolves.toEqual({
      nodeId: 'node-1',
      status: 'HEALTHY',
    });
    expect(transaction.node.update).not.toHaveBeenCalled();
    expect(transaction.auditEvent.create).not.toHaveBeenCalled();
  });

  it.each(['QUARANTINED', 'DELETED', 'PROVISIONING'])(
    'rejects HEALTHY restore from %s',
    async (status) => {
      const transaction = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'node-1', status }]),
        node: { update: vi.fn() },
        auditEvent: { create: vi.fn() },
      };
      const manager = new NodeLifecycleManager(
        transactionPrisma(transaction) as never,
      );

      await expect(manager.restoreHealthy('node-1')).rejects.toThrow(
        'Node cannot be restored to HEALTHY',
      );
      expect(transaction.node.update).not.toHaveBeenCalled();
      expect(transaction.auditEvent.create).not.toHaveBeenCalled();
    },
  );

  it.each(['HEALTHY', 'DRAINING'])(
    'disables %s with one status update and audit',
    async (status) => {
      const transaction = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'node-1', status }]),
        node: { update: vi.fn().mockResolvedValue({ id: 'node-1' }) },
        auditEvent: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
      };
      const manager = new NodeLifecycleManager(
        transactionPrisma(transaction) as never,
      );

      await expect(manager.disable('node-1', 'user-1')).resolves.toEqual({
        nodeId: 'node-1',
        status: 'DISABLED',
      });
      expect(transaction.node.update).toHaveBeenCalledWith({
        where: { id: 'node-1' },
        data: { status: 'DISABLED' },
      });
      expect(transaction.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: 'user-1',
          action: 'node.disabled',
          entityType: 'Node',
          entityId: 'node-1',
          metadata: { previousStatus: status },
        },
      });
    },
  );

  it('keeps repeated disable idempotent without another write', async () => {
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ id: 'node-1', status: 'DISABLED' }]),
      node: { update: vi.fn() },
      auditEvent: { create: vi.fn() },
    };
    const manager = new NodeLifecycleManager(
      transactionPrisma(transaction) as never,
    );

    await expect(manager.disable('node-1')).resolves.toEqual({
      nodeId: 'node-1',
      status: 'DISABLED',
    });
    expect(transaction.node.update).not.toHaveBeenCalled();
    expect(transaction.auditEvent.create).not.toHaveBeenCalled();
  });

  it.each(['QUARANTINED', 'DELETED', 'PROVISIONING'])(
    'rejects disable from %s',
    async (status) => {
      const transaction = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'node-1', status }]),
        node: { update: vi.fn() },
        auditEvent: { create: vi.fn() },
      };
      const manager = new NodeLifecycleManager(
        transactionPrisma(transaction) as never,
      );

      await expect(manager.disable('node-1')).rejects.toThrow(
        'Node cannot be disabled',
      );
      expect(transaction.node.update).not.toHaveBeenCalled();
      expect(transaction.auditEvent.create).not.toHaveBeenCalled();
    },
  );

  it.each(['HEALTHY', 'DRAINING', 'DISABLED'])(
    'quarantines %s without a sync job when no live grants remain',
    async (status) => {
      const transaction = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([
            { id: 'node-1', status, desiredConfigVersion: 3 },
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { now: new Date('2026-08-26T00:00:00.000Z') },
          ]),
        node: {
          findUnique: vi.fn(),
          update: vi.fn().mockResolvedValue({ desiredConfigVersion: 4 }),
        },
        nodeAccessGrant: { findMany: vi.fn().mockResolvedValue([]) },
        nodeSyncJob: { findUnique: vi.fn().mockResolvedValue(null) },
        outboxEvent: { findUnique: vi.fn().mockResolvedValue(null) },
        auditEvent: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
      };
      const manager = new NodeLifecycleManager(
        transactionPrisma(transaction) as never,
      );
      const input = {
        nodeId: 'node-1',
        syncJobIdempotencyKey: 'sync-1',
        outboxEventIdempotencyKey: 'outbox-1',
      };

      await expect(manager.quarantine(input)).resolves.toEqual({
        nodeId: 'node-1',
        nodeSyncJobId: null,
        outboxEventId: null,
        targetVersion: 3,
      });
      expect(transaction.node.update).toHaveBeenCalledOnce();
      expect(transaction.node.update).toHaveBeenCalledWith({
        where: { id: 'node-1' },
        data: { status: 'QUARANTINED' },
      });
      expect(transaction.auditEvent.create).toHaveBeenCalledWith({
        data: {
          action: 'node.quarantined',
          entityType: 'Node',
          entityId: 'node-1',
          metadata: {
            nodeSyncJobId: null,
            targetVersion: 3,
            revokedGrantCount: 0,
          },
        },
      });
    },
  );

  it('keeps repeated quarantine idempotent without another write', async () => {
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: 'node-1',
          status: 'QUARANTINED',
          desiredConfigVersion: 3,
        },
      ]),
      node: { findUnique: vi.fn(), update: vi.fn() },
      nodeAccessGrant: { findMany: vi.fn() },
      nodeSyncJob: { findUnique: vi.fn().mockResolvedValue(null) },
      outboxEvent: { findUnique: vi.fn().mockResolvedValue(null) },
      auditEvent: { create: vi.fn() },
    };
    const manager = new NodeLifecycleManager(
      transactionPrisma(transaction) as never,
    );

    await expect(
      manager.quarantine({
        nodeId: 'node-1',
        syncJobIdempotencyKey: 'sync-1',
        outboxEventIdempotencyKey: 'outbox-1',
      }),
    ).resolves.toEqual({
      nodeId: 'node-1',
      nodeSyncJobId: null,
      outboxEventId: null,
      targetVersion: 3,
    });
    expect(transaction.node.update).not.toHaveBeenCalled();
    expect(transaction.nodeAccessGrant.findMany).not.toHaveBeenCalled();
    expect(transaction.auditEvent.create).not.toHaveBeenCalled();
  });

  it.each(['DELETED', 'PROVISIONING'])(
    'rejects quarantine from %s',
    async (status) => {
      const transaction = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        $queryRaw: vi
          .fn()
          .mockResolvedValue([
            { id: 'node-1', status, desiredConfigVersion: 3 },
          ]),
        node: { findUnique: vi.fn(), update: vi.fn() },
        nodeAccessGrant: { findMany: vi.fn() },
        nodeSyncJob: { findUnique: vi.fn().mockResolvedValue(null) },
        outboxEvent: { findUnique: vi.fn().mockResolvedValue(null) },
        auditEvent: { create: vi.fn() },
      };
      const manager = new NodeLifecycleManager(
        transactionPrisma(transaction) as never,
      );

      await expect(
        manager.quarantine({
          nodeId: 'node-1',
          syncJobIdempotencyKey: 'sync-1',
          outboxEventIdempotencyKey: 'outbox-1',
        }),
      ).rejects.toThrow('Node cannot be quarantined');
      expect(transaction.node.update).not.toHaveBeenCalled();
      expect(transaction.nodeAccessGrant.findMany).not.toHaveBeenCalled();
      expect(transaction.auditEvent.create).not.toHaveBeenCalled();
    },
  );
});
