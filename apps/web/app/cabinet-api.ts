import {
  cabinetOverviewSchema,
  type CabinetOverview,
} from '@vpn-platform/contracts';

export class CabinetApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'unauthenticated' | 'unavailable' | 'invalid-response',
  ) {
    super(message);
  }
}

export async function fetchCabinetOverview(
  fetcher: typeof fetch = fetch,
): Promise<CabinetOverview> {
  let response: Response;
  try {
    response = await fetcher('/api/cabinet/overview', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    throw new CabinetApiError('Cabinet API is unavailable', 'unavailable');
  }

  if (response.status === 401) {
    throw new CabinetApiError('Session is unavailable', 'unauthenticated');
  }
  if (!response.ok) {
    throw new CabinetApiError('Cabinet API is unavailable', 'unavailable');
  }

  const result = cabinetOverviewSchema.safeParse(await response.json());
  if (!result.success) {
    throw new CabinetApiError(
      'Cabinet API returned an invalid response',
      'invalid-response',
    );
  }
  return result.data;
}
