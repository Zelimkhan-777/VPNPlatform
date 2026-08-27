import { Inject, Injectable } from '@nestjs/common';
import { PrismaSubscriptionAccessStore } from '@vpn-platform/orchestration-store';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class NodeAccessReconciler {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  reconcileBeforeHealthy(nodeId: string): Promise<boolean> {
    const pepper = this.environment.DATA_PLANE_CREDENTIAL_PEPPER;
    if (!pepper) {
      throw new Error('Data-plane credential pepper is not configured');
    }
    return new PrismaSubscriptionAccessStore(
      this.prisma,
      pepper,
    ).reconcileNodeBeforeHealthy(nodeId);
  }
}
