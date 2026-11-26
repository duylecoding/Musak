import { requestJson } from './http';
import type { HealthStatus, StemDevice } from './types';

export function getHealth(): Promise<HealthStatus> {
  return requestJson<HealthStatus>('/api/health');
}

export function setBackendApiKey(apiKey: string): Promise<{ api_key_configured: boolean }> {
  return requestJson<{ api_key_configured: boolean }>('/api/settings/api-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey }),
  });
}

export function clearBackendApiKey(): Promise<{ api_key_configured: boolean }> {
  return requestJson<{ api_key_configured: boolean }>('/api/settings/api-key', {
    method: 'DELETE',
  });
}

export function setStemDevice(device: StemDevice): Promise<{ stem_device: StemDevice }> {
  return requestJson<{ stem_device: StemDevice }>('/api/settings/stem-device', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device }),
  });
}
