import type { PrismaService } from '../database/prisma.service';
import { describe, expect, it, vi } from 'vitest';

import { CabinetService } from './cabinet.service';

describe('CabinetService', () => {
  it('prefers an active subscription and selects only safe device fields', async () => {
    const subscriptionFindMany = vi.fn().mockResolvedValue([
      {
        status: 'EXPIRED',
        startsAt: new Date('2026-07-01T00:00:00.000Z'),
        expiresAt: new Date('2026-08-01T00:00:00.000Z'),
        updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        plan: { name: 'Old plan', deviceLimit: 1 },
      },
      {
        status: 'ACTIVE',
        startsAt: new Date('2026-08-02T00:00:00.000Z'),
        expiresAt: new Date('2026-09-02T00:00:00.000Z'),
        updatedAt: new Date('2026-08-02T00:00:00.000Z'),
        plan: { name: 'Current plan', deviceLimit: 3 },
      },
    ]);
    const deviceFindMany = vi.fn().mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        displayName: 'My laptop',
        platform: 'windows',
        status: 'ACTIVE',
        createdAt: new Date('2026-08-02T00:00:00.000Z'),
      },
    ]);
    const service = new CabinetService({
      subscription: { findMany: subscriptionFindMany },
      device: { findMany: deviceFindMany },
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ now: new Date('2026-08-12T00:00:00.000Z') }]),
    } as unknown as PrismaService);

    await expect(
      service.overview('22222222-2222-4222-8222-222222222222'),
    ).resolves.toEqual({
      subscription: {
        status: 'ACTIVE',
        planName: 'Current plan',
        deviceLimit: 3,
        startsAt: '2026-08-02T00:00:00.000Z',
        expiresAt: '2026-09-02T00:00:00.000Z',
      },
      devices: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          displayName: 'My laptop',
          platform: 'windows',
          status: 'ACTIVE',
          createdAt: '2026-08-02T00:00:00.000Z',
        },
      ],
    });
    expect(deviceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: '22222222-2222-4222-8222-222222222222' },
        select: expect.not.objectContaining({ subscriptionTokenHash: true }),
      }),
    );
  });

  it('returns an empty overview for a user without subscriptions or devices', async () => {
    const service = new CabinetService({
      subscription: { findMany: vi.fn().mockResolvedValue([]) },
      device: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ now: new Date('2026-08-12T00:00:00.000Z') }]),
    } as unknown as PrismaService);

    await expect(
      service.overview('22222222-2222-4222-8222-222222222222'),
    ).resolves.toEqual({ subscription: null, devices: [] });
  });

  it('reports a stored ACTIVE subscription as effectively expired at the PostgreSQL boundary', async () => {
    const boundary = new Date('2026-08-26T12:00:00.000Z');
    const service = new CabinetService({
      subscription: {
        findMany: vi.fn().mockResolvedValue([
          {
            status: 'ACTIVE',
            startsAt: new Date('2026-08-01T00:00:00.000Z'),
            expiresAt: boundary,
            updatedAt: boundary,
            plan: { name: 'Expired plan', deviceLimit: 3 },
          },
        ]),
      },
      device: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([{ now: boundary }]),
    } as unknown as PrismaService);

    await expect(service.overview('user-id')).resolves.toMatchObject({
      subscription: { status: 'EXPIRED' },
    });
  });
});
