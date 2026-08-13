import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { withIsolatedIntegrationSchema } from './integration-schema';

type CommandRunner = (
  executable: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
) => Promise<void>;

const runCommand: CommandRunner = (executable, arguments_, environment) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `Integration command failed (${signal ?? String(code ?? 'unknown')})`,
        ),
      );
    });
  });

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for integration tests');
  }
  const prismaCli = resolve(
    process.cwd(),
    '../../node_modules/prisma/build/index.js',
  );
  const vitestCli = resolve(process.cwd(), 'node_modules/vitest/vitest.mjs');
  const prismaSchema = resolve(process.cwd(), '../../prisma/schema.prisma');

  await withIsolatedIntegrationSchema(databaseUrl, async (isolatedUrl) => {
    const environment = { ...process.env, DATABASE_URL: isolatedUrl };
    await runCommand(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--schema', prismaSchema],
      environment,
    );
    await runCommand(
      process.execPath,
      [vitestCli, 'run', 'test/infrastructure.e2e.test.ts'],
      environment,
    );
  });
}

void main();
