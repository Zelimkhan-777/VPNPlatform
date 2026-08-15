import type { NodeAgentConfigurationSnapshot } from '@vpn-platform/contracts';
import { describe, expect, it, vi } from 'vitest';

import { NodeAgentRunner } from './agent';

const acknowledgement = {
  nodeSyncJobId: '22222222-2222-4222-8222-222222222222',
  targetVersion: 1,
  snapshotHash: 'a'.repeat(64),
};
const snapshot: NodeAgentConfigurationSnapshot = {
  desiredConfigVersion: 1,
  appliedConfigVersion: 0,
  pendingAcknowledgement: acknowledgement,
  grants: [],
  routes: [],
};

describe('NodeAgentRunner', () => {
  it('acknowledges only after the adapter applies the exact snapshot', async () => {
    const events: string[] = [];
    const controlPlane = {
      heartbeat: vi.fn(async () => {
        events.push('heartbeat');
      }),
      configuration: vi.fn(async () => {
        events.push('configuration');
        return snapshot;
      }),
      acknowledge: vi.fn(async () => {
        events.push('acknowledge');
      }),
    };
    const adapter = {
      apply: vi.fn(async () => {
        events.push('apply');
        return 'applied' as const;
      }),
    };

    await expect(
      new NodeAgentRunner(controlPlane, adapter).runCycle(),
    ).resolves.toBe('acknowledged');
    expect(events).toEqual([
      'heartbeat',
      'configuration',
      'apply',
      'acknowledge',
    ]);
    expect(adapter.apply).toHaveBeenCalledWith(snapshot);
    expect(controlPlane.acknowledge).toHaveBeenCalledWith(acknowledgement);
  });

  it('does not acknowledge a failed apply or apply without a command', async () => {
    const acknowledge = vi.fn(async () => undefined);
    const failingRunner = new NodeAgentRunner(
      {
        heartbeat: vi.fn(async () => undefined),
        configuration: vi.fn(async () => snapshot),
        acknowledge,
      },
      {
        apply: vi.fn(async () => {
          throw new Error('adapter failed');
        }),
      },
    );
    await expect(failingRunner.runCycle()).rejects.toThrow('adapter failed');
    expect(acknowledge).not.toHaveBeenCalled();

    const apply = vi.fn(async () => 'applied' as const);
    const idleRunner = new NodeAgentRunner(
      {
        heartbeat: vi.fn(async () => undefined),
        configuration: vi.fn(async () => ({
          ...snapshot,
          desiredConfigVersion: 0,
          appliedConfigVersion: 0,
          pendingAcknowledgement: null,
        })),
        acknowledge,
      },
      { apply },
    );
    await expect(idleRunner.runCycle()).resolves.toBe('synchronized');
    expect(apply).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
