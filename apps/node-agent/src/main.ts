import { setTimeout as delay } from 'node:timers/promises';

import pino from 'pino';

import { createNodeAgentDataPlaneAdapter } from './adapter-factory';
import { NodeAgentRunner } from './agent';
import { HttpNodeAgentControlPlane } from './control-plane-client';
import { parseNodeAgentEnvironment } from './environment';
import {
  hasLocalStateReconciler,
  LocalStateReconcileLoop,
} from './local-state-reconciler';

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

  const adapter = createNodeAgentDataPlaneAdapter(config, {
    info(fields, message) {
      logger.info(fields, message);
    },
  });
  const runner = new NodeAgentRunner(
    new HttpNodeAgentControlPlane(
      config.NODE_AGENT_API_BASE_URL as string,
      config.NODE_AGENT_CREDENTIAL as string,
      config.NODE_AGENT_REQUEST_TIMEOUT_MS,
    ),
    adapter,
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
    const loops: Promise<void>[] = [];
    if (hasLocalStateReconciler(adapter)) {
      loops.push(
        new LocalStateReconcileLoop(adapter, {
          retryDelayMs: config.NODE_AGENT_POLL_INTERVAL_MS,
          onError(error) {
            logger.warn(
              {
                component: 'node-agent-local-reconcile',
                errorType:
                  error instanceof Error ? error.constructor.name : 'Error',
              },
              'Node-agent local reconcile failed',
            );
          },
        }).run(abortController.signal),
      );
    }
    loops.push(
      runControlPlaneLoop(
        runner,
        config.NODE_AGENT_POLL_INTERVAL_MS,
        abortController.signal,
        logger,
      ),
    );
    await Promise.all(loops);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function runControlPlaneLoop(
  runner: NodeAgentRunner,
  pollIntervalMs: number,
  signal: AbortSignal,
  logger: pino.Logger,
): Promise<void> {
  while (!signal.aborted) {
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
          errorType: error instanceof Error ? error.constructor.name : 'Error',
        },
        'Node-agent cycle failed',
      );
    }
    await delay(pollIntervalMs, undefined, { signal }).catch(
      (error: unknown) => {
        if (!signal.aborted) throw error;
      },
    );
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
