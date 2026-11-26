import { useEffect } from 'react';
import type React from 'react';
import { getProject } from '../shared/api';
import type { ProjectState, ProjectSummary } from '../shared/api';

function isProcessingStems(project: ProjectState | null): boolean {
  if (!project) return false;
  return (
    project.main_track?.stems_status === 'processing' ||
    project.references.some((r) => r.stems_status === 'processing')
  );
}

export function useStemPolling(
  currentProject: ProjectState | null,
  setCurrentProject: React.Dispatch<React.SetStateAction<ProjectState | null>>,
  refreshProjectList: () => Promise<ProjectSummary[]>
): void {
  const currentProjectId = currentProject?.id ?? null;
  const isAnyStemProcessing = isProcessingStems(currentProject);

  useEffect(() => {
    if (!currentProjectId || !isAnyStemProcessing) return;

    let active = true;
    let timerId: number | null = null;

    const pollOnce = async () => {
      let shouldContinue = true;
      try {
        const updated = await getProject(currentProjectId);
        if (!active) return;

        setCurrentProject((prev) => {
          if (!prev || prev.id !== updated.id) return prev;
          const prevTs = Date.parse(prev.updated_at);
          const nextTs = Date.parse(updated.updated_at);
          if (Number.isFinite(prevTs) && Number.isFinite(nextTs) && nextTs < prevTs) {
            return prev;
          }
          if (
            (!Number.isFinite(prevTs) || !Number.isFinite(nextTs)) &&
            updated.updated_at < prev.updated_at
          ) {
            return prev;
          }
          return updated;
        });

        if (!isProcessingStems(updated)) {
          shouldContinue = false;
          void refreshProjectList();
        }
      } catch {
        // Ignore transient polling failures and retry on next tick
      } finally {
        if (active && shouldContinue) {
          timerId = window.setTimeout(pollOnce, 2500);
        }
      }
    };

    timerId = window.setTimeout(pollOnce, 2500);

    return () => {
      active = false;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [currentProjectId, isAnyStemProcessing, refreshProjectList, setCurrentProject]);
}
