import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { NodeAgentConfigurationSnapshot } from '@vpn-platform/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeAgentRunner } from './agent';
import {
  hashNodeAgentSnapshot,
  type LocalXrayFileHandle,
  LocalXrayAdapter,
  type LocalXrayStateFileOperations,
} from './local-xray-adapter';
import {
  FileXrayRuntime,
  InMemoryXrayRuntime,
  type XrayConfigRuntime,
  type XrayServableClient,
} from './xray-runtime';

const credential = '66666666-6666-4666-8666-666666666666';
const grantId = '55555555-5555-4555-8555-555555555555';
const otherCredential = '77777777-7777-4777-8777-777777777777';
const otherGrantId = '88888888-8888-4888-8888-888888888888';

function snapshot(
  version: number,
  jobId: string,
  grants: NodeAgentConfigurationSnapshot['grants'] = [],
): NodeAgentConfigurationSnapshot {
  return {
    desiredConfigVersion: version,
    appliedConfigVersion: Math.max(0, version - 1),
    pendingAcknowledgement: {
      nodeSyncJobId: jobId,
      targetVersion: version,
      snapshotHash: 'a'.repeat(64),
    },
    grants,
    routes: [],
  };
}

function activeGrant(
  id: string,
  dataPlaneCredential: string,
  expiresAt = '2099-01-01T00:00:00.000Z',
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

class TrackingXrayRuntime implements XrayConfigRuntime {
  private clients: XrayServableClient[] = [];
  applyCount = 0;
  failClosedCount = 0;

  constructor(private readonly onFailClosed?: () => void | Promise<void>) {}

  async applyClients(clients: readonly XrayServableClient[]): Promise<void> {
    this.applyCount += 1;
    this.clients = clients.map((client) => ({ ...client }));
  }

  async failClosed(): Promise<void> {
    this.failClosedCount += 1;
    this.clients = [];
    await this.onFailClosed?.();
  }

  async inspectClients(): Promise<readonly XrayServableClient[]> {
    return this.clients.map((client) => ({ ...client }));
  }
}

function observingFileOperations(
  statePath: string,
  onDirectorySync: () => void,
  unreadableStateReads = 0,
): LocalXrayStateFileOperations {
  let unreadableStateReadsRemaining = unreadableStateReads;
  return {
    async mkdir(path) {
      await mkdir(path, { recursive: true });
    },
    async read(path) {
      if (path === statePath && unreadableStateReadsRemaining > 0) {
        unreadableStateReadsRemaining -= 1;
        throw Object.assign(new Error('injected unreadable state'), {
          code: 'EACCES',
        });
      }
      return readFile(path, 'utf8');
    },
    async openFile(path, flags, mode): Promise<LocalXrayFileHandle> {
      if (path === dirname(statePath)) {
        return {
          async writeFile() {
            throw new Error('directory handle is not writable');
          },
          async sync() {
            onDirectorySync();
          },
          async close() {},
        };
      }
      const file = await open(path, flags, mode);
      return {
        writeFile: (data, encoding) => file.writeFile(data, encoding),
        async sync() {
          await file.sync();
        },
        close: () => file.close(),
      };
    },
    rename,
    async remove(path) {
      await rm(path, { force: true });
    },
  };
}

function faultInjectingFileOperations(
  statePath: string,
  stage: 'temp-write' | 'rename' | 'directory-sync' | 'unreadable',
  failureCount = 1,
): LocalXrayStateFileOperations {
  let failuresRemaining = failureCount;
  const shouldFail = (candidate: typeof stage) => {
    if (candidate !== stage || failuresRemaining <= 0) return false;
    failuresRemaining -= 1;
    return true;
  };
  return {
    async mkdir(path) {
      await mkdir(path, { recursive: true });
    },
    async read(path) {
      if (path === statePath && shouldFail('unreadable')) {
        throw Object.assign(new Error('injected unreadable state'), {
          code: 'EACCES',
        });
      }
      return readFile(path, 'utf8');
    },
    async openFile(path, flags, mode): Promise<LocalXrayFileHandle> {
      const file = await open(path, flags, mode);
      return {
        async writeFile(data, encoding) {
          if (flags === 'wx' && shouldFail('temp-write')) {
            throw new Error('injected temp write failure');
          }
          await file.writeFile(data, encoding);
        },
        async sync() {
          if (path === dirname(statePath) && shouldFail('directory-sync')) {
            throw new Error('injected directory sync failure');
          }
          await file.sync();
        },
        async close() {
          await file.close();
        },
      };
    },
    async rename(from, to) {
      if (shouldFail('rename')) throw new Error('injected rename failure');
      await rename(from, to);
    },
    async remove(path) {
      await rm(path, { force: true });
    },
  };
}

describe('LocalXrayAdapter', () => {
  const directories: string[] = [];

  async function stateFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'vpn-local-xray-'));
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

  it('applies an active grant to Xray and replays the same snapshot idempotently', async () => {
    const runtime = new InMemoryXrayRuntime();
    const adapter = new LocalXrayAdapter(await stateFile(), runtime);
    const next = snapshot(1, '11111111-1111-4111-8111-111111111111', [
      activeGrant(grantId, credential),
    ]);

    await expect(adapter.apply(next)).resolves.toBe('applied');
    await expect(runtime.inspectClients()).resolves.toEqual([
      { grantId, credential },
    ]);
    await expect(adapter.apply(next)).resolves.toBe('already-applied');
    await expect(runtime.inspectClients()).resolves.toEqual([
      { grantId, credential },
    ]);
  });

  it('removes Xray access for revoked or expired grants without a subscription URL', async () => {
    const runtime = new InMemoryXrayRuntime();
    const adapter = new LocalXrayAdapter(await stateFile(), runtime);
    const active = snapshot(1, '11111111-1111-4111-8111-111111111111', [
      activeGrant(grantId, credential),
      activeGrant(otherGrantId, otherCredential),
    ]);
    await adapter.apply(active);

    const revoked = snapshot(2, '22222222-2222-4222-8222-222222222222', [
      {
        ...activeGrant(grantId, credential),
        status: 'REVOKED',
        revokedAt: '2026-08-15T12:00:00.000Z',
        dataPlaneCredential: null,
      },
      activeGrant(otherGrantId, otherCredential),
    ]);
    await expect(adapter.apply(revoked)).resolves.toBe('applied');
    await expect(runtime.inspectClients()).resolves.toEqual([
      { grantId: otherGrantId, credential: otherCredential },
    ]);

    const expired = snapshot(3, '33333333-3333-4333-8333-333333333333', [
      {
        ...activeGrant(grantId, credential),
        status: 'REVOKED',
        revokedAt: '2026-08-15T12:00:00.000Z',
        dataPlaneCredential: null,
      },
      activeGrant(otherGrantId, otherCredential, '2020-01-01T00:00:00.000Z'),
    ]);
    await expect(adapter.apply(expired)).resolves.toBe('applied');
    await expect(runtime.inspectClients()).resolves.toEqual([]);
    expect(JSON.stringify(expired)).not.toContain('vless://');
  });

  it('fails closed without acknowledging or persisting a partial first apply', async () => {
    const statePath = await stateFile();
    let clientsDuringFailure: readonly XrayServableClient[] = [];
    const runtime = new InMemoryXrayRuntime({
      async afterApply(clients) {
        clientsDuringFailure = clients;
        throw new Error('injected xray apply failure');
      },
    });
    const acknowledge = vi.fn(async () => undefined);
    const next = snapshot(1, '11111111-1111-4111-8111-111111111111', [
      activeGrant(grantId, credential),
    ]);
    const runner = new NodeAgentRunner(
      {
        heartbeat: vi.fn(async () => undefined),
        configuration: vi.fn(async () => next),
        acknowledge,
      },
      new LocalXrayAdapter(statePath, runtime),
    );

    await expect(runner.runCycle()).rejects.toThrow(
      'injected xray apply failure',
    );
    expect(acknowledge).not.toHaveBeenCalled();
    expect(clientsDuringFailure).toEqual([{ grantId, credential }]);
    await expect(runtime.inspectClients()).resolves.toEqual([]);
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed on missing state and recovers from a full snapshot without acknowledgement', async () => {
    const statePath = await stateFile();
    const runtime = new InMemoryXrayRuntime();
    await runtime.applyClients([{ grantId, credential }]);
    const adapter = new LocalXrayAdapter(statePath, runtime);

    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    await expect(runtime.inspectClients()).resolves.toEqual([]);

    const acknowledge = vi.fn(async () => undefined);
    const recovered = {
      ...snapshot(1, '11111111-1111-4111-8111-111111111111', [
        activeGrant(otherGrantId, otherCredential),
      ]),
      appliedConfigVersion: 1,
      pendingAcknowledgement: null,
    };
    const runner = new NodeAgentRunner(
      {
        heartbeat: vi.fn(async () => undefined),
        configuration: vi.fn(async () => recovered),
        acknowledge,
      },
      adapter,
    );

    await expect(runner.runCycle()).resolves.toBe('synchronized');
    expect(acknowledge).not.toHaveBeenCalled();
    await expect(runtime.inspectClients()).resolves.toEqual([
      { grantId: otherGrantId, credential: otherCredential },
    ]);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
      current: { version: 1 },
      previous: null,
    });
  });

  it('fails closed on corrupt state while the control plane is unavailable', async () => {
    const statePath = await stateFile();
    await writeFile(statePath, '{"invalid":true}\n', 'utf8');
    const corruptState = await readFile(statePath, 'utf8');
    const runtime = new InMemoryXrayRuntime();
    await runtime.applyClients([{ grantId, credential }]);
    const adapter = new LocalXrayAdapter(statePath, runtime);

    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    await expect(runtime.inspectClients()).resolves.toEqual([]);
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
    expect(await readFile(statePath, 'utf8')).toBe(corruptState);

    const recovered = {
      ...snapshot(1, '11111111-1111-4111-8111-111111111111', [
        activeGrant(otherGrantId, otherCredential),
      ]),
      appliedConfigVersion: 1,
      pendingAcknowledgement: null,
    };
    const acknowledge = vi.fn(async () => undefined);
    await expect(
      new NodeAgentRunner(
        {
          heartbeat: vi.fn(async () => undefined),
          configuration: vi.fn(async () => recovered),
          acknowledge,
        },
        adapter,
      ).runCycle(),
    ).resolves.toBe('synchronized');
    expect(acknowledge).not.toHaveBeenCalled();
    await expect(runtime.inspectClients()).resolves.toEqual([
      { grantId: otherGrantId, credential: otherCredential },
    ]);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
      current: { version: 1 },
      previous: null,
    });
  });

  it('fails closed on schema-valid current or previous state corruption', async () => {
    const statePath = await stateFile();
    const runtime = new InMemoryXrayRuntime();
    const adapter = new LocalXrayAdapter(statePath, runtime);
    const first = snapshot(1, '11111111-1111-4111-8111-111111111111', [
      activeGrant(grantId, credential),
    ]);
    const second = snapshot(2, '22222222-2222-4222-8222-222222222222', [
      activeGrant(otherGrantId, otherCredential),
    ]);
    await adapter.apply(first);
    await adapter.apply(second);

    const envelope = JSON.parse(await readFile(statePath, 'utf8')) as {
      current: {
        version: number;
        snapshotHash: string;
        snapshot: NodeAgentConfigurationSnapshot;
      };
      previous: {
        version: number;
        snapshotHash: string;
        snapshot: NodeAgentConfigurationSnapshot;
      };
    };
    envelope.previous.snapshot.grants[0]!.dataPlaneCredential = otherCredential;
    await writeFile(statePath, `${JSON.stringify(envelope)}\n`, 'utf8');
    const corruptState = await readFile(statePath, 'utf8');

    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    await expect(runtime.inspectClients()).resolves.toEqual([]);
    expect(await readFile(statePath, 'utf8')).toBe(corruptState);

    envelope.previous.snapshotHash = hashNodeAgentSnapshot(
      envelope.previous.snapshot,
    );
    envelope.current.version =
      envelope.current.snapshot.desiredConfigVersion + 1;
    await writeFile(statePath, `${JSON.stringify(envelope)}\n`, 'utf8');
    await expect(adapter.nextLocalReconcileAt()).resolves.toEqual(
      expect.any(Number),
    );
    await expect(runtime.inspectClients()).resolves.toEqual([]);

    envelope.current.version = envelope.current.snapshot.desiredConfigVersion;
    envelope.current.snapshot.grants[0]!.dataPlaneCredential = credential;
    await writeFile(statePath, `${JSON.stringify(envelope)}\n`, 'utf8');
    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    await expect(runtime.inspectClients()).resolves.toEqual([]);

    envelope.current.snapshotHash = hashNodeAgentSnapshot(
      envelope.current.snapshot,
    );
    envelope.previous.version = envelope.current.version;
    await writeFile(statePath, `${JSON.stringify(envelope)}\n`, 'utf8');
    await expect(adapter.nextLocalReconcileAt()).resolves.toEqual(
      expect.any(Number),
    );
    await expect(runtime.inspectClients()).resolves.toEqual([]);
  });

  it.each(['temp-write', 'rename', 'directory-sync'] as const)(
    're-enters fail-closed when %s fails after verified recovery',
    async (stage) => {
      const statePath = await stateFile();
      const runtime = new TrackingXrayRuntime();
      const acknowledge = vi.fn(async () => undefined);
      const next = snapshot(1, '11111111-1111-4111-8111-111111111111', [
        activeGrant(grantId, credential),
      ]);
      const runner = new NodeAgentRunner(
        {
          heartbeat: vi.fn(async () => undefined),
          configuration: vi.fn(async () => next),
          acknowledge,
        },
        new LocalXrayAdapter(statePath, runtime, {
          files: faultInjectingFileOperations(statePath, stage),
        }),
      );

      await expect(runner.runCycle()).rejects.toThrow(
        `injected ${stage.replace('-', ' ')} failure`,
      );
      expect(acknowledge).not.toHaveBeenCalled();
      expect(runtime.failClosedCount).toBe(2);
      await expect(runtime.inspectClients()).resolves.toEqual([]);
    },
  );

  it('does not resume after directory fsync failure until durability is reconfirmed', async () => {
    const statePath = await stateFile();
    const runtime = new TrackingXrayRuntime();
    const next = snapshot(1, '11111111-1111-4111-8111-111111111111', [
      activeGrant(grantId, credential),
    ]);
    const adapter = new LocalXrayAdapter(statePath, runtime, {
      files: faultInjectingFileOperations(statePath, 'directory-sync', 2),
    });

    await expect(adapter.apply(next)).rejects.toThrow(
      'injected directory sync failure',
    );
    expect(runtime.applyCount).toBe(1);
    await expect(runtime.inspectClients()).resolves.toEqual([]);

    await expect(adapter.reconcileLocalState()).rejects.toThrow(
      'injected directory sync failure',
    );
    expect(runtime.applyCount).toBe(1);
    await expect(runtime.inspectClients()).resolves.toEqual([]);

    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    expect(runtime.applyCount).toBe(2);
    await expect(runtime.inspectClients()).resolves.toEqual([
      { grantId, credential },
    ]);
  });

  it('fails closed when durable state cannot be read', async () => {
    const statePath = await stateFile();
    await new LocalXrayAdapter(statePath, new InMemoryXrayRuntime()).apply(
      snapshot(1, '11111111-1111-4111-8111-111111111111', [
        activeGrant(grantId, credential),
      ]),
    );
    const runtime = new TrackingXrayRuntime();
    await runtime.applyClients([{ grantId, credential }]);
    const adapter = new LocalXrayAdapter(statePath, runtime, {
      files: faultInjectingFileOperations(statePath, 'unreadable'),
    });

    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    expect(runtime.applyCount).toBe(1);
    expect(runtime.failClosedCount).toBe(1);
    await expect(runtime.inspectClients()).resolves.toEqual([]);
  });

  it('enforces an uncommanded revoke as stop-only and waits for a matching command', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z');
    const statePath = await stateFile();
    const runtime = new TrackingXrayRuntime();
    const adapter = new LocalXrayAdapter(statePath, runtime, {
      now: () => now,
    });
    const active = snapshot(1, '11111111-1111-4111-8111-111111111111', [
      activeGrant(grantId, credential),
    ]);
    await adapter.apply(active);
    const durableState = await readFile(statePath, 'utf8');
    const revokedGrant = {
      ...activeGrant(grantId, credential),
      status: 'REVOKED' as const,
      revokedAt: now.toISOString(),
      dataPlaneCredential: null,
    };
    const withoutCommand: NodeAgentConfigurationSnapshot = {
      ...snapshot(2, '22222222-2222-4222-8222-222222222222', [revokedGrant]),
      pendingAcknowledgement: null,
    };
    const acknowledge = vi.fn(async () => undefined);
    const controlPlane = {
      heartbeat: vi.fn(async () => undefined),
      configuration: vi.fn(async () => withoutCommand),
      acknowledge,
    };

    await expect(
      new NodeAgentRunner(controlPlane, adapter).runCycle(),
    ).resolves.toBe('waiting-for-command');
    expect(runtime.applyCount).toBe(1);
    await expect(runtime.inspectClients()).resolves.toEqual([]);
    expect(await readFile(statePath, 'utf8')).toBe(durableState);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(`${statePath}.stop-only.json`, 'utf8')),
    ).toMatchObject({
      formatVersion: 1,
      targetVersion: 2,
      revokedGrantIds: [grantId],
    });
    if (process.platform !== 'win32') {
      expect((await stat(`${statePath}.stop-only.json`)).mode & 0o777).toBe(
        0o600,
      );
    }

    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    expect(runtime.applyCount).toBe(1);
    await expect(runtime.inspectClients()).resolves.toEqual([]);
    expect(await readFile(statePath, 'utf8')).toBe(durableState);

    const withCommand: NodeAgentConfigurationSnapshot = {
      ...withoutCommand,
      pendingAcknowledgement: {
        nodeSyncJobId: '22222222-2222-4222-8222-222222222222',
        targetVersion: 2,
        snapshotHash: 'b'.repeat(64),
      },
    };
    controlPlane.configuration.mockResolvedValue(withCommand);
    await expect(
      new NodeAgentRunner(controlPlane, adapter).runCycle(),
    ).resolves.toBe('acknowledged');
    expect(runtime.applyCount).toBe(2);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
      current: { version: 2 },
      previous: { version: 1 },
    });
    await expect(
      readFile(`${statePath}.stop-only.json`, 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('durably syncs an unreadable-state revoke latch before stopping Xray', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z');
    const statePath = await stateFile();
    const active = snapshot(1, '11111111-1111-4111-8111-111111111111', [
      activeGrant(grantId, credential),
    ]);
    await new LocalXrayAdapter(statePath, new InMemoryXrayRuntime(), {
      now: () => now,
    }).apply(active);
    let directorySyncCount = 0;
    const failClosedObservation = vi.fn(async () => {
      expect(directorySyncCount).toBe(1);
      expect(
        JSON.parse(await readFile(`${statePath}.stop-only.json`, 'utf8')),
      ).toMatchObject({
        formatVersion: 1,
        targetVersion: 2,
        revokedGrantIds: [grantId],
      });
    });
    const runtime = new TrackingXrayRuntime(failClosedObservation);
    await runtime.applyClients([{ grantId, credential }]);
    const adapter = new LocalXrayAdapter(statePath, runtime, {
      now: () => now,
      files: observingFileOperations(
        statePath,
        () => {
          directorySyncCount += 1;
        },
        1,
      ),
    });
    const revokedGrant = {
      ...activeGrant(grantId, credential),
      status: 'REVOKED' as const,
      revokedAt: now.toISOString(),
      dataPlaneCredential: null,
    };

    await expect(
      adapter.enforceSnapshotSecurity({
        ...snapshot(2, '22222222-2222-4222-8222-222222222222', [revokedGrant]),
        pendingAcknowledgement: null,
      }),
    ).resolves.toBeUndefined();

    expect(failClosedObservation).toHaveBeenCalledOnce();
    expect(directorySyncCount).toBe(1);
    await expect(runtime.inspectClients()).resolves.toEqual([]);
  });

  it('keeps the durable revoke latch after termination during fail-closed enforcement', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z');
    const statePath = await stateFile();
    const active = snapshot(1, '11111111-1111-4111-8111-111111111111', [
      activeGrant(grantId, credential),
    ]);
    await new LocalXrayAdapter(statePath, new InMemoryXrayRuntime(), {
      now: () => now,
    }).apply(active);
    const simulatedTermination = new Error('simulated process termination');
    const interruptedRuntime = new TrackingXrayRuntime(async () => {
      throw simulatedTermination;
    });
    await interruptedRuntime.applyClients([{ grantId, credential }]);
    const interruptedAdapter = new LocalXrayAdapter(
      statePath,
      interruptedRuntime,
      {
        now: () => now,
        files: observingFileOperations(statePath, () => undefined, 1),
      },
    );
    const revokedGrant = {
      ...activeGrant(grantId, credential),
      status: 'REVOKED' as const,
      revokedAt: now.toISOString(),
      dataPlaneCredential: null,
    };
    const withoutCommand: NodeAgentConfigurationSnapshot = {
      ...snapshot(2, '22222222-2222-4222-8222-222222222222', [revokedGrant]),
      pendingAcknowledgement: null,
    };

    await expect(
      interruptedAdapter.enforceSnapshotSecurity(withoutCommand),
    ).rejects.toBe(simulatedTermination);
    expect(
      JSON.parse(await readFile(`${statePath}.stop-only.json`, 'utf8')),
    ).toMatchObject({ targetVersion: 2, revokedGrantIds: [grantId] });

    const restartedRuntime = new TrackingXrayRuntime();
    await restartedRuntime.applyClients([{ grantId, credential }]);
    const restartedAdapter = new LocalXrayAdapter(statePath, restartedRuntime, {
      now: () => now,
    });
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
        restartedAdapter,
      ).runCycle(),
    ).rejects.toBe(controlPlaneFailure);
    await expect(restartedAdapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    expect(restartedRuntime.applyCount).toBe(1);
    await expect(restartedRuntime.inspectClients()).resolves.toEqual([]);
  });

  it('keeps an unreadable-state revoke latched after state becomes readable', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z');
    const statePath = await stateFile();
    const active = snapshot(1, '11111111-1111-4111-8111-111111111111', [
      activeGrant(grantId, credential),
    ]);
    await new LocalXrayAdapter(statePath, new InMemoryXrayRuntime(), {
      now: () => now,
    }).apply(active);
    const runtime = new TrackingXrayRuntime();
    await runtime.applyClients([{ grantId, credential }]);
    const adapter = new LocalXrayAdapter(statePath, runtime, {
      now: () => now,
      files: faultInjectingFileOperations(statePath, 'unreadable'),
    });
    const revokedGrant = {
      ...activeGrant(grantId, credential),
      status: 'REVOKED' as const,
      revokedAt: now.toISOString(),
      dataPlaneCredential: null,
    };
    const withoutCommand: NodeAgentConfigurationSnapshot = {
      ...snapshot(2, '22222222-2222-4222-8222-222222222222', [revokedGrant]),
      pendingAcknowledgement: null,
    };
    const acknowledge = vi.fn(async () => undefined);
    const controlPlane = {
      heartbeat: vi.fn(async () => undefined),
      configuration: vi.fn(async () => withoutCommand),
      acknowledge,
    };

    await expect(
      new NodeAgentRunner(controlPlane, adapter).runCycle(),
    ).resolves.toBe('waiting-for-command');
    await expect(runtime.inspectClients()).resolves.toEqual([]);
    expect(
      JSON.parse(await readFile(`${statePath}.stop-only.json`, 'utf8')),
    ).toMatchObject({ targetVersion: 2, revokedGrantIds: [grantId] });

    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    expect(runtime.applyCount).toBe(1);
    await expect(runtime.inspectClients()).resolves.toEqual([]);

    controlPlane.configuration.mockResolvedValue({
      ...withoutCommand,
      pendingAcknowledgement: {
        nodeSyncJobId: '22222222-2222-4222-8222-222222222222',
        targetVersion: 2,
        snapshotHash: 'b'.repeat(64),
      },
    });
    await expect(
      new NodeAgentRunner(controlPlane, adapter).runCycle(),
    ).resolves.toBe('acknowledged');
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(runtime.applyCount).toBe(2);
    await expect(
      readFile(`${statePath}.stop-only.json`, 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an uncommanded revoke latched across adapter restart and control-plane outage', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z');
    const statePath = await stateFile();
    const active = snapshot(1, '11111111-1111-4111-8111-111111111111', [
      activeGrant(grantId, credential),
    ]);
    const initialRuntime = new TrackingXrayRuntime();
    const initialAdapter = new LocalXrayAdapter(statePath, initialRuntime, {
      now: () => now,
    });
    await initialAdapter.apply(active);
    const revokedGrant = {
      ...activeGrant(grantId, credential),
      status: 'REVOKED' as const,
      revokedAt: now.toISOString(),
      dataPlaneCredential: null,
    };
    const withoutCommand: NodeAgentConfigurationSnapshot = {
      ...snapshot(2, '22222222-2222-4222-8222-222222222222', [revokedGrant]),
      pendingAcknowledgement: null,
    };
    await expect(
      new NodeAgentRunner(
        {
          heartbeat: vi.fn(async () => undefined),
          configuration: vi.fn(async () => withoutCommand),
          acknowledge: vi.fn(),
        },
        initialAdapter,
      ).runCycle(),
    ).resolves.toBe('waiting-for-command');

    const restartedRuntime = new TrackingXrayRuntime();
    await restartedRuntime.applyClients([{ grantId, credential }]);
    const restartedAdapter = new LocalXrayAdapter(statePath, restartedRuntime, {
      now: () => now,
    });
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
        restartedAdapter,
      ).runCycle(),
    ).rejects.toBe(controlPlaneFailure);
    await expect(restartedAdapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    expect(restartedRuntime.applyCount).toBe(1);
    await expect(restartedRuntime.inspectClients()).resolves.toEqual([]);

    const acknowledge = vi.fn(async () => undefined);
    await expect(
      new NodeAgentRunner(
        {
          heartbeat: vi.fn(async () => undefined),
          configuration: vi.fn(async () => ({
            ...withoutCommand,
            pendingAcknowledgement: {
              nodeSyncJobId: '22222222-2222-4222-8222-222222222222',
              targetVersion: 2,
              snapshotHash: 'b'.repeat(64),
            },
          })),
          acknowledge,
        },
        restartedAdapter,
      ).runCycle(),
    ).resolves.toBe('acknowledged');
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(restartedRuntime.applyCount).toBe(2);
    await expect(
      readFile(`${statePath}.stop-only.json`, 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries a failed reload before persisting state and acknowledging once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vpn-xray-reload-retry-'));
    directories.push(directory);
    const statePath = join(directory, 'state.json');
    const templatePath = join(directory, 'config.template.json');
    const runtimeConfigPath = join(directory, 'runtime', 'config.json');
    await writeFile(
      templatePath,
      `${JSON.stringify({
        inbounds: [
          {
            tag: 'vless-tcp-tls',
            protocol: 'vless',
            settings: { clients: [], decryption: 'none' },
          },
        ],
      })}\n`,
      'utf8',
    );

    const reloadFailure = new Error('injected xray reload failure');
    let failNextReload = false;
    const executeReloadCommand = vi.fn(async (command: string) => {
      if (command !== 'reload xray') {
        throw new Error('unexpected reload command');
      }
      if (failNextReload) {
        failNextReload = false;
        throw reloadFailure;
      }
    });
    const runtime = new FileXrayRuntime(
      {
        templatePath,
        runtimeConfigPath,
        inboundTag: 'vless-tcp-tls',
        reloadCommand: 'reload xray',
      },
      executeReloadCommand,
    );
    const adapter = new LocalXrayAdapter(statePath, runtime);
    const current = snapshot(1, '11111111-1111-4111-8111-111111111111');
    await expect(adapter.apply(current)).resolves.toBe('applied');
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
      current: { version: 1 },
    });
    executeReloadCommand.mockClear();
    failNextReload = true;

    const acknowledge = vi.fn(async () => undefined);
    const next = snapshot(2, '22222222-2222-4222-8222-222222222222', [
      activeGrant(grantId, credential),
    ]);
    const runner = new NodeAgentRunner(
      {
        heartbeat: vi.fn(async () => undefined),
        configuration: vi.fn(async () => next),
        acknowledge,
      },
      adapter,
    );

    await expect(runner.runCycle()).rejects.toBe(reloadFailure);
    expect(executeReloadCommand).toHaveBeenCalledTimes(1);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
      current: { version: 1 },
    });
    expect(await readFile(runtimeConfigPath, 'utf8')).toContain(credential);

    await expect(runner.runCycle()).resolves.toBe('acknowledged');
    expect(executeReloadCommand).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith(next.pendingAcknowledgement);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
      current: { version: 2 },
      previous: { version: 1 },
    });

    await expect(adapter.apply(next)).resolves.toBe('already-applied');
    expect(executeReloadCommand).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it('does not acknowledge reload exit zero until the serving state matches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vpn-xray-serving-retry-'));
    directories.push(directory);
    const statePath = join(directory, 'state.json');
    const templatePath = join(directory, 'config.template.json');
    const runtimeConfigPath = join(directory, 'runtime', 'config.json');
    await writeFile(
      templatePath,
      `${JSON.stringify({
        inbounds: [
          {
            tag: 'vless-tcp-tls',
            protocol: 'vless',
            settings: { clients: [], decryption: 'none' },
          },
        ],
      })}\n`,
      'utf8',
    );

    let servingClients: readonly XrayServableClient[] = [];
    let publishExpectedClients = false;
    const executeReloadCommand = vi.fn(async () => {
      if (publishExpectedClients) {
        servingClients = [{ grantId, credential }];
      }
    });
    const verifyClients = vi.fn(
      async (expectedClients: readonly XrayServableClient[]) => {
        if (
          JSON.stringify(servingClients) !== JSON.stringify(expectedClients)
        ) {
          throw new Error('injected old Xray serving state');
        }
      },
    );
    const adapter = new LocalXrayAdapter(
      statePath,
      new FileXrayRuntime(
        {
          templatePath,
          runtimeConfigPath,
          inboundTag: 'vless-tcp-tls',
          reloadCommand: 'reload xray',
          servingVerifier: { verifyClients },
        },
        executeReloadCommand,
      ),
    );
    const current = snapshot(1, '11111111-1111-4111-8111-111111111111');
    await adapter.apply(current);
    executeReloadCommand.mockClear();
    verifyClients.mockClear();

    const acknowledge = vi.fn(async () => undefined);
    const next = snapshot(2, '22222222-2222-4222-8222-222222222222', [
      activeGrant(grantId, credential),
    ]);
    const runner = new NodeAgentRunner(
      {
        heartbeat: vi.fn(async () => undefined),
        configuration: vi.fn(async () => next),
        acknowledge,
      },
      adapter,
    );

    await expect(runner.runCycle()).rejects.toThrow(
      'injected old Xray serving state',
    );
    expect(executeReloadCommand).toHaveBeenCalledOnce();
    expect(verifyClients).toHaveBeenCalledOnce();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
      current: { version: 1 },
    });

    publishExpectedClients = true;
    await expect(runner.runCycle()).resolves.toBe('acknowledged');
    expect(executeReloadCommand).toHaveBeenCalledTimes(2);
    expect(verifyClients).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
      current: { version: 2 },
      previous: { version: 1 },
    });

    await expect(adapter.apply(next)).resolves.toBe('already-applied');
    expect(executeReloadCommand).toHaveBeenCalledTimes(2);
    expect(verifyClients).toHaveBeenCalledTimes(3);
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it('retries a failed local-expiry reload without changing durable state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vpn-xray-expiry-retry-'));
    directories.push(directory);
    const statePath = join(directory, 'state.json');
    const templatePath = join(directory, 'config.template.json');
    const runtimeConfigPath = join(directory, 'runtime', 'config.json');
    await writeFile(
      templatePath,
      `${JSON.stringify({
        inbounds: [
          {
            tag: 'vless-tcp-tls',
            protocol: 'vless',
            settings: { clients: [], decryption: 'none' },
          },
        ],
      })}\n`,
      'utf8',
    );

    let now = new Date('2026-08-24T12:00:00.000Z');
    let failNextReload = false;
    const reloadFailure = new Error('injected local expiry reload failure');
    const executeReloadCommand = vi.fn(async () => {
      if (failNextReload) {
        failNextReload = false;
        throw reloadFailure;
      }
    });
    const adapter = new LocalXrayAdapter(
      statePath,
      new FileXrayRuntime(
        {
          templatePath,
          runtimeConfigPath,
          inboundTag: 'vless-tcp-tls',
          reloadCommand: 'reload xray',
        },
        executeReloadCommand,
      ),
      { now: () => now },
    );
    const current = snapshot(1, '11111111-1111-4111-8111-111111111111', [
      activeGrant(grantId, credential, '2026-08-24T12:00:01.000Z'),
    ]);
    await adapter.apply(current);
    const durableState = await readFile(statePath, 'utf8');
    executeReloadCommand.mockClear();
    now = new Date('2026-08-24T12:00:01.000Z');
    failNextReload = true;

    await expect(adapter.reconcileLocalState()).rejects.toBe(reloadFailure);
    expect(executeReloadCommand).toHaveBeenCalledTimes(1);
    expect(await readFile(statePath, 'utf8')).toBe(durableState);
    expect(await readFile(runtimeConfigPath, 'utf8')).not.toContain(credential);

    await expect(adapter.reconcileLocalState()).resolves.toEqual(
      expect.any(Number),
    );
    expect(executeReloadCommand).toHaveBeenCalledTimes(2);
    expect(await readFile(statePath, 'utf8')).toBe(durableState);
  });

  it('keeps secrets, client UUIDs and subscription URLs out of adapter logs', async () => {
    const records: string[] = [];
    const runtime = new InMemoryXrayRuntime();
    const adapter = new LocalXrayAdapter(await stateFile(), runtime, {
      logger: {
        info(fields, message) {
          records.push(`${JSON.stringify(fields)} ${message}`);
        },
      },
    });
    const next = snapshot(1, '11111111-1111-4111-8111-111111111111', [
      activeGrant(grantId, credential),
    ]);

    await adapter.apply(next);
    const joined = records.join('\n');
    expect(joined).toContain('applied');
    expect(joined).not.toContain(credential);
    expect(joined).not.toContain(grantId);
    expect(joined).not.toContain('vless://');
    expect(joined.toLowerCase()).not.toContain('http');
  });
});

