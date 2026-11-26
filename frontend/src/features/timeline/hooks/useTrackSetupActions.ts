import { useCallback, useState } from 'react';
import type { MainTrack, ProjectState } from '../../../shared/api';

export interface UseTrackSetupActionsOptions {
  project: ProjectState | null;
  mainTrack: MainTrack | null;
  mainTrackBusy: boolean;
  apiKeyConfigured: boolean;
  onOpenSettings?: () => void;
  uploadMainTrack: (file: File) => Promise<void>;
  loadMainFromYoutube: (url: string) => Promise<void>;
  loadMainFromReference: (refId: string) => Promise<void>;
  separateMainStems: () => Promise<void>;
  extractHooks: () => Promise<void>;
}

export function useTrackSetupActions(opts: UseTrackSetupActionsOptions) {
  const [uploading, setUploading] = useState(false);
  const [loadingYoutube, setLoadingYoutube] = useState(false);
  const [promotingRefId, setPromotingRefId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [startingStems, setStartingStems] = useState(false);
  const [extractingHooks, setExtractingHooks] = useState(false);

  const anyMainBusy = opts.mainTrackBusy || uploading || loadingYoutube || Boolean(promotingRefId);

  const handleFileSelected = useCallback(async (file: File | undefined) => {
    if (!file || !opts.project || anyMainBusy) return;
    setUploadError(null);
    setUploading(true);
    try { await opts.uploadMainTrack(file); }
    catch (err) { setUploadError(err instanceof Error ? err.message : 'Failed to upload main track.'); }
    finally { setUploading(false); }
  }, [anyMainBusy, opts]);

  const handleYoutubeMainSubmit = useCallback(async (url: string) => {
    if (!url.trim() || !opts.project || anyMainBusy) return;
    setUploadError(null);
    setLoadingYoutube(true);
    try { await opts.loadMainFromYoutube(url.trim()); }
    catch (err) { setUploadError(err instanceof Error ? err.message : 'Failed to load audio from YouTube URL.'); throw err; }
    finally { setLoadingYoutube(false); }
  }, [anyMainBusy, opts]);

  const handlePromoteReference = useCallback(async (refId: string) => {
    if (!opts.project || anyMainBusy) return;
    setUploadError(null);
    setPromotingRefId(refId);
    try { await opts.loadMainFromReference(refId); }
    catch (err) { setUploadError(err instanceof Error ? err.message : 'Failed to load reference as main track.'); }
    finally { setPromotingRefId(null); }
  }, [anyMainBusy, opts]);

  const handleSeparateStems = useCallback(async () => {
    if (!opts.mainTrack || opts.mainTrack.stems_status === 'processing' || startingStems) return;
    setStartingStems(true);
    try { await opts.separateMainStems(); } finally { setStartingStems(false); }
  }, [opts, startingStems]);

  const handleExtractHooks = useCallback(async () => {
    if (!opts.mainTrack || extractingHooks) return;
    if (!opts.apiKeyConfigured) { opts.onOpenSettings?.(); return; }
    setExtractingHooks(true);
    try { await opts.extractHooks(); } finally { setExtractingHooks(false); }
  }, [extractingHooks, opts]);

  return {
    uploading, loadingYoutube, promotingRefId, uploadError, setUploadError,
    startingStems, extractingHooks, anyMainBusy,
    handleFileSelected, handleYoutubeMainSubmit, handlePromoteReference,
    handleSeparateStems, handleExtractHooks,
  };
}
