// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceApiError, revokeCabinetDevice } from './device-api';
import type * as DeviceApiModule from './device-api';
import { DeviceRevokeButton } from './device-revoke-button';
import Providers from './providers';

vi.mock('./device-api', async (importOriginal) => ({
  ...(await importOriginal<typeof DeviceApiModule>()),
  revokeCabinetDevice: vi.fn(),
}));

const revokeCabinetDeviceMock = vi.mocked(revokeCabinetDevice);
const deviceId = '82ef72a5-0c97-4fbd-9600-c64db2d01ca9';

function renderButton() {
  return render(
    <Providers>
      <DeviceRevokeButton deviceId={deviceId} />
    </Providers>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('device revoke presentation', () => {
  it('requires confirmation and allows cancellation without a mutation', () => {
    renderButton();

    fireEvent.click(screen.getByRole('button', { name: 'Отозвать' }));
    expect(
      screen.getByRole('button', { name: 'Подтвердить отзыв' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));

    expect(screen.getByRole('button', { name: 'Отозвать' })).toBeTruthy();
    expect(revokeCabinetDeviceMock).not.toHaveBeenCalled();
  });

  it('submits the selected device and exposes an unrecoverable error', async () => {
    revokeCabinetDeviceMock.mockRejectedValue(
      new DeviceApiError('Device request is forbidden', 'forbidden'),
    );
    renderButton();

    fireEvent.click(screen.getByRole('button', { name: 'Отозвать' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить отзыв' }));

    await waitFor(() =>
      expect(revokeCabinetDeviceMock).toHaveBeenCalledWith(deviceId),
    );
    expect(
      await screen.findByText('Не удалось отозвать устройство.'),
    ).toBeTruthy();
  });
});
