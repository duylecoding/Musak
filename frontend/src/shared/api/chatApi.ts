import { AI_TIMEOUT_MS, requestJson } from './http';
import type { ProjectState, TimeSelection } from './types';

export function sendProducerChat(
  projectId: string,
  payload: {
    message: string;
    selection?: TimeSelection | null;
    reference_ids?: string[];
  }
): Promise<ProjectState> {
  return requestJson<ProjectState>(
    `/api/projects/${encodeURIComponent(projectId)}/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    AI_TIMEOUT_MS
  );
}

export function transcribeVoice(blob: Blob, filename = 'voice.webm'): Promise<{ text: string }> {
  const form = new FormData();
  form.append('file', blob, filename);
  return requestJson<{ text: string }>(
    '/api/voice/transcribe',
    { method: 'POST', body: form },
    AI_TIMEOUT_MS
  );
}
