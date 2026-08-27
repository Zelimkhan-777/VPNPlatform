// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { CabinetOverview } from '@vpn-platform/contracts';
import React, { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { signInWithTelegram } from './auth-api';
import type * as AuthApiModule from './auth-api';
import { CabinetApiError, fetchCabinetOverview } from './cabinet-api';
import type * as CabinetApiModule from './cabinet-api';
import {
  cabinetOverviewQueryKey,
  useCabinetQuery,
  useIssueCabinetDevice,
  useRevokeCabinetDevice,
} from './cabinet-queries';
import {
  DeviceApiError,
  issueCabinetDevice,
  revokeCabinetDevice,
} from './device-api';
import type * as DeviceApiModule from './device-api';
import { getTelegramWebAppInitData } from './telegram-web-app';
import type * as TelegramWebAppModule from './telegram-web-app';

vi.mock('./auth-api', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthApiModule>()),
  signInWithTelegram: vi.fn(),
}));
vi.mock('./cabinet-api', async (importOriginal) => ({
  ...(await importOriginal<typeof CabinetApiModule>()),
  fetchCabinetOverview: vi.fn(),
}));
vi.mock('./device-api', async (importOriginal) => ({
  ...(await importOriginal<typeof DeviceApiModule>()),
  issueCabinetDevice: vi.fn(),
  revokeCabinetDevice: vi.fn(),
}));
vi.mock('./telegram-web-app', async (importOriginal) => ({
  ...(await importOriginal<typeof TelegramWebAppModule>()),
  getTelegramWebAppInitData: vi.fn(),
}));

const fetchCabinetOverviewMock = vi.mocked(fetchCabinetOverview);
const getTelegramWebAppInitDataMock = vi.mocked(getTelegramWebAppInitData);
const issueCabinetDeviceMock = vi.mocked(issueCabinetDevice);
const revokeCabinetDeviceMock = vi.mocked(revokeCabinetDevice);
const signInWithTelegramMock = vi.mocked(signInWithTelegram);

const emptyOverview: CabinetOverview = { subscription: null, devices: [] };
const activeOverview: CabinetOverview = {
  subscription: {
    status: 'ACTIVE' as const,
    planName: 'Базовый',
    deviceLimit: 3,
    startsAt: '2026-08-27T00:00:00.000Z',
    expiresAt: '2026-09-27T00:00:00.000Z',
  },
  devices: [],
};
const issuedDevice = {
  id: '82ef72a5-0c97-4fbd-9600-c64db2d01ca9',
  displayName: 'Мой ноутбук',
  platform: null,
  status: 'ACTIVE' as const,
  createdAt: '2026-08-27T00:00:00.000Z',
  subscriptionUrl: 'https://sub.example.test/sub/opaque-test-token',
};
const idempotencyKey = 'a77aab04-cfad-4d81-845e-ff90a6b7b651';

