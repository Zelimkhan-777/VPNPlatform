import { describe, expect, it } from 'vitest';

import { parseApiEnvironment } from '../config/environment';
import { RedisService } from './redis.service';

describe('RedisService key namespace', () => {
  it('centrally prefixes every logical API key', async () => {
    const redis = new RedisService(
      parseApiEnvironment({
        NODE_ENV: 'test',
        DATABASE_URL:
          'postgresql://test:test@127.0.0.1:5432/test?schema=public',
        REDIS_URL: 'redis://127.0.0.1:6379',
        API_REDIS_KEY_NAMESPACE:
          'api-integration-11111111111141118111111111111111',
      }),
    );

    expect(redis.keyFor('subscription-feed:rate-limit:192.0.2.1')).toBe(
      'api-integration-11111111111141118111111111111111:subscription-feed:rate-limit:192.0.2.1',
    );
    await redis.onModuleDestroy();
  });
});
