import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';

export const DATA_PLANE_CREDENTIAL_DERIVATION_VERSION = 1;

export type DataPlaneCredentialBinding = {
  grantId: string;
  deviceId: string;
  nodeId: string;
};

/**
 * Derives the future data-plane client identifier without persisting its
 * plaintext. The two HMAC domains prevent a stored verifier from being used
 * as a credential (or vice versa).
 */
@Injectable()
export class DataPlaneCredentialService {
  constructor(
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  derive(binding: DataPlaneCredentialBinding): string {
    const digest = this.hmac('credential:v1', binding).subarray(0, 16);
    // RFC 4122 variant and UUIDv4 wire format. Entropy originates in HMAC,
    // while the stable grant binding makes retries deterministic.
    digest[6] = (digest[6]! & 0x0f) | 0x40;
    digest[8] = (digest[8]! & 0x3f) | 0x80;
    const hex = digest.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  hash(credential: string): string {
    return this.hmac('verifier:v1', credential).toString('hex');
  }

  verifyHash(credential: string, storedHash: string): boolean {
    const expected = Buffer.from(this.hash(credential), 'hex');
    const actual = /^[a-f0-9]{64}$/.test(storedHash)
      ? Buffer.from(storedHash, 'hex')
      : Buffer.alloc(expected.length);
    return (
      timingSafeEqual(expected, actual) && /^[a-f0-9]{64}$/.test(storedHash)
    );
  }

  private hmac(domain: string, value: DataPlaneCredentialBinding | string) {
    const pepper = this.environment.DATA_PLANE_CREDENTIAL_PEPPER;
    if (!pepper) {
      throw new Error('Data-plane credential pepper is not configured');
    }
    const material =
      typeof value === 'string'
        ? value
        : `${value.grantId}\0${value.deviceId}\0${value.nodeId}`;
    return createHmac('sha256', pepper)
      .update(`vpn-platform:data-plane:${domain}\0`)
      .update(material)
      .digest();
  }
}
