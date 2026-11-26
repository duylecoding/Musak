import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadBlob,
  extractErrorDetail,
  getBackendUrl,
  requestJson,
  resolveApiUrl,
} from './http';

describe('http helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('resolveApiUrl', () => {
    it('resolves relative paths against backend URL and preserves absolute URLs', () => {
      expect(getBackendUrl()).toBe('http://127.0.0.1:8765');
      expect(resolveApiUrl('/api/health')).toBe('http://127.0.0.1:8765/api/health');
      expect(resolveApiUrl('api/projects')).toBe('http://127.0.0.1:8765/api/projects');
      expect(resolveApiUrl('https://example.com/audio.wav')).toBe('https://example.com/audio.wav');
    });
  });

  describe('extractErrorDetail', () => {
    it('handles string detail', () => {
      expect(extractErrorDetail({ detail: 'Project not found' }, 'fallback')).toBe(
        'Project not found'
      );
    });

    it('handles FastAPI 422 validation error arrays', () => {
      const payload = {
        detail: [
          { loc: ['body', 'name'], msg: 'Field required', type: 'missing' },
          { loc: ['body', 'start'], msg: 'Input should be >= 0', type: 'greater_than_equal' },
        ],
      };
      expect(extractErrorDetail(payload, 'fallback')).toBe(
        'Field required; Input should be >= 0'
      );
    });

    it('falls back to message, error, or fallback string', () => {
      expect(extractErrorDetail({ message: 'Bad gateway' }, 'fallback')).toBe('Bad gateway');
      expect(extractErrorDetail({ error: 'Boom' }, 'fallback')).toBe('Boom');
      expect(extractErrorDetail({ detail: [] }, 'fallback')).toBe('fallback');
      expect(extractErrorDetail(null, 'fallback')).toBe('fallback');
    });
  });

  describe('requestJson', () => {
    it('returns parsed JSON on 200 response', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const data = await requestJson<{ ok: boolean }>('/api/health');
      expect(data).toEqual({ ok: true });
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8765/api/health',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('throws extracted FastAPI detail on non-OK HTTP responses', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ detail: [{ msg: 'Invalid BPM value' }] }),
          { status: 422 }
        )
      );

      await expect(requestJson('/api/projects')).rejects.toThrow('Invalid BPM value');
    });

    it('throws plain text error or status fallback when body is not JSON', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Internal crash', { status: 500 })
      );
      await expect(requestJson('/api/projects')).rejects.toThrow('Internal crash');
    });

    it('throws explicit timeout message when request exceeds timeoutMs', async () => {
      vi.useFakeTimers();

      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      });

      const promise = requestJson('/api/slow', undefined, 500);
      const expectation = expect(promise).rejects.toThrow('Request timed out — please try again');
      await vi.advanceTimersByTimeAsync(500);
      await expectation;
    });
  });

  describe('downloadBlob', () => {
    it('keeps timeout active through res.blob()', async () => {
      vi.useFakeTimers();

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-disposition': 'attachment; filename="mix.wav"' }),
        blob: () => new Promise<Blob>(() => {}),
      } as unknown as Response;

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

      const promise = downloadBlob('/api/projects/1/export', undefined, 400);
      const expectation = expect(promise).rejects.toThrow('Request timed out — please try again');
      await vi.advanceTimersByTimeAsync(400);
      await expectation;
    });
  });
});
