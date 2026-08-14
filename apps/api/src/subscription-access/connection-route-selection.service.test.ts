import { describe, expect, it } from 'vitest';

import {
  validateConnectionProfileInput,
  validateEndpointInput,
} from './connection-route-selection.service';

describe('connection route selection input validation', () => {
  it('accepts protocol-neutral public metadata without credentials', () => {
    expect(
      validateEndpointInput({
        addressKind: 'HOSTNAME',
        host: 'fi-1.example.test',
        port: 443,
        priority: 0,
      }),
    ).toMatchObject({ host: 'fi-1.example.test', port: 443 });
    expect(
      validateConnectionProfileInput({
        version: 1,
        priority: 10,
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      }),
    ).toMatchObject({ version: 1, priority: 10 });
  });

  it('rejects invalid endpoint and profile values before persistence', () => {
    expect(() =>
      validateEndpointInput({
        addressKind: 'IPV4',
        host: '999.1.1.1',
        port: 65_536,
        priority: -1,
      }),
    ).toThrow();
    expect(() =>
      validateEndpointInput({
        addressKind: 'IPV6',
        host: '2001:::1',
        port: 443,
        priority: 0,
      }),
    ).toThrow();
    expect(() =>
      validateConnectionProfileInput({
        version: 0,
        priority: -1,
        protocolKind: 'VLESS',
        transportKind: 'TCP',
        securityKind: 'TLS',
        clientCompatibility: 'HAPP',
      }),
    ).toThrow();
  });
});
