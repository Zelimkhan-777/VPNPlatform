import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { nodeAgentAcknowledgementOpenApiSchema } from '@vpn-platform/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { NodeAgentCredentialService } from '../src/orchestration/node-agent-credential.service';
import { OrchestrationService } from '../src/orchestration/orchestration.service';

describe('node-agent acknowledgement HTTP contract', () => {
  const nodeId = '11111111-1111-4111-8111-111111111111';
  const bearerToken = 'a'.repeat(43);
  const acknowledgement = {
    nodeSyncJobId: '22222222-2222-4222-8222-222222222222',
    targetVersion: 1,
    snapshotHash: 'b'.repeat(64),
  };
  const acknowledgeNodeConfigInTransaction = vi
    .fn()
    .mockResolvedValue(undefined);
  const withAuthenticatedNodeTransaction = vi.fn(
    async (
      _token: string,
      action: (authenticatedNodeId: string, transaction: object) => unknown,
    ) => action(nodeId, {}),
  );
  let app: INestApplication;

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv(
      'DATABASE_URL',
      'postgresql://test:test@127.0.0.1:5432/test?schema=public',
    );
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379');
    vi.stubEnv('CABINET_ORIGIN', 'https://app.example.test');

    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(NodeAgentCredentialService)
      .useValue({ withAuthenticatedNodeTransaction })
      .overrideProvider(OrchestrationService)
      .useValue({ acknowledgeNodeConfigInTransaction })
      .compile();

    app = module.createNestApplication(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('accepts the exact contract and passes only validated fields downstream', async () => {
    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${bearerToken}`)
      .send(acknowledgement)
      .expect(204);

    expect(withAuthenticatedNodeTransaction).toHaveBeenCalledWith(
      bearerToken,
      expect.any(Function),
    );
    expect(acknowledgeNodeConfigInTransaction).toHaveBeenCalledWith(
      expect.any(Object),
      { nodeId, ...acknowledgement },
    );
  });

  it.each([
    ['missing nodeSyncJobId', { ...acknowledgement, nodeSyncJobId: undefined }],
    ['missing targetVersion', { ...acknowledgement, targetVersion: undefined }],
    ['missing snapshotHash', { ...acknowledgement, snapshotHash: undefined }],
    ['an extra field', { ...acknowledgement, futureField: 'not-supported' }],
    ['an invalid UUID', { ...acknowledgement, nodeSyncJobId: 'not-a-uuid' }],
    ['a negative version', { ...acknowledgement, targetVersion: -1 }],
    ['a fractional version', { ...acknowledgement, targetVersion: 1.5 }],
    ['an invalid hash', { ...acknowledgement, snapshotHash: 'not-a-hash' }],
  ])('rejects %s before authentication or mutation', async (_case, body) => {
    withAuthenticatedNodeTransaction.mockClear();
    acknowledgeNodeConfigInTransaction.mockClear();

    await request(app.getHttpServer())
      .post('/node-agent/v1/acknowledgements')
      .set('authorization', `Bearer ${bearerToken}`)
      .send(body)
      .expect(400);

    expect(withAuthenticatedNodeTransaction).not.toHaveBeenCalled();
    expect(acknowledgeNodeConfigInTransaction).not.toHaveBeenCalled();
  });

  it('publishes the exact runtime-derived request schema', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('contract test')
        .setVersion('test')
        .build(),
    );
    const operation = document.paths['/node-agent/v1/acknowledgements']?.post;
    const requestBody = operation?.requestBody;

    expect(requestBody).not.toHaveProperty('$ref');
    if (requestBody === undefined || '$ref' in requestBody) {
      throw new Error('Acknowledgement request body must be inline');
    }
    expect(requestBody.content['application/json']?.schema).toEqual(
      nodeAgentAcknowledgementOpenApiSchema,
    );
  });
});
