import { AI_TIMEOUT_MS, MEDIA_TIMEOUT_MS, requestJson, resolveApiUrl } from './http';
import type { ProjectState, WaveformPeaksResponse } from './types';

export function uploadMainTrack(projectId: string, file: File): Promise<ProjectState> {
  const form = new FormData();
  form.append('file', file);
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/main-track`,
    { method: 'POST', body: form },
    MEDIA_TIMEOUT_MS
  );
}

export function setMainTrackFromYoutube(
  projectId: string,
  url: string,
  title?: string
): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/main-track/youtube`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, ...(title ? { title } : {}) }),
    },
    MEDIA_TIMEOUT_MS
  );
}

export function setMainTrackFromReference(projectId: string, refId: string): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/main-track/from-reference/${encodeURIComponent(refId)}`,
    { method: 'POST' },
    MEDIA_TIMEOUT_MS
  );
}

export function separateMainStems(projectId: string): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/main-track/separate`,
    { method: 'POST' }
  );
}

export function extractMainTrackHooks(projectId: string): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/main-track/extract-hooks`,
    { method: 'POST' },
    AI_TIMEOUT_MS
  );
}

export function updateMainTrackMeta(
  projectId: string,
  payload: { bpm?: number; key?: string }
): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/main-track/meta`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
}

export function addCueMarker(
  projectId: string,
  payload: { label: string; time: number; color?: string }
): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/main-track/cues`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
}

export function updateCueMarker(
  projectId: string,
  cueId: string,
  payload: { label?: string; time?: number; color?: string }
): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/main-track/cues/${encodeURIComponent(cueId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
}

export function deleteCueMarker(projectId: string, cueId: string): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/main-track/cues/${encodeURIComponent(cueId)}`,
    { method: 'DELETE' }
  );
}

export function getProjectPeaks(projectId: string, buckets = 500): Promise<WaveformPeaksResponse> {
  return requestJson<WaveformPeaksResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/peaks?buckets=${encodeURIComponent(String(buckets))}`
  );
}

export function getMainAudioUrl(project: ProjectState): string | null {
  if (!project.main_track) return null;
  const raw = project.main_track.audio_url || `/api/projects/${project.id}/audio/main`;
  const url = new URL(resolveApiUrl(raw));
  url.searchParams.set('t', project.main_track.id);
  return url.toString();
}

export function getRenderedAudioUrl(project: ProjectState): string | null {
  if (!project.main_track) return null;
  const raw = project.main_track.rendered_url || `/api/projects/${project.id}/audio/rendered`;
  const url = new URL(resolveApiUrl(raw));
  url.searchParams.set('t', project.main_track.id);
  url.searchParams.set('v', String(project.render_version));
  return url.toString();
}

export function getStemAudioUrl(
  project: ProjectState,
  stemName: string,
  mode: 'original' | 'remix' = 'original'
): string {
  const fromMap = project.main_track?.stem_urls?.[stemName];
  const raw = fromMap || `/api/projects/${project.id}/audio/stem/${stemName}`;
  const url = new URL(resolveApiUrl(raw));
  if (project.main_track?.id) url.searchParams.set('t', project.main_track.id);
  url.searchParams.set('mode', mode);
  if (mode === 'remix') url.searchParams.set('v', String(project.render_version));
  return url.toString();
}

export function getPreviewAudioUrl(
  projectId: string,
  proposalId: string,
  previewUrl: string | null = null
): string {
  const raw = previewUrl || `/api/projects/${projectId}/audio/preview/${proposalId}`;
  return resolveApiUrl(raw);
}
