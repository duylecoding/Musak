import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  EditOperation,
  EditUpdatePayload,
  ExportOptions,
  HealthStatus,
  MashupMode,
  MomentPin,
  ProjectState,
  ProjectSummary,
  ProposalTunePayload,
  ReferenceTrack,
  SfxItem,
  TimeSelection,
} from '../shared/api';
import { useChatActions } from './useChatActions';
import { useEditActions } from './useEditActions';
import { useProjectLifecycle } from './useProjectLifecycle';
import { useReferenceActions } from './useReferenceActions';
import { useStemPolling } from './useStemPolling';
import { useToast, type ToastState } from './useToast';
import { useTrackActions } from './useTrackActions';

export interface ProjectContextValue {
  health: HealthStatus | null;
  backendOnline: boolean;
  initializing: boolean;
  projects: ProjectSummary[];
  currentProject: ProjectState | null;
  sfxItems: SfxItem[];
  abMode: 'original' | 'remix';
  setAbMode: React.Dispatch<React.SetStateAction<'original' | 'remix'>>;
  selection: TimeSelection | null;
  setSelection: React.Dispatch<React.SetStateAction<TimeSelection | null>>;
  attachedRefIds: string[];
  toggleAttachRef: (refId: string) => void;
  attachRef: (refId: string) => void;
  draftSnippet: { text: string; nonce: number } | null;
  setDraftSnippet: React.Dispatch<React.SetStateAction<{ text: string; nonce: number } | null>>;
  focusChatNonce: number;
  requestFocusChat: () => void;
  playheadRef: React.MutableRefObject<number>;
  mainTrackBusy: boolean;
  historyBusy: boolean;
  exportingLabel: string | null;
  toast: ToastState | null;
  showToast: (type: 'error' | 'success', message: string) => void;
  dismissToast: () => void;
  refreshHealth: () => Promise<HealthStatus | null>;
  selectProject: (projectId: string) => Promise<void>;
  createProject: (name: string) => Promise<void>;
  renameProject: (projectId: string, name: string) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  uploadMainTrack: (file: File) => Promise<void>;
  loadMainFromYoutube: (url: string) => Promise<void>;
  loadMainFromReference: (refId: string) => Promise<void>;
  separateMainStems: () => Promise<void>;
  extractHooks: () => Promise<void>;
  addYouTubeReference: (url: string) => Promise<void>;
  uploadReference: (file: File) => Promise<void>;
  deleteReference: (refId: string) => Promise<void>;
  addMoment: (
    refId: string,
    payload: { label: string; start: number; end: number; note?: string }
  ) => Promise<void>;
  deleteMoment: (refId: string, momentId: string) => Promise<void>;
  autoTagReference: (refId: string) => Promise<void>;
  extractReferenceStems: (refId: string) => Promise<void>;
  createAutoMashup: (refId: string, mode: MashupMode) => Promise<void>;
  sendMomentToChat: (ref: ReferenceTrack, moment: MomentPin) => void;
  createEdit: (payload: {
    title: string;
    description: string;
    start: number;
    end: number;
    operations: EditOperation[];
  }) => Promise<void>;
  updateEdit: (editId: string, patch: EditUpdatePayload) => Promise<void>;
  deleteEdit: (editId: string) => Promise<void>;
  addSfxLayer: (sfx: SfxItem, startTime?: number) => Promise<void>;
  addReferenceLayer: (
    ref: ReferenceTrack,
    stem?: 'vocals' | 'drums' | 'bass' | 'other' | 'full',
    startTime?: number
  ) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  exportAudio: (options: ExportOptions) => Promise<void>;
  sendChat: (message: string) => Promise<void>;
  tuneProposal: (proposalId: string, payload: ProposalTunePayload) => Promise<void>;
  applyProposal: (proposalId: string) => Promise<void>;
}

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
