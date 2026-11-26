import { useCallback, useState } from 'react';
import type React from 'react';
import {
  createEdit as apiCreateEdit,
  deleteEdit as apiDeleteEdit,
  exportProjectAudio,
  redoEdit,
  undoEdit,
  updateEdit as apiUpdateEdit,
} from '../shared/api';
import type {
  EditOperation,
  EditUpdatePayload,
  ExportOptions,
  ProjectState,
  ProjectSummary,
  ReferenceTrack,
  SfxItem,
  TimeSelection,
} from '../shared/api';

interface EditActionsDeps {
  activeProjectIdRef: React.MutableRefObject<string | null>;
  currentProject: ProjectState | null;
  selection: TimeSelection | null;
  playheadRef: React.MutableRefObject<number>;
  setCurrentProject: React.Dispatch<React.SetStateAction<ProjectState | null>>;
  setAbMode: React.Dispatch<React.SetStateAction<'original' | 'remix'>>;
  refreshProjectList: () => Promise<ProjectSummary[]>;
  showToast: (type: 'error' | 'success', message: string) => void;
}

const EXPORT_TARGET_LABELS: Record<NonNullable<ExportOptions['target']>, { busy: (fmt: string) => string; done: (fmt: string) => string }> = {
  remix: { busy: (f) => `Exporting ${f}...`, done: (f) => `Exported ${f} remix!` },
  instrumental: { busy: () => 'Exporting Instrumental...', done: () => 'Exported Instrumental WAV!' },
  vocals: { busy: () => 'Exporting Acapella...', done: () => 'Exported Acapella (Vocals) WAV!' },
  stems_zip: { busy: () => 'Zipping 4 Stems...', done: () => 'Exported all 4 stems (.zip)!' },
};

