'use client';

import type { CabinetOverview } from '@vpn-platform/contracts';
import { useEffect, useState } from 'react';

import { CabinetApiError, fetchCabinetOverview } from './cabinet-api';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; overview: CabinetOverview }
  | { kind: 'unauthenticated' }
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

  useEffect(() => {
    void fetchCabinetOverview()
      .then((overview) => setState({ kind: 'ready', overview }))
      .catch((error: unknown) => {
        setState({
          kind:
            error instanceof CabinetApiError && error.kind === 'unauthenticated'
              ? 'unauthenticated'
              : 'unavailable',
        });
      });
  }, []);

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
        {state.kind === 'unavailable' && (
          <p className="notice error" role="alert">
            Не удалось загрузить кабинет. Попробуйте обновить страницу позже.
          </p>
        )}
        {state.kind === 'ready' && (
          <CabinetOverviewView overview={state.overview} />
        )}
      </section>
    </main>
  );
}

function CabinetOverviewView({ overview }: { overview: CabinetOverview }) {
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

function formatDate(value: string | null): string {
  if (!value) {
    return 'Не указан';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeZone: 'Europe/Moscow',
  }).format(new Date(value));
}
