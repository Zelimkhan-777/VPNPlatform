import { describe, expect, it, vi } from 'vitest';

import { DeviceApiError } from './device-api';
import { recoverFromDeviceRevokeError } from './device-revoke-flow';

describe('device revoke recovery', () => {
  it('leaves the stale authenticated state after 401 and reloads authentication', async () => {
    const onAuthenticationRequired = vi.fn().mockResolvedValue(undefined);
    const onNotFound = vi.fn();

    await expect(
      recoverFromDeviceRevokeError(
        new DeviceApiError('Session is unavailable', 'unauthenticated'),
        { onAuthenticationRequired, onNotFound },
      ),
    ).resolves.toBe(true);
    expect(onAuthenticationRequired).toHaveBeenCalledOnce();
    expect(onNotFound).not.toHaveBeenCalled();
  });

  it('refreshes the overview after a concurrent 404', async () => {
    const onAuthenticationRequired = vi.fn();
    const onNotFound = vi.fn().mockResolvedValue(undefined);

    await expect(
      recoverFromDeviceRevokeError(
        new DeviceApiError('Device was not found', 'not-found'),
        { onAuthenticationRequired, onNotFound },
      ),
    ).resolves.toBe(true);
    expect(onNotFound).toHaveBeenCalledOnce();
    expect(onAuthenticationRequired).not.toHaveBeenCalled();
  });

  it.each(['forbidden', 'unavailable'] as const)(
    'keeps an explicit retryable error after %s',
    async (kind) => {
      const onAuthenticationRequired = vi.fn();
      const onNotFound = vi.fn();

      await expect(
        recoverFromDeviceRevokeError(
          new DeviceApiError('Revoke failed', kind),
          { onAuthenticationRequired, onNotFound },
        ),
      ).resolves.toBe(false);
      expect(onAuthenticationRequired).not.toHaveBeenCalled();
      expect(onNotFound).not.toHaveBeenCalled();
    },
  );
});
