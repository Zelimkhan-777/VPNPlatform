import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { CabinetDeviceService } from './cabinet-device.service';

const tokenPepper = 'subscription-token-pepper-for-device-unit-tests';
const idempotencyKey = 'a77aab04-cfad-4d81-845e-ff90a6b7b651';
const environment = {
  SUBSCRIPTION_FEED_BASE_URL: 'https://sub.example.test',
  SUBSCRIPTION_TOKEN_PEPPER: tokenPepper,
};

describe('CabinetDeviceService', () => {
  it('creates a hashed device and audit event atomically when the plan has capacity', async () => {
    const deviceCreate = vi.fn().mockResolvedValue({
      id: 'c4d9f1fd-5b6f-4f13-a4a8-142a7da4dc26',
      displayName: 'Laptop',
      platform: 'windows',
      status: 'ACTIVE',
      createdAt: new Date('2026-08-12T12:00:00.000Z'),
    });
    const auditCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      $executeRaw: vi.fn(),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'subscription-id' }])
        .mockResolvedValueOnce([
          {
            id: 'subscription-id',
            status: 'ACTIVE',
            expiresAt: new Date('2026-09-12T12:00:00.000Z'),
            deviceLimit: 2,
          },
        ])
        .mockResolvedValueOnce([
          { id: 'node-a', status: 'HEALTHY' },
          { id: 'node-b', status: 'HEALTHY' },
        ])
        .mockResolvedValueOnce([{ now: new Date('2026-08-12T12:00:00.000Z') }]),
      device: {
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(1),
        create: deviceCreate,
      },
      auditEvent: { create: auditCreate },
    };
    const prisma = {
      $transaction: vi.fn((callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const hashToken = vi.fn().mockReturnValue('token-hash');
    const scheduleInTransaction = vi.fn().mockResolvedValue({});
    const service = new CabinetDeviceService(
      prisma as never,
      { hashToken } as never,
      environment as never,
      {} as never,
      { scheduleInTransaction } as never,
    );

    const result = await service.issue(
      'd26c7d3f-e0f5-4cd1-9a6d-d17f6b45c3db',
      idempotencyKey,
      { displayName: 'Laptop', platform: 'windows' },
    );

    expect(result).toMatchObject({
      id: 'c4d9f1fd-5b6f-4f13-a4a8-142a7da4dc26',
      status: 'ACTIVE',
      subscriptionUrl: expect.stringMatching(
        /^https:\/\/sub\.example\.test\/sub\/[A-Za-z0-9_-]{43}$/,
      ),
    });
    expect(hashToken).toHaveBeenCalledWith(expect.any(String), tokenPepper);
    expect(deviceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subscriptionTokenHash: 'token-hash' }),
      }),
    );
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'device.issued' }),
      }),
    );
    expect(scheduleInTransaction).toHaveBeenCalledTimes(2);
    expect(
      scheduleInTransaction.mock.calls.map((call) => call[1].nodeId),
    ).toEqual(['node-a', 'node-b']);
  });

  it('does not create a device once the active device limit is reached', async () => {
    const transaction = {
      $executeRaw: vi.fn(),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'subscription-id' }])
        .mockResolvedValueOnce([
          {
            id: 'subscription-id',
            status: 'ACTIVE',
            expiresAt: new Date('2026-09-12T12:00:00.000Z'),
            deviceLimit: 1,
          },
        ])
        .mockResolvedValueOnce([{ id: 'node-id', status: 'HEALTHY' }])
        .mockResolvedValueOnce([{ now: new Date('2026-08-12T12:00:00.000Z') }]),
      device: {
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(1),
        create: vi.fn(),
      },
      auditEvent: { create: vi.fn() },
    };
    const service = new CabinetDeviceService(
      {
        $transaction: vi.fn(
          (callback: (client: typeof transaction) => unknown) =>
            callback(transaction),
        ),
      } as never,
      { hashToken: vi.fn() } as never,
      environment as never,
      {} as never,
      { scheduleInTransaction: vi.fn() } as never,
    );

    await expect(
      service.issue('user-id', idempotencyKey, {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.device.create).not.toHaveBeenCalled();
  });

  it('rolls back issuance when no healthy node can receive the desired grant', async () => {
    const transaction = {
      $executeRaw: vi.fn(),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'subscription-id' }])
        .mockResolvedValueOnce([
          {
            id: 'subscription-id',
            status: 'ACTIVE',
            expiresAt: new Date('2026-09-12T12:00:00.000Z'),
            deviceLimit: 1,
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ now: new Date('2026-08-12T12:00:00.000Z') }]),
      device: {
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn(),
        create: vi.fn(),
      },
      auditEvent: { create: vi.fn() },
    };
    const service = new CabinetDeviceService(
      {
        $transaction: vi.fn(
          (callback: (client: typeof transaction) => unknown) =>
            callback(transaction),
        ),
      } as never,
      { hashToken: vi.fn() } as never,
      environment as never,
      {} as never,
      { scheduleInTransaction: vi.fn() } as never,
    );

    await expect(
      service.issue('user-id', idempotencyKey, {}),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(transaction.device.create).not.toHaveBeenCalled();
  });

  it('returns the original device and derived URL for a repeated issuance key', async () => {
    const existing = {
      id: 'c4d9f1fd-5b6f-4f13-a4a8-142a7da4dc26',
      userId: 'user-id',
      displayName: 'Laptop',
      platform: null,
      status: 'ACTIVE',
      createdAt: new Date('2026-08-12T12:00:00.000Z'),
    };
    const transaction = {
      $executeRaw: vi.fn(),
      device: { findUnique: vi.fn().mockResolvedValue(existing) },
    };
    const service = new CabinetDeviceService(
      {
        $transaction: vi.fn(
          (callback: (client: typeof transaction) => unknown) =>
            callback(transaction),
        ),
      } as never,
      { hashToken: vi.fn() } as never,
      environment as never,
      {} as never,
      { scheduleInTransaction: vi.fn() } as never,
    );

    const first = await service.issue('user-id', idempotencyKey, {
      displayName: 'Laptop',
    });
    const retry = await service.issue('user-id', idempotencyKey, {
      displayName: 'Laptop',
    });

    expect(retry).toEqual(first);
    expect(first.subscriptionUrl).toMatch(
      /^https:\/\/sub\.example\.test\/sub\/[A-Za-z0-9_-]{43}$/,
    );
  });

  it('revokes only through the orchestration ownership boundary', async () => {
    const revokeDeviceAccess = vi.fn().mockResolvedValue('revoked');
    const service = new CabinetDeviceService(
      {} as never,
      {} as never,
      environment as never,
      { revokeDeviceAccess } as never,
      {} as never,
    );

    await expect(
      service.revoke(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ),
    ).resolves.toBeUndefined();
    expect(revokeDeviceAccess).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
  });

  it('hides devices owned by another user behind not found', async () => {
    const service = new CabinetDeviceService(
      {} as never,
      {} as never,
      environment as never,
      { revokeDeviceAccess: vi.fn().mockResolvedValue('not-found') } as never,
      {} as never,
    );

    await expect(
      service.revoke(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
