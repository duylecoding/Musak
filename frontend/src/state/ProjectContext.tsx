import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ProjectState, TimeSelection } from '../shared/api';
import type { ProjectContextValue } from './projectContextTypes';
import { useChatActions } from './useChatActions';
import { useEditActions } from './useEditActions';
import { useProjectLifecycle } from './useProjectLifecycle';
import { useReferenceActions } from './useReferenceActions';
import { useStemPolling } from './useStemPolling';
import { useToast } from './useToast';
import { useTrackActions } from './useTrackActions';

export type { AddReferenceLayerFn, ProjectContextValue } from './projectContextTypes';

const ProjectContext = createContext<ProjectContextValue | null>(null);

export const ProjectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentProject, setCurrentProject] = useState<ProjectState | null>(null);
  const [abMode, setAbMode] = useState<'original' | 'remix'>('remix');
  const [selection, setSelection] = useState<TimeSelection | null>(null);
  const [attachedRefIds, setAttachedRefIds] = useState<string[]>([]);
  const [draftSnippet, setDraftSnippet] = useState<{ text: string; nonce: number } | null>(null);
  const [focusChatNonce, setFocusChatNonce] = useState(0);

  const activeProjectIdRef = useRef<string | null>(null);
  const playheadRef = useRef<number>(0);
  activeProjectIdRef.current = currentProject?.id ?? null;

  const { toast, showToast, dismissToast } = useToast();

  const toggleAttachRef = useCallback((refId: string) => {
    setAttachedRefIds((prev) =>
      prev.includes(refId) ? prev.filter((id) => id !== refId) : [...prev, refId]
    );
  }, []);

  const attachRef = useCallback((refId: string) => {
    setAttachedRefIds((prev) => (prev.includes(refId) ? prev : [...prev, refId]));
  }, []);

  const requestFocusChat = useCallback(() => {
    setFocusChatNonce((n) => n + 1);
  }, []);

  const lifecycle = useProjectLifecycle({
    activeProjectIdRef,
    currentProject,
    setCurrentProject,
    setSelection,
    setAttachedRefIds,
    setAbMode,
    showToast,
  });

  useStemPolling(currentProject, setCurrentProject, lifecycle.refreshProjectList);

  useEffect(() => {
    if (!currentProject) return;
    const validIds = new Set(currentProject.references.map((r) => r.id));
    setAttachedRefIds((prev) => prev.filter((id) => validIds.has(id)));
  }, [currentProject]);

  const trackActions = useTrackActions({
    activeProjectIdRef,
    setCurrentProject,
    setSelection,
    setAbMode,
    refreshProjectList: lifecycle.refreshProjectList,
    showToast,
  });

  const referenceActions = useReferenceActions({
    activeProjectIdRef,
    selection,
    setCurrentProject,
    setAbMode,
    attachRef,
    setDraftSnippet,
    refreshProjectList: lifecycle.refreshProjectList,
    showToast,
  });

  const editActions = useEditActions({
    activeProjectIdRef,
    currentProject,
    selection,
    playheadRef,
    setCurrentProject,
    setAbMode,
    refreshProjectList: lifecycle.refreshProjectList,
    showToast,
  });

  const chatActions = useChatActions({
    activeProjectIdRef,
    selection,
    attachedRefIds,
    setCurrentProject,
    setAbMode,
    refreshProjectList: lifecycle.refreshProjectList,
    showToast,
  });

  const value = useMemo<ProjectContextValue>(
    () => ({
      health: lifecycle.health,
      backendOnline: lifecycle.backendOnline,
      initializing: lifecycle.initializing,
      projects: lifecycle.projects,
      currentProject,
      sfxItems: lifecycle.sfxItems,
      abMode,
      setAbMode,
      selection,
      setSelection,
      attachedRefIds,
      toggleAttachRef,
      attachRef,
      draftSnippet,
      setDraftSnippet,
      focusChatNonce,
      requestFocusChat,
      playheadRef,
      toast,
      showToast,
      dismissToast,
      refreshHealth: lifecycle.refreshHealth,
      selectProject: lifecycle.selectProject,
      createProject: lifecycle.createProject,
      renameProject: lifecycle.renameProject,
      deleteProject: lifecycle.deleteProject,
      ...trackActions,
      ...referenceActions,
      ...editActions,
      ...chatActions,
    }),
    [
      abMode,
      attachedRefIds,
      attachRef,
      chatActions,
      currentProject,
      dismissToast,
      draftSnippet,
      editActions,
      focusChatNonce,
      lifecycle,
      referenceActions,
      requestFocusChat,
      selection,
      showToast,
      toast,
      toggleAttachRef,
      trackActions,
    ]
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
};

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return ctx;
}
