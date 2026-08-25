import { Controller, Get, Inject, type INestApplication } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { DestinationStream } from 'pino';
import { PinoLogger } from 'nestjs-pino';
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
import { API_LOG_DESTINATION } from '../src/config/config.module';
import { SubscriptionPrototypeService } from '../src/subscription-prototype/subscription-prototype.service';
import {
  HEALTH_DEPENDENCY_CHECKER,
  type HealthDependencyChecker,
} from '../src/health/health.types';

@Controller('__test/safe-logger')
class SafeLoggerProbeController {
  constructor(@Inject(PinoLogger) private readonly logger: PinoLogger) {}

  @Get('assign')
  assignBindings(): { ok: true } {
    this.logger.assign({
      session: 'api-child-session-secret',
      nodeId: 'e10d1c51-81d6-4d8f-aad4-9fb1bd0c317c',
      challengeVerifier: 'api-child-challenge-secret',
      nested: {
        request: {
          method: 'POST',
          url: '/auth/logout?session=api-child-url-secret',
          headers: { cookie: 'session=api-child-cookie-secret' },
        },
      },
    });
    this.logger.info(
      { component: 'api', outcome: 'assigned', active: true, retryCount: 2 },
      'safe assign probe',
    );
    return { ok: true };
  }

  @Get('throwing-assign')
  assignThrowingBindings(): { ok: true } {
    const bindings = new Proxy(Object.create(null) as Record<string, unknown>, {
      ownKeys() {
        throw new Error(
          'api-child-proxy-secret redis://user:password@192.0.2.60:6379',
        );
      },
    });
    this.logger.assign(bindings);
    this.logger.info(
      { component: 'must-not-survive' },
      'caller message must not survive',
    );
    return { ok: true };
  }
}

function assertPublicOpenApi(document: Record<string, unknown>): void {
  const serialized = JSON.stringify(document);
  for (const forbidden of [
    'sessionSecret',
    'challengeSecret',
    'prelaunchSecret',
    'challengeToken',
    'sessionToken',
    'telegramReplayHash',
    'tokenHash',
    'replayHash',
    'TrustedPrelaunchService',
  ]) {
    expect(serialized).not.toContain(forbidden);
  }

  const paths = document.paths as Record<string, Record<string, unknown>>;
  expect(paths).not.toHaveProperty('/auth/challenge');
  expect(paths).toHaveProperty('/auth/telegram');
  const telegram = paths['/auth/telegram']?.post as {
    requestBody?: {
      content?: Record<string, { schema?: Record<string, unknown> }>;
    };
    responses?: Record<
      string,
      { content?: Record<string, { schema?: Record<string, unknown> }> }
    >;
  };
  const requestSchema =
    telegram.requestBody?.content?.['application/json']?.schema;
  expect(requestSchema?.properties).toHaveProperty('initData');
  const initData = (requestSchema?.properties as Record<string, unknown>)
    ?.initData as Record<string, unknown> | undefined;
  expect(initData).not.toHaveProperty('example');
  expect(initData).not.toHaveProperty('default');
  expect(
    telegram.responses?.['200']?.content?.['application/json']?.schema,
  ).toEqual(
    expect.objectContaining({
      additionalProperties: false,
      required: ['user', 'expiresAt'],
      properties: expect.objectContaining({
        user: expect.any(Object),
        expiresAt: expect.any(Object),
      }),
    }),
  );
  for (const response of Object.values(telegram.responses ?? {})) {
    expect(JSON.stringify(response.content ?? {})).not.toContain('initData');
  }

  for (const secretExample of [
    'vpn_platform_session=',
    'vpn_platform_prelaunch=',
    'Set-Cookie',
    '/sub/opaque-',
  ]) {
    expect(serialized).not.toContain(secretExample);
  }
}

