import { randomUUID } from 'node:crypto';

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { NodeSyncProcessor, type NodeSyncStore } from './node-sync-processor';

const command = {
  nodeAccessGrantId: randomUUID(),
  nodeSyncJobId: randomUUID(),
  targetVersion: 3,
};

function store(overrides: Partial<NodeSyncStore> = {}) {
  return {
    reclaimExpiredLeases: vi.fn().mockResolvedValue(0),
    claim: vi.fn().mockResolvedValue({
      id: command.nodeSyncJobId,
      leaseToken: randomUUID(),
    }),
    complete: vi.fn().mockResolvedValue(true),
    retry: vi.fn().mockResolvedValue('retried'),
    ...overrides,
  };
}

describe('NodeSyncProcessor', () => {
  it('claims and completes one validated command', async () => {
    const nodeSyncStore = store();
    const processor = new NodeSyncProcessor(
      nodeSyncStore,
      'worker-a',
      pino({ enabled: false }),
    );

    await expect(
      processor.process({ name: 'node-sync.requested', data: command }),
    ).resolves.toBeUndefined();
    expect(nodeSyncStore.claim).toHaveBeenCalledWith(command, 'worker-a');
    expect(nodeSyncStore.complete).toHaveBeenCalledWith(
      command.nodeSyncJobId,
      'worker-a',
      expect.any(String),
    );
    expect(nodeSyncStore.retry).not.toHaveBeenCalled();
  });

  it('treats an already completed command as an idempotent success', async () => {
    const nodeSyncStore = store({
      claim: vi.fn().mockResolvedValue('already-completed'),
    });
    const processor = new NodeSyncProcessor(
      nodeSyncStore,
      'worker-a',
      pino({ enabled: false }),
    );

    await expect(
      processor.process({ name: 'node-sync.requested', data: command }),
    ).resolves.toBeUndefined();
    expect(nodeSyncStore.complete).not.toHaveBeenCalled();
  });

  it('retries a failed completion and lets BullMQ retry delivery', async () => {
    const nodeSyncStore = store({
      complete: vi.fn().mockRejectedValue(new Error('database unavailable')),
    });
    const processor = new NodeSyncProcessor(
      nodeSyncStore,
      'worker-a',
      pino({ enabled: false }),
    );

    await expect(
      processor.process({ name: 'node-sync.requested', data: command }),
    ).rejects.toThrow('database unavailable');
    expect(nodeSyncStore.retry).toHaveBeenCalledWith(
      command.nodeSyncJobId,
      'worker-a',
      expect.any(String),
      'NODE_SYNC_PROCESSING_FAILED',
    );
  });

  it('rejects malformed or unsupported work before database access', async () => {
    const nodeSyncStore = store();
    const processor = new NodeSyncProcessor(
      nodeSyncStore,
      'worker-a',
      pino({ enabled: false }),
    );

    await expect(
      processor.process({ name: 'other.topic', data: command }),
    ).rejects.toThrow('Unsupported node-sync job');
    await expect(
      processor.process({
        name: 'node-sync.requested',
        data: { ...command, secret: 'must-not-be-accepted' },
      }),
    ).rejects.toThrow('Invalid node-sync job payload');
    expect(nodeSyncStore.claim).not.toHaveBeenCalled();
  });
});
