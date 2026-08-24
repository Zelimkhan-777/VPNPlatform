import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NodeAgentConfigurationSnapshot } from '@vpn-platform/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeAgentRunner } from './agent';
import { LocalXrayAdapter } from './local-xray-adapter';
import {
  type LocalReconcileClock,
  LocalStateReconcileLoop,
} from './local-state-reconciler';
import { InMemoryXrayRuntime } from './xray-runtime';

const firstCredential = '66666666-6666-4666-8666-666666666666';
const firstGrantId = '55555555-5555-4555-8555-555555555555';
const secondCredential = '77777777-7777-4777-8777-777777777777';
const secondGrantId = '88888888-8888-4888-8888-888888888888';

class FakeClock implements LocalReconcileClock {
  private nextHandle = 1;
  private readonly timers = new Map<
    number,
    { callback: () => void; deadlineAt: number }
  >();

  constructor(private currentTime: number) {}

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, {
      callback,
      deadlineAt: this.currentTime + delayMs,
    });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle);
  }

  hasDeadline(timestamp: number): boolean {
    return [...this.timers.values()].some(
      (timer) => timer.deadlineAt === timestamp,
    );
  }

  async advanceTo(timestamp: number): Promise<void> {
    if (timestamp < this.currentTime) throw new Error('Clock cannot go back');
    this.currentTime = timestamp;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.deadlineAt <= timestamp)
        .sort((left, right) => left[1].deadlineAt - right[1].deadlineAt)[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
    }
  }
}

function snapshot(
  expiresAt: string,
  secondExpiresAt: string | null = null,
): NodeAgentConfigurationSnapshot {
  return {
    desiredConfigVersion: 1,
    appliedConfigVersion: 0,
    pendingAcknowledgement: {
      nodeSyncJobId: '11111111-1111-4111-8111-111111111111',
      targetVersion: 1,
      snapshotHash: 'a'.repeat(64),
    },
    grants: [
      activeGrant(firstGrantId, firstCredential, expiresAt),
      ...(secondExpiresAt
        ? [activeGrant(secondGrantId, secondCredential, secondExpiresAt)]
        : []),
    ],
    routes: [],
  };
}

function activeGrant(
  id: string,
  dataPlaneCredential: string,
  expiresAt: string,
): NodeAgentConfigurationSnapshot['grants'][number] {
  return {
    id,
    status: 'ACTIVE',
    expiresAt,
    desiredVersion: 1,
    appliedVersion: 0,
    revokedAt: null,
    dataPlaneCredential,
  };
}

describe('LocalStateReconcileLoop', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('expires a durable client on deadline after restart while the control plane stays unavailable', async () => {
    const startAt = Date.parse('2026-08-24T12:00:00.000Z');
    const firstExpiresAt = startAt + 1_000;
    const secondExpiresAt = startAt + 5_000;
    const clock = new FakeClock(startAt);
    const directory = await mkdtemp(join(tmpdir(), 'vpn-local-expiry-'));
    directories.push(directory);
    const statePath = join(directory, 'state.json');
    const initialAdapter = new LocalXrayAdapter(
      statePath,
      new InMemoryXrayRuntime(),
      { now: () => new Date(clock.now()) },
    );
    await initialAdapter.apply(
      snapshot(
        new Date(firstExpiresAt).toISOString(),
        new Date(secondExpiresAt).toISOString(),
      ),
    );
    const durableState = await readFile(statePath, 'utf8');

    const restartedRuntime = new InMemoryXrayRuntime();
    const restartedAdapter = new LocalXrayAdapter(statePath, restartedRuntime, {
      now: () => new Date(clock.now()),
    });
    const abortController = new AbortController();
    const reconcileLoop = new LocalStateReconcileLoop(restartedAdapter, {
      retryDelayMs: 30_000,
      clock,
    }).run(abortController.signal);
    await vi.waitFor(async () => {
      await expect(restartedRuntime.inspectClients()).resolves.toEqual([
        { grantId: firstGrantId, credential: firstCredential },
        { grantId: secondGrantId, credential: secondCredential },
      ]);
    });
    await vi.waitFor(() =>
      expect(clock.hasDeadline(firstExpiresAt)).toBe(true),
    );

    const controlPlaneFailure = new Error('control plane unavailable');
    const configuration = vi.fn(async () => snapshot('2099-01-01T00:00:00Z'));
    const acknowledge = vi.fn(async () => undefined);
    const runner = new NodeAgentRunner(
      {
        heartbeat: vi.fn(async () => {
          throw controlPlaneFailure;
        }),
        configuration,
        acknowledge,
      },
      restartedAdapter,
    );
    await expect(runner.runCycle()).rejects.toBe(controlPlaneFailure);

    await clock.advanceTo(firstExpiresAt - 1);
    await expect(restartedRuntime.inspectClients()).resolves.toHaveLength(2);
    await clock.advanceTo(firstExpiresAt);
    await vi.waitFor(async () => {
      await expect(restartedRuntime.inspectClients()).resolves.toEqual([
        { grantId: secondGrantId, credential: secondCredential },
      ]);
    });
    await expect(runner.runCycle()).rejects.toBe(controlPlaneFailure);

    expect(configuration).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(await readFile(statePath, 'utf8')).toBe(durableState);

    abortController.abort();
    await reconcileLoop;
  });

  it('reschedules a newly persisted snapshot without an extra runtime apply', async () => {
    const startAt = Date.parse('2026-08-24T12:00:00.000Z');
    const expiresAt = startAt + 1_000;
    const clock = new FakeClock(startAt);
    const directory = await mkdtemp(join(tmpdir(), 'vpn-local-reschedule-'));
    directories.push(directory);
    const statePath = join(directory, 'state.json');
    let applyCount = 0;
    const runtime = new InMemoryXrayRuntime({
      afterApply() {
        applyCount += 1;
      },
    });
    const adapter = new LocalXrayAdapter(statePath, runtime, {
      now: () => new Date(clock.now()),
    });
    const abortController = new AbortController();
    const reconcileLoop = new LocalStateReconcileLoop(adapter, {
      retryDelayMs: 30_000,
      clock,
    }).run(abortController.signal);
    await Promise.resolve();

    await adapter.apply(snapshot(new Date(expiresAt).toISOString()));
    await vi.waitFor(() => expect(applyCount).toBe(1));
    await vi.waitFor(() => expect(clock.hasDeadline(expiresAt)).toBe(true));
    await clock.advanceTo(expiresAt);
    await vi.waitFor(async () => {
      await expect(runtime.inspectClients()).resolves.toEqual([]);
    });
    expect(applyCount).toBe(2);

    abortController.abort();
    await reconcileLoop;
  });
});
