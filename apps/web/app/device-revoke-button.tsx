'use client';

import React, { useState } from 'react';

import { useRevokeCabinetDevice } from './cabinet-queries';

export function DeviceRevokeButton({ deviceId }: { deviceId: string }) {
  const [confirming, setConfirming] = useState(false);
  const revokeDevice = useRevokeCabinetDevice();

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)}>
        Отозвать
      </button>
    );
  }

  return (
    <div>
      <button
        type="button"
        disabled={revokeDevice.isPending}
        onClick={() => {
          revokeDevice.reset();
          revokeDevice.mutate(deviceId);
        }}
      >
        {revokeDevice.isPending ? 'Отзываем…' : 'Подтвердить отзыв'}
      </button>
      <button
        type="button"
        disabled={revokeDevice.isPending}
        onClick={() => setConfirming(false)}
      >
        Отмена
      </button>
      {revokeDevice.isError && (
        <span className="error" role="alert">
          Не удалось отозвать устройство.
        </span>
      )}
    </div>
  );
}
