export const apiIntegrationSuites = [
  {
    name: 'auth',
    file: 'test/infrastructure/auth.e2e.test.ts',
    scenarioCount: 10,
  },
  {
    name: 'orchestration',
    file: 'test/infrastructure/orchestration.e2e.test.ts',
    scenarioCount: 12,
  },
  {
    name: 'cabinet',
    file: 'test/infrastructure/cabinet.e2e.test.ts',
    scenarioCount: 6,
  },
  {
    name: 'feed',
    file: 'test/infrastructure/feed.e2e.test.ts',
    scenarioCount: 10,
  },
] as const;

export const apiIntegrationScenarioCount = apiIntegrationSuites.reduce(
  (total, suite) => total + suite.scenarioCount,
  0,
);
