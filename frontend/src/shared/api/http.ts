export const DEFAULT_TIMEOUT_MS = 25_000;
export const AI_TIMEOUT_MS = 45_000;
export const MEDIA_TIMEOUT_MS = 180_000;
export const EXPORT_TIMEOUT_MS = 120_000;

let backendBaseUrl = 'http://127.0.0.1:8765';

export async function initBackendUrl(): Promise<string> {
  if (typeof window !== 'undefined' && window.musakBridge?.getBackendUrl) {
    try {
      const url = await window.musakBridge.getBackendUrl();
      if (url) {
        backendBaseUrl = url.replace(/\/+$/, '');
      }
    } catch {
      // Keep default localhost backend URL
    }
  }
  return backendBaseUrl;
}

export function getBackendUrl(): string {
  return backendBaseUrl;
}

export function resolveApiUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }
  const normalizedPath = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${backendBaseUrl}${normalizedPath}`;
}

export function extractErrorDetail(parsed: unknown, fallback: string): string {
  if (!parsed || typeof parsed !== 'object') return fallback;
  const obj = parsed as { detail?: unknown; message?: unknown; error?: unknown };
  if (typeof obj.detail === 'string' && obj.detail.trim()) return obj.detail;
  if (Array.isArray(obj.detail)) {
    const msgs = obj.detail
      .map((item) =>
        item && typeof item === 'object' && 'msg' in item && typeof item.msg === 'string'
          ? item.msg
          : null
      )
      .filter((m): m is string => Boolean(m));
    if (msgs.length > 0) return msgs.join('; ');
  }
  if (typeof obj.message === 'string' && obj.message.trim()) return obj.message;
  if (typeof obj.error === 'string' && obj.error.trim()) return obj.error;
  return fallback;
}

async function readResponseError(res: Response, fallbackPrefix: string): Promise<string> {
  let detail = `${fallbackPrefix} (${res.status})`;
  try {
    const text = await res.text();
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        detail = extractErrorDetail(parsed, text);
      } catch {
        detail = text;
      }
    }
  } catch {
    // Ignore response body read failure
  }
  return detail;
}

function createRequestSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; didTimeout: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      globalThis.clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

export async function requestJson<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const req = createRequestSignal(init?.signal ?? undefined, timeoutMs);
  try {
    const res = await fetch(resolveApiUrl(path), {
      ...init,
      signal: req.signal,
    });
    if (!res.ok) {
      throw new Error(await readResponseError(res, 'Request failed'));
    }
    return (await res.json()) as T;
  } catch (err) {
    if (req.didTimeout()) {
      throw new Error('Request timed out — please try again');
    }
    throw err;
  } finally {
    req.cleanup();
  }
}

export async function downloadBlob(
  path: string,
  init?: RequestInit,
  timeoutMs = EXPORT_TIMEOUT_MS
): Promise<{ blob: Blob; disposition: string | null }> {
  const req = createRequestSignal(init?.signal ?? undefined, timeoutMs);
  try {
    const res = await fetch(resolveApiUrl(path), {
      ...init,
      signal: req.signal,
    });
    if (!res.ok) {
      throw new Error(await readResponseError(res, 'Export failed'));
    }
    const disposition = res.headers.get('content-disposition');
    const blob = await new Promise<Blob>((resolve, reject) => {
      if (req.signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
      req.signal.addEventListener('abort', onAbort, { once: true });
      res.blob().then(
        (b) => {
          req.signal.removeEventListener('abort', onAbort);
          resolve(b);
        },
        (err) => {
          req.signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
    return { blob, disposition };
  } catch (err) {
    if (req.didTimeout()) {
      throw new Error('Request timed out — please try again');
    }
    throw err;
  } finally {
    req.cleanup();
  }
}
