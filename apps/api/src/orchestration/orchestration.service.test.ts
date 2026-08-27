import { describe, expect, it, vi } from 'vitest';

import { OrchestrationService } from './orchestration.service';

function createService(
  prisma: unknown,
  dependencies: {
    nodeAccessGrantScheduler?: unknown;
    nodeLifecycleManager?: unknown;
    deviceAccessRevoker?: unknown;
    nodeAccessReconciler?: unknown;
  } = {},
) {
  return new OrchestrationService(
    prisma as never,
    (dependencies.nodeAccessGrantScheduler ?? { schedule: vi.fn() }) as never,
    (dependencies.nodeLifecycleManager ?? {
      restoreHealthy: vi.fn(),
      disable: vi.fn(),
      quarantine: vi.fn(),
    }) as never,
    (dependencies.deviceAccessRevoker ?? { revoke: vi.fn() }) as never,
    (dependencies.nodeAccessReconciler ?? {
      reconcileBeforeHealthy: vi.fn(),
    }) as never,
  );
}

describe('OrchestrationService', () => {
  it('requires convergence instead of attempting a HEALTHY transition after a repair', async () => {
    const reconciler = {
      reconcileBeforeHealthy: vi.fn().mockResolvedValue(true),
    };
    const lifecycle = { restoreHealthy: vi.fn() };
    const service = createService(
      {},
      { nodeAccessReconciler: reconciler, nodeLifecycleManager: lifecycle },
    );

    await expect(service.restoreNodeToHealthy('node-1')).resolves.toEqual({
      nodeId: 'node-1',
      status: 'RECONCILIATION_REQUIRED',
    });
    expect(reconciler.reconcileBeforeHealthy).toHaveBeenCalledWith('node-1');
    expect(lifecycle.restoreHealthy).not.toHaveBeenCalled();
  });

  it('performs the lifecycle transition only after reconciliation is a no-op', async () => {
    const reconciler = {
      reconcileBeforeHealthy: vi.fn().mockResolvedValue(false),
    };
    const restored = { nodeId: 'node-1', status: 'HEALTHY' as const };
    const lifecycle = {
      restoreHealthy: vi.fn().mockResolvedValue(restored),
    };
    const service = createService(
      {},
      { nodeAccessReconciler: reconciler, nodeLifecycleManager: lifecycle },
    );

    await expect(
      service.restoreNodeToHealthy('node-1', 'operator-1'),
    ).resolves.toBe(restored);
    expect(reconciler.reconcileBeforeHealthy).toHaveBeenCalledWith('node-1');
    expect(lifecycle.restoreHealthy).toHaveBeenCalledWith(
      'node-1',
      'operator-1',
    );
  });

  it('delegates grant scheduling without changing the input or result', async () => {
    const input = {
      nodeId: 'node-1',
      deviceId: 'device-1',
      expiresAt: new Date('2026-08-26T00:00:00.000Z'),
      syncJobIdempotencyKey: 'sync-1',
      outboxEventIdempotencyKey: 'outbox-1',
      actorUserId: 'user-1',
    };
    const result = {
      nodeAccessGrantId: 'grant-1',
      nodeSyncJobId: 'job-1',
      outboxEventId: 'event-1',
      targetVersion: 3,
    };
    const scheduler = { schedule: vi.fn().mockResolvedValue(result) };
    const service = createService({}, { nodeAccessGrantScheduler: scheduler });

    await expect(service.scheduleNodeAccessGrant(input)).resolves.toBe(result);
    expect(scheduler.schedule).toHaveBeenCalledOnce();
    expect(scheduler.schedule).toHaveBeenCalledWith(input);
  });

  it('delegates node lifecycle and device revoke without changing arguments', async () => {
    const disabled = { nodeId: 'node-1', status: 'DISABLED' as const };
    const quarantined = {
      nodeId: 'node-1',
      nodeSyncJobId: 'job-1',
      outboxEventId: 'event-1',
      targetVersion: 4,
    };
    const quarantineInput = {
      nodeId: 'node-1',
      syncJobIdempotencyKey: 'sync-1',
      outboxEventIdempotencyKey: 'outbox-1',
      actorUserId: 'user-1',
    };
    const nodeLifecycleManager = {
      restoreHealthy: vi.fn(),
      disable: vi.fn().mockResolvedValue(disabled),
      quarantine: vi.fn().mockResolvedValue(quarantined),
    };
    const deviceAccessRevoker = {
      revoke: vi.fn().mockResolvedValue('revoked'),
    };
    const service = createService(
      {},
      { nodeLifecycleManager, deviceAccessRevoker },
    );

    await expect(service.disableNode('node-1', 'user-1')).resolves.toBe(
      disabled,
    );
    await expect(service.quarantineNode(quarantineInput)).resolves.toBe(
      quarantined,
    );
    await expect(
      service.revokeDeviceAccess('user-1', 'device-1'),
    ).resolves.toBe('revoked');
    expect(nodeLifecycleManager.disable).toHaveBeenCalledWith(
      'node-1',
      'user-1',
    );
    expect(nodeLifecycleManager.quarantine).toHaveBeenCalledWith(
      quarantineInput,
    );
    expect(deviceAccessRevoker.revoke).toHaveBeenCalledWith(
      'user-1',
      'device-1',
    );
  });
});
