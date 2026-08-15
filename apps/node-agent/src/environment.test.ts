import { describe, expect, it } from 'vitest';

import { parseNodeAgentEnvironment } from './environment';

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
        ...enabled,
        NODE_AGENT_API_BASE_URL: 'http://control.example.test',
      }),
    ).toThrow();
  });
});
