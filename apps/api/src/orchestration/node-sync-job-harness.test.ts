import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = {
    claim: vi.fn(),
    complete: vi.fn(),
  };
  const PrismaNodeSyncStore = vi.fn(function MockPrismaNodeSyncStore() {
    return store;
  });
  return { PrismaNodeSyncStore, store };
});

vi.mock('@vpn-platform/orchestration-store', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    PrismaNodeSyncStore: mocks.PrismaNodeSyncStore,
  };
});

import { completeNodeSyncJobForHarness } from './node-sync-job-harness';

type JobRow = {
  status: string;
  nodeAccessGrantId: string | null;
  routeEndpointId: string | null;
  routeConnectionProfileId: string | null;
  targetVersion: number;
};

function prismaWithJob(job: JobRow) {
  return {
    nodeSyncJob: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(job),
    },
  };
}

describe('completeNodeSyncJobForHarness', () => {
  beforeEach(() => {
    mocks.PrismaNodeSyncStore.mockClear();
    mocks.store.claim.mockReset();
    mocks.store.complete.mockReset();
  });

  it.each([
    {
      name: 'empty binding',
      job: {
        nodeAccessGrantId: null,
        routeEndpointId: null,
        routeConnectionProfileId: null,
      },
    },
    {
      name: 'mixed grant and route binding',
      job: {
        nodeAccessGrantId: 'grant-1',
        routeEndpointId: 'endpoint-1',
        routeConnectionProfileId: 'profile-1',
      },
    },
    {
      name: 'partial route binding',
      job: {
        nodeAccessGrantId: null,
        routeEndpointId: 'endpoint-1',
        routeConnectionProfileId: null,
      },
    },
  ])('rejects $name before creating a store', async ({ job }) => {
    const prisma = prismaWithJob({
      status: 'PENDING',
      targetVersion: 7,
      ...job,
    });

    await expect(
      completeNodeSyncJobForHarness(prisma as never, 'job-1', 'harness-1', {}),
    ).rejects.toThrow('Harness found an invalid sync job resource binding');
    expect(mocks.PrismaNodeSyncStore).not.toHaveBeenCalled();
    expect(mocks.store.claim).not.toHaveBeenCalled();
    expect(mocks.store.complete).not.toHaveBeenCalled();
  });

  it('treats a succeeded replay as idempotent without a new claim or write', async () => {
    const prisma = prismaWithJob({
      status: 'SUCCEEDED',
      nodeAccessGrantId: 'grant-1',
      routeEndpointId: null,
      routeConnectionProfileId: null,
      targetVersion: 11,
    });

    await expect(
      completeNodeSyncJobForHarness(prisma as never, 'job-1', 'harness-1', {}),
    ).resolves.toBeUndefined();
    expect(mocks.PrismaNodeSyncStore).not.toHaveBeenCalled();
    expect(mocks.store.claim).not.toHaveBeenCalled();
    expect(mocks.store.complete).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'grant',
      job: {
        nodeAccessGrantId: 'grant-1',
        routeEndpointId: null,
        routeConnectionProfileId: null,
      },
      command: {
        nodeAccessGrantId: 'grant-1',
        nodeSyncJobId: 'job-1',
        targetVersion: 17,
      },
    },
    {
      name: 'route',
      job: {
        nodeAccessGrantId: null,
        routeEndpointId: 'endpoint-1',
        routeConnectionProfileId: 'profile-1',
      },
      command: {
        routeEndpointId: 'endpoint-1',
        routeConnectionProfileId: 'profile-1',
        nodeSyncJobId: 'job-1',
        targetVersion: 17,
      },
    },
  ])(
    'claims and completes a $name command with the job targetVersion',
    async ({ job, command }) => {
      const prisma = prismaWithJob({
        status: 'PENDING',
        targetVersion: 17,
        ...job,
      });
      mocks.store.claim.mockResolvedValue({
        id: 'job-1',
        leaseToken: 'lease-1',
      });
      mocks.store.complete.mockResolvedValue(true);

      await expect(
        completeNodeSyncJobForHarness(
          prisma as never,
          'job-1',
          'harness-1',
          {},
        ),
      ).resolves.toBeUndefined();

      expect(prisma.nodeSyncJob.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        select: {
          status: true,
          nodeAccessGrantId: true,
          routeEndpointId: true,
          routeConnectionProfileId: true,
          targetVersion: true,
        },
      });
      expect(mocks.PrismaNodeSyncStore).toHaveBeenCalledWith(
        prisma,
        30_000,
        0,
        5,
      );
      expect(mocks.store.claim).toHaveBeenCalledWith(command, 'harness-1');
      expect(mocks.store.complete).toHaveBeenCalledWith(
        'job-1',
        'harness-1',
        'lease-1',
      );
    },
  );
});
