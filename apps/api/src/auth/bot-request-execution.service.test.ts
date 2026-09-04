import {
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../database/prisma.service';
import type { AuthenticatedBotRequest } from './bot-request-authentication.service';
import { BotRequestExecutionService } from './bot-request-execution.service';

const authenticatedRequest: AuthenticatedBotRequest = {
  credentialId: '11111111-1111-4111-8111-111111111111',
  principalId: '22222222-2222-4222-8222-222222222222',
  telegramUserId: '123456789',
  method: 'POST',
  path: '/internal/bot/auth/confirm',
  idempotencyKey: 'login-confirmation-1',
  requestHash: 'a'.repeat(64),
};

function harness(existing: Record<string, unknown> | null = null) {
  const findFirst = vi.fn().mockResolvedValue(existing);
  const create = vi.fn().mockResolvedValue({
    id: '33333333-3333-4333-8333-333333333333',
  });
  const update = vi.fn().mockResolvedValue({});
  const lock = vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]);
  const transaction = {
    $queryRaw: lock,
    botRequestIdempotency: { findFirst, create, update },
  };
  const prisma = {
    $transaction: vi.fn((callback: (value: unknown) => unknown) =>
      callback(transaction),
    ),
  } as unknown as PrismaService;
  return {
    create,
    findFirst,
    lock,
    service: new BotRequestExecutionService(prisma),
    update,
  };
}

describe('BotRequestExecutionService', () => {
  it('executes and stores a new response in the same transaction', async () => {
    const { service, create, update } = harness();
    const operation = vi.fn().mockResolvedValue({
      statusCode: 201,
      body: { outcome: 'created' },
    });

    await expect(
      service.execute(authenticatedRequest, operation),
    ).resolves.toEqual({
      statusCode: 201,
      body: { outcome: 'created' },
      replayed: false,
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        principalId: authenticatedRequest.principalId,
        method: authenticatedRequest.method,
        path: authenticatedRequest.path,
        telegramUserId: authenticatedRequest.telegramUserId,
        idempotencyKey: authenticatedRequest.idempotencyKey,
        requestHash: authenticatedRequest.requestHash,
      },
      select: { id: true },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: '33333333-3333-4333-8333-333333333333' },
      data: {
        responseStatus: 201,
        responseBody: { outcome: 'created' },
        completedAt: expect.any(Date),
      },
    });
  });

  it('returns a stored response without executing the operation', async () => {
    const { service } = harness({
      requestHash: authenticatedRequest.requestHash,
      responseStatus: 202,
      responseBody: { outcome: 'accepted' },
      completedAt: new Date(),
    });
    const operation = vi.fn();

    await expect(
      service.execute(authenticatedRequest, operation),
    ).resolves.toEqual({
      statusCode: 202,
      body: { outcome: 'accepted' },
      replayed: true,
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('returns 409 for the same scope with a different request hash', async () => {
    const { service } = harness({
      requestHash: 'b'.repeat(64),
      responseStatus: 200,
      responseBody: { outcome: 'old' },
      completedAt: new Date(),
    });

    await expect(
      service.execute(authenticatedRequest, vi.fn()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('fails closed for an incomplete persisted response', async () => {
    const { service } = harness({
      requestHash: authenticatedRequest.requestHash,
      responseStatus: null,
      responseBody: null,
      completedAt: null,
    });

    await expect(
      service.execute(authenticatedRequest, vi.fn()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('fails closed when the credential was revoked after authentication', async () => {
    const { service, lock } = harness();
    lock.mockResolvedValueOnce([]);
    const operation = vi.fn();

    await expect(
      service.execute(authenticatedRequest, operation),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not complete the idempotency row when the operation fails', async () => {
    const { service, update } = harness();
    const failure = new Error('business transaction failed');

    await expect(
      service.execute(authenticatedRequest, () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(update).not.toHaveBeenCalled();
  });

  it('rolls back an invalid response status instead of caching it', async () => {
    const { service, update } = harness();

    await expect(
      service.execute(authenticatedRequest, () =>
        Promise.resolve({ statusCode: 700, body: { outcome: 'invalid' } }),
      ),
    ).rejects.toThrow('Bot operation returned an invalid HTTP status');
    expect(update).not.toHaveBeenCalled();
  });
});
