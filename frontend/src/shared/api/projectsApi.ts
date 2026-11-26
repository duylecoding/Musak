import { requestJson } from './http';
import type { ProjectState, ProjectSummary } from './types';

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
