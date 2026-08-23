import { describe, expect, it } from 'vitest';

import { access } from 'node:fs/promises';
import { join } from 'node:path';

import {
  VPN_EU_ARTIFACT_DIRECTORY,
  VPN_EU_NODE_NAME,
  assertVpnEuBootstrapAllowed,
  readVpnEuBootstrapInput,
  vpnEuBootstrapRoot,
} from './vpn-eu-bootstrap';
import {
  VPN_EU_BOOTSTRAP_DEFINITION,
  assertVpnNodePublicConfigCompatible,
  type VpnNodeBootstrapInput,
} from './vpn-node-bootstrap';
import {
  VPN_FI_ARTIFACT_DIRECTORY,
  VPN_FI_NODE_NAME,
} from './vpn-fi-bootstrap';

describe('vpn-eu bootstrap', () => {
  it('resolves the repository root from the bootstrap module', async () => {
    await expect(
      access(join(vpnEuBootstrapRoot(), 'pnpm-workspace.yaml')),
    ).resolves.toBeUndefined();
  });

  it('rejects production API environment', () => {
    expect(() =>
      assertVpnEuBootstrapAllowed({ NODE_ENV: 'production' }),
    ).toThrow(/forbidden in production/);
    expect(() =>
      assertVpnEuBootstrapAllowed({ NODE_ENV: 'development' }),
    ).not.toThrow();
  });

  it('requires HTTPS agent API URL and endpoint settings', () => {
    expect(() => readVpnEuBootstrapInput({})).toThrow(/VPN_EU_ENDPOINT_HOST/);
    expect(() =>
      readVpnEuBootstrapInput({
        VPN_EU_ENDPOINT_HOST: '203.0.113.20',
        VPN_EU_TLS_SERVER_NAME: 'nl.example.test',
      }),
    ).toThrow(/VPN_EU_NODE_AGENT_API_BASE_URL/);
    expect(() =>
      readVpnEuBootstrapInput({
        VPN_EU_ENDPOINT_HOST: '203.0.113.20',
        VPN_EU_TLS_SERVER_NAME: 'nl.example.test',
        VPN_EU_NODE_AGENT_API_BASE_URL: 'http://127.0.0.1:3001',
      }),
    ).toThrow(/HTTPS/);
  });

  it('uses safe Amsterdam defaults and accepts explicit settings', () => {
    expect(
      readVpnEuBootstrapInput({
        VPN_EU_ENDPOINT_HOST: '203.0.113.20',
        VPN_EU_TLS_SERVER_NAME: 'nl.example.test',
        VPN_EU_NODE_AGENT_API_BASE_URL: 'https://api-tunnel.example.test',
      }),
    ).toEqual({
      endpointHost: '203.0.113.20',
      tlsServerName: 'nl.example.test',
      nodeAgentApiBaseUrl: 'https://api-tunnel.example.test',
      vpnPort: 443,
      displayName: 'Netherlands',
    });

    expect(
      readVpnEuBootstrapInput({
        VPN_EU_ENDPOINT_HOST: '203.0.113.21',
        VPN_EU_TLS_SERVER_NAME: 'edge.example.test',
        VPN_EU_NODE_AGENT_API_BASE_URL: 'https://api.example.test',
        VPN_EU_VPN_PORT: '8443',
        VPN_EU_DISPLAY_NAME: 'Amsterdam',
      }),
    ).toEqual({
      endpointHost: '203.0.113.21',
      tlsServerName: 'edge.example.test',
      nodeAgentApiBaseUrl: 'https://api.example.test',
      vpnPort: 8443,
      displayName: 'Amsterdam',
    });
  });

  it('cannot overwrite the Finland node or its local artifacts', () => {
    expect(VPN_EU_NODE_NAME).toBe('vpn-eu-1');
    expect(VPN_EU_ARTIFACT_DIRECTORY).toBe('vpn-nl-01');
    expect(VPN_EU_NODE_NAME).not.toBe(VPN_FI_NODE_NAME);
    expect(VPN_EU_ARTIFACT_DIRECTORY).not.toBe(VPN_FI_ARTIFACT_DIRECTORY);
  });

  it('keeps an identical immutable public config and rejects mutations', () => {
    const input: VpnNodeBootstrapInput = {
      endpointHost: '203.0.113.20',
      tlsServerName: 'nl.example.test',
      nodeAgentApiBaseUrl: 'https://api.example.test',
      vpnPort: 443,
      displayName: 'Netherlands',
    };
    expect(() =>
      assertVpnNodePublicConfigCompatible(
        VPN_EU_BOOTSTRAP_DEFINITION,
        1,
        {
          tlsServerName: input.tlsServerName,
          displayName: input.displayName,
        },
        input,
      ),
    ).not.toThrow();
    expect(() =>
      assertVpnNodePublicConfigCompatible(
        VPN_EU_BOOTSTRAP_DEFINITION,
        1,
        {
          tlsServerName: 'old.example.test',
          displayName: input.displayName,
        },
        input,
      ),
    ).toThrow(/immutable.*new profile version/);
  });
});