function createHarness({ strict = false } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => {
    const tree = (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
  return { queryClient, Wrapper };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('cabinet query', () => {
  it('loads the overview once through Strict Mode without a duplicate Telegram sign-in', async () => {
    fetchCabinetOverviewMock
      .mockRejectedValueOnce(
        new CabinetApiError('Session is unavailable', 'unauthenticated'),
      )
      .mockResolvedValueOnce(activeOverview);
    getTelegramWebAppInitDataMock.mockReturnValue('signed-init-data');
    signInWithTelegramMock.mockResolvedValue({
      user: {
        id: '13f12b99-f0d6-41ae-bd8f-61d6e950ee4c',
        role: 'CUSTOMER',
      },
      expiresAt: '2026-08-27T01:00:00.000Z',
    });
    const { Wrapper } = createHarness({ strict: true });

    const { result } = renderHook(() => useCabinetQuery(), {
      wrapper: Wrapper,
    });

    await waitFor(() =>
      expect(result.current.data).toEqual({
        kind: 'ready',
        overview: activeOverview,
      }),
    );
    expect(fetchCabinetOverviewMock).toHaveBeenCalledTimes(2);
    expect(getTelegramWebAppInitDataMock).toHaveBeenCalledTimes(1);
    expect(signInWithTelegramMock).toHaveBeenCalledTimes(1);
    expect(signInWithTelegramMock).toHaveBeenCalledWith('signed-init-data');
  });

  it('does not retry authentication when Telegram context is absent', async () => {
    fetchCabinetOverviewMock.mockRejectedValue(
      new CabinetApiError('Session is unavailable', 'unauthenticated'),
    );
    getTelegramWebAppInitDataMock.mockReturnValue(null);
    const { Wrapper } = createHarness();

    const { result } = renderHook(() => useCabinetQuery(), {
      wrapper: Wrapper,
    });

    await waitFor(() =>
      expect(result.current.data).toEqual({ kind: 'unauthenticated' }),
    );
    expect(fetchCabinetOverviewMock).toHaveBeenCalledTimes(1);
    expect(signInWithTelegramMock).not.toHaveBeenCalled();
  });
});

describe('cabinet mutations', () => {
  it('refreshes overview after issue without retaining the subscription URL in query or mutation data', async () => {
    fetchCabinetOverviewMock
      .mockResolvedValueOnce(activeOverview)
      .mockResolvedValueOnce({
        ...activeOverview,
        devices: [
          {
            id: issuedDevice.id,
            displayName: issuedDevice.displayName,
            platform: issuedDevice.platform,
            status: issuedDevice.status,
            createdAt: issuedDevice.createdAt,
          },
        ],
      });
    issueCabinetDeviceMock.mockResolvedValue(issuedDevice);
    const onIssued = vi.fn();
    const { queryClient, Wrapper } = createHarness();

    const { result } = renderHook(
      () => ({
        cabinet: useCabinetQuery(),
        issue: useIssueCabinetDevice({ onIssued }),
      }),
      { wrapper: Wrapper },
    );
    await waitFor(() =>
      expect(result.current.cabinet.data?.kind).toBe('ready'),
    );

    await act(async () => {
      await result.current.issue.mutateAsync({
        input: { displayName: 'Мой ноутбук' },
        idempotencyKey,
      });
    });

    await waitFor(() =>
      expect(
        result.current.cabinet.data?.kind === 'ready'
          ? result.current.cabinet.data.overview.devices
          : [],
      ).toHaveLength(1),
    );
    expect(issueCabinetDeviceMock).toHaveBeenCalledWith(
      { displayName: 'Мой ноутбук' },
      idempotencyKey,
    );
    expect(onIssued).toHaveBeenCalledWith(issuedDevice);
    expect(result.current.issue.data).toBeUndefined();
    expect(
      JSON.stringify(queryClient.getQueryData(cabinetOverviewQueryKey)),
    ).not.toContain(issuedDevice.subscriptionUrl);
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.data),
      ),
    ).not.toContain(issuedDevice.subscriptionUrl);
  });

  it('recovers an expired session during revoke through the same cabinet query', async () => {
    fetchCabinetOverviewMock
      .mockResolvedValueOnce(activeOverview)
      .mockRejectedValueOnce(
        new CabinetApiError('Session is unavailable', 'unauthenticated'),
      )
      .mockResolvedValueOnce(emptyOverview);
    revokeCabinetDeviceMock.mockRejectedValue(
      new DeviceApiError('Session is unavailable', 'unauthenticated'),
    );
    getTelegramWebAppInitDataMock.mockReturnValue('signed-init-data');
    signInWithTelegramMock.mockResolvedValue({
      user: {
        id: '13f12b99-f0d6-41ae-bd8f-61d6e950ee4c',
        role: 'CUSTOMER',
      },
      expiresAt: '2026-08-27T01:00:00.000Z',
    });
    const { Wrapper } = createHarness();

    const { result } = renderHook(
      () => ({
        cabinet: useCabinetQuery(),
        revoke: useRevokeCabinetDevice(),
      }),
      { wrapper: Wrapper },
    );
    await waitFor(() =>
      expect(result.current.cabinet.data?.kind).toBe('ready'),
    );

    await act(async () => {
      await result.current.revoke.mutateAsync(issuedDevice.id);
    });

    await waitFor(() => expect(result.current.revoke.isSuccess).toBe(true));
    expect(signInWithTelegramMock).toHaveBeenCalledWith('signed-init-data');
    expect(fetchCabinetOverviewMock).toHaveBeenCalledTimes(3);
  });

  it('treats an already absent device as recovered and refreshes the overview', async () => {
    fetchCabinetOverviewMock
      .mockResolvedValueOnce(activeOverview)
      .mockResolvedValueOnce(emptyOverview);
    revokeCabinetDeviceMock.mockRejectedValue(
      new DeviceApiError('Device was not found', 'not-found'),
    );
    const { Wrapper } = createHarness();

    const { result } = renderHook(
      () => ({
        cabinet: useCabinetQuery(),
        revoke: useRevokeCabinetDevice(),
      }),
      { wrapper: Wrapper },
    );
    await waitFor(() =>
      expect(result.current.cabinet.data?.kind).toBe('ready'),
    );

    await act(async () => {
      await result.current.revoke.mutateAsync(issuedDevice.id);
    });

    await waitFor(() => expect(result.current.revoke.isSuccess).toBe(true));
    expect(fetchCabinetOverviewMock).toHaveBeenCalledTimes(2);
  });

  it('keeps an unrecoverable revoke failure visible without refreshing stale data', async () => {
    fetchCabinetOverviewMock.mockResolvedValue(activeOverview);
    const forbidden = new DeviceApiError(
      'Device request is forbidden',
      'forbidden',
    );
    revokeCabinetDeviceMock.mockRejectedValue(forbidden);
    const { Wrapper } = createHarness();

    const { result } = renderHook(
      () => ({
        cabinet: useCabinetQuery(),
        revoke: useRevokeCabinetDevice(),
      }),
      { wrapper: Wrapper },
    );
    await waitFor(() =>
      expect(result.current.cabinet.data?.kind).toBe('ready'),
    );

    await act(async () => {
      await expect(
        result.current.revoke.mutateAsync(issuedDevice.id),
      ).rejects.toBe(forbidden);
    });

    await waitFor(() => expect(result.current.revoke.isError).toBe(true));
    expect(fetchCabinetOverviewMock).toHaveBeenCalledTimes(1);
  });
});
