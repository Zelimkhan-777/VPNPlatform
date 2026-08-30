import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NodeAgentConfigurationSnapshot } from '@vpn-platform/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeAgentRunner } from './agent';
import type {
  ClockTrustAssessment,
  ClockTrustProbe,
  ClockTrustReason,
} from './clock-trust';
import { LocalXrayAdapter } from './local-xray-adapter';
import {
  InMemoryXrayRuntime,
  type XrayConfigRuntime,
  type XrayServableClient,
} from './xray-runtime';

const credential = '66666666-6666-4666-8666-666666666666';
const grantId = '55555555-5555-4555-8555-555555555555';

function snapshot(
  version: number,
  jobId: string,
): NodeAgentConfigurationSnapshot {
  return {
    desiredConfigVersion: version,
    appliedConfigVersion: Math.max(0, version - 1),
    pendingAcknowledgement: {
      nodeSyncJobId: jobId,
      targetVersion: version,
      snapshotHash: 'a'.repeat(64),
    },
    grants: [
      {
        id: grantId,
        status: 'ACTIVE',
        expiresAt: '2099-01-01T00:00:00.000Z',
        desiredVersion: 1,
        appliedVersion: 0,
        revokedAt: null,
        dataPlaneCredential: credential,
      },
    ],
    routes: [],
  };
}

class TrackingRuntime implements XrayConfigRuntime {
  clients: XrayServableClient[] = [];
  applyCount = 0;
  failClosedCount = 0;

  async applyClients(clients: readonly XrayServableClient[]): Promise<void> {
    this.applyCount += 1;
    this.clients = clients.map((client) => ({ ...client }));
  }

  async failClosed(): Promise<void> {
    this.failClosedCount += 1;
    this.clients = [];
  }

  async inspectClients(): Promise<readonly XrayServableClient[]> {
    return this.clients.map((client) => ({ ...client }));
  }

  async isServing(): Promise<boolean> {
    return this.clients.length > 0;
  }
}

class MutableClockTrustProbe implements ClockTrustProbe {
  trusted = true;
  throwNext: Error | null = null;
  assessments = 0;

  async assess(): Promise<ClockTrustAssessment> {
    this.assessments += 1;
    if (this.throwNext) {
      const error = this.throwNext;
      this.throwNext = null;
      throw error;
    }
    return this.trusted
      ? {
          synchronized: true,
          estimatedAbsoluteErrorMs: 0,
          outcome: 'trusted',
          reason: 'trusted',
        }
      : {
          synchronized: false,
          estimatedAbsoluteErrorMs: 1,
          outcome: 'untrusted',
          reason: 'unsynchronized' satisfies ClockTrustReason,
        };
  }
}

