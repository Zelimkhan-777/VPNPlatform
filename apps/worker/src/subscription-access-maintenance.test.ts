import { describe, expect, it, vi } from 'vitest';

import {
  runSubscriptionAccessMaintenance,
  SubscriptionAccessMaintenance,
} from './subscription-access-maintenance';

describe('SubscriptionAccessMaintenance', () => {
  it('materializes expiry before rebuilding desired access and logs safe counters', async () => {
    const order: string[] = [];
    const store = {
      materializeExpiredSubscriptions: vi.fn(async (limit: number) => {
        order.push(`expiry:${limit}`);
        return { processed: 2, failed: 0 };
      }),
      reconcileAccess: vi.fn(async (limit: number) => {
        order.push(`reconcile:${limit}`);
        return { processed: 3, failed: 1 };
      }),
    };
    const info = vi.fn();
    const maintenance = new SubscriptionAccessMaintenance(store, 100, {
      info,
    } as never);

    await expect(maintenance.runOnce()).resolves.toEqual({
      expiredSubscriptions: 2,
      reconciliationRepairs: 3,
      failures: 1,
    });
    expect(order).toEqual(['expiry:100', 'reconcile:100']);
    expect(info).toHaveBeenCalledWith(
      {
        component: 'subscription-access-maintenance',
        expiredSubscriptions: 2,
        reconciliationRepairs: 3,
        failures: 1,
      },
      'Subscription access maintenance batch completed',
    );
  });

  it('does not emit a log record for an idempotent no-op scan', async () => {
    const info = vi.fn();
    const maintenance = new SubscriptionAccessMaintenance(
      {
        materializeExpiredSubscriptions: vi
          .fn()
          .mockResolvedValue({ processed: 0, failed: 0 }),
        reconcileAccess: vi.fn().mockResolvedValue({ processed: 0, failed: 0 }),
      },
      10,
      { info } as never,
    );

    await expect(maintenance.runOnce()).resolves.toEqual({
      expiredSubscriptions: 0,
      reconciliationRepairs: 0,
      failures: 0,
    });
    expect(info).not.toHaveBeenCalled();
  });

  it('runs immediately and resolves cleanly when shutdown aborts the wait', async () => {
    const abortController = new AbortController();
    const maintenance = { runOnce: vi.fn().mockResolvedValue(undefined) };
    const loop = runSubscriptionAccessMaintenance(
      maintenance as never,
      60_000,
      abortController.signal,
    );

    await vi.waitFor(() => expect(maintenance.runOnce).toHaveBeenCalledOnce());
    abortController.abort();

    await expect(loop).resolves.toBeUndefined();
    expect(maintenance.runOnce).toHaveBeenCalledOnce();
  });

  it('does not start maintenance after shutdown was already requested', async () => {
    const abortController = new AbortController();
    const maintenance = { runOnce: vi.fn() };
    abortController.abort();

    await expect(
      runSubscriptionAccessMaintenance(
        maintenance as never,
        60_000,
        abortController.signal,
      ),
    ).resolves.toBeUndefined();
    expect(maintenance.runOnce).not.toHaveBeenCalled();
  });
});
