import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import {
  livenessResponseSchema,
  localSubscriptionFeedSchema,
  readinessResponseSchema,
  type DependencyStatus,
} from '@vpn-platform/contracts';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { AppModule } from '../src/app.module';
import {
  HEALTH_DEPENDENCY_CHECKER,
  type HealthDependencyChecker,
} from '../src/health/health.types';

describe('health endpoints', () => {
  let app: INestApplication | undefined;

  beforeAll(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv(
      'DATABASE_URL',
      'postgresql://test:test@127.0.0.1:5432/test?schema=public',
    );
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379');
  });

  const createApp = async (
    postgres: DependencyStatus,
    redis: DependencyStatus,
    subscriptionPrototypeEnabled = false,
  ): Promise<INestApplication> => {
    vi.stubEnv(
      'LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED',
      String(subscriptionPrototypeEnabled),
    );
    vi.stubEnv(
      'LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN',
      'prototype-token-for-local-tests-12345',
    );
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

  afterAll(() => {
    vi.unstubAllEnvs();
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

  it('serves the enabled local subscription fixture as UTF-8 text', async () => {
    const instance = await createApp('up', 'up', true);
    const response = await request(instance.getHttpServer())
      .get('/prototype/subscription/prototype-token-for-local-tests-12345')
      .expect('content-type', /text\/plain; charset=utf-8/)
      .expect(200);

    expect(localSubscriptionFeedSchema.parse(response.text)).toBe(
      '# VPNPlatform local subscription prototype\n',
    );
  });

  it('rejects an invalid local subscription token', async () => {
    const instance = await createApp('up', 'up', true);

    await request(instance.getHttpServer())
      .get('/prototype/subscription/not-the-local-token')
      .expect(401);
  });

  it('hides the local subscription endpoint while it is disabled', async () => {
    const instance = await createApp('up', 'up');

    await request(instance.getHttpServer())
      .get('/prototype/subscription/prototype-token-for-local-tests-12345')
      .expect(404);
  });

  it('includes health and local subscription prototype paths in OpenAPI', async () => {
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
      '/prototype/subscription/{token}',
    ]);
  });
});
