import { describe, expect, it, vi } from 'vitest';

import {
  assertNoLegacyAdmins,
  countLegacyAdmins,
  demoteLegacyAdmins,
} from './legacy-admin';

describe('legacy ADMIN commands', () => {
  it('fails the read-only preflight when legacy rows remain', async () => {
    const database = {
      $queryRawUnsafe: vi.fn((query: string) =>
        query.includes('to_regclass')
          ? Promise.resolve([{ exists: true }])
          : Promise.resolve([{ count: 2n }]),
      ),
    };

    await expect(countLegacyAdmins(database as never)).resolves.toBe(2);
    await expect(assertNoLegacyAdmins(database as never)).rejects.toThrow(
      /2 row\(s\)/,
    );
  });

  it('allows an initial deploy before the User table exists', async () => {
    const database = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ exists: false }]),
    };

    await expect(
      assertNoLegacyAdmins(database as never),
    ).resolves.toBeUndefined();
    expect(database.$queryRawUnsafe).toHaveBeenCalledOnce();
  });

  it('demotes under a transaction and records one audit per user', async () => {
    const transaction = {
      $queryRawUnsafe: vi
        .fn()
        .mockResolvedValue([
          { id: '11111111-1111-4111-8111-111111111111' },
          { id: '22222222-2222-4222-8222-222222222222' },
        ]),
      $executeRawUnsafe: vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2),
      auditEvent: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(transaction)),
    };

    await expect(
      demoteLegacyAdmins(
        prisma as never,
        'Remove obsolete broad access before Stage B migration',
      ),
    ).resolves.toBe(2);
    expect(transaction.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(transaction.auditEvent.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          action: 'legacy-admin-demoted',
          entityId: '11111111-1111-4111-8111-111111111111',
        }),
      ]),
    });
  });

  it('rejects an unauditable reason before opening a transaction', async () => {
    const prisma = { $transaction: vi.fn() };
    await expect(demoteLegacyAdmins(prisma as never, 'short')).rejects.toThrow(
      /Reason/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
