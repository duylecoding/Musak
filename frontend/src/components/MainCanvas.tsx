import React, { useEffect, useMemo, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js';
import {
  AlertCircle,
  AudioLines,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Disc,
  Drum,
  Guitar,
  Layers,
  Link2,
  Loader2,
  Mic2,
  Music,
  Music2,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Volume2,
  X,
  Youtube,
} from 'lucide-react';
import type { EditBlock, ProjectState, Section, TimeSelection } from '../api/types';
import { getMainAudioUrl, getRenderedAudioUrl, getStemAudioUrl } from '../api/client';
import { formatBpm, formatTime, formatTimeRange } from '../utils/format';

interface MainCanvasProps {
  project: ProjectState | null;
  abMode: 'original' | 'remix';
  onAbModeChange: (mode: 'original' | 'remix') => void;
  selection: TimeSelection | null;
  onSelectionChange: (sel: TimeSelection | null) => void;
  mainTrackBusy: boolean;
  onUploadMainTrack: (file: File) => Promise<void>;
  onLoadMainFromYoutube: (url: string) => Promise<void>;
  onLoadMainFromReference: (refId: string) => Promise<void>;
  onSeparateStems: () => Promise<void>;
  onToggleEdit: (editId: string, enabled: boolean) => Promise<void>;
  onDeleteEdit: (editId: string) => Promise<void>;
}

const STEM_META: Record<
  string,
  { label: string; color: string; bg: string; icon: React.ComponentType<{ className?: string }> }
> = {
  vocals: {
    label: 'Vocals',
    color: 'text-fuchsia-300',
    bg: 'bg-fuchsia-500/15 border-fuchsia-500/30',
    icon: Mic2,
  },
  drums: {
    label: 'Drums',
    color: 'text-amber-300',
    bg: 'bg-amber-500/15 border-amber-500/30',
    icon: Drum,
  },
  bass: {
    label: 'Bass',
    color: 'text-emerald-300',
    bg: 'bg-emerald-500/15 border-emerald-500/30',
    icon: Disc,
  },
  other: {
    label: 'Other / Synths',
    color: 'text-sky-300',
    bg: 'bg-sky-500/15 border-sky-500/30',
    icon: Guitar,
  },
};

const SELECTION_REGION_ID = 'musak-selection';

function makeRegionLabel(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'musak-region-label';
  span.textContent = text;
  return span;
}

export const MainCanvas: React.FC<MainCanvasProps> = ({
  project,
  abMode,
  onAbModeChange,
  selection,
  onSelectionChange,
  mainTrackBusy,
  onUploadMainTrack,
  onLoadMainFromYoutube,
  onLoadMainFromReference,
  onSeparateStems,
  onToggleEdit,
  onDeleteEdit,
}) => {
  const mainTrack = project?.main_track ?? null;

  const [uploading, setUploading] = useState(false);
  const [loadingYoutube, setLoadingYoutube] = useState(false);
  const [promotingRefId, setPromotingRefId] = useState<string | null>(null);
  const [ytInput, setYtInput] = useState('');
  const [ytSwapOpen, setYtSwapOpen] = useState(false);
  const [ytSwapInput, setYtSwapInput] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [startingStems, setStartingStems] = useState(false);

  // Waveform & playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [waveformReady, setWaveformReady] = useState(false);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [audioLoadError, setAudioLoadError] = useState<string | null>(null);
  const [retryLoadNonce, setRetryLoadNonce] = useState(0);
  const [loopSelection, setLoopSelection] = useState(false);

  // Collapsible drawer (collapsed by default)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'stems' | 'edits'>('stems');
  const [playingStem, setPlayingStem] = useState<string | null>(null);
  const [busyEditId, setBusyEditId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const waveformContainerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsPluginRef = useRef<RegionsPlugin | null>(null);
  const isSyncingRegionsRef = useRef(false);
  const loadedUrlRef = useRef<string | null>(null);
  const waveformReadyRef = useRef(false);
  const pendingRestoreRef = useRef<{ time: number; shouldPlay: boolean } | null>(null);
  const selectionRef = useRef<TimeSelection | null>(selection);
  const loopSelectionRef = useRef(loopSelection);
  const stemAudioRef = useRef<HTMLAudioElement | null>(null);

  selectionRef.current = selection;
  loopSelectionRef.current = loopSelection;
  waveformReadyRef.current = waveformReady;

  const activeAudioUrl = useMemo(() => {
    if (!project || !project.main_track) return null;
    return abMode === 'original' ? getMainAudioUrl(project) : getRenderedAudioUrl(project);
  }, [project, abMode]);

  const enabledEdits = useMemo(
    () => (project?.edits ?? []).filter((e) => e.enabled),
    [project?.edits]
  );

  // Cleanup stem preview audio on unmount, project change, or track replacement
  useEffect(() => {
    return () => {
      if (stemAudioRef.current) {
        stemAudioRef.current.pause();
        stemAudioRef.current = null;
      }
      setPlayingStem(null);
    };
  }, [project?.id, mainTrack?.id]);

  // Reset transient track-loading UI state when switching projects
  useEffect(() => {
    setUploadError(null);
    setYtSwapOpen(false);
    setYtSwapInput('');
    setYtInput('');
  }, [project?.id]);

  // Initialize WaveSurfer whenever mainTrack ID exists (mounts container)
  useEffect(() => {
    loadedUrlRef.current = null;
    pendingRestoreRef.current = null;
    waveformReadyRef.current = false;
    setWaveformReady(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setAudioLoadError(null);

    if (!mainTrack || !waveformContainerRef.current) {
      if (wavesurferRef.current) {
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
        regionsPluginRef.current = null;
      }
      setDuration(0);
      return;
    }

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: waveformContainerRef.current,
      height: 156,
      waveColor: '#4c5268',
      progressColor: '#8b5cf6',
      cursorColor: '#e4e4e7',
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1.5,
      barRadius: 2,
      normalize: true,
      dragToSeek: false,
      plugins: [regions],
    });

    wavesurferRef.current = ws;
    regionsPluginRef.current = regions;
    loadedUrlRef.current = null;

    const disableDrag = regions.enableDragSelection({
      color: 'rgba(139, 92, 246, 0.28)',
    });

    const unsubReady = ws.on('ready', (dur) => {
      setDuration(dur || mainTrack.duration || 0);
      waveformReadyRef.current = true;
      setWaveformReady(true);
      setLoadingAudio(false);
      setAudioLoadError(null);

      const restore = pendingRestoreRef.current;
      pendingRestoreRef.current = null;
      if (restore) {
        const clamped = Math.max(0, Math.min(restore.time, Math.max(0, dur - 0.05)));
        ws.setTime(clamped);
        setCurrentTime(clamped);
        if (restore.shouldPlay) {
          ws.play().catch(() => {});
        }
      }
    });

    const unsubError = ws.on('error', (err) => {
      if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') {
        return;
      }
      loadedUrlRef.current = null;
      waveformReadyRef.current = false;
      setWaveformReady(false);
      setLoadingAudio(false);
      setAudioLoadError(
        err instanceof Error ? err.message : 'Failed to load audio waveform.'
      );
    });

    const unsubPlay = ws.on('play', () => setIsPlaying(true));
    const unsubPause = ws.on('pause', () => setIsPlaying(false));
    const unsubFinish = ws.on('finish', () => setIsPlaying(false));

    const unsubTime = ws.on('timeupdate', (t) => {
      setCurrentTime(t);
      const sel = selectionRef.current;
      if (loopSelectionRef.current && sel && ws.isPlaying() && t >= sel.end) {
        ws.setTime(sel.start);
      }
    });

    const unsubRegionCreated = regions.on('region-created', (region: Region) => {
      if (isSyncingRegionsRef.current) return;
      if (region.id.startsWith('edit-')) return;

      const start = Math.max(0, Math.min(region.start, region.end));
      const end = Math.max(region.start, region.end);

      // Ignore tiny accidental clicks BEFORE removing any existing selection region
      if (end - start < 0.2) {
        isSyncingRegionsRef.current = true;
        region.remove();
        isSyncingRegionsRef.current = false;
        return;
      }

      // Remove any previous selection regions so only one active selection exists
      isSyncingRegionsRef.current = true;
      for (const existing of regions.getRegions()) {
        if (existing !== region && !existing.id.startsWith('edit-')) {
          existing.remove();
        }
      }
      region.setOptions({
        id: SELECTION_REGION_ID,
        color: 'rgba(139, 92, 246, 0.28)',
        drag: true,
        resize: true,
      });
      isSyncingRegionsRef.current = false;

      onSelectionChange({ start, end });
    });

    const unsubRegionUpdated = regions.on('region-updated', (region: Region) => {
      if (isSyncingRegionsRef.current) return;
      if (region.id.startsWith('edit-')) return;
      const start = Math.max(0, Math.min(region.start, region.end));
      const end = Math.max(region.start, region.end);
      if (end - start >= 0.2) {
        onSelectionChange({ start, end });
      }
    });

    const unsubRegionClicked = regions.on('region-clicked', (region: Region, e: MouseEvent) => {
      e.stopPropagation();
      ws.setTime(region.start);
      setCurrentTime(region.start);
    });

    return () => {
      disableDrag();
      unsubReady();
      unsubError();
      unsubPlay();
      unsubPause();
      unsubFinish();
      unsubTime();
      unsubRegionCreated();
      unsubRegionUpdated();
      unsubRegionClicked();
      ws.destroy();
      wavesurferRef.current = null;
      regionsPluginRef.current = null;
      loadedUrlRef.current = null;
      waveformReadyRef.current = false;
    };
    // Re-create only when the mainTrack id or project id changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, mainTrack?.id]);

  // Load or swap audio URL (Original vs Remix / render_version) while preserving playhead
  useEffect(() => {
    const ws = wavesurferRef.current;
    if (!ws || !activeAudioUrl) return;
    if (loadedUrlRef.current === activeAudioUrl) return;

    const hadPrevious = Boolean(loadedUrlRef.current);
    if (hadPrevious) {
      // Preserve existing pendingRestoreRef if rapidly toggling A/B while a load is already in flight
      if (waveformReadyRef.current || !pendingRestoreRef.current) {
        pendingRestoreRef.current = {
          time: ws.getCurrentTime(),
          shouldPlay: ws.isPlaying(),
        };
      }
    } else {
      pendingRestoreRef.current = null;
    }

    const urlToLoad = activeAudioUrl;
    loadedUrlRef.current = urlToLoad;
    waveformReadyRef.current = false;
    setLoadingAudio(true);
    setWaveformReady(false);
    setAudioLoadError(null);

    ws.load(urlToLoad).catch((err: unknown) => {
      // Ignore abort errors superseded by a newer load
      if (loadedUrlRef.current !== urlToLoad) return;
      if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') {
        return;
      }
      loadedUrlRef.current = null;
      setLoadingAudio(false);
      setAudioLoadError(
        err instanceof Error ? err.message : 'Could not load audio stream from backend.'
      );
    });
  }, [activeAudioUrl, project?.id, mainTrack?.id, retryLoadNonce]);

  // Sync visual regions (enabled edits + active selection) onto WaveSurfer
  useEffect(() => {
    const regions = regionsPluginRef.current;
    if (!regions || !waveformReady) return;

    isSyncingRegionsRef.current = true;
    try {
      regions.clearRegions();

      // 1. Applied enabled edits (subtle emerald regions)
      for (const edit of enabledEdits) {
        if (edit.end > edit.start) {
          regions.addRegion({
            id: `edit-${edit.id}`,
            start: edit.start,
            end: edit.end,
            color: 'rgba(16, 185, 129, 0.14)',
            drag: false,
            resize: false,
            content: makeRegionLabel(edit.title),
          });
        }
      }

      // 2. Active user selection (violet draggable/resizable region)
      if (selection && selection.end > selection.start) {
        regions.addRegion({
          id: SELECTION_REGION_ID,
          start: selection.start,
          end: selection.end,
          color: 'rgba(139, 92, 246, 0.28)',
          drag: true,
          resize: true,
        });
      }
    } finally {
      isSyncingRegionsRef.current = false;
    }
  }, [selection, enabledEdits, waveformReady]);

  // Spacebar shortcut for Play/Pause when not typing in an input/textarea
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (!wavesurferRef.current || !waveformReady) return;
      e.preventDefault();
      if (wavesurferRef.current.isPlaying()) {
        wavesurferRef.current.pause();
      } else {
        const sel = selectionRef.current;
        const cur = wavesurferRef.current.getCurrentTime();
        if (sel && (cur < sel.start || cur >= sel.end)) {
          wavesurferRef.current.setTime(sel.start);
        }
        wavesurferRef.current.play().catch(() => {});
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [waveformReady]);

  const anyMainBusy = mainTrackBusy || uploading || loadingYoutube || Boolean(promotingRefId);

  const handleFileSelected = async (file: File | undefined) => {
    if (!file || !project || anyMainBusy) return;
    setUploadError(null);
    setUploading(true);
    try {
      await onUploadMainTrack(file);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to upload main track.');
    } finally {
      setUploading(false);
    }
  };

  const handleYoutubeMainSubmit = async (e: React.FormEvent, fromSwapBar = false) => {
    e.preventDefault();
    const rawUrl = (fromSwapBar ? ytSwapInput : ytInput).trim();
    if (!rawUrl || !project || anyMainBusy) return;
    setUploadError(null);
    setLoadingYoutube(true);
    try {
      await onLoadMainFromYoutube(rawUrl);
      if (fromSwapBar) {
        setYtSwapInput('');
        setYtSwapOpen(false);
      } else {
        setYtInput('');
      }
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : 'Failed to load audio from YouTube URL.'
      );
    } finally {
      setLoadingYoutube(false);
    }
  };

  const handlePromoteReference = async (refId: string) => {
    if (!project || anyMainBusy) return;
    setUploadError(null);
    setPromotingRefId(refId);
    try {
      await onLoadMainFromReference(refId);
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : 'Failed to load reference as main track.'
      );
    } finally {
      setPromotingRefId(null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFileSelected(file);
    }
  };

  const handlePlayPause = () => {
    const ws = wavesurferRef.current;
    if (!ws || !waveformReady) return;
    if (ws.isPlaying()) {
      ws.pause();
    } else {
      const sel = selectionRef.current;
      const cur = ws.getCurrentTime();
      if (sel && (cur < sel.start || cur >= sel.end)) {
        ws.setTime(sel.start);
      }
      ws.play().catch(() => {});
    }
  };

  const handleStop = () => {
    const ws = wavesurferRef.current;
    if (!ws) return;
    ws.pause();
    const resetTime = selection ? selection.start : 0;
    ws.setTime(resetTime);
    setCurrentTime(resetTime);
  };

  const handleSelectSection = (section: Section) => {
    onSelectionChange({ start: section.start, end: section.end });
    if (wavesurferRef.current && waveformReady) {
      wavesurferRef.current.setTime(section.start);
      setCurrentTime(section.start);
    }
  };

  const handleSeparateClick = async () => {
    if (!mainTrack || mainTrack.stems_status === 'processing' || startingStems) return;
    setStartingStems(true);
    try {
      await onSeparateStems();
    } finally {
      setStartingStems(false);
    }
  };

  const handleToggleStemPreview = (stemName: string) => {
    if (!project) return;
    if (playingStem === stemName) {
      stemAudioRef.current?.pause();
      stemAudioRef.current = null;
      setPlayingStem(null);
      return;
    }

    if (stemAudioRef.current) {
      stemAudioRef.current.pause();
      stemAudioRef.current = null;
    }
    // Pause main waveform if playing
    if (wavesurferRef.current?.isPlaying()) {
      wavesurferRef.current.pause();
    }

    const audio = new Audio(getStemAudioUrl(project, stemName));
    stemAudioRef.current = audio;
    setPlayingStem(stemName);
    audio.onended = () => setPlayingStem((cur) => (cur === stemName ? null : cur));
    audio.onerror = () => setPlayingStem((cur) => (cur === stemName ? null : cur));
    audio.play().catch(() => setPlayingStem(null));
  };

  const handleEditToggle = async (edit: EditBlock) => {
    if (busyEditId) return;
    setBusyEditId(edit.id);
    try {
      await onToggleEdit(edit.id, !edit.enabled);
    } finally {
      setBusyEditId(null);
    }
  };

  const handleEditDelete = async (editId: string) => {
    if (busyEditId) return;
    setBusyEditId(editId);
    try {
      await onDeleteEdit(editId);
    } finally {
      setBusyEditId(null);
    }
  };

  const stemsProcessing = mainTrack?.stems_status === 'processing' || startingStems;
  const stemsReady = mainTrack?.stems_status === 'ready';
  const stemsError = mainTrack?.stems_status === 'error';

  const stemNames = useMemo(() => {
    const ordered = ['vocals', 'drums', 'bass', 'other'];
    if (!mainTrack?.stems?.length) return ordered;
    const extras = mainTrack.stems.filter((s) => !ordered.includes(s));
    return [...ordered.filter((s) => mainTrack.stems.includes(s)), ...extras];
  }, [mainTrack?.stems]);

  return (
    <main className="flex-1 min-w-0 bg-[#0b0c10] flex flex-col h-full overflow-hidden">
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          handleFileSelected(f);
        }}
        className="hidden"
      />

      {!mainTrack ? (
        /* Empty State: YouTube Hero + Reference Shelf Picker + Local File Dropzone */
        <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
          <div className="w-full max-w-2xl space-y-4">
            {/* Primary Hero: Load directly from YouTube */}
            <div className="studio-card rounded-2xl p-7 space-y-5">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-rose-500/25 via-violet-500/25 to-indigo-500/20 border border-violet-500/30 flex items-center justify-center shrink-0">
                  {loadingYoutube ? (
                    <Loader2 className="w-6 h-6 text-violet-300 animate-spin" />
                  ) : (
                    <Youtube className="w-6 h-6 text-rose-400" />
                  )}
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-white">
                    Load a song from YouTube to remix
                  </h2>
                  <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                    Paste any public YouTube link — Musak downloads the audio and automatically
                    detects BPM, key, beat grid, and song sections like Verse, Buildup, and Drop.
                  </p>
                </div>
              </div>

              <form
                onSubmit={(e) => handleYoutubeMainSubmit(e, false)}
                className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5"
              >
                <div className="relative flex-1">
                  <Link2 className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={ytInput}
                    onChange={(e) => setYtInput(e.target.value)}
                    disabled={!project || anyMainBusy}
                    placeholder="Paste a YouTube URL to remix..."
                    className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-[#0b0c10] border border-white/10 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500/60 disabled:opacity-50"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!project || !ytInput.trim() || anyMainBusy}
                  className="px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold text-white shadow-lg shadow-violet-950/50 transition-colors flex items-center justify-center gap-2 shrink-0"
                >
                  {loadingYoutube ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Downloading & analyzing...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      Load Song
                    </>
                  )}
                </button>
              </form>

              {/* Pick from Reference Shelf strip when references exist */}
              {project && project.references.length > 0 && (
                <div className="pt-3 border-t border-white/[0.07] space-y-2.5">
                  <div className="text-[11px] font-medium text-zinc-400">
                    Or pick from your Reference Shelf
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {project.references.map((ref) => {
                      const isPromoting = promotingRefId === ref.id;
                      return (
                        <button
                          key={ref.id}
                          type="button"
                          disabled={anyMainBusy}
                          onClick={() => handlePromoteReference(ref.id)}
                          className="px-3 py-1.5 rounded-xl bg-[#181b26] hover:bg-[#222638] border border-white/[0.09] hover:border-violet-500/45 text-xs text-zinc-200 flex items-center gap-2 transition-colors disabled:opacity-50 max-w-full"
                        >
                          {isPromoting ? (
                            <Loader2 className="w-3.5 h-3.5 text-violet-300 animate-spin shrink-0" />
                          ) : ref.source_type === 'youtube' ? (
                            <Youtube className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                          ) : (
                            <Music className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                          )}
                          <span className="truncate max-w-[220px]">{ref.title}</span>
                          {isPromoting && (
                            <span className="text-[10px] text-violet-300 shrink-0">
                              Loading...
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {uploadError && (
                <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                    <span className="leading-snug">{uploadError}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setUploadError(null)}
                    className="text-rose-300/70 hover:text-rose-200 shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* Secondary Option: Local Audio Drag & Drop */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => !anyMainBusy && project && fileInputRef.current?.click()}
              className={`rounded-2xl border-2 border-dashed px-6 py-5 cursor-pointer transition-all flex flex-col sm:flex-row items-center justify-between gap-4 ${
                dragOver
                  ? 'border-violet-400 bg-violet-500/10 scale-[1.01]'
                  : 'border-white/12 bg-[#12141c]/80 hover:border-violet-500/45 hover:bg-[#151824]'
              }`}
            >
              <div className="flex items-center gap-3.5 text-left">
                <div className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center shrink-0">
                  {uploading ? (
                    <Loader2 className="w-5 h-5 text-violet-300 animate-spin" />
                  ) : (
                    <Upload className="w-5 h-5 text-zinc-400" />
                  )}
                </div>
                <div>
                  <div className="text-xs font-semibold text-zinc-200">
                    {uploading
                      ? 'Analyzing local audio...'
                      : 'Or drop / browse a local MP3, WAV, FLAC, M4A'}
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-0.5">
                    {uploading
                      ? 'Detecting BPM, musical key, beat grid, and song sections.'
                      : 'Drag an audio file anywhere here or click to choose from your PC.'}
                  </div>
                </div>
              </div>

              {!uploading && (
                <span className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#181b26] hover:bg-[#222638] border border-white/10 text-xs font-medium text-zinc-200 shrink-0 transition-colors">
                  <Music2 className="w-3.5 h-3.5 text-violet-300" />
                  Browse File
                </span>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* Active Track Workspace */
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto p-5 gap-4">
          {/* Track Info Bar */}
          <div className="studio-card rounded-2xl px-4 py-3.5 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <AudioLines className="w-4 h-4 text-violet-400 shrink-0" />
                <h1 className="text-sm font-semibold text-white truncate" title={mainTrack.name}>
                  {mainTrack.name}
                </h1>
              </div>

              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                <span className="px-2 py-0.5 rounded-md bg-white/[0.05] border border-white/[0.07] text-[11px] font-mono text-zinc-200">
                  {formatBpm(mainTrack.bpm) || '— BPM'}
                </span>
                <span className="px-2 py-0.5 rounded-md bg-white/[0.05] border border-white/[0.07] text-[11px] font-mono text-zinc-200">
                  Key: {mainTrack.key || '—'}
                </span>
                <span className="px-2 py-0.5 rounded-md bg-white/[0.05] border border-white/[0.07] text-[11px] font-mono text-zinc-400 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {formatTime(duration || mainTrack.duration)}
                </span>
                <span className="text-[11px] text-zinc-500">
                  {project?.edits.filter((e) => e.enabled).length || 0} active edits
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={anyMainBusy}
                onClick={() => fileInputRef.current?.click()}
                className="px-2.5 py-1.5 rounded-lg bg-[#181b26] hover:bg-[#222636] border border-white/[0.08] text-xs text-zinc-300 hover:text-white flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                {uploading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Upload className="w-3.5 h-3.5" />
                )}
                Replace
              </button>

              <button
                type="button"
                disabled={anyMainBusy}
                onClick={() => setYtSwapOpen((v) => !v)}
                className={`px-2.5 py-1.5 rounded-lg border text-xs flex items-center gap-1.5 transition-colors disabled:opacity-50 ${
                  ytSwapOpen
                    ? 'bg-rose-500/15 border-rose-500/35 text-rose-200'
                    : 'bg-[#181b26] hover:bg-[#222636] border-white/[0.08] text-zinc-300 hover:text-white'
                }`}
              >
                {loadingYoutube ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-300" />
                ) : (
                  <Youtube className="w-3.5 h-3.5 text-rose-400" />
                )}
                From YouTube
              </button>

              <button
                type="button"
                onClick={handleSeparateClick}
                disabled={stemsProcessing || stemsReady}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition-colors ${
                  stemsReady
                    ? 'bg-emerald-500/12 border-emerald-500/30 text-emerald-300 cursor-default'
                    : stemsProcessing
                    ? 'bg-amber-500/15 border-amber-500/35 text-amber-200 animate-pulse cursor-wait'
                    : stemsError
                    ? 'bg-rose-500/15 border-rose-500/35 text-rose-200 hover:bg-rose-500/25'
                    : 'bg-violet-600/20 hover:bg-violet-600/30 border-violet-500/40 text-violet-200'
                }`}
              >
                {stemsProcessing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Separating Stems...
                  </>
                ) : stemsReady ? (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    Stems Ready
                  </>
                ) : (
                  <>
                    <Layers className="w-3.5 h-3.5" />
                    {stemsError ? 'Retry Stems' : 'Separate Stems'}
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Inline YouTube Track Swap Bar */}
          {ytSwapOpen && (
            <form
              onSubmit={(e) => handleYoutubeMainSubmit(e, true)}
              className="studio-card rounded-xl px-3.5 py-2.5 flex items-center gap-2 border-rose-500/25"
            >
              <Youtube className="w-4 h-4 text-rose-400 shrink-0" />
              <input
                type="text"
                value={ytSwapInput}
                onChange={(e) => setYtSwapInput(e.target.value)}
                disabled={anyMainBusy}
                placeholder="Paste a YouTube URL to swap the main track..."
                autoFocus
                className="flex-1 min-w-0 bg-[#0b0c10] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500/60 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!ytSwapInput.trim() || anyMainBusy}
                className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-medium text-white flex items-center gap-1.5 shrink-0 transition-colors"
              >
                {loadingYoutube ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Downloading & analyzing...
                  </>
                ) : (
                  'Load Song'
                )}
              </button>
              <button
                type="button"
                disabled={anyMainBusy}
                onClick={() => {
                  setYtSwapOpen(false);
                  setYtSwapInput('');
                }}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] shrink-0"
                title="Close"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </form>
          )}

          {uploadError && (
            <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-xl px-3.5 py-2 flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 min-w-0">
                <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                <span className="leading-snug break-words">{uploadError}</span>
              </div>
              <button
                type="button"
                onClick={() => setUploadError(null)}
                className="text-rose-300/70 hover:text-rose-200 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {stemsError && mainTrack.stems_error && (
            <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-xl px-3.5 py-2">
              Stem separation error: {mainTrack.stems_error}
            </div>
          )}

          {/* Section Chips */}
          {mainTrack.sections && mainTrack.sections.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
              <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 shrink-0">
                Sections
              </span>
              {mainTrack.sections.map((section, idx) => {
                const isSelected =
                  Boolean(selection) &&
                  Math.abs((selection?.start ?? -1) - section.start) < 0.4 &&
                  Math.abs((selection?.end ?? -1) - section.end) < 0.4;
                return (
                  <button
                    key={`${section.label}-${idx}`}
                    type="button"
                    onClick={() => handleSelectSection(section)}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors shrink-0 flex items-center gap-1.5 ${
                      isSelected
                        ? 'bg-violet-600 text-white border-violet-400 shadow-sm shadow-violet-950/60'
                        : 'bg-[#12141c] hover:bg-[#1a1e2b] text-zinc-300 border-white/[0.08]'
                    }`}
                  >
                    <span>{section.label}</span>
                    <span
                      className={`text-[10px] font-mono ${
                        isSelected ? 'text-violet-200' : 'text-zinc-500'
                      }`}
                    >
                      {formatTime(section.start)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Hero Waveform Stage */}
          <div className="studio-card rounded-2xl p-4 space-y-3">
            {/* Selection & Mode Sub-Header */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {selection ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-violet-500/15 border border-violet-500/35 text-xs text-violet-200 font-medium">
                    <span className="w-2 h-2 rounded-full bg-violet-400" />
                    Selected:{' '}
                    <span className="font-mono">
                      {formatTimeRange(selection.start, selection.end)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onSelectionChange(null)}
                      title="Clear selection"
                      className="ml-0.5 text-violet-300/80 hover:text-white"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </span>
                ) : (
                  <span className="text-xs text-zinc-400">
                    Drag across the waveform to select a moment, or click a section chip above.
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 text-[11px]">
                {enabledEdits.length > 0 && (
                  <span className="flex items-center gap-1.5 text-emerald-300/90">
                    <span className="w-2 h-2 rounded-sm bg-emerald-400/70" />
                    {enabledEdits.length} Remix {enabledEdits.length === 1 ? 'Edit' : 'Edits'}
                  </span>
                )}
                {loadingAudio && (
                  <span className="flex items-center gap-1 text-violet-300">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Loading {abMode === 'remix' ? 'remix' : 'original'}...
                  </span>
                )}
              </div>
            </div>

            {/* WaveSurfer Canvas */}
            <div className="relative rounded-xl bg-[#0b0c10] border border-white/[0.06] px-3 py-3">
              <div ref={waveformContainerRef} className="w-full" />
              {!waveformReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#0b0c10]/80 rounded-xl px-4">
                  {audioLoadError ? (
                    <div className="flex flex-col items-center gap-2 text-center">
                      <div className="flex items-center gap-1.5 text-xs text-rose-300">
                        <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                        <span>{audioLoadError}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          loadedUrlRef.current = null;
                          setAudioLoadError(null);
                          setRetryLoadNonce((n) => n + 1);
                        }}
                        className="px-3 py-1 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-medium text-white flex items-center gap-1.5 transition-colors"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Retry Load
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-zinc-300">
                      <Loader2 className="w-4 h-4 animate-spin text-violet-400" />
                      Rendering waveform...
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Transport Bar + Before / After A/B Switch */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              {/* Left Transport Controls */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handlePlayPause}
                  disabled={!waveformReady}
                  title="Play / Pause (Space)"
                  className="w-10 h-10 rounded-full bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white flex items-center justify-center shadow-lg shadow-violet-950/60 transition-colors"
                >
                  {isPlaying ? (
                    <Pause className="w-4 h-4 fill-current" />
                  ) : (
                    <Play className="w-4 h-4 fill-current ml-0.5" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleStop}
                  disabled={!waveformReady}
                  title="Stop & return to start"
                  className="w-8 h-8 rounded-lg bg-[#181b26] hover:bg-[#222636] border border-white/[0.08] text-zinc-300 hover:text-white flex items-center justify-center transition-colors disabled:opacity-40"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                </button>

                <button
                  type="button"
                  onClick={() => setLoopSelection((v) => !v)}
                  disabled={!selection}
                  title={
                    selection
                      ? 'Loop selected region'
                      : 'Select a region on the waveform to enable loop'
                  }
                  className={`px-2.5 h-8 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition-colors disabled:opacity-35 disabled:cursor-not-allowed ${
                    loopSelection && selection
                      ? 'bg-violet-500/20 border-violet-500/45 text-violet-200'
                      : 'bg-[#181b26] hover:bg-[#222636] border-white/[0.08] text-zinc-300'
                  }`}
                >
                  <Repeat className="w-3.5 h-3.5" />
                  Loop
                </button>

                <div className="ml-2 font-mono text-xs text-zinc-300 tabular-nums">
                  <span>{formatTime(currentTime)}</span>
                  <span className="text-zinc-600 mx-1">/</span>
                  <span className="text-zinc-500">{formatTime(duration || mainTrack.duration)}</span>
                </div>
              </div>

              {/* Right: Prominent Before (Original) / After (Remix) A/B Segmented Switch */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold hidden sm:inline">
                  A/B Listen
                </span>
                <div className="inline-flex rounded-xl bg-[#0b0c10] border border-white/10 p-1">
                  <button
                    type="button"
                    onClick={() => onAbModeChange('original')}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                      abMode === 'original'
                        ? 'bg-zinc-700 text-white shadow-sm'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    Before · Original
                  </button>
                  <button
                    type="button"
                    onClick={() => onAbModeChange('remix')}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                      abMode === 'remix'
                        ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-950/60'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <Sparkles className="w-3 h-3" />
                    After · Remix
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Collapsible Stems & Applied Edits Drawer (Collapsed by default) */}
          <div className="studio-card rounded-2xl overflow-hidden">
            <button
              type="button"
              onClick={() => setDrawerOpen((v) => !v)}
              className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
            >
              <div className="flex items-center gap-2.5">
                <SlidersHorizontal className="w-4 h-4 text-zinc-400" />
                <span className="text-xs font-semibold text-zinc-200">
                  Stems & Applied Edits
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.05] text-zinc-400">
                  {stemsReady ? `${stemNames.length} Stems Ready` : 'Stems Optional'}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                  {project?.edits.length ?? 0}{' '}
                  {(project?.edits.length ?? 0) === 1 ? 'Edit' : 'Edits'}
                </span>
              </div>

              <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                <span>{drawerOpen ? 'Hide' : 'Expand'}</span>
                {drawerOpen ? (
                  <ChevronUp className="w-4 h-4" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
              </div>
            </button>

            {drawerOpen && (
              <div className="border-t border-white/[0.07] p-4 space-y-3">
                {/* Drawer Tabs */}
                <div className="flex items-center gap-1.5 border-b border-white/[0.06] pb-2.5">
                  <button
                    type="button"
                    onClick={() => setDrawerTab('stems')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                      drawerTab === 'stems'
                        ? 'bg-violet-500/15 text-violet-200 border border-violet-500/30'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]'
                    }`}
                  >
                    <Layers className="w-3.5 h-3.5" />
                    4-Stem Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => setDrawerTab('edits')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                      drawerTab === 'edits'
                        ? 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/30'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]'
                    }`}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Applied Edits ({project?.edits.length ?? 0})
                  </button>
                </div>

                {drawerTab === 'stems' ? (
                  stemsReady ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {stemNames.map((stem) => {
                        const meta = STEM_META[stem] || {
                          label: stem,
                          color: 'text-zinc-200',
                          bg: 'bg-white/[0.05] border-white/10',
                          icon: Volume2,
                        };
                        const Icon = meta.icon;
                        const isStemPlaying = playingStem === stem;

                        return (
                          <div
                            key={stem}
                            className="p-3 rounded-xl bg-[#181b26] border border-white/[0.07] flex items-center justify-between gap-3"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div
                                className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${meta.bg}`}
                              >
                                <Icon className={`w-4 h-4 ${meta.color}`} />
                              </div>
                              <div className="min-w-0">
                                <div className="text-xs font-semibold text-zinc-100 capitalize">
                                  {meta.label}
                                </div>
                                <div className="text-[10px] text-zinc-500">
                                  {isStemPlaying ? 'Playing isolated stem...' : 'Isolated audio'}
                                </div>
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => handleToggleStemPreview(stem)}
                              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition-colors shrink-0 ${
                                isStemPlaying
                                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-200'
                                  : 'bg-white/[0.05] hover:bg-white/[0.1] border-white/10 text-zinc-200'
                              }`}
                            >
                              {isStemPlaying ? (
                                <>
                                  <Square className="w-3 h-3 fill-current" />
                                  Stop
                                </>
                              ) : (
                                <>
                                  <Play className="w-3 h-3 fill-current" />
                                  Solo
                                </>
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="p-5 rounded-xl bg-[#181b26] border border-white/[0.06] text-center space-y-2.5">
                      <p className="text-xs text-zinc-300 font-medium">
                        {stemsProcessing
                          ? 'Demucs is splitting your song into Vocals, Drums, Bass, and Other...'
                          : 'Split your track into 4 stems for surgical remixes'}
                      </p>
                      <p className="text-[11px] text-zinc-500 max-w-md mx-auto">
                        Once separated, you can solo individual instruments and let Gemini drop just
                        the drums, boost the bass, or add vocal reverb throws.
                      </p>
                      {!stemsProcessing && (
                        <button
                          type="button"
                          onClick={handleSeparateClick}
                          className="mt-1 px-4 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-medium text-white inline-flex items-center gap-1.5 transition-colors"
                        >
                          <Layers className="w-3.5 h-3.5" />
                          Separate Stems Now
                        </button>
                      )}
                    </div>
                  )
                ) : (project?.edits.length ?? 0) === 0 ? (
                  <div className="p-5 rounded-xl bg-[#181b26] border border-white/[0.06] text-center text-xs text-zinc-400">
                    No edits applied yet. Ask the Gemini Producer on the right to suggest remix
                    ideas and click <span className="text-violet-300">Apply to Track</span>.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {project!.edits.map((edit) => {
                      const isBusy = busyEditId === edit.id;
                      return (
                        <div
                          key={edit.id}
                          className={`p-3 rounded-xl border flex items-center justify-between gap-3 transition-colors ${
                            edit.enabled
                              ? 'bg-[#181b26] border-emerald-500/25'
                              : 'bg-[#141720] border-white/[0.05] opacity-65'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-zinc-100 truncate">
                                {edit.title}
                              </span>
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.05] text-zinc-400 shrink-0">
                                {formatTimeRange(edit.start, edit.end)}
                              </span>
                            </div>
                            <p className="text-[11px] text-zinc-400 mt-0.5 line-clamp-1">
                              {edit.description}
                            </p>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={edit.enabled}
                              disabled={isBusy}
                              onClick={() => handleEditToggle(edit)}
                              title={edit.enabled ? 'Disable edit' : 'Enable edit'}
                              className={`relative w-9 h-5 rounded-full transition-colors ${
                                edit.enabled ? 'bg-emerald-500' : 'bg-zinc-700'
                              }`}
                            >
                              <span
                                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                                  edit.enabled ? 'translate-x-4' : 'translate-x-0'
                                }`}
                              />
                            </button>

                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleEditDelete(edit.id)}
                              title="Delete edit"
                              className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                            >
                              {isBusy ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
};
