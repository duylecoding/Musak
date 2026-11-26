import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  AtSign,
  Check,
  ChevronDown,
  ChevronUp,
  Disc3,
  ExternalLink,
  Layers,
  Link2,
  Loader2,
  Music,
  Pin,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  Youtube,
} from 'lucide-react';
import type { MomentPin, ReferenceTrack } from '../api/types';
import { getReferenceAudioUrl } from '../api/client';
import { formatBpm, formatTime, parseTimeInput } from '../utils/format';

interface ReferenceShelfProps {
  projectId: string | null;
  references: ReferenceTrack[];
  attachedRefIds: string[];
  onToggleAttachRef: (refId: string) => void;
  onAddYouTube: (url: string) => Promise<void>;
  onUploadReference: (file: File) => Promise<void>;
  onDeleteReference: (refId: string) => Promise<void>;
  onAddMoment: (
    refId: string,
    payload: { label: string; start: number; end: number; note?: string }
  ) => Promise<void>;
  onDeleteMoment: (refId: string, momentId: string) => Promise<void>;
  onAutoTag: (refId: string) => Promise<void>;
  onExtractStems: (refId: string) => Promise<void>;
  onUseAsMain: (refId: string) => Promise<void>;
  mainTrackBusy: boolean;
  onSendMomentToChat: (ref: ReferenceTrack, moment: MomentPin) => void;
  apiKeyConfigured: boolean;
  onOpenSettings: () => void;
}

interface ReferenceCardProps {
  projectId: string;
  reference: ReferenceTrack;
  isAttached: boolean;
  onToggleAttach: () => void;
  onDelete: () => Promise<void>;
  onAddMoment: (payload: {
    label: string;
    start: number;
    end: number;
    note?: string;
  }) => Promise<void>;
  onDeleteMoment: (momentId: string) => Promise<void>;
  onAutoTag: () => Promise<void>;
  onExtractStems: () => Promise<void>;
  onUseAsMain: () => Promise<void>;
  mainTrackBusy: boolean;
  onSendMomentToChat: (moment: MomentPin) => void;
  apiKeyConfigured: boolean;
  onOpenSettings: () => void;
}

