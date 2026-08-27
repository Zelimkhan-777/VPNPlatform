import { createHmac, timingSafeEqual } from 'node:crypto';

export const DATA_PLANE_CREDENTIAL_DERIVATION_VERSION = 1;

export type DataPlaneCredentialBinding = {
  grantId: string;
  deviceId: string;
  nodeId: string;
};

export function deriveDataPlaneCredential(
  pepper: string,
  binding: DataPlaneCredentialBinding,
): string {
  const digest = hmac(pepper, 'credential:v1', binding).subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function hashDataPlaneCredential(
  pepper: string,
  credential: string,
): string {
  return hmac(pepper, 'verifier:v1', credential).toString('hex');
}

export function verifyDataPlaneCredentialHash(
  pepper: string,
  credential: string,
  storedHash: string,
): boolean {
  const expected = Buffer.from(
    hashDataPlaneCredential(pepper, credential),
    'hex',
  );
  const validStoredHash = /^[a-f0-9]{64}$/.test(storedHash);
  const actual = validStoredHash
    ? Buffer.from(storedHash, 'hex')
    : Buffer.alloc(expected.length);
  return timingSafeEqual(expected, actual) && validStoredHash;
}

function hmac(
  pepper: string,
  domain: string,
  value: DataPlaneCredentialBinding | string,
): Buffer {
  if (!pepper)
    throw new Error('Data-plane credential pepper is not configured');
  const material =
    typeof value === 'string'
      ? value
      : `${value.grantId}\0${value.deviceId}\0${value.nodeId}`;
  return createHmac('sha256', pepper)
    .update(`vpn-platform:data-plane:${domain}\0`)
    .update(material)
    .digest();
}
