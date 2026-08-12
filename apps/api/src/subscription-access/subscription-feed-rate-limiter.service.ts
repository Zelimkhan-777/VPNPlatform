import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class SubscriptionFeedRateLimiterService {
  constructor(
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  async assertAllowed(clientIp: string): Promise<void> {
    const windowMs = this.environment.SUBSCRIPTION_FEED_RATE_LIMIT_WINDOW_MS;
    const attempts = await this.redis.incrementWithExpiry(
      `subscription-feed:rate-limit:${clientIp}`,
      windowMs,
    );

    if (attempts > this.environment.SUBSCRIPTION_FEED_RATE_LIMIT_MAX) {
      throw new HttpException(
        'Too many requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
