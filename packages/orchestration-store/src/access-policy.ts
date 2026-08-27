export const SUBSCRIPTION_STATUSES = [
  'PENDING',
  'ACTIVE',
  'EXPIRED',
  'CANCELLED',
] as const;

export type SubscriptionLifecycleStatus =
  (typeof SUBSCRIPTION_STATUSES)[number];

export type EffectiveSubscription = {
  status: SubscriptionLifecycleStatus;
  expiresAt: Date | null;
};

export function effectiveSubscriptionStatus(
  subscription: EffectiveSubscription,
  databaseTime: Date,
): SubscriptionLifecycleStatus {
  if (
    subscription.status === 'ACTIVE' &&
    (subscription.expiresAt === null ||
      subscription.expiresAt.getTime() <= databaseTime.getTime())
  ) {
    return 'EXPIRED';
  }
  return subscription.status;
}

export function hasEntitlement(
  input: {
    deviceStatus: 'ACTIVE' | 'REVOKED';
    subscription: EffectiveSubscription;
  },
  databaseTime: Date,
): boolean {
  return (
    input.deviceStatus === 'ACTIVE' &&
    effectiveSubscriptionStatus(input.subscription, databaseTime) === 'ACTIVE'
  );
}

export function isGrantConverged(input: {
  status: 'PENDING' | 'ACTIVE' | 'REVOKED';
  expiresAt: Date;
  desiredVersion: number;
  appliedVersion: number;
  databaseTime: Date;
}): boolean {
  return (
    input.status === 'ACTIVE' &&
    input.expiresAt.getTime() > input.databaseTime.getTime() &&
    input.appliedVersion === input.desiredVersion
  );
}

export function isRouteReady(input: {
  hasEntitlement: boolean;
  grantConverged: boolean;
  nodeStatus: string;
  routeActive: boolean;
  routeActivationVersion: number | null;
  nodeAppliedVersion: number;
}): boolean {
  return (
    input.hasEntitlement &&
    input.grantConverged &&
    input.nodeStatus === 'HEALTHY' &&
    input.routeActive &&
    input.routeActivationVersion !== null &&
    input.routeActivationVersion <= input.nodeAppliedVersion
  );
}
