// @vitest-environment jsdom

import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import RootLayout from './layout';
import Providers from './providers';

function captureClient(onClient: (client: QueryClient) => void) {
  return function QueryClientProbe() {
    onClient(useQueryClient());
    return null;
  };
}

afterEach(cleanup);

describe('production query provider', () => {
  it('keeps one client per mount and applies the explicit no-background-refetch policy', () => {
    let currentClient: QueryClient | undefined;
    const Probe = captureClient((client) => {
      currentClient = client;
    });
    const firstRoot = render(
      <Providers>
        <Probe />
      </Providers>,
    );
    const firstClient = currentClient;

    expect(firstClient).toBeDefined();
    expect(firstClient?.getDefaultOptions()).toEqual({
      queries: {
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
      mutations: { retry: false },
    });

    firstRoot.rerender(
      <Providers>
        <Probe />
      </Providers>,
    );
    expect(currentClient).toBe(firstClient);
    firstRoot.unmount();

    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    expect(currentClient).not.toBe(firstClient);
  });

  it('is wired by the real root layout', () => {
    let layoutClient: QueryClient | undefined;
    const Probe = captureClient((client) => {
      layoutClient = client;
    });

    const markup = renderToStaticMarkup(
      <RootLayout>
        <Probe />
      </RootLayout>,
    );

    expect(layoutClient).toBeDefined();
    expect(markup).toContain('<html lang="ru">');
  });
});
