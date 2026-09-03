import { createInterface } from 'node:readline/promises';

import { PrismaClient } from '@prisma/client';

import { demoteLegacyAdmins } from './legacy-admin';

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive TTY is required');
  }

  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const confirmation = await prompt.question(
      'Type DEMOTE LEGACY ADMIN to continue: ',
    );
    if (confirmation !== 'DEMOTE LEGACY ADMIN') {
      throw new Error('Confirmation did not match');
    }
    const reason = await prompt.question('Reason (10-500 characters): ');
    const prisma = new PrismaClient();
    try {
      const count = await demoteLegacyAdmins(prisma, reason);
      process.stdout.write(`Legacy ADMIN demotion completed: count=${count}\n`);
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    prompt.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Legacy ADMIN demotion failed'}\n`,
  );
  process.exitCode = 1;
});