const ReferenceCard: React.FC<ReferenceCardProps> = ({
  projectId,
  reference,
  isAttached,
  onToggleAttach,
  onDelete,
  onAddMoment,
  onDeleteMoment,
  onAutoTag,
  onExtractStems,
  onUseAsMain,
  mainTrackBusy,
  onSendMomentToChat,
  apiKeyConfigured,
  onOpenSettings,
}) => {
  const [playerOpen, setPlayerOpen] = useState(false);
  const [ytSeek, setYtSeek] = useState<{ start: number; autoplay: boolean; nonce: number }>({
    start: 0,
    autoplay: false,
    nonce: 0,
  });
  const [localSeek, setLocalSeek] = useState<{ start: number; nonce: number } | null>(null);
  const [pinFormOpen, setPinFormOpen] = useState(false);
  const [pinLabel, setPinLabel] = useState('');
  const [pinStart, setPinStart] = useState('');
  const [pinEnd, setPinEnd] = useState('');
  const [pinNote, setPinNote] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [savingPin, setSavingPin] = useState(false);
  const [autoTagging, setAutoTagging] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const canPlayLocalAudio = reference.source_type === 'local' || reference.audio_downloaded;
  const localAudioUrl = canPlayLocalAudio
    ? getReferenceAudioUrl(projectId, reference.id, reference.audio_url)
    : null;
  const youtubeWatchUrl =
    reference.source_type === 'youtube'
      ? reference.youtube_url ||
        (reference.youtube_id ? `https://www.youtube.com/watch?v=${reference.youtube_id}` : null)
      : null;

  useEffect(() => {
    if (!playerOpen || !localSeek || !canPlayLocalAudio) return;
    const audio = audioRef.current;
    if (!audio) return;

    const targetTime = Math.max(0, localSeek.start);
    const applySeekAndPlay = () => {
      try {
        audio.currentTime = targetTime;
      } catch {
        // ignore out-of-range seek error
      }
      audio.play().catch(() => {});
    };

    if (audio.readyState >= 1) {
      applySeekAndPlay();
      return;
    }

    const onLoadedMetadata = () => {
      applySeekAndPlay();
    };
    audio.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
    return () => {
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
    };
  }, [playerOpen, localSeek, canPlayLocalAudio]);

  const handleOpenYouTubeExternal = async () => {
    if (!youtubeWatchUrl) return;
    if (window.musakBridge?.openExternal) {
      await window.musakBridge.openExternal(youtubeWatchUrl);
    } else {
      window.open(youtubeWatchUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const handlePlayMoment = (moment: MomentPin) => {
    setPlayerOpen(true);
    if (reference.source_type === 'youtube' && reference.youtube_id && !canPlayLocalAudio) {
      setYtSeek((prev) => ({
        start: Math.max(0, Math.floor(moment.start)),
        autoplay: true,
        nonce: prev.nonce + 1,
      }));
    } else if (canPlayLocalAudio) {
      setLocalSeek((prev) => ({
        start: Math.max(0, moment.start),
        nonce: (prev?.nonce ?? 0) + 1,
      }));
    }
  };

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError(null);
    const label = pinLabel.trim();
    const startSec = parseTimeInput(pinStart);
    const endSec = pinEnd.trim() ? parseTimeInput(pinEnd) : startSec !== null ? startSec + 8 : null;

    if (!label) {
      setPinError('Add a short label (e.g. "Beat Drop").');
      return;
    }
    if (startSec === null) {
      setPinError('Enter start time like 1:12 or 72.');
      return;
    }
    if (endSec === null || endSec <= startSec) {
      setPinError('End time must be after start time.');
      return;
    }

    setSavingPin(true);
    try {
      await onAddMoment({
        label,
        start: startSec,
        end: endSec,
        note: pinNote.trim() || undefined,
      });
      setPinLabel('');
      setPinStart('');
      setPinEnd('');
      setPinNote('');
      setPinFormOpen(false);
    } catch (err) {
      setPinError(err instanceof Error ? err.message : 'Failed to pin moment.');
    } finally {
      setSavingPin(false);
    }
  };

  const handleAutoTagClick = async () => {
    if (!apiKeyConfigured) {
      onOpenSettings();
      return;
    }
    setAutoTagging(true);
    try {
      await onAutoTag();
    } finally {
      setAutoTagging(false);
    }
  };

  const handleExtractStemsClick = async () => {
    if (reference.stems_status === 'processing' || reference.stems_status === 'ready') return;
    setExtracting(true);
    try {
      await onExtractStems();
    } finally {
      setExtracting(false);
    }
  };

  const handleUseAsMainClick = async () => {
    if (promoting || mainTrackBusy) return;
    setPromoting(true);
    try {
      await onUseAsMain();
    } finally {
      setPromoting(false);
    }
  };

  const handleDeleteClick = async () => {
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  };

  const stemsProcessing = reference.stems_status === 'processing' || extracting;
  const stemsReady = reference.stems_status === 'ready';
  const stemsError = reference.stems_status === 'error';

  return (
    <div
      className={`rounded-xl bg-[#181b26] border transition-colors ${
        isAttached ? 'border-violet-500/45 shadow-sm shadow-violet-950/30' : 'border-white/[0.07]'
      }`}
    >
      {/* Card Header */}
      <div className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {reference.source_type === 'youtube' ? (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/25 text-[10px] font-medium shrink-0">
                  <Youtube className="w-2.5 h-2.5" />
                  YouTube
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/25 text-[10px] font-medium shrink-0">
                  <Music className="w-2.5 h-2.5" />
                  Local
                </span>
              )}
              {reference.bpm && (
                <span className="px-1.5 py-0.5 rounded bg-white/[0.05] text-zinc-300 text-[10px] font-mono">
                  {formatBpm(reference.bpm)}
                </span>
              )}
              {reference.key && (
                <span className="px-1.5 py-0.5 rounded bg-white/[0.05] text-zinc-300 text-[10px] font-mono">
                  {reference.key}
                </span>
              )}
            </div>
            <h4
              className="text-xs font-semibold text-zinc-100 mt-1.5 leading-snug line-clamp-2"
              title={reference.title}
            >
              {reference.title}
            </h4>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={onToggleAttach}
              title={
                isAttached
                  ? 'Attached to Gemini Chat (click to detach)'
                  : 'Attach as @reference in Gemini Chat'
              }
              className={`px-2 py-1 rounded-md text-[10px] font-medium border flex items-center gap-1 transition-colors ${
                isAttached
                  ? 'bg-violet-500/20 text-violet-200 border-violet-500/45'
                  : 'bg-white/[0.04] text-zinc-400 border-white/[0.08] hover:text-zinc-200 hover:bg-white/[0.08]'
              }`}
            >
              {isAttached ? <Check className="w-2.5 h-2.5" /> : <AtSign className="w-2.5 h-2.5" />}
              Chat
            </button>
            <button
              type="button"
              onClick={handleDeleteClick}
              disabled={deleting}
              title="Remove reference"
              className="p-1 rounded-md text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
            >
              {deleting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Action Row: Player Toggle, Auto-Tag, Extract Stems */}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={() => setPlayerOpen((v) => !v)}
            className="px-2 py-1 rounded-md bg-white/[0.05] hover:bg-white/[0.1] text-[11px] text-zinc-200 flex items-center gap-1 transition-colors"
          >
            <Play className="w-3 h-3 text-violet-300" />
            Listen
            {playerOpen ? (
              <ChevronUp className="w-3 h-3 text-zinc-400" />
            ) : (
              <ChevronDown className="w-3 h-3 text-zinc-400" />
            )}
          </button>

          <button
            type="button"
            onClick={handleUseAsMainClick}
            disabled={promoting || mainTrackBusy}
            title="Load this song onto the main stage to remix it"
            className="px-2 py-1 rounded-md bg-emerald-500/12 hover:bg-emerald-500/22 border border-emerald-500/30 text-[11px] font-medium text-emerald-200 flex items-center gap-1 transition-colors disabled:opacity-50"
          >
            {promoting ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading...
              </>
            ) : (
              <>
                <ArrowUpRight className="w-3 h-3 text-emerald-300" />
                Use as Main
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleAutoTagClick}
            disabled={autoTagging}
            title="Let Gemini find the coolest drops, hooks, and transitions"
            className="px-2 py-1 rounded-md bg-violet-500/12 hover:bg-violet-500/22 border border-violet-500/25 text-[11px] text-violet-200 flex items-center gap-1 transition-colors disabled:opacity-50"
          >
            {autoTagging ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3 text-violet-300" />
            )}
            Auto-Tag
          </button>

          <button
            type="button"
            onClick={handleExtractStemsClick}
            disabled={stemsProcessing || stemsReady}
            title={
              stemsReady
                ? 'Stems extracted and ready for mashups'
                : 'Download & separate Vocals/Drums/Bass/Other for borrowing'
            }
            className={`px-2 py-1 rounded-md text-[11px] flex items-center gap-1 border transition-colors ${
              stemsReady
                ? 'bg-emerald-500/12 border-emerald-500/30 text-emerald-300 cursor-default'
                : stemsProcessing
                ? 'bg-amber-500/12 border-amber-500/30 text-amber-200 cursor-wait'
                : stemsError
                ? 'bg-rose-500/12 border-rose-500/30 text-rose-300 hover:bg-rose-500/20'
                : 'bg-white/[0.04] hover:bg-white/[0.09] border-white/[0.08] text-zinc-300'
            }`}
          >
            {stemsProcessing ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Separating...
              </>
            ) : stemsReady ? (
              <>
                <Check className="w-3 h-3" />
                Stems Ready
              </>
            ) : (
              <>
                <Layers className="w-3 h-3" />
                {stemsError ? 'Retry Stems' : 'Extract Stems'}
              </>
            )}
          </button>
          {youtubeWatchUrl && (
            <button
              type="button"
              onClick={handleOpenYouTubeExternal}
              title="Open video directly on YouTube in your browser"
              className="px-2 py-1 rounded-md bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.08] text-[11px] text-zinc-300 hover:text-white flex items-center gap-1 transition-colors"
            >
              <ExternalLink className="w-3 h-3 text-rose-300" />
              Open on YouTube
            </button>
          )}
        </div>

        {stemsError && reference.stems_error && (
          <p className="text-[10px] text-rose-400 leading-snug">{reference.stems_error}</p>
        )}

        {/* Expandable Mini Player */}
        {playerOpen && (
          <div className="pt-1">
            {reference.source_type === 'youtube' && reference.youtube_id && !canPlayLocalAudio ? (
              <div className="rounded-lg overflow-hidden bg-black border border-white/10 aspect-video">
                <iframe
                  key={`${reference.youtube_id}-${ytSeek.nonce}`}
                  src={`https://www.youtube.com/embed/${encodeURIComponent(
                    reference.youtube_id
                  )}?start=${ytSeek.start}&autoplay=${ytSeek.autoplay ? 1 : 0}&rel=0`}
                  title={reference.title}
                  referrerPolicy="strict-origin-when-cross-origin"
                  className="w-full h-full border-0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            ) : localAudioUrl ? (
              <audio
                ref={audioRef}
                controls
                src={localAudioUrl}
                className="w-full h-8 rounded-md"
              />
            ) : (
              <div className="text-[11px] text-zinc-500 py-2 text-center bg-[#0b0c10] rounded-lg">
                Preview unavailable for this reference.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pinned Moments Section */}
      <div className="border-t border-white/[0.06] px-3 py-2 bg-[#141722]/70 rounded-b-xl space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400 flex items-center gap-1">
            <Pin className="w-2.5 h-2.5" />
            Pinned Moments ({reference.moments.length})
          </span>
          <button
            type="button"
            onClick={() => {
              setPinFormOpen((v) => !v);
              setPinError(null);
            }}
            className="text-[10px] font-medium text-violet-300 hover:text-violet-200 flex items-center gap-0.5 transition-colors"
          >
            <Plus className="w-3 h-3" />
            Pin Moment
          </button>
        </div>

        {pinFormOpen && (
          <form
            onSubmit={handlePinSubmit}
            className="p-2 rounded-lg bg-[#0b0c10] border border-white/10 space-y-1.5"
          >
            <input
              type="text"
              value={pinLabel}
              onChange={(e) => setPinLabel(e.target.value)}
              placeholder="Label (e.g. Heavy Bass Drop)"
              className="w-full px-2 py-1 text-[11px] rounded bg-[#151822] border border-white/10 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500/60"
            />
            <div className="grid grid-cols-2 gap-1.5">
              <input
                type="text"
                value={pinStart}
                onChange={(e) => setPinStart(e.target.value)}
                placeholder="Start (e.g. 1:12)"
                className="px-2 py-1 text-[11px] rounded bg-[#151822] border border-white/10 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500/60"
              />
              <input
                type="text"
                value={pinEnd}
                onChange={(e) => setPinEnd(e.target.value)}
                placeholder="End (e.g. 1:24)"
                className="px-2 py-1 text-[11px] rounded bg-[#151822] border border-white/10 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500/60"
              />
            </div>
            <input
              type="text"
              value={pinNote}
              onChange={(e) => setPinNote(e.target.value)}
              placeholder="Optional vibe note..."
              className="w-full px-2 py-1 text-[11px] rounded bg-[#151822] border border-white/10 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500/60"
            />
            {pinError && <div className="text-[10px] text-rose-400">{pinError}</div>}
            <div className="flex items-center justify-end gap-1.5 pt-0.5">
              <button
                type="button"
                onClick={() => setPinFormOpen(false)}
                className="px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingPin}
                className="px-2.5 py-1 rounded bg-violet-600 hover:bg-violet-500 text-[10px] font-medium text-white flex items-center gap-1 disabled:opacity-50"
              >
                {savingPin && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                Save Pin
              </button>
            </div>
          </form>
        )}

        {reference.moments.length === 0 ? (
          <p className="text-[11px] text-zinc-500 py-1">
            Pin a timestamp or hit <span className="text-violet-300">Auto-Tag</span> to mark cool
            moments.
          </p>
        ) : (
          <div className="space-y-1">
            {reference.moments.map((moment) => (
              <div
                key={moment.id}
                className="group flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-lg bg-[#0b0c10]/70 hover:bg-[#0b0c10] border border-white/[0.05] transition-colors"
              >
                <button
                  type="button"
                  onClick={() => handlePlayMoment(moment)}
                  className="min-w-0 flex-1 text-left flex items-center gap-1.5"
                  title={moment.note || `Play from ${formatTime(moment.start)}`}
                >
                  <span className="text-[10px] font-mono text-violet-300 shrink-0">
                    {formatTime(moment.start)}
                  </span>
                  <span className="text-[11px] text-zinc-200 truncate">{moment.label}</span>
                  <span
                    className={`text-[9px] px-1 py-0.2 rounded uppercase font-semibold shrink-0 ${
                      moment.source === 'gemini'
                        ? 'bg-violet-500/20 text-violet-300'
                        : 'bg-zinc-700/80 text-zinc-300'
                    }`}
                  >
                    {moment.source === 'gemini' ? 'AI' : 'You'}
                  </span>
                </button>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => onSendMomentToChat(moment)}
                    title="Attach reference & moment timestamp to Producer Chat"
                    className="px-1.5 py-0.5 rounded bg-violet-500/15 hover:bg-violet-500/30 text-[10px] font-medium text-violet-200 transition-colors"
                  >
                    @Chat
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteMoment(moment.id)}
                    title="Delete pin"
                    className="p-0.5 rounded text-zinc-500 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export const ReferenceShelf: React.FC<ReferenceShelfProps> = ({
  projectId,
  references,
  attachedRefIds,
  onToggleAttachRef,
  onAddYouTube,
  onUploadReference,
  onDeleteReference,
  onAddMoment,
  onDeleteMoment,
  onAutoTag,
  onExtractStems,
  onUseAsMain,
  mainTrackBusy,
  onSendMomentToChat,
  apiKeyConfigured,
  onOpenSettings,
}) => {
  const [ytUrl, setYtUrl] = useState('');
  const [addingYt, setAddingYt] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [shelfError, setShelfError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAddYouTubeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = ytUrl.trim();
    if (!trimmed || !projectId || addingYt) return;
    setShelfError(null);
    setAddingYt(true);
    try {
      await onAddYouTube(trimmed);
      setYtUrl('');
    } catch (err) {
      setShelfError(err instanceof Error ? err.message : 'Could not add YouTube link.');
    } finally {
      setAddingYt(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !projectId) return;
    setShelfError(null);
    setUploadingFile(true);
    try {
      await onUploadReference(file);
    } catch (err) {
      setShelfError(err instanceof Error ? err.message : 'Could not upload reference audio.');
    } finally {
      setUploadingFile(false);
    }
  };

  return (
    <aside className="w-[300px] xl:w-[320px] shrink-0 bg-[#12141c] border-r border-white/[0.07] flex flex-col h-full overflow-hidden">
      {/* Pane Header */}
      <div className="px-4 py-3.5 border-b border-white/[0.07] shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-200 flex items-center gap-1.5">
              <Disc3 className="w-3.5 h-3.5 text-violet-400" />
              Reference Shelf
            </h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Drop songs for vibe matching & mashups
            </p>
          </div>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.05] text-zinc-400">
            {references.length}
          </span>
        </div>

        {/* Add YouTube URL */}
        <form onSubmit={handleAddYouTubeSubmit} className="mt-3 flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <Link2 className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={ytUrl}
              onChange={(e) => setYtUrl(e.target.value)}
              disabled={!projectId || addingYt}
              placeholder="Paste YouTube URL..."
              className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded-lg bg-[#0b0c10] border border-white/10 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500/60 disabled:opacity-50"
            />
          </div>
          <button
            type="submit"
            disabled={!projectId || !ytUrl.trim() || addingYt}
            className="px-2.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium text-white shrink-0 transition-colors flex items-center gap-1"
          >
            {addingYt ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Add'}
          </button>
        </form>

        {/* Upload Local Audio */}
        <div className="mt-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            disabled={!projectId || uploadingFile}
            onClick={() => fileInputRef.current?.click()}
            className="w-full py-1.5 px-3 rounded-lg bg-[#181b26] hover:bg-[#1f2332] border border-dashed border-white/15 hover:border-violet-500/40 text-xs text-zinc-300 hover:text-white flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40"
          >
            {uploadingFile ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-400" />
                Analyzing audio...
              </>
            ) : (
              <>
                <Upload className="w-3.5 h-3.5 text-zinc-400" />
                Upload Local Audio
              </>
            )}
          </button>
        </div>

        {shelfError && (
          <div className="mt-2 text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-2.5 py-1.5">
            {shelfError}
          </div>
        )}
      </div>

      {/* Reference List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {references.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-4 py-8">
            <div className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center mb-3">
              <Music className="w-5 h-5 text-zinc-500" />
            </div>
            <p className="text-xs font-medium text-zinc-300">No inspiration tracks yet</p>
            <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
              Paste a YouTube link or drop a local song to copy its vibe, pin favorite moments, or
              borrow its drums/vocals.
            </p>
          </div>
        ) : (
          projectId &&
          references.map((ref) => (
            <ReferenceCard
              key={ref.id}
              projectId={projectId}
              reference={ref}
              isAttached={attachedRefIds.includes(ref.id)}
              onToggleAttach={() => onToggleAttachRef(ref.id)}
              onDelete={() => onDeleteReference(ref.id)}
              onAddMoment={(payload) => onAddMoment(ref.id, payload)}
              onDeleteMoment={(momentId) => onDeleteMoment(ref.id, momentId)}
              onAutoTag={() => onAutoTag(ref.id)}
              onExtractStems={() => onExtractStems(ref.id)}
              onUseAsMain={() => onUseAsMain(ref.id)}
              mainTrackBusy={mainTrackBusy}
              onSendMomentToChat={(moment) => onSendMomentToChat(ref, moment)}
              apiKeyConfigured={apiKeyConfigured}
              onOpenSettings={onOpenSettings}
            />
          ))
        )}
      </div>
    </aside>
  );
};
