import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import { ProbeSourceCredentialService } from '../../src/probe-agent/probe-source-credential.service';
import { createInfrastructureTestApp } from './fixture';

describe('infrastructure probe-ingestion', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createInfrastructureTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const createSource = async (status: 'ACTIVE' | 'DISABLED' = 'ACTIVE') => {
    const prisma = app.get(PrismaService);
    const source = await prisma.probeSource.create({
      data: {
        code: `probe-${randomUUID()}`,
        independenceKey: `network-${randomUUID()}`,
        status,
      },
    });
    const credential = await app
      .get(ProbeSourceCredentialService)
      .rotate(source.id);
    return { source, credential };
  };

  const submission = (sourceResultId = `result-${randomUUID()}`) => ({
    sourceResultId,
    affectedScope: { kind: 'ENDPOINT', id: `endpoint:${randomUUID()}` },
    cycleStartedAt: new Date(Date.now() - 1_000).toISOString(),
    routeVersion: 7,
    outcome: 'FAILURE',
    failureClass: 'TCP_TLS',
    controlHealthy: true,
  });

  it('binds a strict submission to its credential and records server receipt time', async () => {
    const prisma = app.get(PrismaService);
    const { source, credential } = await createSource();
    const body = submission();
    const before = Date.now();
    const response = await request(app.getHttpServer())
      .post('/probe-agent/v1/results')
      .set('authorization', `Bearer ${credential.secret}`)
      .set('x-forwarded-for', '192.0.2.41')
      .send(body)
      .expect(200);

    expect(response.body).toMatchObject({ replayed: false });
    expect(new Date(response.body.receivedAt).getTime()).toBeGreaterThanOrEqual(
      before,
    );
    await expect(
      prisma.probeResult.findUniqueOrThrow({
        where: { id: response.body.probeResultId as string },
      }),
    ).resolves.toMatchObject({
      probeSourceId: source.id,
      sourceResultId: body.sourceResultId,
      sourceIndependenceKey: source.independenceKey,
      scopeKind: 'ENDPOINT',
      scopeKey: body.affectedScope.id,
    });
  });

  it('returns the exact retry and rejects a changed replay without mutation', async () => {
    const prisma = app.get(PrismaService);
    const { source, credential } = await createSource();
    const body = submission();
    const first = await request(app.getHttpServer())
      .post('/probe-agent/v1/results')
      .set('authorization', `Bearer ${credential.secret}`)
      .set('x-forwarded-for', '192.0.2.42')
      .send(body)
      .expect(200);
    const replay = await request(app.getHttpServer())
      .post('/probe-agent/v1/results')
      .set('authorization', `Bearer ${credential.secret}`)
      .set('x-forwarded-for', '192.0.2.42')
      .send(body)
      .expect(200);
    expect(replay.body).toEqual({ ...first.body, replayed: true });

    await request(app.getHttpServer())
      .post('/probe-agent/v1/results')
      .set('authorization', `Bearer ${credential.secret}`)
      .set('x-forwarded-for', '192.0.2.42')
      .send({ ...body, routeVersion: 8 })
      .expect(409);
    await expect(
      prisma.probeResult.count({ where: { probeSourceId: source.id } }),
    ).resolves.toBe(1);
  });

  it('rejects malformed bodies and does not accept a caller-supplied source identity', async () => {
    const prisma = app.get(PrismaService);
    const { source, credential } = await createSource();
    await request(app.getHttpServer())
      .post('/probe-agent/v1/results')
      .set('authorization', `Bearer ${credential.secret}`)
      .set('x-forwarded-for', '192.0.2.43')
      .send({ ...submission(), probeSourceId: source.id })
      .expect(400);
    await request(app.getHttpServer())
      .post('/probe-agent/v1/results')
      .set('authorization', `Bearer ${credential.secret}`)
      .set('x-forwarded-for', '192.0.2.43')
      .send({ ...submission(), failureClass: undefined })
      .expect(400);
    await expect(
      prisma.probeResult.count({ where: { probeSourceId: source.id } }),
    ).resolves.toBe(0);
  });

  it('invalidates replaced and explicitly revoked credentials', async () => {
    const credentials = app.get(ProbeSourceCredentialService);
    const { source, credential: first } = await createSource();
    const second = await credentials.rotate(source.id);
    await request(app.getHttpServer())
      .post('/probe-agent/v1/results')
      .set('authorization', `Bearer ${first.secret}`)
      .set('x-forwarded-for', '192.0.2.44')
      .send(submission())
      .expect(401);
    await credentials.revoke(source.id);
    await request(app.getHttpServer())
      .post('/probe-agent/v1/results')
      .set('authorization', `Bearer ${second.secret}`)
      .set('x-forwarded-for', '192.0.2.44')
      .send(submission())
      .expect(401);
  });

  it('rejects disabled sources and future timestamps fail closed', async () => {
    const disabled = await createSource('DISABLED');
    await request(app.getHttpServer())
      .post('/probe-agent/v1/results')
      .set('authorization', `Bearer ${disabled.credential.secret}`)
      .set('x-forwarded-for', '192.0.2.45')
      .send(submission())
      .expect(401);

    const active = await createSource();
    await request(app.getHttpServer())
      .post('/probe-agent/v1/results')
      .set('authorization', `Bearer ${active.credential.secret}`)
      .set('x-forwarded-for', '192.0.2.46')
      .send({
        ...submission(),
        cycleStartedAt: new Date(Date.now() + 60_000).toISOString(),
      })
      .expect(400);
  });
});
