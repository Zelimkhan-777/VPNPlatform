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
    if (!this.environment.LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED) {
      return;
    }

    const now = Date.now();
    this.removeExpiredWindows(now);
    const current = this.windows.get(clientIp);
    const windowMs =
      this.environment.LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_WINDOW_MS;

    if (!current || now - current.startedAt >= windowMs) {
      if (
        !current &&
        this.windows.size >=
          this.environment.LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_MAX_CLIENTS
      ) {
        throw new HttpException(
          'Too many requests',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

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

  private removeExpiredWindows(now: number): void {
    const windowMs =
      this.environment.LOCAL_SUBSCRIPTION_PROTOTYPE_RATE_LIMIT_WINDOW_MS;

    for (const [clientIp, window] of this.windows) {
      if (now - window.startedAt >= windowMs) {
        this.windows.delete(clientIp);
      }
    }
  }
}
