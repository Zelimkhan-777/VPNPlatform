import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import {
  livenessResponseSchema,
  readinessResponseSchema,
  type DependencyStatus,
} from '@vpn-platform/contracts';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import {
  HEALTH_DEPENDENCY_CHECKER,
  type HealthDependencyChecker,
} from '../src/health/health.types';

describe('health endpoints', () => {
  let app: INestApplication | undefined;

  const createApp = async (
    postgres: DependencyStatus,
    redis: DependencyStatus,
  ): Promise<INestApplication> => {
    const checker: HealthDependencyChecker = {
      check: async () => ({ postgres, redis }),
    };
    const testingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HEALTH_DEPENDENCY_CHECKER)
      .useValue(checker)
      .compile();

    const instance = testingModule.createNestApplication(new FastifyAdapter(), {
      logger: false,
    });
    await instance.init();
    await instance.getHttpAdapter().getInstance().ready();
    app = instance;

    return instance;
  };

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('GET /health/live reports a live process', async () => {
    const instance = await createApp('down', 'down');
    const response = await request(instance.getHttpServer())
      .get('/health/live')
      .expect(200);

    expect(livenessResponseSchema.parse(response.body)).toEqual({
      status: 'ok',
    });
  });

  it('GET /health/ready reports ready dependencies', async () => {
    const instance = await createApp('up', 'up');
    const response = await request(instance.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect(readinessResponseSchema.parse(response.body)).toEqual({
      status: 'ready',
      dependencies: { postgres: 'up', redis: 'up' },
    });
  });

  it('GET /health/ready returns 503 when a dependency is down', async () => {
    const instance = await createApp('up', 'down');
    const response = await request(instance.getHttpServer())
      .get('/health/ready')
      .expect(503);

    expect(readinessResponseSchema.parse(response.body)).toEqual({
      status: 'unavailable',
      dependencies: { postgres: 'up', redis: 'down' },
    });
  });

  it('keeps the OpenAPI contract limited to the two health paths', async () => {
    const instance = await createApp('up', 'up');
    const document = SwaggerModule.createDocument(
      instance,
      new DocumentBuilder()
        .setTitle('VPNPlatform API')
        .setVersion('0.1.0')
        .build(),
    );

    expect(Object.keys(document.paths).sort()).toEqual([
      '/health/live',
      '/health/ready',
    ]);
  });
});