describe('health endpoints', () => {
  let app: INestApplication | undefined;

  beforeAll(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv(
      'DATABASE_URL',
      'postgresql://test:test@127.0.0.1:5432/test?schema=public',
    );
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379');
    vi.stubEnv('CABINET_ORIGIN', 'https://app.example.test');
  });

  const createApp = async (
    postgres: DependencyStatus,
    redis: DependencyStatus,
    subscriptionPrototypeEnabled = false,
    subscriptionPrototypeContent?: string,
    logDestination?: DestinationStream,
    includeLoggerProbe = false,
  ): Promise<INestApplication> => {
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv(
      'DATABASE_URL',
      'postgresql://test:test@127.0.0.1:5432/test?schema=public',
    );
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379');
    vi.stubEnv('CABINET_ORIGIN', 'https://app.example.test');
    vi.stubEnv(
      'LOCAL_SUBSCRIPTION_PROTOTYPE_ENABLED',
      String(subscriptionPrototypeEnabled),
    );
    vi.stubEnv(
      'LOCAL_SUBSCRIPTION_PROTOTYPE_TOKEN',
      'prototype-token-for-local-tests-12345',
    );
    if (subscriptionPrototypeContent) {
      vi.stubEnv(
        'LOCAL_SUBSCRIPTION_PROTOTYPE_CONTENT',
        subscriptionPrototypeContent,
      );
    }
    const checker: HealthDependencyChecker = {
      check: async () => ({ postgres, redis }),
    };
    const testingModuleBuilder = Test.createTestingModule({
      imports: [AppModule],
      controllers: includeLoggerProbe ? [SafeLoggerProbeController] : [],
    })
      .overrideProvider(HEALTH_DEPENDENCY_CHECKER)
      .useValue(checker);
    if (logDestination !== undefined) {
      testingModuleBuilder
        .overrideProvider(API_LOG_DESTINATION)
        .useValue(logDestination);
    }
    const testingModule = await testingModuleBuilder.compile();

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

  it('applies safe logger options in the real Nest and Fastify pipeline', async () => {
    const lines: string[] = [];
    const instance = await createApp('up', 'down', false, undefined, {
      write(line) {
        lines.push(line);
      },
    });
    lines.length = 0;

    await request(instance.getHttpServer())
      .get('/health/ready?session=pipeline-query-secret')
      .set('authorization', 'Bearer pipeline-auth-secret')
      .set('cookie', 'vpn_platform_session=pipeline-cookie-secret')
      .set('x-forwarded-for', '2001:db8::7')
      .expect(503);

    const records = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const requestRecords = records.filter((record) => record.req !== undefined);
    expect(requestRecords).toHaveLength(1);
    const logRecord = requestRecords[0];
    expect(logRecord).toMatchObject({
      req: { method: 'GET' },
      res: { statusCode: 503 },
      err: { type: 'Error' },
    });
    expect(logRecord?.req).toEqual({ method: 'GET' });
    expect(logRecord?.res).toEqual({ statusCode: 503 });
    expect(logRecord?.err).toEqual({ type: 'Error' });

    const serialized = JSON.stringify(logRecord);
    expect(serialized).not.toMatch(
      /health\/ready|pipeline-query-secret|pipeline-auth-secret|pipeline-cookie-secret|2001:db8::7|headers|remoteAddress|remotePort|stack|message/,
    );
  });

  it('protects the real request-scoped PinoLogger.assign child path', async () => {
    const lines: string[] = [];
    const instance = await createApp(
      'up',
      'up',
      false,
      undefined,
      {
        write(line) {
          lines.push(line);
        },
      },
      true,
    );
    lines.length = 0;

    await request(instance.getHttpServer())
      .get('/__test/safe-logger/assign')
      .expect(200);

    const assigned = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.msg === 'safe assign probe');
    expect(assigned).toMatchObject({
      session: '[REDACTED]',
      nodeId: '[REDACTED]',
      challengeVerifier: '[REDACTED]',
      nested: { request: { method: 'POST' } },
      component: 'api',
      outcome: 'assigned',
      active: true,
      retryCount: 2,
    });
    expect(JSON.stringify(assigned)).not.toMatch(
      /api-child-session-secret|e10d1c51|api-child-challenge-secret|api-child-url-secret|api-child-cookie-secret|headers|url/,
    );

    lines.length = 0;
    await request(instance.getHttpServer())
      .get('/__test/safe-logger/throwing-assign')
      .expect(200);

    const failureLines = lines.filter((line) =>
      line.includes('"sanitizationFailure":true'),
    );
    expect(failureLines).toHaveLength(1);
    const failureLine = failureLines[0] ?? '';
    expect(JSON.parse(failureLine)).toMatchObject({
      sanitizationFailure: true,
      msg: '[REDACTED]',
    });
    expect(failureLine.match(/"sanitizationFailure"/g) ?? []).toHaveLength(1);
    expect(failureLine).not.toMatch(
      /api-child-proxy-secret|password|192\.0\.2\.60|redis:\/\/|must-not-survive|caller message/,
    );
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
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('serves locally configured fixture content without persisting it', async () => {
    const content =
      'vless://11111111-1111-4111-8111-111111111111@127.0.0.1:1?encryption=none&security=none&type=tcp#VPNPlatform-local-fixture';
    const instance = await createApp('up', 'up', true, content);
    expect(
      instance
        .get(SubscriptionPrototypeService)
        .feed('prototype-token-for-local-tests-12345'),
    ).toBe(`${content}\n`);
    const response = await request(instance.getHttpServer())
      .get('/prototype/subscription/prototype-token-for-local-tests-12345')
      .expect('content-type', /text\/plain; charset=utf-8/);

    expect(response.status).toBe(200);
    expect(localSubscriptionFeedSchema.parse(response.text)).toBe(
      `${content}\n`,
    );
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects an invalid local subscription token', async () => {
    const instance = await createApp('up', 'up', true);

    await request(instance.getHttpServer())
      .get('/prototype/subscription/not-the-local-token')
      .expect(401);
  });

  it('rejects a malformed local subscription token', async () => {
    const instance = await createApp('up', 'up', true);

    await request(instance.getHttpServer())
      .get('/prototype/subscription/short-token')
      .expect(401);
  });

  it('hides the local subscription endpoint while it is disabled', async () => {
    const instance = await createApp('up', 'up');

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await request(instance.getHttpServer())
        .get('/prototype/subscription/prototype-token-for-local-tests-12345')
        .expect(404);
    }
  });

  it('limits requests to the local subscription prototype', async () => {
    const instance = await createApp('up', 'up', true);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(instance.getHttpServer())
        .get('/prototype/subscription/not-the-local-token')
        .expect(401);
    }

    await request(instance.getHttpServer())
      .get('/prototype/subscription/not-the-local-token')
      .expect(429);
  });

  it('requires the exact trusted origin while keeping logout idempotent', async () => {
    const instance = await createApp('up', 'up');
    const trustedLogout = () =>
      request(instance.getHttpServer())
        .post('/auth/logout')
        .set('origin', 'https://app.example.test');

    await trustedLogout().expect(204);
    await trustedLogout().expect(204);
    await request(instance.getHttpServer()).post('/auth/logout').expect(403);
    await request(instance.getHttpServer())
      .post('/auth/logout')
      .set('origin', 'https://attacker.example.test')
      .expect(403);
    await request(instance.getHttpServer())
      .post('/auth/logout')
      .set('origin', 'https://api.example.test')
      .expect(403);
  });

  it('wires the trusted origin guard to device issue and revoke routes', async () => {
    const instance = await createApp('up', 'up');
    const guardedRoutes = [
      '/cabinet/devices',
      '/cabinet/devices/not-a-uuid/revoke',
    ];
    const rejectedOrigins = [
      undefined,
      'https://attacker.example.test',
      'https://api.example.test',
    ];

    for (const route of guardedRoutes) {
      for (const origin of rejectedOrigins) {
        const call = request(instance.getHttpServer())
          .post(route)
          .send({ displayName: 123 });
        if (origin !== undefined) call.set('origin', origin);
        await call.expect(403);
      }

      await request(instance.getHttpServer())
        .post(route)
        .set('origin', 'https://app.example.test')
        .send({ displayName: 123 })
        .expect(400);
    }
  });

  it('keeps the committed OpenAPI contract synchronized with Swagger', async () => {
    const instance = await createApp('up', 'up');
    const document = SwaggerModule.createDocument(
      instance,
      new DocumentBuilder()
        .setTitle('VPNPlatform API')
        .setVersion('0.1.0')
        .addBearerAuth({
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'opaque',
        })
        .build(),
    );

    expect(Object.keys(document.paths).sort()).toEqual([
      '/auth/logout',
      '/auth/me',
      '/auth/telegram',
      '/cabinet/devices',
      '/cabinet/devices/{deviceId}/revoke',
      '/cabinet/overview',
      '/health/live',
      '/health/ready',
      '/node-agent/v1/acknowledgements',
      '/node-agent/v1/configuration',
      '/node-agent/v1/heartbeats',
      '/prototype/subscription/{token}',
      '/sub/{token}',
    ]);
    expect(
      document.paths['/prototype/subscription/{token}']?.get?.responses,
    ).toHaveProperty('429');
    expect(document.paths['/sub/{token}']?.get?.responses).toHaveProperty(
      '401',
    );
    expect(document.paths['/cabinet/devices']?.post?.responses).toHaveProperty(
      '201',
    );
    expect(
      document.paths['/node-agent/v1/acknowledgements']?.post?.responses,
    ).toHaveProperty('204');
    expect(
      document.paths['/node-agent/v1/configuration']?.get?.responses,
    ).toHaveProperty('200');
    expect(
      document.paths['/node-agent/v1/heartbeats']?.post?.responses,
    ).toHaveProperty('204');
    const logout = document.paths['/auth/logout']?.post;
    expect(logout?.parameters).toContainEqual(
      expect.objectContaining({
        name: 'origin',
        in: 'header',
        required: true,
      }),
    );
    expect(logout?.responses).toHaveProperty('204');
    expect(logout?.responses).toHaveProperty('403');
    expect(document.components?.securitySchemes).toHaveProperty('bearer');
    const committed = await readFile(
      resolve(process.cwd(), 'openapi.json'),
      'utf8',
    ).then(JSON.parse);
    const generated = JSON.parse(JSON.stringify(document));
    expect(committed).toEqual(generated);
    assertPublicOpenApi(generated);
    assertPublicOpenApi(committed);
  });
});
