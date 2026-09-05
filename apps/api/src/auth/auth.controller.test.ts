import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { ApiEnvironment } from '../config/environment';
import { AuthController } from './auth.controller';
import type { AuthSessionService } from './auth-session.service';
import type { AuthIssuerRateLimiterService } from './auth-issuer-rate-limiter.service';
import type { PendingLoginService } from './pending-login.service';

const session = {
  user: { id: '11111111-1111-4111-8111-111111111111', role: 'CUSTOMER' },
  expiresAt: '2026-08-11T13:00:00.000Z',
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
  it('sets an HttpOnly, strict session cookie without returning its secret', async () => {
    const signInWithTelegram = vi.fn().mockResolvedValue({
      session,
      secret: 'a'.repeat(43),
    });
    const header = vi.fn();
    const controller = new AuthController(
      { signInWithTelegram } as unknown as AuthSessionService,
      environment('production'),
      {} as never,
      {} as never,
    );

    await expect(
      controller.signIn({ initData: 'signed-data' }, { header }),
    ).resolves.toEqual(session);
    expect(header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(header).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('HttpOnly'),
    );
    expect(header).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('SameSite=Strict'),
    );
    expect(header).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('Secure'),
    );
    expect(JSON.stringify(session)).not.toContain('a'.repeat(43));
  });

  it('rejects malformed request data and a disabled login path', async () => {
    const signInWithTelegram = vi.fn().mockResolvedValue(null);
    const controller = new AuthController(
      { signInWithTelegram } as unknown as AuthSessionService,
      environment('test'),
      {} as never,
      {} as never,
    );
    const reply = { header: vi.fn() };

    await expect(controller.signIn({}, reply)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controller.signIn({ initData: 'signed-data' }, reply),
    ).rejects.toBeInstanceOf(NotFoundException);
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
