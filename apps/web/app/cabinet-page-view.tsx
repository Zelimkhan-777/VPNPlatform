import type { IssuedCabinetDevice } from '@vpn-platform/contracts';
import React from 'react';

import { CabinetOverviewView } from './cabinet-overview-view';
import type { CabinetViewState } from './cabinet-queries';
import { IssuedSubscriptionUrl } from './issued-subscription-url';

export function CabinetPageView({
  state,
  issuedDevice,
  onDeviceIssued,
  onIssuedDeviceClosed,
}: {
  state: CabinetViewState | undefined;
  issuedDevice: IssuedCabinetDevice | null;
  onDeviceIssued: (device: IssuedCabinetDevice) => void;
  onIssuedDeviceClosed: () => void;
}) {
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
            onDeviceIssued={onDeviceIssued}
          />
        )}
        {issuedDevice && (
          <IssuedSubscriptionUrl
            device={issuedDevice}
            onClose={onIssuedDeviceClosed}
          />
        )}
      </section>
    </main>
  );
}
