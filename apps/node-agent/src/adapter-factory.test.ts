import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNodeAgentDataPlaneAdapter } from './adapter-factory';
import { ChronyClockTrustProbe } from './clock-trust';
import { parseNodeAgentEnvironment } from './environment';
import { StateFileSimulationAdapter } from './simulation-adapter';
import { DockerXrayServingVerifier } from './xray-serving-verifier';

const enabled = {
  NODE_AGENT_ENABLED: 'true',
  NODE_AGENT_API_BASE_URL: 'http://127.0.0.1:3001',
  NODE_AGENT_CREDENTIAL: 'a'.repeat(43),
};

const pendingSnapshot = {
  desiredConfigVersion: 1,
  appliedConfigVersion: 0,
  pendingAcknowledgement: {
    nodeSyncJobId: '11111111-1111-4111-8111-111111111111',
    targetVersion: 1,
    snapshotHash: 'a'.repeat(64),
  },
  grants: [],
  routes: [],
};

describe('createNodeAgentDataPlaneAdapter clock probe wiring', () => {
  const directories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('probes chrony only for production xray adapters', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vpn-adapter-clock-'));
    directories.push(directory);
    const statePath = join(directory, 'state.json');
    const assess = vi.spyOn(ChronyClockTrustProbe.prototype, 'assess');
    assess.mockResolvedValue({
      synchronized: false,
      estimatedAbsoluteErrorMs: null,
      outcome: 'untrusted',
      reason: 'probe-failed',
    });
    vi.spyOn(
      DockerXrayServingVerifier.prototype,
      'stopServing',
    ).mockResolvedValue();

    const simulation = createNodeAgentDataPlaneAdapter(
      parseNodeAgentEnvironment({
        ...enabled,
        NODE_AGENT_MODE: 'simulation',
        NODE_AGENT_STATE_FILE: statePath,
      }),
    );
    expect(simulation).toBeInstanceOf(StateFileSimulationAdapter);
    await expect(simulation.apply(pendingSnapshot)).resolves.toBe('applied');

    const localXray = createNodeAgentDataPlaneAdapter(
      parseNodeAgentEnvironment({
        ...enabled,
        NODE_AGENT_MODE: 'local-xray',
        NODE_AGENT_STATE_FILE: statePath,
      }),
    );
    try {
      await localXray.apply(pendingSnapshot);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toBe('Node clock is untrusted');
    }
    expect(assess).not.toHaveBeenCalled();

    const production = createNodeAgentDataPlaneAdapter(
      parseNodeAgentEnvironment({
        NODE_ENV: 'production',
        ...enabled,
        NODE_AGENT_API_BASE_URL: 'https://api.example.test',
        NODE_AGENT_MODE: 'xray',
        NODE_AGENT_XRAY_RELOAD_COMMAND: 'docker compose restart xray',
        NODE_AGENT_STATE_FILE: statePath,
      }),
    );
    await expect(production.apply(pendingSnapshot)).rejects.toThrow(
      'Node clock is untrusted',
    );
    expect(assess).toHaveBeenCalledTimes(1);
  });
});
