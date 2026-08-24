import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseNodeAgentEnvironment } from './environment';
import {
  effectiveControlPlanePollInterval,
  effectiveControlPlaneRetryInterval,
  LOCAL_SECURITY_RETRY_DELAY_MS,
  PRODUCTION_XRAY_MAX_POLL_INTERVAL_MS,
  successfulControlPlaneCycleDelay,
} from './security-timing';

describe('parseNodeAgentEnvironment', () => {
  it('stays disabled without credentials', () => {
    expect(parseNodeAgentEnvironment({})).toMatchObject({
      NODE_AGENT_ENABLED: false,
      NODE_AGENT_MODE: 'simulation',
      NODE_AGENT_POLL_INTERVAL_MS: 30_000,
    });
  });

  it('allows explicit local simulation and rejects unsafe production mode', () => {
    const enabled = {
      NODE_AGENT_ENABLED: 'true',
      NODE_AGENT_API_BASE_URL: 'http://127.0.0.1:3001',
      NODE_AGENT_CREDENTIAL: 'a'.repeat(43),
    };
    expect(parseNodeAgentEnvironment(enabled)).toMatchObject({
      NODE_AGENT_ENABLED: true,
      NODE_AGENT_MODE: 'simulation',
    });
    expect(() => parseNodeAgentEnvironment({ NODE_ENV: 'production' })).toThrow(
      /simulation mode is forbidden in production/,
    );
    expect(() =>
      parseNodeAgentEnvironment({ ...enabled, NODE_ENV: 'production' }),
    ).toThrow(/simulation mode is forbidden in production/);
    expect(() =>
      parseNodeAgentEnvironment({
        ...enabled,
        NODE_ENV: 'production',
        NODE_AGENT_MODE: 'local-xray',
      }),
    ).toThrow(/local-xray mode is forbidden in production/);
    expect(
      parseNodeAgentEnvironment({
        ...enabled,
        NODE_AGENT_MODE: 'local-xray',
      }),
    ).toMatchObject({
      NODE_AGENT_ENABLED: true,
      NODE_AGENT_MODE: 'local-xray',
    });
    expect(() =>
      parseNodeAgentEnvironment({
        NODE_AGENT_MODE: 'xray',
      }),
    ).toThrow(/xray mode is forbidden outside production/);
    expect(
      parseNodeAgentEnvironment({
        NODE_ENV: 'production',
        NODE_AGENT_ENABLED: 'true',
        NODE_AGENT_API_BASE_URL: 'https://api.example.test',
        NODE_AGENT_CREDENTIAL: 'a'.repeat(43),
        NODE_AGENT_MODE: 'xray',
        NODE_AGENT_XRAY_RELOAD_COMMAND: 'docker compose restart xray',
      }),
    ).toMatchObject({
      NODE_AGENT_ENABLED: true,
      NODE_AGENT_MODE: 'xray',
    });
    expect(() =>
      parseNodeAgentEnvironment({
        NODE_ENV: 'production',
        NODE_AGENT_ENABLED: 'true',
        NODE_AGENT_API_BASE_URL: 'https://api.example.test',
        NODE_AGENT_CREDENTIAL: 'a'.repeat(43),
        NODE_AGENT_MODE: 'xray',
      }),
    ).toThrow(/NODE_AGENT_XRAY_RELOAD_COMMAND/);
    expect(() =>
      parseNodeAgentEnvironment({
        ...enabled,
        NODE_AGENT_API_BASE_URL: 'http://control.example.test',
      }),
    ).toThrow();
  });

  it('documents only the safe production reload command', async () => {
    const example = await readFile(
      join(__dirname, '..', '..', '..', '.env.example'),
      'utf8',
    );
    expect(example).toContain(
      'NODE_AGENT_XRAY_RELOAD_COMMAND=docker compose -f infra/docker-compose.vpn-node.yml restart xray',
    );
    expect(example).not.toMatch(
      /NODE_AGENT_XRAY_RELOAD_COMMAND=.*kill -s HUP xray/u,
    );
  });

  it('caps only the effective production Xray poll interval for revoke SLA', () => {
    expect(effectiveControlPlanePollInterval('xray', 300_000)).toBe(
      PRODUCTION_XRAY_MAX_POLL_INTERVAL_MS,
    );
    expect(effectiveControlPlanePollInterval('xray', 30_000)).toBe(30_000);
    expect(effectiveControlPlanePollInterval('simulation', 300_000)).toBe(
      300_000,
    );
    expect(effectiveControlPlanePollInterval('local-xray', 300_000)).toBe(
      300_000,
    );
    expect(
      effectiveControlPlaneRetryInterval(
        'xray',
        PRODUCTION_XRAY_MAX_POLL_INTERVAL_MS,
      ),
    ).toBe(LOCAL_SECURITY_RETRY_DELAY_MS);
    expect(effectiveControlPlaneRetryInterval('simulation', 30_000)).toBe(
      30_000,
    );
    expect(
      successfulControlPlaneCycleDelay('waiting-for-command', 60_000, 10_000),
    ).toBe(10_000);
    expect(
      successfulControlPlaneCycleDelay('synchronized', 60_000, 10_000),
    ).toBe(60_000);
  });
});
