'use client';

import type { CabinetOverview } from '@vpn-platform/contracts';
import type { IssuedCabinetDevice } from '@vpn-platform/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { signInWithTelegram, TelegramSignInError } from './auth-api';
import { CabinetApiError, fetchCabinetOverview } from './cabinet-api';
import {
  DeviceApiError,
  issueCabinetDevice,
  revokeCabinetDevice,
} from './device-api';
import { recoverFromDeviceRevokeError } from './device-revoke-flow';
import { getTelegramWebAppInitData } from './telegram-web-app';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; overview: CabinetOverview }
  | { kind: 'unauthenticated' }
  | { kind: 'telegram-rejected' }
  | { kind: 'unavailable' };

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
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [issuedDevice, setIssuedDevice] = useState<IssuedCabinetDevice | null>(
    null,
  );
  const hasLoaded = useRef(false);

  const refreshCabinet = useCallback(async () => {
    setState({ kind: 'loading' });
    setState(await loadCabinet());
  }, []);

  useEffect(() => {
    if (hasLoaded.current) {
      return;
    }
    hasLoaded.current = true;

    void refreshCabinet();
  }, [refreshCabinet]);

  return (
    <main>
      <section className="cabinet" aria-labelledby="page-title">
        <p className="eyebrow">VPNPlatform</p>
        <h1 id="page-title">Мой VPN</h1>
        {state.kind === 'loading' && (
          <p className="notice">Загружаем данные кабинета…</p>
        )}
        {state.kind === 'unauthenticated' && (
          <p className="notice">
            Откройте кабинет из Telegram-бота. После безопасного входа здесь
            появятся ваша подписка и устройства.
          </p>
        )}
        {state.kind === 'telegram-rejected' && (
          <p className="notice error" role="alert">
            Не удалось безопасно подтвердить вход через Telegram. Закройте
            кабинет и откройте его заново из бота.
          </p>
        )}
        {state.kind === 'unavailable' && (
          <p className="notice error" role="alert">
            Не удалось загрузить кабинет. Попробуйте обновить страницу позже.
          </p>
        )}
        {state.kind === 'ready' && (
          <CabinetOverviewView
            overview={state.overview}
            onDeviceIssued={async (device) => {
              setIssuedDevice(device);
              await refreshCabinet();
            }}
            onDeviceRevoked={refreshCabinet}
            onAuthenticationRequired={refreshCabinet}
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

async function loadCabinet(): Promise<ViewState> {
  try {
    const overview = await fetchCabinetOverview();
    return { kind: 'ready', overview };
  } catch (error) {
    if (
      !(error instanceof CabinetApiError) ||
      error.kind !== 'unauthenticated'
    ) {
      return { kind: 'unavailable' };
    }
  }

  const initData = getTelegramWebAppInitData(window);
  if (!initData) {
    return { kind: 'unauthenticated' };
  }

  try {
    await signInWithTelegram(initData);
    const overview = await fetchCabinetOverview();
    return { kind: 'ready', overview };
  } catch (error) {
    if (error instanceof TelegramSignInError && error.kind === 'rejected') {
      return { kind: 'telegram-rejected' };
    }
    return { kind: 'unavailable' };
  }
}

function CabinetOverviewView({
  overview,
  onDeviceIssued,
  onDeviceRevoked,
  onAuthenticationRequired,
}: {
  overview: CabinetOverview;
  onDeviceIssued: (device: IssuedCabinetDevice) => Promise<void>;
  onDeviceRevoked: () => Promise<void>;
  onAuthenticationRequired: () => Promise<void>;
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
                  <DeviceRevokeButton
                    deviceId={device.id}
                    onRevoked={onDeviceRevoked}
                    onAuthenticationRequired={onAuthenticationRequired}
                  />
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

function DeviceRevokeButton({
  deviceId,
  onRevoked,
  onAuthenticationRequired,
}: {
  deviceId: string;
  onRevoked: () => Promise<void>;
  onAuthenticationRequired: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

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
        disabled={submitting}
        onClick={() => {
          setSubmitting(true);
          setFailed(false);
          void revokeCabinetDevice(deviceId)
            .then(onRevoked)
            .catch(async (error: unknown) => {
              const recovered = await recoverFromDeviceRevokeError(error, {
                onAuthenticationRequired,
                onNotFound: onRevoked,
              });
              if (!recovered) {
                setFailed(true);
              }
            })
            .finally(() => setSubmitting(false));
        }}
      >
        {submitting ? 'Отзываем…' : 'Подтвердить отзыв'}
      </button>
      <button
        type="button"
        disabled={submitting}
        onClick={() => setConfirming(false)}
      >
        Отмена
      </button>
      {failed && (
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
  onIssued: (device: IssuedCabinetDevice) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const pendingIssuance = useRef<{
    idempotencyKey: string;
    displayName: string;
  } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus('submitting');
    setMessage(null);

    try {
      const pending = pendingIssuance.current ?? {
        idempotencyKey: crypto.randomUUID(),
        displayName,
      };
      pendingIssuance.current = pending;
      const device = await issueCabinetDevice(
        { displayName: pending.displayName },
        pending.idempotencyKey,
      );
      pendingIssuance.current = null;
      setDisplayName('');
      await onIssued(device);
      setStatus('idle');
    } catch (error) {
      setStatus('error');
      setMessage(issueErrorMessage(error));
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
        <button type="submit" disabled={status === 'submitting'}>
          {status === 'submitting' ? 'Добавляем…' : 'Добавить устройство'}
        </button>
      </div>
      <p className="muted form-description">
        После создания один раз покажем ссылку для добавления в VPN-клиент.
      </p>
      {message && (
        <p className="form-error" role="alert">
          {message}
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
