import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NodeAgentConfigurationSnapshot } from '@vpn-platform/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeAgentRunner } from './agent';
import {
  LOCAL_ACCESS_ENFORCEMENT_SLA_MS,
  LocalXrayAdapter,
} from './local-xray-adapter';
import {
  LOCAL_SECURITY_RETRY_DELAY_MS,
  type LocalReconcileClock,
  LocalStateReconcileLoop,
} from './local-state-reconciler';
import {
  LOCAL_STATE_INTEGRITY_CHECK_INTERVAL_MS,
  XRAY_APPLY_MAX_DURATION_MS,
  XRAY_FAIL_CLOSED_MAX_DURATION_MS,
} from './security-timing';
import {
  InMemoryXrayRuntime,
  type XrayConfigRuntime,
  type XrayServableClient,
} from './xray-runtime';

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

  elapse(milliseconds: number): void {
    this.currentTime += milliseconds;
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

class TimedFailingXrayRuntime implements XrayConfigRuntime {
  private clients: XrayServableClient[] = [];
  failApplies = false;
  failClosedAt: number | null = null;

  constructor(private readonly clock: FakeClock) {}

  async applyClients(clients: readonly XrayServableClient[]): Promise<void> {
    if (this.failApplies) {
      this.clock.elapse(XRAY_APPLY_MAX_DURATION_MS);
      throw new Error('injected bounded Xray apply failure');
    }
    this.clients = clients.map((client) => ({ ...client }));
  }

  async failClosed(): Promise<void> {
    this.clock.elapse(XRAY_FAIL_CLOSED_MAX_DURATION_MS);
    this.clients = [];
    this.failClosedAt = this.clock.now();
  }

  async inspectClients(): Promise<readonly XrayServableClient[]> {
    return this.clients.map((client) => ({ ...client }));
  }

  async isServing(): Promise<boolean> {
    return this.clients.length > 0;
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

  it.each(['missing', 'corrupt'] as const)(
    'detects %s state within the integrity interval while control plane is unavailable',
    async (stateFailure) => {
      const startAt = Date.parse('2026-08-24T12:00:00.000Z');
      const clock = new FakeClock(startAt);
      const directory = await mkdtemp(join(tmpdir(), 'vpn-state-integrity-'));
      directories.push(directory);
      const statePath = join(directory, 'state.json');
      const runtime = new InMemoryXrayRuntime();
      const adapter = new LocalXrayAdapter(statePath, runtime, {
        now: () => new Date(clock.now()),
      });
      await adapter.apply(snapshot('2099-01-01T00:00:00.000Z'));

      const abortController = new AbortController();
      const reconcileLoop = new LocalStateReconcileLoop(adapter, {
        retryDelayMs: LOCAL_SECURITY_RETRY_DELAY_MS,
        clock,
      }).run(abortController.signal);
      const integrityDeadlineAt =
        startAt + LOCAL_STATE_INTEGRITY_CHECK_INTERVAL_MS;
      await vi.waitFor(() =>
        expect(clock.hasDeadline(integrityDeadlineAt)).toBe(true),
      );

      if (stateFailure === 'missing') {
        await rm(statePath, { force: true });
      } else {
        await writeFile(statePath, '{"invalid":true}\n', 'utf8');
      }
      const controlPlaneFailure = new Error('control plane unavailable');
      const runner = new NodeAgentRunner(
        {
          heartbeat: vi.fn(async () => {
            throw controlPlaneFailure;
          }),
          configuration: vi.fn(),
          acknowledge: vi.fn(),
        },
        adapter,
      );
      await expect(runner.runCycle()).rejects.toBe(controlPlaneFailure);

      await clock.advanceTo(integrityDeadlineAt);
      await vi.waitFor(async () => {
        await expect(runtime.inspectClients()).resolves.toEqual([]);
      });
      if (stateFailure === 'corrupt') {
        expect(await readFile(statePath, 'utf8')).toBe('{"invalid":true}\n');
      }

      abortController.abort();
      await reconcileLoop;
    },
  );

  it('fails closed before the five-minute expiry SLA after bounded apply failures', async () => {
    const startAt = Date.parse('2026-08-24T12:00:00.000Z');
    const expiresAt = startAt + 1_000;
    const enforcementDeadlineAt = expiresAt + LOCAL_ACCESS_ENFORCEMENT_SLA_MS;
    const clock = new FakeClock(startAt);
    const directory = await mkdtemp(join(tmpdir(), 'vpn-local-expiry-sla-'));
    directories.push(directory);
    const statePath = join(directory, 'state.json');
    const initialAdapter = new LocalXrayAdapter(
      statePath,
      new InMemoryXrayRuntime(),
      { now: () => new Date(clock.now()) },
    );
    await initialAdapter.apply(snapshot(new Date(expiresAt).toISOString()));
    const runtime = new TimedFailingXrayRuntime(clock);
    const adapter = new LocalXrayAdapter(statePath, runtime, {
      now: () => new Date(clock.now()),
    });
    await adapter.reconcileLocalState();
    const durableState = await readFile(statePath, 'utf8');

    const abortController = new AbortController();
    const reconcileLoop = new LocalStateReconcileLoop(adapter, {
      retryDelayMs: LOCAL_SECURITY_RETRY_DELAY_MS,
      clock,
    }).run(abortController.signal);
    await vi.waitFor(() => expect(clock.hasDeadline(expiresAt)).toBe(true));
    runtime.failApplies = true;

    await clock.advanceTo(expiresAt);
    const secondAttemptAt =
      expiresAt + XRAY_APPLY_MAX_DURATION_MS + LOCAL_SECURITY_RETRY_DELAY_MS;
    await vi.waitFor(() =>
      expect(clock.hasDeadline(secondAttemptAt)).toBe(true),
    );
    await clock.advanceTo(secondAttemptAt);
    const thirdAttemptAt =
      secondAttemptAt +
      XRAY_APPLY_MAX_DURATION_MS +
      LOCAL_SECURITY_RETRY_DELAY_MS;
    await vi.waitFor(() =>
      expect(clock.hasDeadline(thirdAttemptAt)).toBe(true),
    );
    await clock.advanceTo(thirdAttemptAt);

    await vi.waitFor(() => expect(runtime.failClosedAt).not.toBeNull());
    expect(runtime.failClosedAt).toBeLessThanOrEqual(enforcementDeadlineAt);
    await expect(runtime.inspectClients()).resolves.toEqual([]);
    expect(await readFile(statePath, 'utf8')).toBe(durableState);

    abortController.abort();
    await reconcileLoop;
  });

  it('fails closed before the five-minute revoke SLA after bounded apply failures', async () => {
    const startAt = Date.parse('2026-08-24T12:00:00.000Z');
    const revokedAt = startAt + 1_000;
    const enforcementDeadlineAt = revokedAt + LOCAL_ACCESS_ENFORCEMENT_SLA_MS;
    const clock = new FakeClock(startAt);
    const directory = await mkdtemp(join(tmpdir(), 'vpn-revoke-sla-'));
    directories.push(directory);
    const statePath = join(directory, 'state.json');
    const active = snapshot('2099-01-01T00:00:00.000Z');
    await new LocalXrayAdapter(statePath, new InMemoryXrayRuntime(), {
      now: () => new Date(clock.now()),
    }).apply(active);

    const runtime = new TimedFailingXrayRuntime(clock);
    const adapter = new LocalXrayAdapter(statePath, runtime, {
      now: () => new Date(clock.now()),
    });
    await adapter.reconcileLocalState();
    const durableState = await readFile(statePath, 'utf8');
    await clock.advanceTo(revokedAt);
    runtime.failApplies = true;
    const revoked: NodeAgentConfigurationSnapshot = {
      ...active,
      desiredConfigVersion: 2,
      appliedConfigVersion: 1,
      pendingAcknowledgement: {
        nodeSyncJobId: '22222222-2222-4222-8222-222222222222',
        targetVersion: 2,
        snapshotHash: 'b'.repeat(64),
      },
      grants: [
        {
          ...active.grants[0]!,
          status: 'REVOKED',
          revokedAt: new Date(revokedAt).toISOString(),
          dataPlaneCredential: null,
        },
      ],
    };
    const acknowledge = vi.fn(async () => undefined);
    const runner = new NodeAgentRunner(
      {
        heartbeat: vi.fn(async () => undefined),
        configuration: vi.fn(async () => revoked),
        acknowledge,
      },
      adapter,
    );

    await expect(runner.runCycle()).rejects.toThrow('bounded Xray apply');
    clock.elapse(LOCAL_SECURITY_RETRY_DELAY_MS);
    await expect(runner.runCycle()).rejects.toThrow('bounded Xray apply');
    clock.elapse(LOCAL_SECURITY_RETRY_DELAY_MS);
    await expect(runner.runCycle()).rejects.toThrow('bounded Xray apply');

    expect(runtime.failClosedAt).toBeLessThanOrEqual(enforcementDeadlineAt);
    await expect(runtime.inspectClients()).resolves.toEqual([]);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(await readFile(statePath, 'utf8')).toBe(durableState);
  });
});
