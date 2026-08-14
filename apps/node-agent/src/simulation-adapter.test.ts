import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { NodeAgentConfigurationSnapshot } from '@vpn-platform/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeAgentRunner } from './agent';
import {
  StateFileSimulationAdapter,
  type StateFileOperations,
} from './simulation-adapter';

const realFiles: StateFileOperations = {
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  read: (path) => readFile(path, 'utf8'),
  openFile: (path, flags, mode) => open(path, flags, mode),
  rename,
  async remove(path) {
    await rm(path, { force: true });
  },
};

function snapshot(
  version: number,
  jobId: string,
): NodeAgentConfigurationSnapshot {
  return {
    desiredConfigVersion: version,
    appliedConfigVersion: Math.max(0, version - 1),
    pendingAcknowledgement: { nodeSyncJobId: jobId, targetVersion: version },
    grants: [],
  };
}

describe('StateFileSimulationAdapter', () => {
  const directories: string[] = [];

  async function stateFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'vpn-node-agent-'));
    directories.push(directory);
    return join(directory, 'state.json');
  }

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('atomically stores the new current and exactly the last confirmed previous state', async () => {
    const statePath = await stateFile();
    const adapter = new StateFileSimulationAdapter(statePath);
    const first = snapshot(1, '11111111-1111-4111-8111-111111111111');
    const second = snapshot(2, '22222222-2222-4222-8222-222222222222');
    const third = snapshot(3, '33333333-3333-4333-8333-333333333333');

    await adapter.apply(first);
    await adapter.apply(second);
    await adapter.apply(third);

    const persisted = JSON.parse(await readFile(statePath, 'utf8'));
    expect(persisted).toMatchObject({
      current: { version: 3, snapshot: third },
      previous: { version: 2, snapshot: second },
    });
    expect(await readdir(dirname(statePath))).toEqual(['state.json']);
    await expect(adapter.apply(first)).rejects.toThrow('version downgrade');
  });

  it('removes the deterministic temporary file when rename fails and preserves both old states', async () => {
    const statePath = await stateFile();
    const adapter = new StateFileSimulationAdapter(statePath);
    const first = snapshot(1, '11111111-1111-4111-8111-111111111111');
    const second = snapshot(2, '22222222-2222-4222-8222-222222222222');
    await adapter.apply(first);
    const before = await readFile(statePath, 'utf8');
    const renameFailure = new Error('injected rename failure');
    const failing = new StateFileSimulationAdapter(statePath, {
      ...realFiles,
      rename: () => Promise.reject(renameFailure),
    });

    await expect(failing.apply(second)).rejects.toBe(renameFailure);
    await expect(failing.apply(second)).rejects.toBe(renameFailure);
    expect(await readFile(statePath, 'utf8')).toBe(before);
    expect(await readdir(dirname(statePath))).toEqual(['state.json']);
  });

  it('keeps the prior envelope when durable preparation fails before rename', async () => {
    const statePath = await stateFile();
    const adapter = new StateFileSimulationAdapter(statePath);
    await adapter.apply(snapshot(1, '11111111-1111-4111-8111-111111111111'));
    const before = await readFile(statePath, 'utf8');
    const failing = new StateFileSimulationAdapter(statePath, {
      ...realFiles,
      async openFile(path, flags, mode) {
        const handle = await realFiles.openFile(path, flags, mode);
        if (path.endsWith('.tmp')) {
          return Object.assign(handle, {
            sync: () => Promise.reject(new Error('injected fsync failure')),
          });
        }
        return handle;
      },
    });

    await expect(
      failing.apply(snapshot(2, '22222222-2222-4222-8222-222222222222')),
    ).rejects.toThrow('injected fsync failure');
    expect(await readFile(statePath, 'utf8')).toBe(before);
    expect(await readdir(dirname(statePath))).toEqual(['state.json']);
  });

  it('repeats the durability barrier before acknowledging a state left by a failed directory fsync', async () => {
    const statePath = await stateFile();
    const next = snapshot(1, '11111111-1111-4111-8111-111111111111');
    let allowDirectorySync = false;
    let repeatedStateFileSyncs = 0;
    const interrupted = new StateFileSimulationAdapter(statePath, {
      ...realFiles,
      async openFile(path, flags, mode) {
        const handle = await realFiles.openFile(path, flags, mode);
        if (path === statePath) {
          const sync = handle.sync.bind(handle);
          return Object.assign(handle, {
            async sync() {
              repeatedStateFileSyncs += 1;
              await sync();
            },
          });
        }
        if (path === dirname(statePath)) {
          const sync = handle.sync.bind(handle);
          return Object.assign(handle, {
            async sync() {
              if (!allowDirectorySync) {
                throw new Error('injected directory fsync failure');
              }
              await sync();
            },
          });
        }
        return handle;
      },
    });
    const acknowledge = vi.fn(async () => undefined);
    const runner = new NodeAgentRunner(
      {
        heartbeat: vi.fn(async () => undefined),
        configuration: vi.fn(async () => next),
        acknowledge,
      },
      interrupted,
    );

    await expect(runner.runCycle()).rejects.toThrow(
      'injected directory fsync failure',
    );
    expect(acknowledge).not.toHaveBeenCalled();
    expect(repeatedStateFileSyncs).toBe(0);

    allowDirectorySync = true;
    await expect(runner.runCycle()).resolves.toBe('acknowledged');
    expect(repeatedStateFileSyncs).toBe(1);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith(next.pendingAcknowledgement);
    await expect(
      new StateFileSimulationAdapter(statePath).apply({
        ...next,
        pendingAcknowledgement: {
          nodeSyncJobId: '44444444-4444-4444-8444-444444444444',
          targetVersion: 1,
        },
      }),
    ).resolves.toBe('already-applied');
  });

  it('fails closed for corrupted state and for same-version content collision', async () => {
    const statePath = await stateFile();
    await mkdir(dirname(statePath), { recursive: true });
    const file = await open(statePath, 'w');
    await file.writeFile('{broken');
    await file.close();
    await expect(
      new StateFileSimulationAdapter(statePath).apply(
        snapshot(1, '11111111-1111-4111-8111-111111111111'),
      ),
    ).rejects.toThrow();

    await rm(statePath);
    const adapter = new StateFileSimulationAdapter(statePath);
    const first = snapshot(1, '11111111-1111-4111-8111-111111111111');
    await adapter.apply(first);
    await expect(
      adapter.apply({
        ...first,
        grants: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            status: 'ACTIVE',
            expiresAt: '2099-01-01T00:00:00.000Z',
            desiredVersion: 1,
            appliedVersion: 0,
            revokedAt: null,
            dataPlaneCredential: null,
          },
        ],
      }),
    ).rejects.toThrow('version collision');
  });
});
