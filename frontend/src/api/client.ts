import type {
  EditOperation,
  HealthStatus,
  ProjectState,
  ProjectSummary,
  TimeSelection,
} from './types';
import { sanitizeFilename } from '../utils/format';

let backendBaseUrl = 'http://127.0.0.1:8765';

export async function initBackendUrl(): Promise<string> {
  if (window.musakBridge?.getBackendUrl) {
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

export function getBackendBaseUrl(): string {
  return backendBaseUrl;
}

export function resolveApiUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }
  const normalizedPath = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${backendBaseUrl}${normalizedPath}`;
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

export function getStemAudioUrl(project: ProjectState, stemName: string): string {
  const fromMap = project.main_track?.stem_urls?.[stemName];
  const raw = fromMap || `/api/projects/${project.id}/audio/stem/${stemName}`;
  return resolveApiUrl(raw);
}

export function getProposalPreviewUrl(projectId: string, proposalId: string, previewUrl: string | null): string {
  const raw = previewUrl || `/api/projects/${projectId}/audio/preview/${proposalId}`;
  return resolveApiUrl(raw);
}

export function getReferenceAudioUrl(projectId: string, refId: string, audioUrl: string | null): string {
  const raw = audioUrl || `/api/projects/${projectId}/references/${refId}/audio`;
  return resolveApiUrl(raw);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolveApiUrl(path), init);
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { detail?: string; message?: string; error?: string };
          detail = parsed.detail || parsed.message || parsed.error || text;
        } catch {
          detail = text;
        }
      }
    } catch {
      // ignore body read error
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

// 1. Health & Settings
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

// 2. Projects
export async function listProjects(): Promise<ProjectSummary[]> {
  const data = await requestJson<{ projects: ProjectSummary[] }>('/api/projects');
  return data.projects;
}

export function createProject(name: string): Promise<ProjectState> {
  return requestJson<ProjectState>('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function getProject(projectId: string): Promise<ProjectState> {
  return requestJson<ProjectState>(`/api/projects/${encodeURIComponent(projectId)}`);
}

export function renameProject(projectId: string, name: string): Promise<ProjectState> {
  return requestJson<ProjectState>(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function deleteProject(projectId: string): Promise<{ deleted: boolean }> {
  return requestJson<{ deleted: boolean }>(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
  });
}

// 3. Main Track & Export
export function uploadMainTrack(projectId: string, file: File): Promise<ProjectState> {
  const form = new FormData();
  form.append('file', file);
  return requestJson<ProjectState>(`/api/projects/${encodeURIComponent(projectId)}/main-track`, {
    method: 'POST',
    body: form,
  });
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
    }
  );
}

export function setMainTrackFromReference(
  projectId: string,
  refId: string
): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/main-track/from-reference/${encodeURIComponent(
      refId
    )}`,
    { method: 'POST' }
  );
}

export function separateMainTrackStems(projectId: string): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/main-track/separate`,
    { method: 'POST' }
  );
}

export async function exportProjectAudio(
  projectId: string,
  format: 'wav' | 'mp3',
  trackTitle?: string
): Promise<void> {
  const res = await fetch(resolveApiUrl(`/api/projects/${encodeURIComponent(projectId)}/export`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format }),
  });

  if (!res.ok) {
    let detail = `Export failed (${res.status})`;
    try {
      const parsed = (await res.json()) as { detail?: string };
      if (parsed.detail) detail = parsed.detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }

  const blob = await res.blob();
  let filename = `${sanitizeFilename(trackTitle || 'musak_remix')}_remix.${format}`;
  const disposition = res.headers.get('content-disposition');
  if (disposition) {
    const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
    if (match && match[1]) {
      filename = decodeURIComponent(match[1].replace(/"/g, '').trim());
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
}

// 4. Reference Shelf
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
    {
      method: 'POST',
      body: form,
    }
  );
}

export function addYouTubeReference(
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
    }
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
    { method: 'POST' }
  );
}

export function extractReferenceStems(projectId: string, refId: string): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(
      refId
    )}/extract-stems`,
    { method: 'POST' }
  );
}

// 5. Edits & History
export function createEdit(
  projectId: string,
  payload: {
    title: string;
    description: string;
    start: number;
    end: number;
    operations: EditOperation[];
  }
): Promise<ProjectState> {
  return requestJson<ProjectState>(`/api/projects/${encodeURIComponent(projectId)}/edits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function applyProposal(projectId: string, proposalId: string): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/edits/apply-proposal/${encodeURIComponent(
      proposalId
    )}`,
    { method: 'POST' }
  );
}

export function toggleEdit(
  projectId: string,
  editId: string,
  enabled: boolean
): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/edits/${encodeURIComponent(editId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }
  );
}

export function deleteEdit(projectId: string, editId: string): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/edits/${encodeURIComponent(editId)}`,
    { method: 'DELETE' }
  );
}

export function undoEdit(projectId: string): Promise<ProjectState> {
  return requestJson<ProjectState>(`/api/projects/${encodeURIComponent(projectId)}/undo`, {
    method: 'POST',
  });
}

export function redoEdit(projectId: string): Promise<ProjectState> {
  return requestJson<ProjectState>(`/api/projects/${encodeURIComponent(projectId)}/redo`, {
    method: 'POST',
  });
}

// 6. Gemini Producer Chat & Voice Input
export function sendChatMessage(
  projectId: string,
  payload: {
    message: string;
    selection?: TimeSelection | null;
    reference_ids?: string[];
  }
): Promise<ProjectState> {
  return requestJson<ProjectState>(`/api/projects/${encodeURIComponent(projectId)}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function transcribeVoice(
  blob: Blob,
  filename = 'voice.webm'
): Promise<{ text: string }> {
  const form = new FormData();
  form.append('file', blob, filename);
  return requestJson<{ text: string }>('/api/voice/transcribe', {
    method: 'POST',
    body: form,
  });
}
