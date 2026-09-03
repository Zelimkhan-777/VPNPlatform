import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

type Queryable = Pick<PrismaClient, '$queryRawUnsafe'>;

export async function countLegacyAdmins(database: Queryable): Promise<number> {
  const tableRows = await database.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT to_regclass(format('%I.%I', current_schema(), 'User')) IS NOT NULL AS exists`,
  );
  if (!tableRows[0]?.exists) return 0;

  const rows = await database.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count
     FROM "User"
     WHERE "role"::text = 'ADMIN'`,
  );
  return Number(rows[0]?.count ?? 0);
}

export async function assertNoLegacyAdmins(database: Queryable): Promise<void> {
  const count = await countLegacyAdmins(database);
  if (count !== 0) {
    throw new Error(
      `Legacy ADMIN preflight failed: ${count} row(s) require admin:demote-legacy-admin`,
    );
  }
}

export async function demoteLegacyAdmins(
  prisma: PrismaClient,
  reason: string,
): Promise<number> {
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 10 || normalizedReason.length > 500) {
    throw new Error('Reason must contain between 10 and 500 characters');
  }

  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended('legacy-admin:demote', 0))`,
    );
    const users = await transaction.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id"
       FROM "User"
       WHERE "role"::text = 'ADMIN'
       ORDER BY "id"
       FOR UPDATE`,
    );

    if (users.length === 0) return 0;

    const updated = await transaction.$executeRawUnsafe(
      `UPDATE "User"
       SET "role" = 'CUSTOMER'::"UserRole", "updatedAt" = clock_timestamp()
       WHERE "role"::text = 'ADMIN'`,
    );
    if (updated !== users.length) {
      throw new Error('Legacy ADMIN set changed during demotion');
    }

    await transaction.auditEvent.createMany({
      data: users.map((user) => ({
        id: randomUUID(),
        actorUserId: null,
        action: 'legacy-admin-demoted',
        entityType: 'User',
        entityId: user.id,
        metadata: {
          previousRole: 'ADMIN',
          newRole: 'CUSTOMER',
          reason: normalizedReason,
          source: 'admin:demote-legacy-admin',
        },
      })),
    });

    return updated;
  });
}
