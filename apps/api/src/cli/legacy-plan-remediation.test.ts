import { describe, expect, it, vi } from 'vitest';

import { remediateLegacyPlans } from './legacy-plan-remediation';

const reason =
  'Remove reviewed orphan integration plans before Stage B migration';

describe('legacy plan remediation', () => {
  it('deletes only the exact orphan set and records an audit for every plan', async () => {
    const transaction = {
      $executeRawUnsafe: vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(2),
      $queryRawUnsafe: vi.fn().mockResolvedValue([
        {
          id: '11111111-1111-4111-8111-111111111111',
          code: 'integration-a',
          name: 'Integration A',
          subscriptionCount: 0n,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          code: 'integration-b',
          name: 'Integration B',
          subscriptionCount: 0n,
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          code: 'local-two-node',
          name: 'Local two-node',
          subscriptionCount: 2n,
        },
      ]),
      auditEvent: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(transaction)),
    };

    await expect(
      remediateLegacyPlans(prisma as never, {
        keepPlanCode: 'local-two-node',
        deletePlanCodes: ['integration-a', 'integration-b'],
        reason,
      }),
    ).resolves.toBe(2);
    expect(transaction.auditEvent.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          action: 'legacy-plan-removed',
          entityId: '11111111-1111-4111-8111-111111111111',
        }),
      ]),
    });
  });

  it('refuses to delete a plan that has subscriptions', async () => {
    const transaction = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
      $queryRawUnsafe: vi.fn().mockResolvedValue([
        {
          id: '11111111-1111-4111-8111-111111111111',
          code: 'integration-a',
          name: 'Integration A',
          subscriptionCount: 1n,
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          code: 'local-two-node',
          name: 'Local two-node',
          subscriptionCount: 2n,
        },
      ]),
      auditEvent: { createMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(transaction)),
    };

    await expect(
      remediateLegacyPlans(prisma as never, {
        keepPlanCode: 'local-two-node',
        deletePlanCodes: ['integration-a'],
        reason,
      }),
    ).rejects.toThrow(/has subscriptions/);
    expect(transaction.auditEvent.createMany).not.toHaveBeenCalled();
  });

  it('refuses an inventory that differs from the reviewed exact set', async () => {
    const transaction = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
      $queryRawUnsafe: vi.fn().mockResolvedValue([
        {
          id: '33333333-3333-4333-8333-333333333333',
          code: 'local-two-node',
          name: 'Local two-node',
          subscriptionCount: 2n,
        },
        {
          id: '44444444-4444-4444-8444-444444444444',
          code: 'unexpected-plan',
          name: 'Unexpected',
          subscriptionCount: 0n,
        },
      ]),
      auditEvent: { createMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(transaction)),
    };

    await expect(
      remediateLegacyPlans(prisma as never, {
        keepPlanCode: 'local-two-node',
        deletePlanCodes: ['integration-a'],
        reason,
      }),
    ).rejects.toThrow(/exact reviewed plan set/);
    expect(transaction.auditEvent.createMany).not.toHaveBeenCalled();
  });
});
