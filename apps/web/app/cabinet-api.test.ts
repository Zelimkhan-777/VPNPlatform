import { describe, expect, it, vi } from 'vitest';

import { fetchCabinetOverview } from './cabinet-api';
import type { CabinetApiError } from './cabinet-api';

describe('fetchCabinetOverview', () => {
  it('requests the same-origin proxy and parses a safe overview', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          subscription: null,
          devices: [],
        }),
        { status: 200 },
      ),
    );

    await expect(fetchCabinetOverview(fetcher)).resolves.toEqual({
      subscription: null,
      devices: [],
    });
    expect(fetcher).toHaveBeenCalledWith('/api/cabinet/overview', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });

  it('does not treat an absent session as cabinet data', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));

    await expect(fetchCabinetOverview(fetcher)).rejects.toMatchObject({
      kind: 'unauthenticated',
    } satisfies Partial<CabinetApiError>);
  });

  it('rejects a response that contains fields outside the public contract', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          subscription: null,
          devices: [],
          tokenHash: 'must-not-render',
        }),
        { status: 200 },
      ),
    );

    await expect(fetchCabinetOverview(fetcher)).rejects.toMatchObject({
      kind: 'invalid-response',
    } satisfies Partial<CabinetApiError>);
  });
});
