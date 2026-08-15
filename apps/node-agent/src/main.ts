import { setTimeout as delay } from 'node:timers/promises';

import pino from 'pino';

import { createNodeAgentDataPlaneAdapter } from './adapter-factory';
import { NodeAgentRunner } from './agent';
import { HttpNodeAgentControlPlane } from './control-plane-client';
import { parseNodeAgentEnvironment } from './environment';

export async function runNodeAgent(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = parseNodeAgentEnvironment(environment);
  const logger = pino({ level: config.LOG_LEVEL });
  if (!config.NODE_AGENT_ENABLED) {
    logger.info(
      { component: 'node-agent', active: false },
      'Node agent is inactive',
    );
    return;
  }

  const runner = new NodeAgentRunner(
    new HttpNodeAgentControlPlane(
      config.NODE_AGENT_API_BASE_URL as string,
      config.NODE_AGENT_CREDENTIAL as string,
      config.NODE_AGENT_REQUEST_TIMEOUT_MS,
    ),
    createNodeAgentDataPlaneAdapter(config, {
      info(fields, message) {
        logger.info(fields, message);
      },
    }),
  );
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  logger.info(
    { component: 'node-agent', active: true, mode: config.NODE_AGENT_MODE },
    'Node agent started',
  );
  try {
    while (!abortController.signal.aborted) {
      try {
        const outcome = await runner.runCycle();
        logger.info(
          { component: 'node-agent', outcome },
          'Node-agent cycle completed',
        );
      } catch (error) {
        logger.warn(
          {
            component: 'node-agent',
            errorType:
              error instanceof Error ? error.constructor.name : 'Error',
          },
          'Node-agent cycle failed',
        );
      }
      await delay(config.NODE_AGENT_POLL_INTERVAL_MS, undefined, {
        signal: abortController.signal,
      }).catch((error: unknown) => {
        if (!abortController.signal.aborted) throw error;
      });
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (require.main === module) {
  void runNodeAgent().catch((error: unknown) => {
    const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
    logger.fatal(
      {
        component: 'node-agent',
        errorType: error instanceof Error ? error.constructor.name : 'Error',
      },
      'Node-agent runtime stopped unexpectedly',
    );
    process.exitCode = 1;
  });
}