describe('FileXrayRuntime', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('materializes clients into local runtime config from a secret-free template', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vpn-xray-runtime-'));
    directories.push(directory);
    const templatePath = join(directory, 'config.template.json');
    const runtimeConfigPath = join(directory, 'runtime', 'config.json');
    await writeFile(
      templatePath,
      `${JSON.stringify(
        {
          inbounds: [
            {
              tag: 'vless-tcp-tls',
              protocol: 'vless',
              settings: { clients: [], decryption: 'none' },
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const runtime = new FileXrayRuntime({
      templatePath,
      runtimeConfigPath,
      inboundTag: 'vless-tcp-tls',
    });

    await runtime.applyClients([{ grantId, credential }]);
    const materialized = JSON.parse(await readFile(runtimeConfigPath, 'utf8'));
    expect(materialized.inbounds[0].settings.clients).toEqual([
      { id: credential, email: grantId },
    ]);
    expect(JSON.parse(await readFile(templatePath, 'utf8'))).toMatchObject({
      inbounds: [{ settings: { clients: [] } }],
    });
  });

  it.skipIf(process.platform === 'win32')(
    'uses the configured protected runtime mode',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'vpn-xray-mode-'));
      directories.push(directory);
      const templatePath = join(directory, 'config.template.json');
      const runtimeConfigPath = join(directory, 'runtime', 'config.json');
      await writeFile(
        templatePath,
        `${JSON.stringify({
          inbounds: [
            {
              tag: 'vless-tcp-tls',
              protocol: 'vless',
              settings: { clients: [], decryption: 'none' },
            },
          ],
        })}\n`,
        'utf8',
      );
      const runtime = new FileXrayRuntime({
        templatePath,
        runtimeConfigPath,
        inboundTag: 'vless-tcp-tls',
        runtimeConfigMode: 0o640,
      });

      await runtime.applyClients([{ grantId, credential }]);

      expect((await stat(runtimeConfigPath)).mode & 0o777).toBe(0o640);

      await chmod(runtimeConfigPath, 0o600);
      await runtime.applyClients([{ grantId, credential }]);

      expect((await stat(runtimeConfigPath)).mode & 0o777).toBe(0o640);
    },
  );

  it('rejects a template that already contains client credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vpn-xray-secret-'));
    directories.push(directory);
    const templatePath = join(directory, 'config.template.json');
    const runtimeConfigPath = join(directory, 'runtime', 'config.json');
    await mkdir(join(directory, 'runtime'), { recursive: true });
    await writeFile(
      templatePath,
      `${JSON.stringify({
        inbounds: [
          {
            tag: 'vless-tcp-tls',
            protocol: 'vless',
            settings: {
              clients: [{ id: credential, email: grantId }],
              decryption: 'none',
            },
          },
        ],
      })}\n`,
      'utf8',
    );

    await expect(
      new FileXrayRuntime({
        templatePath,
        runtimeConfigPath,
        inboundTag: 'vless-tcp-tls',
      }).applyClients([]),
    ).rejects.toThrow('must not contain client credentials');
  });
});
