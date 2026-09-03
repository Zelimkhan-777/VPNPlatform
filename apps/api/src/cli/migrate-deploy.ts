import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';

import { assertNoLegacyAdmins } from './legacy-admin';

function firstExistingPath(candidates: readonly string[]): string {
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error('Required Prisma runtime path is unavailable');
  return path;
}

async function runPrismaDeploy(): Promise<void> {
  const prismaCli = firstExistingPath([
    resolve(process.cwd(), 'node_modules/prisma/build/index.js'),
    resolve(process.cwd(), '../../node_modules/prisma/build/index.js'),
  ]);
  const schema = firstExistingPath([
    resolve(process.cwd(), 'prisma/schema.prisma'),
    resolve(process.cwd(), '../../prisma/schema.prisma'),
  ]);

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--schema', schema],
      { stdio: 'inherit', env: process.env },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `Prisma migrate deploy failed (${signal ?? String(code ?? 'unknown')})`,
        ),
      );
    });
  });
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await assertNoLegacyAdmins(prisma);
  } finally {
    await prisma.$disconnect();
  }
  await runPrismaDeploy();
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Migration deployment failed'}\n`,
  );
  process.exitCode = 1;
});
