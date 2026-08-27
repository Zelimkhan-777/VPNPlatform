'use client';

import type { IssuedCabinetDevice } from '@vpn-platform/contracts';
import React, { useState } from 'react';

import { CabinetPageView } from './cabinet-page-view';
import { useCabinetQuery } from './cabinet-queries';

export default function HomePage() {
  const [issuedDevice, setIssuedDevice] = useState<IssuedCabinetDevice | null>(
    null,
  );
  const cabinetQuery = useCabinetQuery();

  return (
    <CabinetPageView
      state={cabinetQuery.data}
      issuedDevice={issuedDevice}
      onDeviceIssued={setIssuedDevice}
      onIssuedDeviceClosed={() => setIssuedDevice(null)}
    />
  );
}
