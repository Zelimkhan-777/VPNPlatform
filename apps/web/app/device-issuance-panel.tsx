'use client';

import type { IssuedCabinetDevice } from '@vpn-platform/contracts';
import React, { useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { useIssueCabinetDevice } from './cabinet-queries';
import { DeviceApiError } from './device-api';

export function DeviceIssuancePanel({
  canAddDevice,
  activeDeviceCount,
  deviceLimit,
  subscriptionActive,
  onIssued,
}: {
  canAddDevice: boolean;
  activeDeviceCount: number;
  deviceLimit: number | undefined;
  subscriptionActive: boolean;
  onIssued: (device: IssuedCabinetDevice) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const issueDevice = useIssueCabinetDevice({ onIssued });
  const pendingIssuance = useRef<{
    idempotencyKey: string;
    displayName: string;
  } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    issueDevice.reset();

    try {
      const pending = pendingIssuance.current ?? {
        idempotencyKey: crypto.randomUUID(),
        displayName,
      };
      pendingIssuance.current = pending;
      await issueDevice.mutateAsync({
        input: { displayName: pending.displayName },
        idempotencyKey: pending.idempotencyKey,
      });
      pendingIssuance.current = null;
      setDisplayName('');
    } catch {
      return;
    }
  }

  if (!subscriptionActive) {
    return (
      <p className="muted device-hint">
        Добавление устройств доступно при активной подписке.
      </p>
    );
  }

  if (!canAddDevice) {
    return (
      <p className="muted device-hint">
        Использовано устройств: {activeDeviceCount} из {deviceLimit}. Чтобы
        добавить новое, сначала освободите место в тарифе.
      </p>
    );
  }

  return (
    <form className="device-form" onSubmit={submit}>
      <label htmlFor="device-name">Название устройства</label>
      <div className="device-form-controls">
        <input
          id="device-name"
          name="device-name"
          value={displayName}
          onChange={(event) => {
            if (
              pendingIssuance.current &&
              event.target.value !== pendingIssuance.current.displayName
            ) {
              pendingIssuance.current = null;
            }
            setDisplayName(event.target.value);
          }}
          maxLength={128}
          placeholder="Например, мой ноутбук"
          required
        />
        <button type="submit" disabled={issueDevice.isPending}>
          {issueDevice.isPending ? 'Добавляем…' : 'Добавить устройство'}
        </button>
      </div>
      <p className="muted form-description">
        После создания один раз покажем ссылку для добавления в VPN-клиент.
      </p>
      {issueDevice.error && (
        <p className="form-error" role="alert">
          {issueErrorMessage(issueDevice.error)}
        </p>
      )}
    </form>
  );
}

function issueErrorMessage(error: unknown): string {
  if (error instanceof DeviceApiError) {
    if (error.kind === 'conflict') {
      return 'Лимит устройств исчерпан или подписка больше не активна. Обновите кабинет.';
    }
    if (error.kind === 'unauthenticated') {
      return 'Сессия завершилась. Откройте кабинет из Telegram-бота ещё раз.';
    }
    if (error.kind === 'forbidden') {
      return 'Не удалось подтвердить запрос. Обновите кабинет и повторите попытку.';
    }
  }
  return 'Не удалось добавить устройство. Попробуйте ещё раз позже.';
}
