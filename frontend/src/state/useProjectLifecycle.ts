import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import {
  createProject as apiCreateProject,
  deleteProject as apiDeleteProject,
  getHealth,
  getProject,
  initBackendUrl,
  listProjects,
  listSfx,
  renameProject as apiRenameProject,
} from '../shared/api';
import type {
  HealthStatus,
  ProjectState,
  ProjectSummary,
  SfxItem,
  TimeSelection,
} from '../shared/api';

interface LifecycleDeps {
  activeProjectIdRef: React.MutableRefObject<string | null>;
  currentProject: ProjectState | null;
  setCurrentProject: React.Dispatch<React.SetStateAction<ProjectState | null>>;
  setSelection: React.Dispatch<React.SetStateAction<TimeSelection | null>>;
  setAttachedRefIds: React.Dispatch<React.SetStateAction<string[]>>;
  setAbMode: React.Dispatch<React.SetStateAction<'original' | 'remix'>>;
  showToast: (type: 'error' | 'success', message: string) => void;
}

export function useProjectLifecycle({
  activeProjectIdRef,
  currentProject,
  setCurrentProject,
  setSelection,
  setAttachedRefIds,
  setAbMode,
  showToast,
}: LifecycleDeps) {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [backendOnline, setBackendOnline] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [sfxItems, setSfxItems] = useState<SfxItem[]>([]);

  const refreshHealth = useCallback(async (): Promise<HealthStatus | null> => {
    try {
      const h = await getHealth();
      setHealth(h);
      setBackendOnline(true);
      return h;
    } catch {
      setBackendOnline(false);
      return null;
    }
  }, []);

  const refreshProjectList = useCallback(async () => {
    try {
      const list = await listProjects();
      setProjects(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  const loadWorkspace = useCallback(async () => {
    const list = await refreshProjectList();
    if (list.length > 0) {
      setCurrentProject(await getProject(list[0].id));
    } else {
      setCurrentProject(await apiCreateProject('My First Remix'));
      await refreshProjectList();
    }
  }, [refreshProjectList, setCurrentProject]);

  useEffect(() => {
    return window.musakBridge?.onApiKeySynced?.(() => void refreshHealth());
  }, [refreshHealth]);

  useEffect(() => {
    if (!backendOnline || !health || health.api_key_configured || !window.musakBridge?.getKeyStatus) return;
    let cancelled = false;
    let timer: number | null = null;
    window.musakBridge
      .getKeyStatus()
      .then((status) => {
        if (cancelled || !status.configured) return;
        timer = window.setTimeout(() => {
          if (!cancelled) void refreshHealth();
        }, 1000);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [backendOnline, health, refreshHealth]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;

    const boot = async () => {
      await initBackendUrl();
      const online = Boolean(await refreshHealth());
      if (cancelled) return;

      if (online) {
        try {
          await loadWorkspace();
        } catch (err) {
          showToast(
            'error',
            err instanceof Error ? err.message : 'Failed to load workspace projects.'
          );
        } finally {
          if (!cancelled) setInitializing(false);
        }
      } else {
        setInitializing(false);
        retryTimer = window.setInterval(async () => {
          const ok = Boolean(await refreshHealth());
          if (ok && !cancelled) {
            if (retryTimer) window.clearInterval(retryTimer);
            retryTimer = null;
            try {
              await loadWorkspace();
            } catch {
              // Ignore transient startup error
            }
          }
        }, 2000);
      }
    };

    void boot();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearInterval(retryTimer);
    };
  }, [loadWorkspace, refreshHealth, showToast]);

  useEffect(() => {
    if (!backendOnline || sfxItems.length > 0) return;
    let cancelled = false;
    listSfx()
      .then((items) => {
        if (!cancelled) setSfxItems(items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [backendOnline, sfxItems.length]);

  const selectProject = useCallback(
    async (projectId: string) => {
      if (projectId === currentProject?.id) return;
      activeProjectIdRef.current = projectId;
      try {
        const state = await getProject(projectId);
        if (activeProjectIdRef.current !== projectId) return;
        setCurrentProject(state);
        setSelection(null);
        setAttachedRefIds([]);
        setAbMode('remix');
      } catch (err) {
        if (activeProjectIdRef.current === projectId) {
          activeProjectIdRef.current = currentProject?.id ?? null;
        }
        showToast('error', err instanceof Error ? err.message : 'Failed to open project.');
      }
    },
    [activeProjectIdRef, currentProject?.id, setAbMode, setAttachedRefIds, setCurrentProject, setSelection, showToast]
  );

  const createProject = useCallback(
    async (name: string) => {
      try {
        const created = await apiCreateProject(name);
        activeProjectIdRef.current = created.id;
        setCurrentProject(created);
        setSelection(null);
        setAttachedRefIds([]);
        setAbMode('remix');
        await refreshProjectList();
        showToast('success', `Created project "${created.name}".`);
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Failed to create project.');
        throw err;
      }
    },
    [activeProjectIdRef, refreshProjectList, setAbMode, setAttachedRefIds, setCurrentProject, setSelection, showToast]
  );

  const renameProject = useCallback(
    async (targetProjectId: string, name: string) => {
      const trimmed = name.trim();
      if (!targetProjectId || !trimmed) return;
      try {
        const updated = await apiRenameProject(targetProjectId, trimmed);
        setProjects((prev) =>
          prev.map((p) =>
            p.id === targetProjectId ? { ...p, name: updated.name, updated_at: updated.updated_at } : p
          )
        );
        if (activeProjectIdRef.current === targetProjectId) {
          setCurrentProject(updated);
        }
        await refreshProjectList();
        showToast('success', `Renamed project to "${updated.name}".`);
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Failed to rename project.');
        throw err;
      }
    },
    [activeProjectIdRef, refreshProjectList, setCurrentProject, showToast]
  );

  const deleteProject = useCallback(
    async (projectId: string) => {
      try {
        await apiDeleteProject(projectId);
        const updatedList = await refreshProjectList();
        if (projectId === activeProjectIdRef.current) {
          if (updatedList.length > 0) {
            const nextId = updatedList[0].id;
            activeProjectIdRef.current = nextId;
            const next = await getProject(nextId);
            if (activeProjectIdRef.current === nextId) setCurrentProject(next);
          } else {
            const fresh = await apiCreateProject('My First Remix');
            activeProjectIdRef.current = fresh.id;
            setCurrentProject(fresh);
            await refreshProjectList();
          }
          setSelection(null);
          setAttachedRefIds([]);
        }
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Failed to delete project.');
      }
    },
    [activeProjectIdRef, refreshProjectList, setAttachedRefIds, setCurrentProject, setSelection, showToast]
  );

  return {
    health,
    backendOnline,
    initializing,
    projects,
    sfxItems,
    refreshHealth,
    refreshProjectList,
    selectProject,
    createProject,
    renameProject,
    deleteProject,
  };
}
