export const apiIntegrationSuites = [
  {
    name: 'trial',
    file: 'test/infrastructure/trial.e2e.test.ts',
    scenarioCount: 10,
  },
  {
    name: 'auth',
    file: 'test/infrastructure/auth.e2e.test.ts',
    scenarioCount: 17,
  },
  {
    name: 'orchestration',
    file: 'test/infrastructure/orchestration.e2e.test.ts',
    scenarioCount: 15,
  },
  {
    name: 'cabinet',
    file: 'test/infrastructure/cabinet.e2e.test.ts',
    scenarioCount: 8,
  },
  {
    name: 'feed',
    file: 'test/infrastructure/feed.e2e.test.ts',
    scenarioCount: 10,
  },
  {
    name: 'migration',
    file: 'test/infrastructure/migration.e2e.test.ts',
    scenarioCount: 10,
  },
] as const;

export const apiIntegrationScenarioCount = apiIntegrationSuites.reduce(
  (total, suite) => total + suite.scenarioCount,
  0,
);
