import { sanitizeFilename } from '../utils/format';
import { downloadBlob, EXPORT_TIMEOUT_MS, requestJson } from './http';
import type {
  EditOperation,
  EditUpdatePayload,
  ExportOptions,
  ProjectState,
  ProposalTunePayload,
} from './types';

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
    `/api/projects/${encodeURIComponent(projectId)}/edits/apply-proposal/${encodeURIComponent(proposalId)}`,
    { method: 'POST' }
  );
}

export function tuneProposal(
  projectId: string,
  proposalId: string,
  payload: ProposalTunePayload
): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}/tune`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
}

export function updateEdit(
  projectId: string,
  editId: string,
  patch: EditUpdatePayload
): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/edits/${encodeURIComponent(editId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
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

export async function exportProjectAudio(
  projectId: string,
  options: ExportOptions,
  trackTitle?: string
): Promise<void> {
  const target = options.target ?? 'remix';
  const format = target === 'stems_zip' ? 'zip' : options.format ?? 'wav';
  const masterPreset = options.master_preset ?? 'off';

  const { blob, disposition } = await downloadBlob(
    `/api/projects/${encodeURIComponent(projectId)}/export`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, target, master_preset: masterPreset }),
    },
    EXPORT_TIMEOUT_MS
  );

  const suffixMap: Record<NonNullable<ExportOptions['target']>, string> = {
    remix: 'remix',
    instrumental: 'instrumental',
    vocals: 'vocals',
    stems_zip: 'stems',
  };
  let filename = `${sanitizeFilename(trackTitle || 'musak_track')}_${suffixMap[target]}.${format}`;
  if (disposition) {
    const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
    if (match?.[1]) {
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
  globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
}
