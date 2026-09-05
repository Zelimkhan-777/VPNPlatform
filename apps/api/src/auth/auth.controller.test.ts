import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { ApiEnvironment } from '../config/environment';
import { AuthController } from './auth.controller';
import type { AuthSessionService } from './auth-session.service';
import type { AuthIssuerRateLimiterService } from './auth-issuer-rate-limiter.service';
import type { PendingLoginService } from './pending-login.service';
import { TelegramInitDataValidationError } from './telegram-init-data';

const session = {
  user: { id: '11111111-1111-4111-8111-111111111111', role: 'CUSTOMER' },
  expiresAt: '2026-08-11T13:00:00.000Z',
} as const;

const pending = {
  confirmationCode: '01AB2CD3',
  expiresAt: '2026-08-11T12:02:00.000Z',
} as const;

function environment(
  nodeEnvironment: ApiEnvironment['NODE_ENV'],
): ApiEnvironment {
  return {
    NODE_ENV: nodeEnvironment,
    AUTH_SESSION_TTL_SECONDS: 3_600,
  } as ApiEnvironment;
}

describe('AuthController', () => {
  it('sets an HttpOnly strict pending cookie without returning its secret', async () => {
    const begin = vi.fn().mockResolvedValue({
      pending,
      secret: 'a'.repeat(43),
    });
    const header = vi.fn();
    const controller = new AuthController(
      {} as unknown as AuthSessionService,
      environment('production'),
      { begin } as unknown as PendingLoginService,
      {} as never,
    );

    await expect(
      controller.signIn({ initData: 'signed-data' }, { header }),
    ).resolves.toEqual(pending);
    expect(begin).toHaveBeenCalledWith('signed-data');
    expect(header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(header).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining(`vpn_platform_pending_login=${'a'.repeat(43)}`),
    );
    expect(header).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('SameSite=Strict'),
    );
    expect(header).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('Secure'),
    );
    expect(header).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('Max-Age=120'),
    );
    expect(JSON.stringify(pending)).not.toContain('a'.repeat(43));
    expect(JSON.stringify(pending)).not.toContain('vpn_platform_session');
  });

  it('rejects malformed and invalid Telegram data without setting a cookie', async () => {
    const begin = vi
      .fn()
      .mockRejectedValue(new TelegramInitDataValidationError());
    const controller = new AuthController(
      {} as unknown as AuthSessionService,
      environment('test'),
      { begin } as unknown as PendingLoginService,
      {} as never,
    );
    const reply = { header: vi.fn() };

    await expect(controller.signIn({}, reply)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controller.signIn({ initData: 'signed-data' }, reply),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(reply.header).not.toHaveBeenCalled();
  });

  it('preserves fail-closed dependency failures without setting a cookie', async () => {
    const failure = new ServiceUnavailableException(
      'Telegram login is unavailable',
    );
    const controller = new AuthController(
      {} as unknown as AuthSessionService,
      environment('test'),
      {
        begin: vi.fn().mockRejectedValue(failure),
      } as unknown as PendingLoginService,
      {} as never,
    );
    const reply = { header: vi.fn() };

    await expect(
      controller.signIn({ initData: 'signed-data' }, reply),
    ).rejects.toBe(failure);
    expect(reply.header).not.toHaveBeenCalled();
  });

  it('passes the cookie header to the session service without parsing it in the controller', async () => {
    const currentSessionFromCookie = vi.fn().mockResolvedValue(session);
    const controller = new AuthController(
      { currentSessionFromCookie } as unknown as AuthSessionService,
      environment('test'),
      {} as never,
      {} as never,
    );

    await expect(
      controller.current(`other=value; vpn_platform_session=${'a'.repeat(43)}`),
    ).resolves.toEqual(session);
    expect(currentSessionFromCookie).toHaveBeenCalledWith(
      `other=value; vpn_platform_session=${'a'.repeat(43)}`,
    );
  });

  it('revokes the current session and clears its cookie idempotently', async () => {
    const revokeFromCookie = vi.fn().mockResolvedValue(undefined);
    const header = vi.fn();
    const controller = new AuthController(
      { revokeFromCookie } as unknown as AuthSessionService,
      environment('test'),
      {} as never,
      {} as never,
    );
    await controller.logout(`vpn_platform_session=${'a'.repeat(43)}`, {
      header,
    });
    await controller.logout(undefined, { header });
    expect(revokeFromCookie).toHaveBeenCalledTimes(2);
    expect(header).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('Max-Age=0'),
    );
  });

  it('rate limits complete before reading pending state and replaces its cookie', async () => {
    const order: string[] = [];
    const assertCompletionAllowed = vi.fn().mockImplementation(() => {
      order.push('rate-limit');
    });
    const complete = vi.fn().mockImplementation(() => {
      order.push('complete');
      return { session, secret: 's'.repeat(43) };
    });
    const header = vi.fn();
    const controller = new AuthController(
      {} as never,
      environment('production'),
      { complete } as unknown as PendingLoginService,
      { assertCompletionAllowed } as unknown as AuthIssuerRateLimiterService,
    );

    await expect(
      controller.completeTelegramLogin(
        { ip: '192.0.2.10' },
        `vpn_platform_pending_login=${'p'.repeat(43)}`,
        { header },
      ),
    ).resolves.toEqual(session);
    expect(order).toEqual(['rate-limit', 'complete']);
    expect(assertCompletionAllowed).toHaveBeenCalledWith('192.0.2.10');
    expect(complete).toHaveBeenCalledWith('p'.repeat(43));
    expect(header).toHaveBeenCalledWith('Set-Cookie', [
      expect.stringContaining(`vpn_platform_session=${'s'.repeat(43)}`),
      expect.stringContaining('vpn_platform_pending_login=;'),
    ]);
  });

  it('does not inspect pending state when the complete rate limiter fails closed', async () => {
    const failure = new Error('redis unavailable');
    const complete = vi.fn();
    const controller = new AuthController(
      {} as never,
      environment('test'),
      { complete } as unknown as PendingLoginService,
      {
        assertCompletionAllowed: vi.fn().mockRejectedValue(failure),
      } as unknown as AuthIssuerRateLimiterService,
    );

    await expect(
      controller.completeTelegramLogin(
        { ip: '192.0.2.10' },
        `vpn_platform_pending_login=${'p'.repeat(43)}`,
        { header: vi.fn() },
      ),
    ).rejects.toBe(failure);
    expect(complete).not.toHaveBeenCalled();
  });
});
