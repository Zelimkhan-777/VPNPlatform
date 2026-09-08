import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHmac, randomBytes } from 'node:crypto';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';

const credentialPattern = /^[A-Za-z0-9_-]{43}$/;
const hashDomain = 'probe-source-credential-v1\0';

export type IssuedProbeSourceCredential = {
  credentialId: string;
  secret: string;
};

@Injectable()
export class ProbeSourceCredentialService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  async rotate(probeSourceId: string): Promise<IssuedProbeSourceCredential> {
    const secret = randomBytes(32).toString('base64url');
    const secretHash = this.hashSecret(secret);

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`probe-source-credential:${probeSourceId}`}, 0)
        )
      `;
      await transaction.probeSource.findUniqueOrThrow({
        where: { id: probeSourceId },
        select: { id: true },
      });
      await transaction.$executeRaw`
        UPDATE "ProbeSourceCredential"
        SET "revokedAt" = clock_timestamp()
        WHERE "probeSourceId" = CAST(${probeSourceId} AS uuid)
          AND "revokedAt" IS NULL
      `;
      const credential = await transaction.probeSourceCredential.create({
        data: { probeSourceId, secretHash },
        select: { id: true },
      });
      await transaction.auditEvent.create({
        data: {
          action: 'probe-source-credential.rotated',
          entityType: 'ProbeSource',
          entityId: probeSourceId,
          metadata: { credentialId: credential.id },
        },
      });
      return { credentialId: credential.id, secret };
    });
  }

  async revoke(probeSourceId: string): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`probe-source-credential:${probeSourceId}`}, 0)
        )
      `;
      const changed = await transaction.$executeRaw`
        UPDATE "ProbeSourceCredential"
        SET "revokedAt" = clock_timestamp()
        WHERE "probeSourceId" = CAST(${probeSourceId} AS uuid)
          AND "revokedAt" IS NULL
      `;
      if (changed === 0) return false;
      await transaction.auditEvent.create({
        data: {
          action: 'probe-source-credential.revoked',
          entityType: 'ProbeSource',
          entityId: probeSourceId,
        },
      });
      return true;
    });
  }

  async withAuthenticatedSourceTransaction<T>(
    secret: string,
    operation: (
      probeSourceId: string,
      transaction: Prisma.TransactionClient,
    ) => Promise<T>,
  ): Promise<T | null> {
    if (!credentialPattern.test(secret)) return null;

    return this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<{ probeSourceId: string }[]>`
        SELECT credential."probeSourceId"::text AS "probeSourceId"
        FROM "ProbeSourceCredential" AS credential
        INNER JOIN "ProbeSource" AS source
          ON source.id = credential."probeSourceId"
        WHERE credential."secretHash" = ${this.hashSecret(secret)}
          AND credential."revokedAt" IS NULL
          AND source.status = 'ACTIVE'
        FOR UPDATE OF credential, source
      `;
      if (!rows[0]) return null;
      return operation(rows[0].probeSourceId, transaction);
    });
  }

  private hashSecret(secret: string): string {
    const pepper = this.environment.PROBE_SOURCE_CREDENTIAL_PEPPER;
    if (!pepper) {
      throw new Error('Probe source credential pepper is not configured');
    }
    return createHmac('sha256', pepper)
      .update(hashDomain)
      .update(secret)
      .digest('hex');
  }
}
