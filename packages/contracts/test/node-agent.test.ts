import { describe, expect, it } from 'vitest';

import { nodeSyncRequestedEventSchema } from '../src';

describe('nodeSyncRequestedEventSchema', () => {
  const payload = {
    nodeAccessGrantId: '11111111-1111-4111-8111-111111111111',
    nodeSyncJobId: '22222222-2222-4222-8222-222222222222',
    targetVersion: 1,
  };

  it('accepts only the minimal node sync payload', () => {
    expect(nodeSyncRequestedEventSchema.parse(payload)).toEqual(payload);
    expect(() =>
      nodeSyncRequestedEventSchema.parse({
        ...payload,
        secret: 'must-not-cross-the-outbox-boundary',
      }),
    ).toThrow();
  });
});
