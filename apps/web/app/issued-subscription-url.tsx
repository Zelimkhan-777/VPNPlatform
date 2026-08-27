'use client';

import type { IssuedCabinetDevice } from '@vpn-platform/contracts';
import React, { useState } from 'react';

export function IssuedSubscriptionUrl({
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
