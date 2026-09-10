import { PrismaClient } from '@prisma/client';

import { remediateLegacyPlans } from './legacy-plan-remediation';

type Arguments = {
  keepPlanCode: string;
  deletePlanCodes: string[];
  reason: string;
  confirmation: string;
};

function readArguments(argv: readonly string[]): Arguments {
  const result: Arguments = {
    keepPlanCode: '',
    deletePlanCodes: [],
    reason: '',
    confirmation: '',
  };

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || value === undefined) {
      throw new Error('Every remediation flag requires a value');
    }
    if (flag === '--keep-plan-code') result.keepPlanCode = value;
    else if (flag === '--delete-plan-code') result.deletePlanCodes.push(value);
    else if (flag === '--reason') result.reason = value;
    else if (flag === '--confirm') result.confirmation = value;
    else throw new Error(`Unknown remediation flag: ${flag}`);
  }

  if (result.confirmation !== 'DELETE_ORPHAN_PLANS') {
    throw new Error('Confirmation did not match DELETE_ORPHAN_PLANS');
  }
  return result;
}

async function main(): Promise<void> {
  const input = readArguments(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const count = await remediateLegacyPlans(prisma, input);
    process.stdout.write(`Legacy plan remediation completed: count=${count}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Legacy plan remediation failed'}\n`,
  );
  process.exitCode = 1;
});
