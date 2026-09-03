import { PrismaClient } from '@prisma/client';

import { assertNoLegacyAdmins } from './legacy-admin';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await assertNoLegacyAdmins(prisma);
    process.stdout.write('Legacy ADMIN preflight: count=0\n');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Legacy ADMIN preflight failed'}\n`,
  );
  process.exitCode = 1;
});
