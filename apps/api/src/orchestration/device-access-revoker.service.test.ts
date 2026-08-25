import { describe, expect, it, vi } from 'vitest';

import { DeviceAccessRevoker } from './device-access-revoker.service';

describe('DeviceAccessRevoker', () => {
  it.each([
    ['HEALTHY', true],
    ['DRAINING', true],
    ['DISABLED', true],
    ['QUARANTINED', false],
    ['DELETED', false],
    ['PROVISIONING', false],
  ] as const)(
    'revokes access on %s with sync=%s',
    async (status, expectsSync) => {
      const now = new Date('2026-08-26T00:00:00.000Z');
      const transaction = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'device-1', status: 'ACTIVE' }])
          .mockResolvedValueOnce([{ id: 'node-1', status }])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ now }]),
        device: { update: vi.fn().mockResolvedValue({ id: 'device-1' }) },
        node: {
          update: vi.fn().mockResolvedValue({ desiredConfigVersion: 4 }),
        },
        nodeAccessGrant: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: 'grant-1', nodeId: 'node-1' }]),
          update: vi.fn().mockResolvedValue({ id: 'grant-1' }),
        },
        nodeSyncJob: {
          create: vi.fn().mockResolvedValue({ id: 'job-1' }),
        },
        outboxEvent: {
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
      const revoker = new DeviceAccessRevoker(prisma as never);

      await expect(revoker.revoke('user-1', 'device-1')).resolves.toBe(
        'revoked',
      );
      expect(transaction.device.update).toHaveBeenCalledWith({
        where: { id: 'device-1' },
        data: { status: 'REVOKED', revokedAt: now },
      });

      if (expectsSync) {
        expect(transaction.node.update).toHaveBeenCalledWith({
          where: { id: 'node-1' },
          data: { desiredConfigVersion: { increment: 1 } },
          select: { desiredConfigVersion: true },
        });
        expect(transaction.nodeAccessGrant.update).toHaveBeenCalledWith({
          where: { id: 'grant-1' },
          data: {
            status: 'REVOKED',
            revokedAt: now,
            desiredVersion: 4,
          },
        });
        expect(transaction.nodeSyncJob.create).toHaveBeenCalledOnce();
        expect(transaction.outboxEvent.create).toHaveBeenCalledOnce();
      } else {
        expect(transaction.node.update).not.toHaveBeenCalled();
        expect(transaction.nodeAccessGrant.update).toHaveBeenCalledWith({
          where: { id: 'grant-1' },
          data: { status: 'REVOKED', revokedAt: now },
        });
        expect(transaction.nodeSyncJob.create).not.toHaveBeenCalled();
        expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
      }
      expect(transaction.auditEvent.create).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    [[], 'not-found'],
    [[{ id: 'device-1', status: 'REVOKED' }], 'already-revoked'],
  ] as const)(
    'returns %s device as %s without writes',
    async (devices, result) => {
      const transaction = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        $queryRaw: vi.fn().mockResolvedValue(devices),
        device: { update: vi.fn() },
        node: { update: vi.fn() },
        nodeAccessGrant: { findMany: vi.fn(), update: vi.fn() },
        nodeSyncJob: { create: vi.fn() },
        outboxEvent: { create: vi.fn() },
        auditEvent: { create: vi.fn() },
      };
      const prisma = {
        $transaction: vi.fn(
          async (callback: (client: typeof transaction) => unknown) =>
            callback(transaction),
        ),
      };
      const revoker = new DeviceAccessRevoker(prisma as never);

      await expect(revoker.revoke('user-1', 'device-1')).resolves.toBe(result);
      expect(transaction.device.update).not.toHaveBeenCalled();
      expect(transaction.node.update).not.toHaveBeenCalled();
      expect(transaction.nodeAccessGrant.findMany).not.toHaveBeenCalled();
      expect(transaction.auditEvent.create).not.toHaveBeenCalled();
    },
  );
});
