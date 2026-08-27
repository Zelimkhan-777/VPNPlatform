// @vitest-environment jsdom

import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { CabinetOverview } from '@vpn-platform/contracts';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchCabinetOverview } from './cabinet-api';
import type * as CabinetApiModule from './cabinet-api';
import { DeviceApiError, issueCabinetDevice } from './device-api';
import type * as DeviceApiModule from './device-api';
import HomePage from './page';
import Providers from './providers';

vi.mock('./cabinet-api', async (importOriginal) => ({
  ...(await importOriginal<typeof CabinetApiModule>()),
  fetchCabinetOverview: vi.fn(),
}));
vi.mock('./device-api', async (importOriginal) => ({
  ...(await importOriginal<typeof DeviceApiModule>()),
  issueCabinetDevice: vi.fn(),
  revokeCabinetDevice: vi.fn(),
}));

const fetchCabinetOverviewMock = vi.mocked(fetchCabinetOverview);
const issueCabinetDeviceMock = vi.mocked(issueCabinetDevice);
const idempotencyKey = 'a77aab04-cfad-4d81-845e-ff90a6b7b651';
const overview: CabinetOverview = {
  subscription: {
    status: 'ACTIVE',
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('cabinet page server-state wiring', () => {
  it('reuses the same idempotency key after a failed issue and forgets the URL when the dialog closes', async () => {
    fetchCabinetOverviewMock.mockResolvedValue(overview);
    issueCabinetDeviceMock
      .mockRejectedValueOnce(
        new DeviceApiError('Device API is unavailable', 'unavailable'),
      )
      .mockResolvedValueOnce(issuedDevice);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(idempotencyKey);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    let queryClient: QueryClient | undefined;
    function QueryClientProbe() {
      queryClient = useQueryClient();
      return null;
    }

    render(
      <Providers>
        <QueryClientProbe />
        <HomePage />
      </Providers>,
    );

    expect(screen.getByText('Загружаем данные кабинета…')).toBeTruthy();
    const input = await screen.findByLabelText('Название устройства');
    fireEvent.change(input, { target: { value: 'Мой ноутбук' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить устройство' }),
    );
    await screen.findByText(
      'Не удалось добавить устройство. Попробуйте ещё раз позже.',
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить устройство' }),
    );
    await screen.findByRole('dialog', { name: 'Ссылка для нового устройства' });

    expect(issueCabinetDeviceMock).toHaveBeenCalledTimes(2);
    expect(issueCabinetDeviceMock).toHaveBeenNthCalledWith(
      1,
      { displayName: 'Мой ноутбук' },
      idempotencyKey,
    );
    expect(issueCabinetDeviceMock).toHaveBeenNthCalledWith(
      2,
      { displayName: 'Мой ноутбук' },
      idempotencyKey,
    );
    expect(screen.getByText(issuedDevice.subscriptionUrl)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Скопировать ссылку' }));
    await screen.findByText('Ссылка скопирована. Добавьте её в VPN-клиент.');
    expect(writeText).toHaveBeenCalledWith(issuedDevice.subscriptionUrl);

    fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
    await waitFor(() =>
      expect(screen.queryByText(issuedDevice.subscriptionUrl)).toBeNull(),
    );
    expect(
      JSON.stringify(
        queryClient
          ?.getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(issuedDevice.subscriptionUrl);
  });
});
