import { useCallback, useRef, useState } from 'react';
import type React from 'react';
import {
  extractMainTrackHooks,
  separateMainStems,
  setMainTrackFromReference,
  setMainTrackFromYoutube,
  uploadMainTrack as apiUploadMainTrack,
} from '../shared/api';
import type { ProjectState, ProjectSummary, TimeSelection } from '../shared/api';

interface TrackActionsDeps {
  activeProjectIdRef: React.MutableRefObject<string | null>;
  setCurrentProject: React.Dispatch<React.SetStateAction<ProjectState | null>>;
  setSelection: React.Dispatch<React.SetStateAction<TimeSelection | null>>;
  setAbMode: React.Dispatch<React.SetStateAction<'original' | 'remix'>>;
  refreshProjectList: () => Promise<ProjectSummary[]>;
  showToast: (type: 'error' | 'success', message: string) => void;
}

export function useTrackActions({
  activeProjectIdRef,
  setCurrentProject,
  setSelection,
  setAbMode,
  refreshProjectList,
  showToast,
}: TrackActionsDeps) {
  const [mainTrackBusy, setMainTrackBusy] = useState(false);
  const mainTrackBusyRef = useRef(false);

  const runMainTrackLoad = useCallback(
    async (
      loader: (projectId: string) => Promise<ProjectState>,
      successMsg: (updated: ProjectState) => string
    ) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId || mainTrackBusyRef.current) return;
      mainTrackBusyRef.current = true;
      setMainTrackBusy(true);
      try {
        const updated = await loader(targetProjectId);
        await refreshProjectList();
        if (activeProjectIdRef.current !== targetProjectId) return;
        setCurrentProject(updated);
        setSelection(null);
        setAbMode('remix');
        showToast('success', successMsg(updated));
      } finally {
        mainTrackBusyRef.current = false;
        setMainTrackBusy(false);
      }
    },
    [activeProjectIdRef, refreshProjectList, setAbMode, setCurrentProject, setSelection, showToast]
  );

  const uploadMainTrack = useCallback(
    (file: File) =>
      runMainTrackLoad(
        (id) => apiUploadMainTrack(id, file),
        (u) => `Loaded "${u.main_track?.name || file.name}".`
      ),
    [runMainTrackLoad]
  );

  const loadMainFromYoutube = useCallback(
    (url: string) =>
      runMainTrackLoad(
        (id) => setMainTrackFromYoutube(id, url),
        (u) => `Loaded "${u.main_track?.name || 'YouTube track'}" onto main stage.`
      ),
    [runMainTrackLoad]
  );

  const loadMainFromReference = useCallback(
    (refId: string) =>
      runMainTrackLoad(
        (id) => setMainTrackFromReference(id, refId),
        (u) => `Loaded "${u.main_track?.name || 'reference track'}" as main track.`
      ),
    [runMainTrackLoad]
  );

  const separateStems = useCallback(async () => {
    const targetProjectId = activeProjectIdRef.current;
    if (!targetProjectId) return;
    try {
      const updated = await separateMainStems(targetProjectId);
      if (activeProjectIdRef.current !== targetProjectId) return;
      setCurrentProject(updated);
      showToast('success', 'Stem separation started on local compute.');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Could not start stem separation.');
    }
  }, [activeProjectIdRef, setCurrentProject, showToast]);

  const extractHooks = useCallback(async () => {
    const targetProjectId = activeProjectIdRef.current;
    if (!targetProjectId) return;
    try {
      const updated = await extractMainTrackHooks(targetProjectId);
      if (activeProjectIdRef.current !== targetProjectId) return;
      setCurrentProject(updated);
      const count = updated.main_track?.lyric_hooks?.length ?? 0;
      showToast(
        'success',
        count > 0
          ? `Found ${count} clickable lyric & hook moments!`
          : 'Scan complete — no distinct hooks detected.'
      );
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to extract lyrics & hooks.');
    }
  }, [activeProjectIdRef, setCurrentProject, showToast]);

  return {
    mainTrackBusy,
    uploadMainTrack,
    loadMainFromYoutube,
    loadMainFromReference,
    separateMainStems: separateStems,
    extractHooks,
  };
}
