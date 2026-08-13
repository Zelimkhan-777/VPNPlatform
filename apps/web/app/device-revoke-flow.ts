import { DeviceApiError } from './device-api';

export type DeviceRevokeRecovery = {
  onAuthenticationRequired: () => Promise<void>;
  onNotFound: () => Promise<void>;
};

export async function recoverFromDeviceRevokeError(
  error: unknown,
  recovery: DeviceRevokeRecovery,
): Promise<boolean> {
  if (!(error instanceof DeviceApiError)) {
    return false;
  }
  try {
    if (error.kind === 'unauthenticated') {
      await recovery.onAuthenticationRequired();
      return true;
    }
    if (error.kind === 'not-found') {
      await recovery.onNotFound();
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
