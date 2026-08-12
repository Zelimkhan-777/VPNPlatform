import { ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { CabinetDeviceService } from './cabinet-device.service';

const tokenPepper = 'subscription-token-pepper-for-device-unit-tests';
const environment = {
  CABINET_ORIGIN: 'https://app.example.test',
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
      subscription: {
        findFirst: vi.fn().mockResolvedValue({ plan: { deviceLimit: 2 } }),
      },
      device: { count: vi.fn().mockResolvedValue(1), create: deviceCreate },
      auditEvent: { create: auditCreate },
    };
    const prisma = {
      $transaction: vi.fn((callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const hashToken = vi.fn().mockReturnValue('token-hash');
    const service = new CabinetDeviceService(
      prisma as never,
      { hashToken } as never,
      environment as never,
    );

    const result = await service.issue(
      'd26c7d3f-e0f5-4cd1-9a6d-d17f6b45c3db',
      'https://app.example.test',
      { displayName: 'Laptop', platform: 'windows' },
      new Date('2026-08-12T12:00:00.000Z'),
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
  });

  it('rejects an untrusted origin before starting a database transaction', async () => {
    const prisma = { $transaction: vi.fn() };
    const service = new CabinetDeviceService(
      prisma as never,
      { hashToken: vi.fn() } as never,
      environment as never,
    );

    await expect(
      service.issue('user-id', 'https://attacker.example.test', {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not create a device once the active device limit is reached', async () => {
    const transaction = {
      $executeRaw: vi.fn(),
      subscription: {
        findFirst: vi.fn().mockResolvedValue({ plan: { deviceLimit: 1 } }),
      },
      device: { count: vi.fn().mockResolvedValue(1), create: vi.fn() },
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
    );

    await expect(
      service.issue('user-id', 'https://app.example.test', {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.device.create).not.toHaveBeenCalled();
  });
});
