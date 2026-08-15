import { afterAll, describe, expect, it } from 'vitest';

import { parseApiEnvironment } from '../src/config/environment';
import { RedisService } from '../src/redis/redis.service';

const redis = new RedisService(parseApiEnvironment(process.env));

describe('intentional API integration cleanup probe', () => {
  afterAll(async () => {
    await redis.onModuleDestroy();
  });

  it('creates only a namespaced key before the child suite fails', async () => {
    await redis.incrementWithExpiry('cleanup-probe', 60_000);
    expect(process.env.API_INTEGRATION_EXPECT_FAILURE).toBe('true');
    throw new Error('intentional isolated API suite failure');
  });
});
