import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(API_ENVIRONMENT) environment: ApiEnvironment) {
    super({
      datasources: {
        db: { url: environment.DATABASE_URL },
      },
      log: [],
    });
  }

  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
