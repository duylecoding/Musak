import type React from 'react';
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
  ReferenceLayerOptions,
  ReferenceTrack,
  SfxItem,
  TimeSelection,
} from '../shared/api';
import type { ToastState } from './useToast';

export type AddReferenceLayerFn = {
  (
    ref: ReferenceTrack,
    stem?: 'vocals' | 'drums' | 'bass' | 'other' | 'full',
    startTime?: number
  ): Promise<void>;
  (options: ReferenceLayerOptions): Promise<void>;
};

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
  updateMainTrackMeta: (payload: { bpm?: number; key?: string }) => Promise<void>;
  addCue: (payload: { label: string; time: number; color?: string }) => Promise<void>;
  updateCue: (
    cueId: string,
    payload: { label?: string; time?: number; color?: string }
  ) => Promise<void>;
  deleteCue: (cueId: string) => Promise<void>;
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
  duplicateEdit: (editId: string, start?: number) => Promise<void>;
  deleteEdit: (editId: string) => Promise<void>;
  addSfxLayer: (sfx: SfxItem, startTime?: number) => Promise<void>;
  addReferenceLayer: AddReferenceLayerFn;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  exportAudio: (options: ExportOptions) => Promise<void>;
  sendChat: (message: string) => Promise<void>;
  tuneProposal: (proposalId: string, payload: ProposalTunePayload) => Promise<void>;
  applyProposal: (proposalId: string) => Promise<void>;
}