export function useEditActions({
  activeProjectIdRef,
  currentProject,
  selection,
  playheadRef,
  setCurrentProject,
  setAbMode,
  refreshProjectList,
  showToast,
}: EditActionsDeps) {
  const [historyBusy, setHistoryBusy] = useState(false);
  const [exportingLabel, setExportingLabel] = useState<string | null>(null);

  const createEdit = useCallback(
    async (payload: {
      title: string;
      description: string;
      start: number;
      end: number;
      operations: EditOperation[];
    }) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      try {
        const updated = await apiCreateEdit(targetProjectId, payload);
        await refreshProjectList();
        if (activeProjectIdRef.current !== targetProjectId) return;
        setCurrentProject(updated);
        setAbMode('remix');
        showToast('success', `Applied "${payload.title}"! Listening to After · Remix.`);
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Could not apply remix edit.');
        throw err;
      }
    },
    [activeProjectIdRef, refreshProjectList, setAbMode, setCurrentProject, showToast]
  );

  const updateEdit = useCallback(
    async (editId: string, patch: EditUpdatePayload) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      try {
        const updated = await apiUpdateEdit(targetProjectId, editId, patch);
        if (activeProjectIdRef.current !== targetProjectId) return;
        setCurrentProject(updated);
        setAbMode('remix');
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Failed to update edit.');
        throw err;
      }
    },
    [activeProjectIdRef, setAbMode, setCurrentProject, showToast]
  );

  const deleteEdit = useCallback(
    async (editId: string) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      try {
        const updated = await apiDeleteEdit(targetProjectId, editId);
        await refreshProjectList();
        if (activeProjectIdRef.current !== targetProjectId) return;
        setCurrentProject(updated);
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Failed to delete edit.');
        throw err;
      }
    },
    [activeProjectIdRef, refreshProjectList, setCurrentProject, showToast]
  );

  const addSfxLayer = useCallback(
    async (sfx: SfxItem, startTime?: number) => {
      const targetProjectId = activeProjectIdRef.current;
      const track = currentProject?.main_track;
      if (!targetProjectId || !track) return;

      const rawStart = startTime ?? selection?.start ?? playheadRef.current;
      const dur = Math.max(0.5, sfx.default_duration || 2.0);
      const clampedStart = Math.max(0, Math.min(Math.max(0, track.duration - 0.5), rawStart));
      const end = Math.min(track.duration, clampedStart + dur);

      try {
        const updated = await apiCreateEdit(targetProjectId, {
          title: sfx.name,
          description: sfx.description,
          start: Number(clampedStart.toFixed(2)),
          end: Number(end.toFixed(2)),
          operations: [
            {
              type: 'add_sfx',
              sfx_id: sfx.id,
              start: Number(clampedStart.toFixed(2)),
              end: Number(end.toFixed(2)),
              gain_db: 0,
              snap_to_beat: true,
            },
          ],
        });
        await refreshProjectList();
        if (activeProjectIdRef.current !== targetProjectId) return;
        setCurrentProject(updated);
        setAbMode('remix');
        showToast('success', `Dropped "${sfx.name}" onto a Sound Layer!`);
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Could not add sound layer.');
        throw err;
      }
    },
    [activeProjectIdRef, currentProject?.main_track, playheadRef, refreshProjectList, selection, setAbMode, setCurrentProject, showToast]
  );

  const addReferenceLayer = useCallback(
    async (
      ref: ReferenceTrack,
      stem: 'vocals' | 'drums' | 'bass' | 'other' | 'full' = 'full',
      startTime?: number
    ) => {
      const targetProjectId = activeProjectIdRef.current;
      const track = currentProject?.main_track;
      if (!targetProjectId || !track) return;

      const rawStart = startTime ?? selection?.start ?? playheadRef.current;
      const bpm = track.bpm && track.bpm > 20 ? track.bpm : 120;
      const bar4Dur = 4 * 4 * (60 / bpm);
      const maxClipLen = Math.min(
        ref.duration && ref.duration > 1 ? ref.duration : bar4Dur,
        Math.max(4, Math.min(16, bar4Dur))
      );
      const clampedStart = Math.max(0, Math.min(Math.max(0, track.duration - 1), rawStart));
      const end = Math.min(track.duration, clampedStart + maxClipLen);
      const actualLen = Math.max(0.5, end - clampedStart);

      const stemLabel =
        stem === 'full' ? 'Clip' : stem === 'other' ? 'Melody' : stem.charAt(0).toUpperCase() + stem.slice(1);
      const shortTitle = ref.title.length > 22 ? `${ref.title.slice(0, 22)}…` : ref.title;

      try {
        const updated = await apiCreateEdit(targetProjectId, {
          title: `@${shortTitle} ${stemLabel}`,
          description: `Layered ${stemLabel.toLowerCase()} from ${ref.title}, BPM & key matched.`,
          start: Number(clampedStart.toFixed(2)),
          end: Number(end.toFixed(2)),
          operations: [
            {
              type: 'borrow_stem',
              ref_id: ref.id,
              ref_stem: stem,
              ref_start: 0,
              ref_end: Number(actualLen.toFixed(2)),
              target_start: Number(clampedStart.toFixed(2)),
              target_end: Number(end.toFixed(2)),
              match_bpm: true,
              match_key: stem !== 'drums',
              gain_db: 0,
            },
          ],
        });
        await refreshProjectList();
        if (activeProjectIdRef.current !== targetProjectId) return;
        setCurrentProject(updated);
        setAbMode('remix');
        showToast('success', `Added "${shortTitle}" (${stemLabel}) to Sound Layer!`);
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Could not add reference layer.');
        throw err;
      }
    },
    [activeProjectIdRef, currentProject?.main_track, playheadRef, refreshProjectList, selection, setAbMode, setCurrentProject, showToast]
  );

  const runHistoryAction = useCallback(
    async (action: (id: string) => Promise<ProjectState>, fallbackErr: string) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId || historyBusy) return;
      setHistoryBusy(true);
      try {
        const updated = await action(targetProjectId);
        await refreshProjectList();
        if (activeProjectIdRef.current !== targetProjectId) return;
        setCurrentProject(updated);
        setAbMode('remix');
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : fallbackErr);
      } finally {
        setHistoryBusy(false);
      }
    },
    [activeProjectIdRef, historyBusy, refreshProjectList, setAbMode, setCurrentProject, showToast]
  );

  const undo = useCallback(() => runHistoryAction(undoEdit, 'Undo failed.'), [runHistoryAction]);
  const redo = useCallback(() => runHistoryAction(redoEdit, 'Redo failed.'), [runHistoryAction]);

  const exportAudio = useCallback(
    async (options: ExportOptions) => {
      if (!currentProject || exportingLabel) return;
      const target = options.target ?? 'remix';
      const fmtLabel = (target === 'stems_zip' ? 'zip' : options.format ?? 'wav').toUpperCase();
      setExportingLabel(EXPORT_TARGET_LABELS[target].busy(fmtLabel));
      try {
        await exportProjectAudio(
          currentProject.id,
          options,
          currentProject.main_track?.name || currentProject.name
        );
        showToast('success', EXPORT_TARGET_LABELS[target].done(fmtLabel));
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Export failed.');
      } finally {
        setExportingLabel(null);
      }
    },
    [currentProject, exportingLabel, showToast]
  );

  return {
    historyBusy,
    exportingLabel,
    createEdit,
    updateEdit,
    deleteEdit,
    addSfxLayer,
    addReferenceLayer,
    undo,
    redo,
    exportAudio,
  };
}
