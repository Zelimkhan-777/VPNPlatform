'use client';

import type { CabinetOverview } from '@vpn-platform/contracts';
import type { IssuedCabinetDevice } from '@vpn-platform/contracts';
import React, { useRef, useState } from 'react';
import type { FormEvent } from 'react';

import {
  useCabinetQuery,
  useIssueCabinetDevice,
  useRevokeCabinetDevice,
} from './cabinet-queries';
import { DeviceApiError } from './device-api';

const subscriptionStatus: Record<
  NonNullable<CabinetOverview['subscription']>['status'],
  string
> = {
  PENDING: 'Ожидает оплаты',
  ACTIVE: 'Активна',
  EXPIRED: 'Закончилась',
  CANCELLED: 'Отменена',
};

const deviceStatus: Record<
  CabinetOverview['devices'][number]['status'],
  string
> = {
  ACTIVE: 'Активно',
  REVOKED: 'Отозвано',
};

export default function HomePage() {
  const [issuedDevice, setIssuedDevice] = useState<IssuedCabinetDevice | null>(
    null,
  );
  const cabinetQuery = useCabinetQuery();
  const state = cabinetQuery.data;

  return (
    <main>
      <section className="cabinet" aria-labelledby="page-title">
        <p className="eyebrow">VPNPlatform</p>
        <h1 id="page-title">Мой VPN</h1>
        {!state && <p className="notice">Загружаем данные кабинета…</p>}
        {state?.kind === 'unauthenticated' && (
          <p className="notice">
            Откройте кабинет из Telegram-бота. После безопасного входа здесь
            появятся ваша подписка и устройства.
          </p>
        )}
        {state?.kind === 'telegram-rejected' && (
          <p className="notice error" role="alert">
            Не удалось безопасно подтвердить вход через Telegram. Закройте
            кабинет и откройте его заново из бота.
          </p>
        )}
        {state?.kind === 'unavailable' && (
          <p className="notice error" role="alert">
            Не удалось загрузить кабинет. Попробуйте обновить страницу позже.
          </p>
        )}
        {state?.kind === 'ready' && (
          <CabinetOverviewView
            overview={state.overview}
            onDeviceIssued={setIssuedDevice}
          />
        )}
        {issuedDevice && (
          <IssuedSubscriptionUrl
            device={issuedDevice}
            onClose={() => setIssuedDevice(null)}
          />
        )}
      </section>
    </main>
  );
}

function CabinetOverviewView({
  overview,
  onDeviceIssued,
}: {
  overview: CabinetOverview;
  onDeviceIssued: (device: IssuedCabinetDevice) => void;
}) {
  const activeDeviceCount = overview.devices.filter(
    (device) => device.status === 'ACTIVE',
  ).length;
  const canAddDevice =
    overview.subscription?.status === 'ACTIVE' &&
    activeDeviceCount < overview.subscription.deviceLimit;

  return (
    <div className="cabinet-content">
      <article className="card">
        <h2>Подписка</h2>
        {overview.subscription ? (
          <dl>
            <div>
              <dt>Статус</dt>
              <dd>{subscriptionStatus[overview.subscription.status]}</dd>
            </div>
            <div>
              <dt>Тариф</dt>
              <dd>{overview.subscription.planName}</dd>
            </div>
            <div>
              <dt>Устройств</dt>
              <dd>До {overview.subscription.deviceLimit}</dd>
            </div>
            <div>
              <dt>Действует до</dt>
              <dd>{formatDate(overview.subscription.expiresAt)}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted">Подписки пока нет.</p>
        )}
      </article>

      <article className="card">
        <h2>Устройства</h2>
        <DeviceIssuancePanel
          canAddDevice={canAddDevice}
          activeDeviceCount={activeDeviceCount}
          deviceLimit={overview.subscription?.deviceLimit}
          subscriptionActive={overview.subscription?.status === 'ACTIVE'}
          onIssued={onDeviceIssued}
        />
        {overview.devices.length > 0 ? (
          <ul className="device-list">
            {overview.devices.map((device) => (
              <li key={device.id}>
                <div>
                  <strong>{device.displayName ?? 'Без названия'}</strong>
                  <span>{device.platform ?? 'Платформа не указана'}</span>
                </div>
                <span
                  className={
                    device.status === 'ACTIVE' ? 'status active' : 'status'
                  }
                >
                  {deviceStatus[device.status]}
                </span>
                {device.status === 'ACTIVE' && (
                  <DeviceRevokeButton deviceId={device.id} />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Устройств пока нет.</p>
        )}
      </article>
    </div>
  );
}

function DeviceRevokeButton({ deviceId }: { deviceId: string }) {
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

function DeviceIssuancePanel({
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

function IssuedSubscriptionUrl({
  device,
  onClose,
}: {
  device: IssuedCabinetDevice;
  onClose: () => void;
}) {
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(device.subscriptionUrl);
      setCopyMessage('Ссылка скопирована. Добавьте её в VPN-клиент.');
    } catch {
      setCopyMessage(
        'Не удалось скопировать автоматически. Скопируйте ссылку вручную.',
      );
    }
  }

  return (
    <section
      className="issued-url"
      role="dialog"
      aria-modal="true"
      aria-labelledby="issued-url-title"
    >
      <h2 id="issued-url-title">Ссылка для нового устройства</h2>
      <p className="muted">
        Скопируйте её сейчас и добавьте в VPN-клиент. После закрытия она не
        остаётся в кабинете.
      </p>
      <code>{device.subscriptionUrl}</code>
      <div className="issued-url-actions">
        <button type="button" onClick={() => void copyUrl()}>
          Скопировать ссылку
        </button>
        <button type="button" className="secondary-button" onClick={onClose}>
          Готово
        </button>
      </div>
      {copyMessage && <p className="form-description">{copyMessage}</p>}
    </section>
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

function formatDate(value: string | null): string {
  if (!value) {
    return 'Не указан';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeZone: 'Europe/Moscow',
  }).format(new Date(value));
}
