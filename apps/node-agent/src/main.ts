import { setTimeout as delay } from 'node:timers/promises';

import { createSafeLogger, type Logger } from '@vpn-platform/safe-logger';

import { createNodeAgentDataPlaneAdapter } from './adapter-factory';
import { NodeAgentRunner } from './agent';
import { HttpNodeAgentControlPlane } from './control-plane-client';
import { parseNodeAgentEnvironment } from './environment';
import {
  hasLocalStateReconciler,
  LocalStateReconcileLoop,
} from './local-state-reconciler';
import {
  effectiveControlPlanePollInterval,
  effectiveControlPlaneRetryInterval,
  LOCAL_SECURITY_RETRY_DELAY_MS,
  successfulControlPlaneCycleDelay,
} from './security-timing';

export async function runNodeAgent(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = parseNodeAgentEnvironment(environment);
  const logger = createSafeLogger(config.LOG_LEVEL);
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
          retryDelayMs: LOCAL_SECURITY_RETRY_DELAY_MS,
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
    const pollIntervalMs = effectiveControlPlanePollInterval(
      config.NODE_AGENT_MODE,
      config.NODE_AGENT_POLL_INTERVAL_MS,
    );
    loops.push(
      runControlPlaneLoop(
        runner,
        pollIntervalMs,
        effectiveControlPlaneRetryInterval(
          config.NODE_AGENT_MODE,
          pollIntervalMs,
        ),
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
  retryIntervalMs: number,
  signal: AbortSignal,
  logger: Logger,
): Promise<void> {
  while (!signal.aborted) {
    let nextCycleDelayMs = pollIntervalMs;
    try {
      const outcome = await runner.runCycle();
      nextCycleDelayMs = successfulControlPlaneCycleDelay(
        outcome,
        pollIntervalMs,
        retryIntervalMs,
      );
      logger.info(
        { component: 'node-agent', outcome },
        'Node-agent cycle completed',
      );
    } catch (error) {
      nextCycleDelayMs = retryIntervalMs;
      logger.warn(
        {
          component: 'node-agent',
          errorType: error instanceof Error ? error.constructor.name : 'Error',
        },
        'Node-agent cycle failed',
      );
    }
    await delay(nextCycleDelayMs, undefined, { signal }).catch(
      (error: unknown) => {
        if (!signal.aborted) throw error;
      },
    );
  }
}

if (require.main === module) {
  void runNodeAgent().catch((error: unknown) => {
    const logger = createSafeLogger(process.env.LOG_LEVEL ?? 'info');
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
