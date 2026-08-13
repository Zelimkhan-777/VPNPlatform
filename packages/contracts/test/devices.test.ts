import { describe, expect, it } from 'vitest';

import { cabinetDeviceIdSchema } from '../src';

describe('cabinetDeviceIdSchema', () => {
  it('accepts only UUID device identifiers', () => {
    expect(
      cabinetDeviceIdSchema.parse('11111111-1111-4111-8111-111111111111'),
    ).toBe('11111111-1111-4111-8111-111111111111');
    expect(() => cabinetDeviceIdSchema.parse('not-a-device-id')).toThrow();
  });
});
