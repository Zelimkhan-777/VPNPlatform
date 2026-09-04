import {
  Body,
  Controller,
  type INestApplication,
  Post,
  UseGuards,
} from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BotRequestAuthenticationGuard } from './bot-request-authentication.guard';
import { BotRequestAuthenticationService } from './bot-request-authentication.service';

@Controller('internal/bot/raw-body-probe')
class RawBodyProbeController {
  @Post()
  @UseGuards(BotRequestAuthenticationGuard)
  probe(@Body() body: unknown): unknown {
    return body;
  }
}

describe('bot request raw-body boundary', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('passes the exact incoming JSON bytes to authentication', async () => {
    const rawBody = '{"telegramUserId":"123456789","code":"ABC"}';
    const authenticate = vi
      .fn()
      .mockImplementation((input: { rawBody: Buffer }) => {
        expect(input.rawBody.equals(Buffer.from(rawBody))).toBe(true);
        return Promise.resolve({
          credentialId: '11111111-1111-4111-8111-111111111111',
          idempotencyKey: 'raw-body-probe-1',
          method: 'POST',
          path: '/internal/bot/raw-body-probe',
          principalId: '22222222-2222-4222-8222-222222222222',
          requestHash: 'b'.repeat(64),
          telegramUserId: '123456789',
        });
      });
    const module = await Test.createTestingModule({
      controllers: [RawBodyProbeController],
      providers: [
        BotRequestAuthenticationGuard,
        {
          provide: BotRequestAuthenticationService,
          useValue: { authenticate },
        },
      ],
    }).compile();
    app = module.createNestApplication(new FastifyAdapter(), {
      logger: false,
      rawBody: true,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    await request(app.getHttpServer())
      .post('/internal/bot/raw-body-probe')
      .set('content-type', 'application/json')
      .set('x-bot-credential-id', '11111111-1111-4111-8111-111111111111')
      .set('idempotency-key', 'raw-body-probe-1')
      .set('x-bot-timestamp', '1788436800')
      .set('x-bot-nonce', '0123456789abcdef')
      .set('x-bot-signature', 'a'.repeat(64))
      .send(rawBody)
      .expect(201)
      .expect({ telegramUserId: '123456789', code: 'ABC' });
    expect(authenticate).toHaveBeenCalledOnce();
  });
});
