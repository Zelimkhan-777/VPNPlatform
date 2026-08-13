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
      {} as never,
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
      {} as never,
    );

    await expect(controller.overview(undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(overview).not.toHaveBeenCalled();
  });

  it('issues a device only for the authenticated session owner', async () => {
    const issue = vi.fn().mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Laptop',
      platform: 'windows',
      status: 'ACTIVE',
      createdAt: '2026-08-12T12:00:00.000Z',
      subscriptionUrl: 'https://sub.example.test/sub/token',
    });
    const controller = new CabinetController(
      {
        currentSessionFromCookie: vi.fn().mockResolvedValue({
          user: {
            id: '22222222-2222-4222-8222-222222222222',
            role: 'CUSTOMER',
          },
          expiresAt: '2026-09-01T00:00:00.000Z',
        }),
      } as unknown as AuthSessionService,
      {} as CabinetService,
      { issue } as never,
    );

    await expect(
      controller.issueDevice(
        { displayName: 'Laptop', platform: 'windows' },
        'vpn_platform_session=valid',
        'https://app.example.test',
        'a77aab04-cfad-4d81-845e-ff90a6b7b651',
      ),
    ).resolves.toMatchObject({ status: 'ACTIVE' });
    expect(issue).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      'https://app.example.test',
      'a77aab04-cfad-4d81-845e-ff90a6b7b651',
      { displayName: 'Laptop', platform: 'windows' },
    );
  });

  it('revokes a device only for the authenticated session owner', async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    const controller = new CabinetController(
      {
        currentSessionFromCookie: vi.fn().mockResolvedValue({
          user: {
            id: '11111111-1111-4111-8111-111111111111',
            role: 'CUSTOMER',
          },
          expiresAt: '2026-09-01T00:00:00.000Z',
        }),
      } as unknown as AuthSessionService,
      {} as CabinetService,
      { revoke } as never,
    );

    await expect(
      controller.revokeDevice(
        '22222222-2222-4222-8222-222222222222',
        'vpn_platform_session=valid',
        'https://app.example.test',
      ),
    ).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'https://app.example.test',
      '22222222-2222-4222-8222-222222222222',
    );
  });
});
