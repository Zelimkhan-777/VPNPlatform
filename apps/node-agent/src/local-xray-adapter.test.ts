import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NodeAgentConfigurationSnapshot } from '@vpn-platform/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeAgentRunner } from './agent';
import { LocalXrayAdapter } from './local-xray-adapter';
import {
  FileXrayRuntime,
  InMemoryXrayRuntime,
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

  it('does not acknowledge a partial Xray apply or persist it as durable state', async () => {
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
    await expect(runtime.inspectClients()).resolves.toEqual([
      { grantId, credential },
    ]);
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
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
