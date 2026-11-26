import { useCallback, useEffect, useRef, useState } from 'react';
import { getPreviewAudioUrl } from '../../../shared/api';
import type { EditProposal } from '../../../shared/api';

/** Manages a single shared proposal preview <audio> element with guaranteed cleanup on stop/switch/unmount. */
export function usePreviewPlayer(projectId: string | null, onError: (msg: string) => void) {
  const [playingProposalId, setPlayingProposalId] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const stopPreview = useCallback(() => {
    const audio = previewAudioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      previewAudioRef.current = null;
    }
    setPlayingProposalId(null);
  }, []);

  useEffect(() => {
    stopPreview();
    return () => stopPreview();
  }, [projectId, stopPreview]);

  const togglePreview = useCallback(
    (proposal: EditProposal) => {
      if (!projectId) return;
      if (playingProposalId === proposal.id) {
        stopPreview();
        return;
      }
      stopPreview();
      const audio = new Audio(getPreviewAudioUrl(projectId, proposal.id, proposal.preview_url));
      previewAudioRef.current = audio;
      setPlayingProposalId(proposal.id);
      audio.onended = () => setPlayingProposalId((cur) => (cur === proposal.id ? null : cur));
      audio.onerror = () => {
        setPlayingProposalId((cur) => (cur === proposal.id ? null : cur));
        onError('Preview audio could not be played.');
      };
      audio.play().catch(() => setPlayingProposalId((cur) => (cur === proposal.id ? null : cur)));
    },
    [onError, playingProposalId, projectId, stopPreview]
  );

  return { playingProposalId, stopPreview, togglePreview };
}
