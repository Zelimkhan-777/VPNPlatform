import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { ApiEnvironment } from '../config/environment';
import { TrustedOriginGuard } from './trusted-origin.guard';

const trustedOrigin = 'https://app.example.test';

function requestContext(origin?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: origin === undefined ? {} : { origin } }),
    }),
  } as ExecutionContext;
}

describe('TrustedOriginGuard', () => {
  const guard = new TrustedOriginGuard({
    CABINET_ORIGIN: trustedOrigin,
  } as ApiEnvironment);

  it('allows the exact trusted cabinet origin', () => {
    expect(guard.canActivate(requestContext(trustedOrigin))).toBe(true);
  });

  it.each([
    ['an absent origin', undefined],
    ['an unrelated origin', 'https://attacker.example.test'],
    ['a same-site sibling origin', 'https://api.example.test'],
  ])('rejects %s', (_scenario, origin) => {
    expect(() => guard.canActivate(requestContext(origin))).toThrow(
      ForbiddenException,
    );
  });
});
