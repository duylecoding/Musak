import { useCallback } from 'react';
import type React from 'react';
import { applyProposal as apiApplyProposal, sendProducerChat, tuneProposal as apiTuneProposal } from '../shared/api';
import type { ProjectState, ProjectSummary, ProposalTunePayload, TimeSelection } from '../shared/api';

interface ChatActionsDeps {
  activeProjectIdRef: React.MutableRefObject<string | null>;
  selection: TimeSelection | null;
  attachedRefIds: string[];
  setCurrentProject: React.Dispatch<React.SetStateAction<ProjectState | null>>;
  setAbMode: React.Dispatch<React.SetStateAction<'original' | 'remix'>>;
  refreshProjectList: () => Promise<ProjectSummary[]>;
  showToast: (type: 'error' | 'success', message: string) => void;
}

export function useChatActions({
  activeProjectIdRef,
  selection,
  attachedRefIds,
  setCurrentProject,
  setAbMode,
  refreshProjectList,
  showToast,
}: ChatActionsDeps) {
  const sendChat = useCallback(
    async (message: string) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      const updated = await sendProducerChat(targetProjectId, {
        message,
        selection,
        reference_ids: attachedRefIds,
      });
      if (activeProjectIdRef.current !== targetProjectId) return;
      setCurrentProject(updated);
    },
    [activeProjectIdRef, attachedRefIds, selection, setCurrentProject]
  );

  const tuneProposal = useCallback(
    async (proposalId: string, payload: ProposalTunePayload) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      const updated = await apiTuneProposal(targetProjectId, proposalId, payload);
      if (activeProjectIdRef.current !== targetProjectId) return;
      setCurrentProject(updated);
    },
    [activeProjectIdRef, setCurrentProject]
  );

  const applyProposal = useCallback(
    async (proposalId: string) => {
      const targetProjectId = activeProjectIdRef.current;
      if (!targetProjectId) return;
      const updated = await apiApplyProposal(targetProjectId, proposalId);
      await refreshProjectList();
      if (activeProjectIdRef.current !== targetProjectId) return;
      setCurrentProject(updated);
      setAbMode('remix');
      showToast('success', 'Applied remix edit! Listening to After · Remix.');
    },
    [activeProjectIdRef, refreshProjectList, setAbMode, setCurrentProject, showToast]
  );

  return { sendChat, tuneProposal, applyProposal };
}
