import {
  createCabinetDeviceRequestSchema,
  issuedCabinetDeviceSchema,
  type CreateCabinetDeviceRequest,
  type IssuedCabinetDevice,
} from '@vpn-platform/contracts';

export class DeviceApiError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'invalid-request'
      | 'unauthenticated'
      | 'forbidden'
      | 'conflict'
      | 'unavailable'
      | 'invalid-response',
  ) {
    super(message);
  }
}

export async function issueCabinetDevice(
  input: CreateCabinetDeviceRequest,
  fetcher: typeof fetch = fetch,
): Promise<IssuedCabinetDevice> {
  const request = createCabinetDeviceRequestSchema.safeParse(input);
  if (!request.success) {
    throw new DeviceApiError('Device request is invalid', 'invalid-request');
  }

  let response: Response;
  try {
    response = await fetcher('/api/cabinet/devices', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.data),
    });
  } catch {
    throw new DeviceApiError('Device API is unavailable', 'unavailable');
  }

  if (response.status === 401) {
    throw new DeviceApiError('Session is unavailable', 'unauthenticated');
  }
  if (response.status === 403) {
    throw new DeviceApiError('Device request is forbidden', 'forbidden');
  }
  if (response.status === 409) {
    throw new DeviceApiError(
      'Device request conflicts with subscription',
      'conflict',
    );
  }
  if (!response.ok) {
    throw new DeviceApiError('Device API is unavailable', 'unavailable');
  }

  const result = issuedCabinetDeviceSchema.safeParse(await response.json());
  if (!result.success) {
    throw new DeviceApiError(
      'Device API returned an invalid response',
      'invalid-response',
    );
  }
  return result.data;
}