describe('LocalXrayAdapter clock trust', () => {
  const directories: string[] = [];

  async function stateFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'vpn-clock-trust-'));
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

  it('stops serving on startup when the clock is untrusted', async () => {
    const statePath = await stateFile();
    const current = snapshot(1, '11111111-1111-4111-8111-111111111111');
    await new LocalXrayAdapter(statePath, new InMemoryXrayRuntime()).apply(
      current,
    );
    const runtime = new TrackingRuntime();
    await runtime.applyClients([{ grantId, credential }]);
    const probe = new MutableClockTrustProbe();
    probe.trusted = false;
    const adapter = new LocalXrayAdapter(statePath, runtime, {
      clockTrust: probe,
    });

    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    expect(runtime.failClosedCount).toBe(1);
    expect(runtime.applyCount).toBe(1);
    await expect(runtime.inspectClients()).resolves.toEqual([]);
  });

  it('fails closed when the clock becomes untrusted during local reconcile', async () => {
    const statePath = await stateFile();
    const runtime = new TrackingRuntime();
    const probe = new MutableClockTrustProbe();
    const adapter = new LocalXrayAdapter(statePath, runtime, {
      clockTrust: probe,
    });
    await adapter.apply(snapshot(1, '11111111-1111-4111-8111-111111111111'));
    expect(runtime.applyCount).toBe(1);
    const failClosedBeforeUntrusted = runtime.failClosedCount;
    probe.trusted = false;

    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    expect(runtime.failClosedCount).toBe(failClosedBeforeUntrusted + 1);
    await expect(runtime.inspectClients()).resolves.toEqual([]);
  });

  it('does not resume after process restart while the clock stays untrusted', async () => {
    const statePath = await stateFile();
    const probe = new MutableClockTrustProbe();
    await new LocalXrayAdapter(statePath, new InMemoryXrayRuntime(), {
      clockTrust: probe,
    }).apply(snapshot(1, '11111111-1111-4111-8111-111111111111'));

    const restarted = new TrackingRuntime();
    await restarted.applyClients([{ grantId, credential }]);
    probe.trusted = false;
    const adapter = new LocalXrayAdapter(statePath, restarted, {
      clockTrust: probe,
    });
    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    expect(restarted.failClosedCount).toBe(1);
    expect(restarted.applyCount).toBe(1);
    await expect(restarted.inspectClients()).resolves.toEqual([]);
  });

  it('keeps serving during a control-plane outage when the clock is trusted', async () => {
    const statePath = await stateFile();
    const runtime = new TrackingRuntime();
    const probe = new MutableClockTrustProbe();
    const adapter = new LocalXrayAdapter(statePath, runtime, {
      clockTrust: probe,
    });
    await adapter.apply(snapshot(1, '11111111-1111-4111-8111-111111111111'));
    const applyCountAfterStart = runtime.applyCount;
    const failClosedAfterStart = runtime.failClosedCount;
    const controlPlaneFailure = new Error('control plane unavailable');

    await expect(
      new NodeAgentRunner(
        {
          heartbeat: vi.fn(async () => {
            throw controlPlaneFailure;
          }),
          configuration: vi.fn(),
          acknowledge: vi.fn(),
        },
        adapter,
      ).runCycle(),
    ).rejects.toBe(controlPlaneFailure);
    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    expect(runtime.failClosedCount).toBe(failClosedAfterStart);
    expect(runtime.applyCount).toBe(applyCountAfterStart);
    await expect(runtime.inspectClients()).resolves.toEqual([
      { grantId, credential },
    ]);
  });

  it('does not resume Xray after clock recovery until verified reload succeeds', async () => {
    const statePath = await stateFile();
    const runtime = new TrackingRuntime();
    const probe = new MutableClockTrustProbe();
    const adapter = new LocalXrayAdapter(statePath, runtime, {
      clockTrust: probe,
    });
    await adapter.apply(snapshot(1, '11111111-1111-4111-8111-111111111111'));
    probe.trusted = false;
    await adapter.reconcileLocalState();
    expect(runtime.clients).toEqual([]);

    probe.trusted = true;
    const reloadFailure = new Error('injected verified reload failure');
    runtime.applyClients = async () => {
      runtime.applyCount += 1;
      throw reloadFailure;
    };
    await expect(adapter.reconcileLocalState()).rejects.toBe(reloadFailure);
    await expect(runtime.inspectClients()).resolves.toEqual([]);
  });

  it('resumes serving once after trusted clock, verified reconcile and durability barrier', async () => {
    const statePath = await stateFile();
    const runtime = new TrackingRuntime();
    const probe = new MutableClockTrustProbe();
    const adapter = new LocalXrayAdapter(statePath, runtime, {
      clockTrust: probe,
    });
    await adapter.apply(snapshot(1, '11111111-1111-4111-8111-111111111111'));
    probe.trusted = false;
    await adapter.reconcileLocalState();
    const failClosedAfterUntrusted = runtime.failClosedCount;

    probe.trusted = true;
    const applyCountBeforeResume = runtime.applyCount;
    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    expect(runtime.applyCount).toBe(applyCountBeforeResume + 1);
    await expect(runtime.inspectClients()).resolves.toEqual([
      { grantId, credential },
    ]);

    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    expect(runtime.applyCount).toBe(applyCountBeforeResume + 1);
    expect(runtime.failClosedCount).toBe(failClosedAfterUntrusted);
  });

  it('does not acknowledge when apply is blocked by an untrusted clock', async () => {
    const runtime = new TrackingRuntime();
    const probe = new MutableClockTrustProbe();
    probe.trusted = false;
    const acknowledge = vi.fn(async () => undefined);
    const current = snapshot(1, '11111111-1111-4111-8111-111111111111');

    await expect(
      new NodeAgentRunner(
        {
          heartbeat: vi.fn(async () => undefined),
          configuration: vi.fn(async () => current),
          acknowledge,
        },
        new LocalXrayAdapter(await stateFile(), runtime, {
          clockTrust: probe,
        }),
      ).runCycle(),
    ).rejects.toThrow('Node clock is untrusted');
    expect(acknowledge).not.toHaveBeenCalled();
    expect(runtime.failClosedCount).toBe(1);
  });

  it('fails closed when the clock probe throws and keeps probe output out of logs', async () => {
    const records: string[] = [];
    const runtime = new TrackingRuntime();
    const probe = new MutableClockTrustProbe();
    const leaked =
      'chronyc stdout CB00710F,secret-ntp.example,Not synchronised';
    probe.throwNext = new Error(leaked);
    const adapter = new LocalXrayAdapter(await stateFile(), runtime, {
      clockTrust: probe,
      logger: {
        info(fields, message) {
          records.push(`${JSON.stringify(fields)} ${message}`);
        },
      },
    });

    await expect(
      adapter.apply(snapshot(1, '11111111-1111-4111-8111-111111111111')),
    ).rejects.toThrow(leaked);
    expect(runtime.failClosedCount).toBe(1);
    const joined = records.join('\n');
    expect(joined).toContain('"outcome":"untrusted"');
    expect(joined).toContain('"synchronized":false');
    expect(joined).toContain('"thresholdExceeded":false');
    expect(joined).not.toContain('secret-ntp.example');
    expect(joined).not.toContain('CB00710F');
    expect(joined).not.toContain(leaked);
    expect(joined).not.toContain(credential);
    expect(joined).not.toContain(grantId);
  });

  it('keeps raw chrony CSV out of the safe JSON clock-trust log', async () => {
    const records: Array<{ fields: Record<string, unknown>; message: string }> =
      [];
    const runtime = new TrackingRuntime();
    const csv =
      'CB00710F,secret-ntp.example,3,1485510557.000000000,0.000000000,0.000000000,0.000000000,0.000,0.000,0.000,0.000000000,0.000000000,64.2,Not synchronised';
    const adapter = new LocalXrayAdapter(await stateFile(), runtime, {
      clockTrust: {
        async assess() {
          return {
            synchronized: false,
            estimatedAbsoluteErrorMs: 0,
            outcome: 'untrusted',
            reason: 'unsynchronized',
          };
        },
      },
      logger: {
        info(fields, message) {
          records.push({ fields, message });
        },
      },
    });

    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    const serialized = JSON.stringify(records);
    expect(serialized).toContain('"outcome":"untrusted"');
    expect(serialized).not.toContain(csv);
    expect(serialized).not.toContain('secret-ntp.example');
    expect(records[0]?.fields).toEqual({
      component: 'local-xray',
      outcome: 'untrusted',
      synchronized: false,
      thresholdExceeded: false,
    });
  });
});
