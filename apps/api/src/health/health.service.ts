import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  livenessResponseSchema,
  readinessResponseSchema,
  type LivenessResponse,
  type ReadinessResponse,
} from '@vpn-platform/contracts';

import {
  HEALTH_DEPENDENCY_CHECKER,
  type HealthDependencyChecker,
} from './health.types';

@Injectable()
export class HealthService {
  constructor(
    @Inject(HEALTH_DEPENDENCY_CHECKER)
    private readonly dependencyChecker: HealthDependencyChecker,
  ) {}

  live(): LivenessResponse {
    return livenessResponseSchema.parse({ status: 'ok' });
  }

  async ready(): Promise<ReadinessResponse> {
    const dependencies = await this.dependencyChecker.check();
    const ready = Object.values(dependencies).every(
      (status) => status === 'up',
    );
    const response = readinessResponseSchema.parse({
      status: ready ? 'ready' : 'unavailable',
      dependencies,
    });

    if (!ready) {
      throw new ServiceUnavailableException(response);
    }

    return response;
  }
}
