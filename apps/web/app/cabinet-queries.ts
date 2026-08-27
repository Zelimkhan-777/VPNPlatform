'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CabinetOverview,
  CreateCabinetDeviceRequest,
  IssuedCabinetDevice,
} from '@vpn-platform/contracts';

import { signInWithTelegram, TelegramSignInError } from './auth-api';
import { CabinetApiError, fetchCabinetOverview } from './cabinet-api';
import { issueCabinetDevice, revokeCabinetDevice } from './device-api';
import { recoverFromDeviceRevokeError } from './device-revoke-flow';
import { getTelegramWebAppInitData } from './telegram-web-app';

export type CabinetViewState =
  | { kind: 'ready'; overview: CabinetOverview }
  | { kind: 'unauthenticated' }
  | { kind: 'telegram-rejected' }
  | { kind: 'unavailable' };

export const cabinetOverviewQueryKey = ['cabinet', 'overview'] as const;

export async function loadCabinetState(): Promise<CabinetViewState> {
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

export function useCabinetQuery() {
  return useQuery({
    queryKey: cabinetOverviewQueryKey,
    queryFn: loadCabinetState,
    enabled: typeof window !== 'undefined',
  });
}

type IssueDeviceVariables = {
  input: CreateCabinetDeviceRequest;
  idempotencyKey: string;
};

export function useIssueCabinetDevice({
  onIssued,
}: {
  onIssued: (device: IssuedCabinetDevice) => void;
}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ input, idempotencyKey }: IssueDeviceVariables) => {
      const device = await issueCabinetDevice(input, idempotencyKey);
      onIssued(device);
    },
    onSuccess: async () => {
      await queryClient.resetQueries({
        queryKey: cabinetOverviewQueryKey,
        exact: true,
      });
    },
  });
}

export function useRevokeCabinetDevice() {
  const queryClient = useQueryClient();
  const refreshCabinet = async () => {
    await queryClient.resetQueries({
      queryKey: cabinetOverviewQueryKey,
      exact: true,
    });
  };

  return useMutation({
    mutationFn: async (deviceId: string) => {
      try {
        await revokeCabinetDevice(deviceId);
        await refreshCabinet();
      } catch (error) {
        const recovered = await recoverFromDeviceRevokeError(error, {
          onAuthenticationRequired: refreshCabinet,
          onNotFound: refreshCabinet,
        });
        if (!recovered) {
          throw error;
        }
      }
    },
  });
}
