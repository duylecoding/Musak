import { useCallback, useState } from 'react';
import type React from 'react';
import {
  createEdit as apiCreateEdit,
  deleteEdit as apiDeleteEdit,
  duplicateEdit as apiDuplicateEdit,
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
  ReferenceLayerOptions,
  ReferenceTrack,
  SfxItem,
  TimeSelection,
} from '../shared/api';
import {
  buildReferenceLayerPayload,
  buildSfxLayerPayload,
  EXPORT_TARGET_LABELS,
  normalizeReferenceLayerOptions,
} from './editPayloads';
import type { AddReferenceLayerFn } from './projectContextTypes';

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

  const duplicateEdit = useCallback(
    async (editId: string, start?: number) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      try {
        const updated = await apiDuplicateEdit(targetProjectId, editId, start);
        await refreshProjectList();
        if (activeProjectIdRef.current !== targetProjectId) return;
        setCurrentProject(updated);
        setAbMode('remix');
        showToast('success', 'Duplicated edit block!');
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Failed to duplicate edit.');
        throw err;
      }
    },
    [activeProjectIdRef, refreshProjectList, setAbMode, setCurrentProject, showToast]
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

      const payload = buildSfxLayerPayload(sfx, track, startTime ?? selection?.start ?? playheadRef.current);
      try {
        const updated = await apiCreateEdit(targetProjectId, payload);
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
      refOrOptions: ReferenceTrack | ReferenceLayerOptions,
      stem: 'vocals' | 'drums' | 'bass' | 'other' | 'full' = 'full',
      startTime?: number
    ) => {
      const targetProjectId = activeProjectIdRef.current;
      const track = currentProject?.main_track;
      if (!targetProjectId || !track) return;

      const opts = normalizeReferenceLayerOptions(refOrOptions, stem, startTime);
      const { payload, shortTitle, stemLabel } = buildReferenceLayerPayload(
        track,
        opts,
        selection?.start ?? playheadRef.current
      );

      try {
        const updated = await apiCreateEdit(targetProjectId, payload);
        await refreshProjectList();
        if (activeProjectIdRef.current !== targetProjectId) return;
        setCurrentProject(updated);
        setAbMode('remix');
        const labelNote = opts.label ? `"${opts.label}"` : `(${stemLabel})`;
        showToast('success', `Added "${shortTitle}" ${labelNote} to Sound Layer!`);
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Could not add reference layer.');
        throw err;
      }
    },
    [activeProjectIdRef, currentProject?.main_track, playheadRef, refreshProjectList, selection, setAbMode, setCurrentProject, showToast]
  ) as AddReferenceLayerFn;

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
    duplicateEdit,
    deleteEdit,
    addSfxLayer,
    addReferenceLayer,
    undo,
    redo,
    exportAudio,
  };
}
