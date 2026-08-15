import {
  parseHarnessCommand,
  runLocalTwoNodeHarness,
} from '../src/orchestration/local-two-node-harness';

void runLocalTwoNodeHarness(parseHarnessCommand(process.argv.slice(2))).catch(
  (error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'Local two-node harness failed';
    console.error(message);
    process.exitCode = 1;
  },
);
