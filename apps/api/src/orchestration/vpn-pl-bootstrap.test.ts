import { describe, expect, it } from 'vitest';

import { access } from 'node:fs/promises';
import { join } from 'node:path';

import {
  VPN_PL_ARTIFACT_DIRECTORY,
  VPN_PL_NODE_NAME,
  assertVpnPlBootstrapAllowed,
  readVpnPlBootstrapInput,
  vpnPlBootstrapRoot,
} from './vpn-pl-bootstrap';
import {
  VPN_EU_ARTIFACT_DIRECTORY,
  VPN_EU_NODE_NAME,
} from './vpn-eu-bootstrap';
import {
  VPN_FI_ARTIFACT_DIRECTORY,
  VPN_FI_NODE_NAME,
} from './vpn-fi-bootstrap';
import {
  VPN_PL_BOOTSTRAP_DEFINITION,
  assertVpnNodePublicConfigCompatible,
  type VpnNodeBootstrapInput,
} from './vpn-node-bootstrap';

describe('vpn-pl bootstrap', () => {
  it('resolves the repository root from the bootstrap module', async () => {
    await expect(
      access(join(vpnPlBootstrapRoot(), 'pnpm-workspace.yaml')),
    ).resolves.toBeUndefined();
  });

  it('rejects production API environment', () => {
    expect(() =>
      assertVpnPlBootstrapAllowed({ NODE_ENV: 'production' }),
    ).toThrow(/forbidden in production/);
    expect(() =>
      assertVpnPlBootstrapAllowed({ NODE_ENV: 'development' }),
    ).not.toThrow();
  });

  it('requires HTTPS agent API URL and endpoint settings', () => {
    expect(() => readVpnPlBootstrapInput({})).toThrow(/VPN_PL_ENDPOINT_HOST/);
    expect(() =>
      readVpnPlBootstrapInput({
        VPN_PL_ENDPOINT_HOST: '203.0.113.30',
        VPN_PL_TLS_SERVER_NAME: 'pl.example.test',
      }),
    ).toThrow(/VPN_PL_NODE_AGENT_API_BASE_URL/);
    expect(() =>
      readVpnPlBootstrapInput({
        VPN_PL_ENDPOINT_HOST: '203.0.113.30',
        VPN_PL_TLS_SERVER_NAME: 'pl.example.test',
        VPN_PL_NODE_AGENT_API_BASE_URL: 'http://127.0.0.1:3001',
      }),
    ).toThrow(/HTTPS/);
  });

  it('uses Poland defaults and accepts explicit settings', () => {
    expect(
      readVpnPlBootstrapInput({
        VPN_PL_ENDPOINT_HOST: '203.0.113.30',
        VPN_PL_TLS_SERVER_NAME: 'pl.example.test',
        VPN_PL_NODE_AGENT_API_BASE_URL: 'https://api-tunnel.example.test',
      }),
    ).toEqual({
      endpointHost: '203.0.113.30',
      tlsServerName: 'pl.example.test',
      nodeAgentApiBaseUrl: 'https://api-tunnel.example.test',
      vpnPort: 443,
      displayName: 'Poland',
    });

    expect(
      readVpnPlBootstrapInput({
        VPN_PL_ENDPOINT_HOST: '203.0.113.31',
        VPN_PL_TLS_SERVER_NAME: 'edge.example.test',
        VPN_PL_NODE_AGENT_API_BASE_URL: 'https://api.example.test',
        VPN_PL_VPN_PORT: '8443',
        VPN_PL_DISPLAY_NAME: 'Warsaw',
      }),
    ).toEqual({
      endpointHost: '203.0.113.31',
      tlsServerName: 'edge.example.test',
      nodeAgentApiBaseUrl: 'https://api.example.test',
      vpnPort: 8443,
      displayName: 'Warsaw',
    });
  });

  it('keeps a new Poland identity and does not reuse Finland or Amsterdam', () => {
    expect(VPN_PL_NODE_NAME).toBe('vpn-pl-1');
    expect(VPN_PL_ARTIFACT_DIRECTORY).toBe('vpn-pl-01');
    expect(VPN_PL_BOOTSTRAP_DEFINITION.attachLocalHarnessDevice).toBe(false);
    expect(VPN_PL_BOOTSTRAP_DEFINITION.locationPool).toEqual({
      code: 'poland',
      publicLabel: 'Poland',
      candidateLimit: 2,
      role: 'STANDBY',
    });
    expect(VPN_PL_NODE_NAME).not.toBe(VPN_FI_NODE_NAME);
    expect(VPN_PL_NODE_NAME).not.toBe(VPN_EU_NODE_NAME);
    expect(VPN_PL_ARTIFACT_DIRECTORY).not.toBe(VPN_FI_ARTIFACT_DIRECTORY);
    expect(VPN_PL_ARTIFACT_DIRECTORY).not.toBe(VPN_EU_ARTIFACT_DIRECTORY);
  });

  it('does not read Finland or Amsterdam bootstrap environment', () => {
    expect(() =>
      readVpnPlBootstrapInput({
        VPN_FI_ENDPOINT_HOST: '203.0.113.10',
        VPN_FI_TLS_SERVER_NAME: 'fi.example.test',
        VPN_FI_NODE_AGENT_API_BASE_URL: 'https://api.example.test',
        VPN_EU_ENDPOINT_HOST: '203.0.113.20',
        VPN_EU_TLS_SERVER_NAME: 'nl.example.test',
        VPN_EU_NODE_AGENT_API_BASE_URL: 'https://api.example.test',
      }),
    ).toThrow(/VPN_PL_ENDPOINT_HOST/);
  });

  it('keeps an identical immutable public config and rejects mutations', () => {
    const input: VpnNodeBootstrapInput = {
      endpointHost: '203.0.113.30',
      tlsServerName: 'pl.example.test',
      nodeAgentApiBaseUrl: 'https://api.example.test',
      vpnPort: 443,
      displayName: 'Poland',
    };
    expect(() =>
      assertVpnNodePublicConfigCompatible(
        VPN_PL_BOOTSTRAP_DEFINITION,
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
        VPN_PL_BOOTSTRAP_DEFINITION,
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
