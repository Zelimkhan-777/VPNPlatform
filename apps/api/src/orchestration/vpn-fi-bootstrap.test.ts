import { describe, expect, it } from 'vitest';

import { access } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertVpnFiBootstrapAllowed,
  readVpnFiBootstrapInput,
  vpnFiBootstrapRoot,
} from './vpn-fi-bootstrap';

describe('vpn-fi bootstrap', () => {
  it('resolves the repository root from the bootstrap module', async () => {
    await expect(
      access(join(vpnFiBootstrapRoot(), 'pnpm-workspace.yaml')),
    ).resolves.toBeUndefined();
  });

  it('rejects production API environment', () => {
    expect(() =>
      assertVpnFiBootstrapAllowed({ NODE_ENV: 'production' }),
    ).toThrow(/forbidden in production/);
    expect(() =>
      assertVpnFiBootstrapAllowed({ NODE_ENV: 'development' }),
    ).not.toThrow();
  });

  it('requires HTTPS agent API URL and endpoint settings', () => {
    expect(() => readVpnFiBootstrapInput({})).toThrow(/VPN_FI_ENDPOINT_HOST/);
    expect(() =>
      readVpnFiBootstrapInput({
        VPN_FI_ENDPOINT_HOST: '203.0.113.10',
        VPN_FI_TLS_SERVER_NAME: 'fi.example.test',
      }),
    ).toThrow(/VPN_FI_NODE_AGENT_API_BASE_URL/);
    expect(() =>
      readVpnFiBootstrapInput({
        VPN_FI_ENDPOINT_HOST: '203.0.113.10',
        VPN_FI_TLS_SERVER_NAME: 'fi.example.test',
        VPN_FI_NODE_AGENT_API_BASE_URL: 'http://127.0.0.1:3001',
      }),
    ).toThrow(/HTTPS/);
    expect(
      readVpnFiBootstrapInput({
        VPN_FI_ENDPOINT_HOST: '203.0.113.10',
        VPN_FI_TLS_SERVER_NAME: 'fi.example.test',
        VPN_FI_NODE_AGENT_API_BASE_URL: 'https://api-tunnel.example.test',
        VPN_FI_DISPLAY_NAME: 'Finland',
        VPN_FI_VPN_PORT: '443',
      }),
    ).toEqual({
      endpointHost: '203.0.113.10',
      tlsServerName: 'fi.example.test',
      nodeAgentApiBaseUrl: 'https://api-tunnel.example.test',
      vpnPort: 443,
      displayName: 'Finland',
    });
  });
});
