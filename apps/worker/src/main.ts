import { Worker, type ConnectionOptions } from 'bullmq';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);

  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use the redis or rediss protocol');
  }

  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export function createWorker(queueName: string, redisUrl: string): Worker {
  return new Worker(
    queueName,
    async (job) => {
      logger.info(
        { component: 'worker', jobId: job.id, jobName: job.name },
        'Scaffold worker received a job without a registered business processor',
      );
    },
    { connection: redisConnection(redisUrl) },
  );
}

if (process.env.WORKER_ENABLED === 'true') {
  const redisUrl = process.env.REDIS_URL;
  const queueName = process.env.WORKER_QUEUE_NAME;

  if (!redisUrl || !queueName) {
    throw new Error(
      'REDIS_URL and WORKER_QUEUE_NAME are required when WORKER_ENABLED=true',
    );
  }

  createWorker(queueName, redisUrl);
} else {
  logger.info(
    { component: 'worker', active: false },
    'BullMQ worker scaffold is inactive; no business processors are registered',
  );
}
