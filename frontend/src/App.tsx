import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import type {
  HealthStatus,
  MomentPin,
  ProjectState,
  ProjectSummary,
  ReferenceTrack,
  TimeSelection,
} from './api/types';
import {
  addReferenceMoment,
  addYouTubeReference,
  applyProposal,
  autoTagReference,
  createProject,
  deleteEdit,
  deleteProject,
  deleteReference,
  deleteReferenceMoment,
  exportProjectAudio,
  extractReferenceStems,
  getHealth,
  getProject,
  initBackendUrl,
  listProjects,
  redoEdit,
  renameProject,
  sendChatMessage,
  separateMainTrackStems,
  setMainTrackFromReference,
  setMainTrackFromYoutube,
  toggleEdit,
  undoEdit,
  uploadMainTrack,
  uploadReferenceTrack,
} from './api/client';
import { TopBar } from './components/TopBar';
import { ReferenceShelf } from './components/ReferenceShelf';
import { MainCanvas } from './components/MainCanvas';
import { ProducerChat } from './components/ProducerChat';
import { SettingsModal } from './components/SettingsModal';
import { formatTimeRange } from './utils/format';

interface ToastState {
  type: 'error' | 'success';
  message: string;
}

export const App: React.FC = () => {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [backendOnline, setBackendOnline] = useState(false);
  const [initializing, setInitializing] = useState(true);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [currentProject, setCurrentProject] = useState<ProjectState | null>(null);

  const [abMode, setAbMode] = useState<'original' | 'remix'>('remix');
  const [selection, setSelection] = useState<TimeSelection | null>(null);
  const [attachedRefIds, setAttachedRefIds] = useState<string[]>([]);
  const [draftSnippet, setDraftSnippet] = useState<{ text: string; nonce: number } | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [mainTrackBusy, setMainTrackBusy] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<'wav' | 'mp3' | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const activeProjectIdRef = useRef<string | null>(null);
  const mainTrackBusyRef = useRef(false);
  activeProjectIdRef.current = currentProject?.id ?? null;

  const showToast = useCallback((type: 'error' | 'success', message: string) => {
    setToast({ type, message });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

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

  // Listen for Electron startup/IPC API key sync notifications
  useEffect(() => {
    const unsubscribe = window.musakBridge?.onApiKeySynced?.(() => {
      refreshHealth();
    });
    return () => {
      unsubscribe?.();
    };
  }, [refreshHealth]);

  // If Electron has a DPAPI-stored key but backend hasn't reflected it yet, trigger a follow-up health refresh
  useEffect(() => {
    if (!backendOnline || !health || health.api_key_configured) return;
    if (!window.musakBridge?.getKeyStatus) return;

    let cancelled = false;
    let followUpTimer: number | null = null;

    window.musakBridge
      .getKeyStatus()
      .then((status) => {
        if (cancelled || !status.configured) return;
        followUpTimer = window.setTimeout(() => {
          if (!cancelled) {
            refreshHealth();
          }
        }, 1000);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (followUpTimer !== null) {
        window.clearTimeout(followUpTimer);
      }
    };
  }, [backendOnline, health, refreshHealth]);

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
      const state = await getProject(list[0].id);
      setCurrentProject(state);
    } else {
      const created = await createProject('My First Remix');
      setCurrentProject(created);
      await refreshProjectList();
    }
  }, [refreshProjectList]);

  // Initial bootstrap (resolves backend URL, waits if Electron just spawned backend)
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
              // ignore transient error
            }
          }
        }, 2000);
      }
    };

    boot();

    return () => {
      cancelled = true;
      if (retryTimer) window.clearInterval(retryTimer);
    };
  }, [loadWorkspace, refreshHealth, showToast]);

  // Sequential race-free polling every 2.5s whenever main track or any reference is separating stems
  const isAnyStemProcessing = Boolean(
    currentProject &&
      (currentProject.main_track?.stems_status === 'processing' ||
        currentProject.references.some((r) => r.stems_status === 'processing'))
  );
  const currentProjectId = currentProject?.id ?? null;

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

        const stillProcessing =
          updated.main_track?.stems_status === 'processing' ||
          updated.references.some((r) => r.stems_status === 'processing');
        if (!stillProcessing) {
          shouldContinue = false;
          refreshProjectList();
        }
      } catch {
        // ignore transient polling failure and retry on next tick
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
  }, [currentProjectId, isAnyStemProcessing, refreshProjectList]);

  // Keep attachedRefIds pruned if references are removed
  useEffect(() => {
    if (!currentProject) return;
    const validIds = new Set(currentProject.references.map((r) => r.id));
    setAttachedRefIds((prev) => prev.filter((id) => validIds.has(id)));
  }, [currentProject]);

  // Project handlers
  const handleSelectProject = async (projectId: string) => {
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
  };

  const handleCreateProject = async (name: string) => {
    try {
      const created = await createProject(name);
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
  };

  const handleRenameProject = async (targetProjectId: string, name: string) => {
    const trimmed = name.trim();
    if (!targetProjectId || !trimmed) return;
    try {
      const updated = await renameProject(targetProjectId, trimmed);
      setProjects((prev) =>
        prev.map((p) =>
          p.id === targetProjectId
            ? { ...p, name: updated.name, updated_at: updated.updated_at }
            : p
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
  };

  const handleDeleteProject = async (projectId: string) => {
    try {
      await deleteProject(projectId);
      const updatedList = await refreshProjectList();
      if (projectId === activeProjectIdRef.current) {
        if (updatedList.length > 0) {
          const nextId = updatedList[0].id;
          activeProjectIdRef.current = nextId;
          const next = await getProject(nextId);
          if (activeProjectIdRef.current === nextId) {
            setCurrentProject(next);
          }
        } else {
          const fresh = await createProject('My First Remix');
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
  };

  // Main Track handlers (serialized via mainTrackBusyRef & guarded against mid-request project switches)
  const handleUploadMainTrack = async (file: File) => {
    const targetProjectId = activeProjectIdRef.current;
    if (!targetProjectId || mainTrackBusyRef.current) return;
    mainTrackBusyRef.current = true;
    setMainTrackBusy(true);
    try {
      const updated = await uploadMainTrack(targetProjectId, file);
      await refreshProjectList();
      if (activeProjectIdRef.current !== targetProjectId) return;
      setCurrentProject(updated);
      setSelection(null);
      setAbMode('remix');
      showToast('success', `Loaded "${updated.main_track?.name || file.name}".`);
    } finally {
      mainTrackBusyRef.current = false;
      setMainTrackBusy(false);
    }
  };

  const handleLoadMainFromYoutube = async (url: string) => {
    const targetProjectId = activeProjectIdRef.current;
    if (!targetProjectId || mainTrackBusyRef.current) return;
    mainTrackBusyRef.current = true;
    setMainTrackBusy(true);
    try {
      const updated = await setMainTrackFromYoutube(targetProjectId, url);
      await refreshProjectList();
      if (activeProjectIdRef.current !== targetProjectId) return;
      setCurrentProject(updated);
      setSelection(null);
      setAbMode('remix');
      showToast(
        'success',
        `Loaded "${updated.main_track?.name || 'YouTube track'}" onto main stage.`
      );
    } finally {
      mainTrackBusyRef.current = false;
      setMainTrackBusy(false);
    }
  };

  const handleLoadMainFromReference = async (refId: string) => {
    const targetProjectId = activeProjectIdRef.current;
    if (!targetProjectId || mainTrackBusyRef.current) return;
    mainTrackBusyRef.current = true;
    setMainTrackBusy(true);
    try {
      const updated = await setMainTrackFromReference(targetProjectId, refId);
      await refreshProjectList();
      if (activeProjectIdRef.current !== targetProjectId) return;
      setCurrentProject(updated);
      setSelection(null);
      setAbMode('remix');
      showToast(
        'success',
        `Loaded "${updated.main_track?.name || 'reference track'}" as main track.`
      );
    } finally {
      mainTrackBusyRef.current = false;
      setMainTrackBusy(false);
    }
  };

  const handleUseReferenceAsMain = async (refId: string) => {
    try {
      await handleLoadMainFromReference(refId);
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'Failed to load reference as main track.'
      );
    }
  };

  const handleSeparateMainStems = async () => {
    if (!currentProject) return;
    try {
      const updated = await separateMainTrackStems(currentProject.id);
      setCurrentProject(updated);
      showToast('success', 'Stem separation started on local compute.');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Could not start stem separation.');
    }
  };

  // Reference Shelf handlers
  const handleToggleAttachRef = (refId: string) => {
    setAttachedRefIds((prev) =>
      prev.includes(refId) ? prev.filter((id) => id !== refId) : [...prev, refId]
    );
  };

  const handleAddYouTube = async (url: string) => {
    if (!currentProject) return;
    const updated = await addYouTubeReference(currentProject.id, url);
    setCurrentProject(updated);
    await refreshProjectList();
  };

  const handleUploadReference = async (file: File) => {
    if (!currentProject) return;
    const updated = await uploadReferenceTrack(currentProject.id, file);
    setCurrentProject(updated);
    await refreshProjectList();
  };

  const handleDeleteReference = async (refId: string) => {
    if (!currentProject) return;
    try {
      const updated = await deleteReference(currentProject.id, refId);
      setCurrentProject(updated);
      await refreshProjectList();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to remove reference.');
    }
  };

  const handleAddMoment = async (
    refId: string,
    payload: { label: string; start: number; end: number; note?: string }
  ) => {
    if (!currentProject) return;
    const updated = await addReferenceMoment(currentProject.id, refId, payload);
    setCurrentProject(updated);
  };

  const handleDeleteMoment = async (refId: string, momentId: string) => {
    if (!currentProject) return;
    try {
      const updated = await deleteReferenceMoment(currentProject.id, refId, momentId);
      setCurrentProject(updated);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to delete moment.');
    }
  };

  const handleAutoTagReference = async (refId: string) => {
    if (!currentProject) return;
    try {
      const updated = await autoTagReference(currentProject.id, refId);
      setCurrentProject(updated);
      showToast('success', 'Gemini tagged standout moments on your reference track.');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Auto-tag failed.');
    }
  };

  const handleExtractReferenceStems = async (refId: string) => {
    if (!currentProject) return;
    try {
      const updated = await extractReferenceStems(currentProject.id, refId);
      setCurrentProject(updated);
      showToast('success', 'Downloading & separating reference stems in background...');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Stem extraction failed.');
    }
  };

  const handleSendMomentToChat = (ref: ReferenceTrack, moment: MomentPin) => {
    setAttachedRefIds((prev) => (prev.includes(ref.id) ? prev : [...prev, ref.id]));
    const range = formatTimeRange(moment.start, moment.end);
    setDraftSnippet({
      text: `@${ref.title} (${range} ${moment.label})`,
      nonce: Date.now(),
    });
  };

  // Edits & History handlers
  const handleSendChat = async (message: string) => {
    const targetProjectId = activeProjectIdRef.current;
    if (!targetProjectId) return;
    const updated = await sendChatMessage(targetProjectId, {
      message,
      selection,
      reference_ids: attachedRefIds,
    });
    if (activeProjectIdRef.current !== targetProjectId) return;
    setCurrentProject(updated);
  };

  const handleApplyProposal = async (proposalId: string) => {
    if (!currentProject) return;
    const updated = await applyProposal(currentProject.id, proposalId);
    setCurrentProject(updated);
    setAbMode('remix');
    await refreshProjectList();
    showToast('success', 'Applied remix edit! Listening to After · Remix.');
  };

  const handleToggleEdit = async (editId: string, enabled: boolean) => {
    if (!currentProject) return;
    try {
      const updated = await toggleEdit(currentProject.id, editId, enabled);
      setCurrentProject(updated);
      setAbMode('remix');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to update edit.');
    }
  };

  const handleDeleteEdit = async (editId: string) => {
    if (!currentProject) return;
    try {
      const updated = await deleteEdit(currentProject.id, editId);
      setCurrentProject(updated);
      await refreshProjectList();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to delete edit.');
    }
  };

  const handleUndo = async () => {
    if (!currentProject || historyBusy) return;
    setHistoryBusy(true);
    try {
      const updated = await undoEdit(currentProject.id);
      setCurrentProject(updated);
      setAbMode('remix');
      await refreshProjectList();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Undo failed.');
    } finally {
      setHistoryBusy(false);
    }
  };

  const handleRedo = async () => {
    if (!currentProject || historyBusy) return;
    setHistoryBusy(true);
    try {
      const updated = await redoEdit(currentProject.id);
      setCurrentProject(updated);
      setAbMode('remix');
      await refreshProjectList();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Redo failed.');
    } finally {
      setHistoryBusy(false);
    }
  };

  const handleExport = async (format: 'wav' | 'mp3') => {
    if (!currentProject || exportingFormat) return;
    setExportingFormat(format);
    try {
      await exportProjectAudio(
        currentProject.id,
        format,
        currentProject.main_track?.name || currentProject.name
      );
      showToast('success', `Exported ${format.toUpperCase()} remix!`);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setExportingFormat(null);
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0b0c10] text-zinc-100 overflow-hidden">
      <TopBar
        health={health}
        backendOnline={backendOnline}
        projects={projects}
        currentProject={currentProject}
        onSelectProject={handleSelectProject}
        onCreateProject={handleCreateProject}
        onRenameProject={handleRenameProject}
        onDeleteProject={handleDeleteProject}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onExport={handleExport}
        onOpenSettings={() => setSettingsOpen(true)}
        historyBusy={historyBusy}
        exportingFormat={exportingFormat}
      />

      {initializing ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-400">
          <Loader2 className="w-7 h-7 text-violet-400 animate-spin" />
          <p className="text-sm font-medium text-zinc-200">Starting Musak Producer Studio...</p>
          <p className="text-xs text-zinc-500">Connecting to local audio engine</p>
        </div>
      ) : (
        <div className="flex-1 flex min-h-0 overflow-hidden">
          <ReferenceShelf
            projectId={currentProject?.id ?? null}
            references={currentProject?.references ?? []}
            attachedRefIds={attachedRefIds}
            onToggleAttachRef={handleToggleAttachRef}
            onAddYouTube={handleAddYouTube}
            onUploadReference={handleUploadReference}
            onDeleteReference={handleDeleteReference}
            onAddMoment={handleAddMoment}
            onDeleteMoment={handleDeleteMoment}
            onAutoTag={handleAutoTagReference}
            onExtractStems={handleExtractReferenceStems}
            onUseAsMain={handleUseReferenceAsMain}
            mainTrackBusy={mainTrackBusy}
            onSendMomentToChat={handleSendMomentToChat}
            apiKeyConfigured={Boolean(health?.api_key_configured)}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          <MainCanvas
            project={currentProject}
            abMode={abMode}
            onAbModeChange={setAbMode}
            selection={selection}
            onSelectionChange={setSelection}
            mainTrackBusy={mainTrackBusy}
            onUploadMainTrack={handleUploadMainTrack}
            onLoadMainFromYoutube={handleLoadMainFromYoutube}
            onLoadMainFromReference={handleLoadMainFromReference}
            onSeparateStems={handleSeparateMainStems}
            onToggleEdit={handleToggleEdit}
            onDeleteEdit={handleDeleteEdit}
          />

          <ProducerChat
            projectId={currentProject?.id ?? null}
            hasMainTrack={Boolean(currentProject?.main_track)}
            messages={currentProject?.chat_messages ?? []}
            selection={selection}
            onClearSelection={() => setSelection(null)}
            references={currentProject?.references ?? []}
            attachedRefIds={attachedRefIds}
            onToggleAttachRef={handleToggleAttachRef}
            onSendMessage={handleSendChat}
            onApplyProposal={handleApplyProposal}
            apiKeyConfigured={Boolean(health?.api_key_configured)}
            onOpenSettings={() => setSettingsOpen(true)}
            draftSnippet={draftSnippet}
          />
        </div>
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        health={health}
        backendOnline={backendOnline}
        onRefreshHealth={async () => {
          await refreshHealth();
        }}
      />

      {/* Floating Toast */}
      {toast && (
        <div
          className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl border shadow-2xl shadow-black/70 flex items-center gap-2.5 text-xs font-medium max-w-md ${
            toast.type === 'error'
              ? 'bg-[#1f1318] border-rose-500/40 text-rose-200'
              : 'bg-[#121e1b] border-emerald-500/35 text-emerald-200'
          }`}
        >
          {toast.type === 'error' ? (
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          )}
          <span className="leading-snug">{toast.message}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="ml-1 opacity-70 hover:opacity-100 shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};

export default App;
