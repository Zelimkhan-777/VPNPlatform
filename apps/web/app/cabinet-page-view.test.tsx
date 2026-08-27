// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type {
  CabinetOverview,
  IssuedCabinetDevice,
} from '@vpn-platform/contracts';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CabinetPageView } from './cabinet-page-view';
import type { CabinetViewState } from './cabinet-queries';
import Providers from './providers';

const overview: CabinetOverview = {
  subscription: {
    status: 'ACTIVE',
    planName: 'Базовый',
    deviceLimit: 1,
    startsAt: '2026-08-27T00:00:00.000Z',
    expiresAt: '2026-09-27T00:00:00.000Z',
  },
  devices: [
    {
      id: '82ef72a5-0c97-4fbd-9600-c64db2d01ca9',
      displayName: 'Мой ноутбук',
      platform: null,
      status: 'ACTIVE',
      createdAt: '2026-08-27T00:00:00.000Z',
    },
  ],
};
const issuedDevice: IssuedCabinetDevice = {
  id: '82ef72a5-0c97-4fbd-9600-c64db2d01ca9',
  displayName: 'Мой ноутбук',
  platform: null,
  status: 'ACTIVE',
  createdAt: '2026-08-27T00:00:00.000Z',
  subscriptionUrl: 'https://sub.example.test/sub/opaque-test-token',
};

function renderView({
  state,
  device = null,
  onClose = vi.fn(),
}: {
  state: CabinetViewState | undefined;
  device?: IssuedCabinetDevice | null;
  onClose?: () => void;
}) {
  return render(
    <Providers>
      <CabinetPageView
        state={state}
        issuedDevice={device}
        onDeviceIssued={vi.fn()}
        onIssuedDeviceClosed={onClose}
      />
    </Providers>,
  );
}

afterEach(cleanup);

describe('cabinet page presentation', () => {
  it.each([
    [undefined, 'Загружаем данные кабинета…'],
    [
      { kind: 'unauthenticated' } satisfies CabinetViewState,
      'Откройте кабинет из Telegram-бота.',
    ],
    [
      { kind: 'telegram-rejected' } satisfies CabinetViewState,
      'Не удалось безопасно подтвердить вход через Telegram.',
    ],
    [
      { kind: 'unavailable' } satisfies CabinetViewState,
      'Не удалось загрузить кабинет.',
    ],
  ])('renders the %s state without server-state decisions', (state, text) => {
    renderView({ state });

    expect(screen.getByText(text, { exact: false })).toBeTruthy();
  });

  it('renders subscription, device and capacity data supplied by the query result', () => {
    renderView({ state: { kind: 'ready', overview } });

    expect(screen.getByText('Базовый')).toBeTruthy();
    expect(screen.getByText('Мой ноутбук')).toBeTruthy();
    expect(screen.getByText('Активно')).toBeTruthy();
    expect(
      screen.getByText('Использовано устройств: 1 из 1.', { exact: false }),
    ).toBeTruthy();
  });

  it('delegates closing the one-time URL dialog to the container', () => {
    const onClose = vi.fn();
    renderView({ state: undefined, device: issuedDevice, onClose });

    expect(screen.getByText(issuedDevice.subscriptionUrl)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
