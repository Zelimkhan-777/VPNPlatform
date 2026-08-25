import { describe, expect, it } from 'vitest';

import {
  createBullMqJobRetention,
  defaultBullMqJobRetention,
} from './job-retention';

describe('BullMQ job retention', () => {
  it('uses the approved completed and failed history defaults', () => {
    expect(defaultBullMqJobRetention).toEqual({
      removeOnComplete: { age: 604_800, count: 10_000 },
      removeOnFail: { age: 2_592_000, count: 10_000 },
    });
  });

  it('maps validated worker settings to both BullMQ retention limits', () => {
    expect(
      createBullMqJobRetention({
        completedAgeSeconds: 3_600,
        completedCount: 50,
        failedAgeSeconds: 7_200,
        failedCount: 75,
      }),
    ).toEqual({
      removeOnComplete: { age: 3_600, count: 50 },
      removeOnFail: { age: 7_200, count: 75 },
    });
  });
});
