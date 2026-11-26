import { AI_TIMEOUT_MS, MEDIA_TIMEOUT_MS, requestJson, resolveApiUrl } from './http';
import type { MashupMode, ProjectState, SfxItem } from './types';

export function uploadReferenceTrack(
  projectId: string,
  file: File,
  title?: string
): Promise<ProjectState> {
  const form = new FormData();
  form.append('file', file);
  if (title && title.trim()) {
    form.append('title', title.trim());
  }
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/references/upload`,
    { method: 'POST', body: form },
    MEDIA_TIMEOUT_MS
  );
}

export function addYoutubeReference(
  projectId: string,
  url: string,
  title?: string
): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/references/youtube`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, ...(title ? { title } : {}) }),
    },
    MEDIA_TIMEOUT_MS
  );
}

export function deleteReference(projectId: string, refId: string): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(refId)}`,
    { method: 'DELETE' }
  );
}

export function addReferenceMoment(
  projectId: string,
  refId: string,
  payload: { label: string; start: number; end: number; note?: string }
): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(refId)}/moments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
}

export function deleteReferenceMoment(
  projectId: string,
  refId: string,
  momentId: string
): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(
      refId
    )}/moments/${encodeURIComponent(momentId)}`,
    { method: 'DELETE' }
  );
}

export function autoTagReference(projectId: string, refId: string): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(refId)}/auto-tag`,
    { method: 'POST' },
    AI_TIMEOUT_MS
  );
}

export function extractReferenceStems(projectId: string, refId: string): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(
      refId
    )}/extract-stems`,
    { method: 'POST' },
    AI_TIMEOUT_MS
  );
}

export function getReferenceAudioUrl(
  projectId: string,
  refId: string,
  audioUrl: string | null = null
): string {
  const raw = audioUrl || `/api/projects/${projectId}/references/${refId}/audio`;
  return resolveApiUrl(raw);
}

export function createAutoMashup(
  projectId: string,
  payload: {
    ref_id: string;
    mode: MashupMode;
    start?: number | null;
    end?: number | null;
    ref_start?: number | null;
    ref_end?: number | null;
  }
): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/mashup`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    AI_TIMEOUT_MS
  );
}

export async function listSfx(): Promise<SfxItem[]> {
  const data = await requestJson<{ items: SfxItem[] }>('/api/sfx');
  return data.items;
}

export function getSfxPreviewUrl(
  sfxId: string,
  bpm?: number,
  duration?: number,
  key?: string
): string {
  const url = new URL(resolveApiUrl(`/api/sfx/${encodeURIComponent(sfxId)}/preview`));
  if (bpm && Number.isFinite(bpm) && bpm > 0) {
    url.searchParams.set('bpm', String(Math.round(bpm)));
  }
  if (duration && Number.isFinite(duration) && duration > 0) {
    url.searchParams.set('duration', String(Number(duration.toFixed(2))));
  }
  if (key && key.trim()) {
    url.searchParams.set('key', key.trim());
  }
  return url.toString();
}
