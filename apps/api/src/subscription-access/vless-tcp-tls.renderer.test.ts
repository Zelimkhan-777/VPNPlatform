import { describe, expect, it } from 'vitest';

import {
  isValidTlsServerName,
  isValidVlessDisplayName,
  renderVlessTcpTls,
} from './vless-tcp-tls.renderer';
import { vlessPublicConfigValidationMatrix } from './vless-public-config.validation-matrix';

describe('renderVlessTcpTls', () => {
  const base = {
    host: '2001:db8::1',
    addressKind: 'IPV6' as const,
    port: 443,
    credential: '11111111-1111-4111-8111-111111111111',
    tlsServerName: 'sni.example.test',
    displayName: 'Happ route',
  };
  it('renders one canonical escaped URI', () => {
    expect(renderVlessTcpTls(base)).toBe(
      'vless://11111111-1111-4111-8111-111111111111@[2001:db8::1]:443?encryption=none&security=tls&type=tcp&sni=sni.example.test#Happ%20route',
    );
  });
  it('fails closed for control-character injection', () => {
    expect(
      renderVlessTcpTls({ ...base, displayName: 'route\nnext' }),
    ).toBeNull();
  });

  it.each(vlessPublicConfigValidationMatrix)(
    'matches the public config validation matrix: $name',
    ({ field, value, accepted }) => {
      const actual =
        field === 'tlsServerName'
          ? isValidTlsServerName(value)
          : isValidVlessDisplayName(value);
      expect(actual).toBe(accepted);
    },
  );
});
