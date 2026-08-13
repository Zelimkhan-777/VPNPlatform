import { setTimeout as delay } from 'node:timers/promises';

import { PrismaClient } from '@prisma/client';
import { Queue, type ConnectionOptions } from 'bullmq';
import pino from 'pino';

import { parseWorkerEnvironment } from './environment';
import { OutboxPublisher, PrismaOutboxStore } from './outbox-publisher';

export function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);

  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use the redis or rediss protocol');
  }
  const databasePath = url.pathname === '/' ? '' : url.pathname.slice(1);
  if (databasePath && !/^\d+$/.test(databasePath)) {
    throw new Error('REDIS_URL database must be a non-negative integer');
  }

  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(databasePath ? { db: Number.parseInt(databasePath, 10) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export async function runWorker(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = parseWorkerEnvironment(environment);
  const logger = pino({ level: config.LOG_LEVEL });
  if (!config.WORKER_ENABLED) {
    logger.info(
      { component: 'worker', active: false },
      'Transactional outbox publisher is inactive',
    );
    return;
  }

  const prisma = new PrismaClient({
    datasourceUrl: config.DATABASE_URL as string,
  });
  const queue = new Queue(config.WORKER_QUEUE_NAME, {
    connection: redisConnection(config.REDIS_URL as string),
  });
  const store = new PrismaOutboxStore(
    prisma,
    config.ORCHESTRATION_LEASE_DURATION_MS,
    config.WORKER_RETRY_DELAY_MS,
    config.ORCHESTRATION_MAX_ATTEMPTS,
  );
  const publisher = new OutboxPublisher(store, queue, config.workerId, logger);
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  logger.info(
    {
      component: 'worker',
      active: true,
      workerId: config.workerId,
      queueName: config.WORKER_QUEUE_NAME,
    },
    'Transactional outbox publisher started',
  );

  try {
    while (!abortController.signal.aborted) {
      const result = await publisher.processOne();
      if (result === 'idle') {
        await delay(config.WORKER_POLL_INTERVAL_MS, undefined, {
          signal: abortController.signal,
        }).catch((error: unknown) => {
          if (!abortController.signal.aborted) throw error;
        });
      }
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await Promise.allSettled([queue.close(), prisma.$disconnect()]);
  }
}

if (require.main === module) {
  void runWorker().catch((error: unknown) => {
    const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
    logger.fatal(
      {
        component: 'worker',
        errorType: error instanceof Error ? error.constructor.name : 'Error',
      },
      'Transactional outbox publisher stopped unexpectedly',
    );
    process.exitCode = 1;
  });
}
