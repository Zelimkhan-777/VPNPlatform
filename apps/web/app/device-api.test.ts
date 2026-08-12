import { describe, expect, it, vi } from 'vitest';

import { issueCabinetDevice } from './device-api';
import type { DeviceApiError } from './device-api';

const issuedDevice = {
  id: '82ef72a5-0c97-4fbd-9600-c64db2d01ca9',
  displayName: 'Мой ноутбук',
  platform: null,
  status: 'ACTIVE' as const,
  createdAt: '2026-08-12T12:00:00.000Z',
  subscriptionUrl: 'https://sub.example.test/sub/opaque-test-token',
};
const idempotencyKey = 'a77aab04-cfad-4d81-845e-ff90a6b7b651';

describe('issueCabinetDevice', () => {
  it('uses the same-origin proxy and accepts only the issued-device contract', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(issuedDevice), { status: 201 }),
      );

    await expect(
      issueCabinetDevice(
        { displayName: 'Мой ноутбук' },
        idempotencyKey,
        fetcher,
      ),
    ).resolves.toEqual(issuedDevice);
    expect(fetcher).toHaveBeenCalledWith('/api/cabinet/devices', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ displayName: 'Мой ноутбук' }),
    });
  });

  it('does not submit malformed input', async () => {
    const fetcher = vi.fn();

    await expect(
      issueCabinetDevice({ displayName: '   ' }, idempotencyKey, fetcher),
    ).rejects.toMatchObject({
      kind: 'invalid-request',
    } satisfies Partial<DeviceApiError>);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('surfaces capacity conflicts without exposing a subscription URL', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 409 }));

    await expect(
      issueCabinetDevice({ displayName: 'Телефон' }, idempotencyKey, fetcher),
    ).rejects.toMatchObject({
      kind: 'conflict',
    } satisfies Partial<DeviceApiError>);
  });

  it('rejects an issued response with fields outside the public contract', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ...issuedDevice, tokenHash: 'must-not-reach-ui' }),
          { status: 201 },
        ),
      );

    await expect(
      issueCabinetDevice({ displayName: 'Телефон' }, idempotencyKey, fetcher),
    ).rejects.toMatchObject({
      kind: 'invalid-response',
    } satisfies Partial<DeviceApiError>);
  });
});
