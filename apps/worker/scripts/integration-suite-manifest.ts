export const workerIntegrationSuites = [
  {
    name: 'outbox-publisher',
    file: 'src/outbox-publisher.integration.test.ts',
    scenarioCount: 3,
  },
  {
    name: 'node-sync-processor',
    file: 'src/node-sync-processor.integration.test.ts',
    scenarioCount: 7,
  },
  {
    name: 'subscription-access-maintenance',
    file: 'src/subscription-access-maintenance.integration.test.ts',
    scenarioCount: 9,
  },
] as const;

export const workerIntegrationScenarioCount = workerIntegrationSuites.reduce(
  (total, suite) => total + suite.scenarioCount,
  0,
);
