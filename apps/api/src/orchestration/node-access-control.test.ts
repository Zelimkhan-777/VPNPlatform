import { describe, expect, it } from 'vitest';

import {
  isNodeAgentAuthAllowed,
  isNodeEligibleForEmergencyQuarantine,
  isNodeEligibleForNewAssignment,
  isNodeInAccessControlSync,
} from './node-access-control';

describe('node access-control eligibility', () => {
  it('keeps healthy, draining and disabled in sync and only healthy for new assignment', () => {
    expect(isNodeInAccessControlSync('HEALTHY')).toBe(true);
    expect(isNodeInAccessControlSync('DRAINING')).toBe(true);
    expect(isNodeInAccessControlSync('DISABLED')).toBe(true);
    expect(isNodeInAccessControlSync('QUARANTINED')).toBe(false);
    expect(isNodeInAccessControlSync('DELETED')).toBe(false);
    expect(isNodeInAccessControlSync('PROVISIONING')).toBe(false);
    expect(isNodeEligibleForNewAssignment('HEALTHY')).toBe(true);
    expect(isNodeEligibleForNewAssignment('DRAINING')).toBe(false);
    expect(isNodeEligibleForNewAssignment('DISABLED')).toBe(false);
    expect(isNodeEligibleForNewAssignment('QUARANTINED')).toBe(false);
    expect(isNodeAgentAuthAllowed('QUARANTINED')).toBe(true);
    expect(isNodeAgentAuthAllowed('DELETED')).toBe(false);
    expect(isNodeEligibleForEmergencyQuarantine('HEALTHY')).toBe(true);
    expect(isNodeEligibleForEmergencyQuarantine('DRAINING')).toBe(true);
    expect(isNodeEligibleForEmergencyQuarantine('DISABLED')).toBe(true);
    expect(isNodeEligibleForEmergencyQuarantine('QUARANTINED')).toBe(false);
    expect(isNodeEligibleForEmergencyQuarantine('DELETED')).toBe(false);
    expect(isNodeEligibleForEmergencyQuarantine('PROVISIONING')).toBe(false);
  });
});
