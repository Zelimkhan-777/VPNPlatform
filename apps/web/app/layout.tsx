import type { Metadata } from 'next';
import React from 'react';
import type { ReactNode } from 'react';

import Providers from './providers';
import './styles.css';

export const metadata: Metadata = {
  title: 'VPNPlatform',
  description: 'Личный кабинет VPNPlatform',
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ru">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
