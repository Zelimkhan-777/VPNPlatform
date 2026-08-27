import type {
  CabinetOverview,
  IssuedCabinetDevice,
} from '@vpn-platform/contracts';
import React from 'react';

import { DeviceIssuancePanel } from './device-issuance-panel';
import { DeviceRevokeButton } from './device-revoke-button';

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

export function CabinetOverviewView({
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

function formatDate(value: string | null): string {
  if (!value) {
    return 'Не указан';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeZone: 'Europe/Moscow',
  }).format(new Date(value));
}
