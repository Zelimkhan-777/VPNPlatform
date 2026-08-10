import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';

interface RateLimitWindow {
  startedAt: number;
  attempts: number;
}

@Injectable()
export class SubscriptionPrototypeRateLimiterService {
  private readonly windows = new Map<string, RateLimitWindow>();

  constructor(
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  assertAllowed(clientIp: string): void {
    const now = Date.now();
    const current = this.windows.get(clientIp);
    const windowMs =
      this.environment.LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_WINDOW_MS;

    if (!current || now - current.startedAt >= windowMs) {
      this.windows.set(clientIp, { startedAt: now, attempts: 1 });
      return;
    }

    if (
      current.attempts >=
      this.environment.LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_MAX
    ) {
      throw new HttpException(
        'Too many requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    current.attempts += 1;
  }
}
