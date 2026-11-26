import { useCallback } from 'react';
import type React from 'react';
import {
  addReferenceMoment,
  addYoutubeReference,
  autoTagReference as apiAutoTagReference,
  createAutoMashup as apiCreateAutoMashup,
  deleteReference as apiDeleteReference,
  deleteReferenceMoment,
  extractReferenceStems as apiExtractReferenceStems,
  uploadReferenceTrack,
} from '../shared/api';
import type {
  MashupMode,
  MomentPin,
  ProjectState,
  ProjectSummary,
  ReferenceTrack,
  TimeSelection,
} from '../shared/api';
import { formatTimeRange } from '../shared/utils/format';

interface ReferenceActionsDeps {
  activeProjectIdRef: React.MutableRefObject<string | null>;
  selection: TimeSelection | null;
  setCurrentProject: React.Dispatch<React.SetStateAction<ProjectState | null>>;
  setAbMode: React.Dispatch<React.SetStateAction<'original' | 'remix'>>;
  attachRef: (refId: string) => void;
  setDraftSnippet: React.Dispatch<React.SetStateAction<{ text: string; nonce: number } | null>>;
  refreshProjectList: () => Promise<ProjectSummary[]>;
  showToast: (type: 'error' | 'success', message: string) => void;
}

export function useReferenceActions({
  activeProjectIdRef,
  selection,
  setCurrentProject,
  setAbMode,
  attachRef,
  setDraftSnippet,
  refreshProjectList,
  showToast,
}: ReferenceActionsDeps) {
  const addYouTubeRef = useCallback(
    async (url: string) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      const updated = await addYoutubeReference(targetProjectId, url);
      if (activeProjectIdRef.current !== targetProjectId) return;
      setCurrentProject(updated);
      await refreshProjectList();
    },
    [activeProjectIdRef, refreshProjectList, setCurrentProject]
  );

  const uploadRef = useCallback(
    async (file: File) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      const updated = await uploadReferenceTrack(targetProjectId, file);
      if (activeProjectIdRef.current !== targetProjectId) return;
      setCurrentProject(updated);
      await refreshProjectList();
    },
    [activeProjectIdRef, refreshProjectList, setCurrentProject]
  );

  const deleteRef = useCallback(
    async (refId: string) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      try {
        const updated = await apiDeleteReference(targetProjectId, refId);
        if (activeProjectIdRef.current !== targetProjectId) return;
        setCurrentProject(updated);
        await refreshProjectList();
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Failed to remove reference.');
      }
    },
    [activeProjectIdRef, refreshProjectList, setCurrentProject, showToast]
  );

  const addMoment = useCallback(
    async (refId: string, payload: { label: string; start: number; end: number; note?: string }) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      const updated = await addReferenceMoment(targetProjectId, refId, payload);
      if (activeProjectIdRef.current !== targetProjectId) return;
      setCurrentProject(updated);
    },
    [activeProjectIdRef, setCurrentProject]
  );

  const deleteMoment = useCallback(
    async (refId: string, momentId: string) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      try {
        const updated = await deleteReferenceMoment(targetProjectId, refId, momentId);
        if (activeProjectIdRef.current !== targetProjectId) return;
        setCurrentProject(updated);
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Failed to delete moment.');
      }
    },
    [activeProjectIdRef, setCurrentProject, showToast]
  );

  const autoTagRef = useCallback(
    async (refId: string) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      try {
        const updated = await apiAutoTagReference(targetProjectId, refId);
        if (activeProjectIdRef.current !== targetProjectId) return;
        setCurrentProject(updated);
        showToast('success', 'Gemini tagged standout moments on your reference track.');
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Auto-tag failed.');
      }
    },
    [activeProjectIdRef, setCurrentProject, showToast]
  );

  const extractRefStems = useCallback(
    async (refId: string) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      try {
        const updated = await apiExtractReferenceStems(targetProjectId, refId);
        if (activeProjectIdRef.current !== targetProjectId) return;
        setCurrentProject(updated);
        showToast('success', 'Downloading & separating reference stems in background...');
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Stem extraction failed.');
      }
    },
    [activeProjectIdRef, setCurrentProject, showToast]
  );

  const createMashup = useCallback(
    async (refId: string, mode: MashupMode) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      try {
        const updated = await apiCreateAutoMashup(targetProjectId, {
          ref_id: refId,
          mode,
          start: selection?.start ?? null,
          end: selection?.end ?? null,
        });
        await refreshProjectList();
        if (activeProjectIdRef.current !== targetProjectId) return;
        setCurrentProject(updated);
        setAbMode('remix');
        showToast('success', 'Auto-Mashup created! Listening to After · Remix.');
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Auto-Mashup failed.');
      }
    },
    [activeProjectIdRef, refreshProjectList, selection, setAbMode, setCurrentProject, showToast]
  );

  const sendMomentToChat = useCallback(
    (ref: ReferenceTrack, moment: MomentPin) => {
      attachRef(ref.id);
      const range = formatTimeRange(moment.start, moment.end);
      setDraftSnippet({
        text: `@${ref.title} (${range} ${moment.label})`,
        nonce: Date.now(),
      });
    },
    [attachRef, setDraftSnippet]
  );

  return {
    addYouTubeReference: addYouTubeRef,
    uploadReference: uploadRef,
    deleteReference: deleteRef,
    addMoment,
    deleteMoment,
    autoTagReference: autoTagRef,
    extractReferenceStems: extractRefStems,
    createAutoMashup: createMashup,
    sendMomentToChat,
  };
}
