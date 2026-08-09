import type { DependencyStatus } from '@vpn-platform/contracts';

export const HEALTH_DEPENDENCY_CHECKER = Symbol('HEALTH_DEPENDENCY_CHECKER');

export interface HealthDependencyChecker {
  check(): Promise<{
    postgres: DependencyStatus;
    redis: DependencyStatus;
  }>;
}
