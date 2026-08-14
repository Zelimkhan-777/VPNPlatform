import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { DataPlaneCredentialService } from './data-plane-credential.service';

const pepper = 'test-data-plane-credential-pepper-000000000000001';
const binding = {
  grantId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
  nodeId: '33333333-3333-4333-8333-333333333333',
};

describe('DataPlaneCredentialService', () => {
  const service = new DataPlaneCredentialService({
    DATA_PLANE_CREDENTIAL_PEPPER: pepper,
  } as never);

  it('derives the documented deterministic UUID test vector and verifier', () => {
    const credential = service.derive(binding);
    expect(credential).toBe('ce8703d3-b9af-4c51-a3c7-8156b52f697c');
    expect(service.hash(credential)).toBe(
      '089d0d997bad29568ef25f3ea270c5f7beaa7f74c734507dd0b1833c2569f525',
    );
    expect(credential).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('keeps retries stable, separates grants and verifies hashes fail-closed', () => {
    const credential = service.derive(binding);
    expect(service.derive(binding)).toBe(credential);
    expect(service.derive({ ...binding, grantId: randomUUID() })).not.toBe(
      credential,
    );
    expect(service.derive({ ...binding, nodeId: randomUUID() })).not.toBe(
      credential,
    );
    expect(service.verifyHash(credential, service.hash(credential))).toBe(true);
    expect(service.verifyHash(credential, '0'.repeat(64))).toBe(false);
    expect(service.verifyHash(credential, 'malformed')).toBe(false);
  });
});
