import { Inject, Injectable } from '@nestjs/common';
import {
  DATA_PLANE_CREDENTIAL_DERIVATION_VERSION,
  deriveDataPlaneCredential,
  hashDataPlaneCredential,
  verifyDataPlaneCredentialHash,
  type DataPlaneCredentialBinding,
} from '@vpn-platform/orchestration-store';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';

export { DATA_PLANE_CREDENTIAL_DERIVATION_VERSION };
export type { DataPlaneCredentialBinding };

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
    return deriveDataPlaneCredential(this.pepper(), binding);
  }

  hash(credential: string): string {
    return hashDataPlaneCredential(this.pepper(), credential);
  }

  verifyHash(credential: string, storedHash: string): boolean {
    return verifyDataPlaneCredentialHash(this.pepper(), credential, storedHash);
  }

  private pepper(): string {
    const pepper = this.environment.DATA_PLANE_CREDENTIAL_PEPPER;
    if (!pepper) {
      throw new Error('Data-plane credential pepper is not configured');
    }
    return pepper;
  }
}
