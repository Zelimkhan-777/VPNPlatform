import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  probeResultSubmissionSchema,
  type AcceptedProbeResult,
} from '@vpn-platform/contracts';
import { PrismaHealthEvidenceStore } from '@vpn-platform/orchestration-store';

import { PrismaService } from '../database/prisma.service';
import { ProbeIngestionRateLimiterService } from './probe-ingestion-rate-limiter.service';
import { ProbeSourceCredentialService } from './probe-source-credential.service';

const isConstraintFailure = (error: unknown) => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown };
  };
  return candidate.code === 'P2004' || candidate.meta?.code === '23514';
};

@Injectable()
export class ProbeIngestionService {
  private readonly evidence: PrismaHealthEvidenceStore;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ProbeSourceCredentialService)
    private readonly credentials: ProbeSourceCredentialService,
    @Inject(ProbeIngestionRateLimiterService)
    private readonly limiter: ProbeIngestionRateLimiterService,
  ) {
    this.evidence = new PrismaHealthEvidenceStore(prisma);
  }

  async ingest(
    bearerSecret: string,
    clientIp: string,
    untrustedBody: unknown,
  ): Promise<AcceptedProbeResult> {
    await this.limiter.assertIpAllowed(clientIp);
    const parsed = probeResultSubmissionSchema.safeParse(untrustedBody);
    if (!parsed.success) {
      throw new BadRequestException('Probe result is invalid');
    }

    try {
      const recorded =
        await this.credentials.withAuthenticatedSourceTransaction(
          bearerSecret,
          async (probeSourceId, transaction) => {
            await this.limiter.assertSourceAllowed(
              probeSourceId,
              parsed.data.affectedScope,
            );
            return this.evidence.recordProbeResultInTransaction(transaction, {
              probeSourceId,
              sourceResultId: parsed.data.sourceResultId,
              affectedScope: parsed.data.affectedScope,
              cycleStartedAt: new Date(parsed.data.cycleStartedAt),
              routeVersion: parsed.data.routeVersion,
              outcome: parsed.data.outcome,
              ...(parsed.data.failureClass
                ? { failureClass: parsed.data.failureClass }
                : {}),
              controlHealthy: parsed.data.controlHealthy,
            });
          },
        );
      if (!recorded) {
        throw new UnauthorizedException('Probe source credential is invalid');
      }
      return {
        probeResultId: recorded.signal.id,
        receivedAt: recorded.signal.receivedAt.toISOString(),
        replayed: recorded.replayed,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Probe result replay key conflicts with stored data'
      ) {
        throw new ConflictException('Probe result replay conflicts with data');
      }
      if (isConstraintFailure(error)) {
        throw new BadRequestException('Probe result is invalid');
      }
      throw error;
    }
  }
}

export const extractProbeBearerSecret = (
  authorization: string | undefined,
): string =>
  /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? '')?.[1] ?? '';
