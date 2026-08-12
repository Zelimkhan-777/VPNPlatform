import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuthSessionService } from '../auth/auth-session.service';
import type { CabinetService } from './cabinet.service';
import { CabinetController } from './cabinet.controller';

describe('CabinetController', () => {
  it('uses only the authenticated session user id', async () => {
    const currentSessionFromCookie = vi.fn().mockResolvedValue({
      user: { id: '11111111-1111-4111-8111-111111111111', role: 'CUSTOMER' },
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
    const overview = vi.fn().mockResolvedValue({
      subscription: null,
      devices: [],
    });
    const controller = new CabinetController(
      { currentSessionFromCookie } as unknown as AuthSessionService,
      { overview } as unknown as CabinetService,
    );

    await expect(
      controller.overview('vpn_platform_session=valid'),
    ).resolves.toEqual({
      subscription: null,
      devices: [],
    });
    expect(overview).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('rejects requests without a valid session before querying cabinet data', async () => {
    const overview = vi.fn();
    const controller = new CabinetController(
      {
        currentSessionFromCookie: vi.fn().mockResolvedValue(null),
      } as unknown as AuthSessionService,
      { overview } as unknown as CabinetService,
    );

    await expect(controller.overview(undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(overview).not.toHaveBeenCalled();
  });
});
