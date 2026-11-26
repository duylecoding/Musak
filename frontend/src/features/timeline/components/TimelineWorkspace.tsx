import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getProjectPeaks, type WaveformPeaksResponse } from '../../../shared/api';
import { useProject } from '../../../state/ProjectContext';
import { partitionEditsByLane } from '../utils';
import { useClipDrag } from '../hooks/useClipDrag';
import { useLaneSelection } from '../hooks/useLaneSelection';
import { useMetronome } from '../hooks/useMetronome';
import { usePlaybackEngine } from '../hooks/usePlaybackEngine';
import { useTimelineActions } from '../hooks/useTimelineActions';
import { useTimelineShortcuts, useTimelineWheelZoom } from '../hooks/useTimelineShortcuts';
import { AddLayerPopover } from './AddLayerPopover';
import { BpmKeyPopover } from './BpmKeyPopover';
import { ClipInspector } from './ClipInspector';
import { EmptyTrackState } from './EmptyTrackState';
import { LyricsHooksPopover } from './LyricsHooksPopover';
import { SegmentActionBar } from './SegmentActionBar';
import { SpeedPitchPopover } from './SpeedPitchPopover';
import { TimelineTracks } from './TimelineTracks';
import { TrackHeader } from './TrackHeader';
import { TransportBar } from './TransportBar';
import styles from './TimelineWorkspace.module.css';

export interface TimelineWorkspaceProps {
  onOpenSettings?: () => void;
}

export const TimelineWorkspace: React.FC<TimelineWorkspaceProps> = ({ onOpenSettings }) => {
  const ctx = useProject();
  const project = ctx.currentProject;
  const mainTrack = project?.main_track ?? null;

  const [beatSnap, setBeatSnap] = useState(true);
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);
  const [zoom, setZoom] = useState<number>(1);
  const [peaks, setPeaks] = useState<WaveformPeaksResponse | null>(null);
  const [speedPitchOpen, setSpeedPitchOpen] = useState(false);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [bpmKeyOpen, setBpmKeyOpen] = useState(false);
  const [addLayerOpen, setAddLayerOpen] = useState(false);
  const [inspectedEditId, setInspectedEditId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const playheadLineRef = useRef<HTMLDivElement>(null);
  const playheadDiamondRef = useRef<HTMLDivElement>(null);
  const laneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const speedPitchBtnRef = useRef<HTMLDivElement>(null);
  const hooksBtnRef = useRef<HTMLDivElement>(null);
  const bpmKeyBtnRef = useRef<HTMLDivElement>(null);
  const addLayerBtnRef = useRef<HTMLButtonElement>(null);
  const clipAnchorRef = useRef<HTMLElement | null>(null);

  const trackDuration = mainTrack?.duration || peaks?.duration || 0;
  const playback = usePlaybackEngine({
    project, abMode: ctx.abMode, selection: ctx.selection, trackDuration,
    playheadRef: ctx.playheadRef, playheadLineRef, playheadDiamondRef,
  });

  useMetronome({
    enabled: metronomeEnabled, isPlaying: playback.isPlaying,
    beats: mainTrack?.beats ?? [], currentTimeRef: playback.currentTimeRef,
  });

  const effectiveDuration = trackDuration || playback.audioDuration || 0;
  const stemsReady = mainTrack?.stems_status === 'ready';

  const actions = useTimelineActions({
    project, mainTrack, trackDuration: effectiveDuration, beatSnap, selection: ctx.selection,
    mainTrackBusy: ctx.mainTrackBusy, apiKeyConfigured: Boolean(ctx.health?.api_key_configured),
    stemChannels: playback.stemChannels, isStemPreviewActive: playback.isStemPreviewActive,
    stemsReady, currentTimeRef: playback.currentTimeRef, onOpenSettings,
    onSelectionChange: ctx.setSelection, uploadMainTrack: ctx.uploadMainTrack,
    loadMainFromYoutube: ctx.loadMainFromYoutube, loadMainFromReference: ctx.loadMainFromReference,
    separateMainStems: ctx.separateMainStems, extractHooks: ctx.extractHooks,
    createEdit: ctx.createEdit, addSfxLayer: ctx.addSfxLayer,
    addReferenceLayer: ctx.addReferenceLayer, resetStemChannels: playback.resetStemChannels,
  });

  const laneSel = useLaneSelection({
    trackDuration: effectiveDuration, beats: mainTrack?.beats ?? [], beatSnap, zoom,
    selection: ctx.selection, laneRefs, timelineScrollRef,
    onSelectionChange: ctx.setSelection, seekToTime: playback.seekToTime,
  });

  const clipDrag = useClipDrag({
    trackDuration: effectiveDuration, beats: mainTrack?.beats ?? [], beatSnap,
    onUpdateEdit: ctx.updateEdit,
    onInspectClip: (edit, anchorEl) => { clipAnchorRef.current = anchorEl; setInspectedEditId(edit.id); },
  });

  useEffect(() => {
    actions.setUploadError(null);
    setSpeedPitchOpen(false);
    setHooksOpen(false);
    setBpmKeyOpen(false);
    setAddLayerOpen(false);
    setInspectedEditId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, mainTrack?.id]);

  useEffect(() => {
    if (!project?.id || !mainTrack?.id) { setPeaks(null); return; }
    let cancelled = false;
    getProjectPeaks(project.id, 1200).then((res) => { if (!cancelled) setPeaks(res); }).catch(() => {});
    return () => { cancelled = true; };
  }, [project?.id, mainTrack?.id, mainTrack?.stems_status, project?.render_version]);

  useTimelineWheelZoom(timelineScrollRef, mainTrack, setZoom);

  const handleDropCue = useCallback(() => {
    if (!mainTrack) return;
    const nextNum = (mainTrack.cues?.length ?? 0) + 1;
    void ctx.addCue({ label: `Cue ${nextNum}`, time: Number(ctx.playheadRef.current.toFixed(2)) });
  }, [ctx, mainTrack]);

  const inspectedEdit = useMemo(
    () => (inspectedEditId ? project?.edits.find((e) => e.id === inspectedEditId) ?? null : null),
    [inspectedEditId, project?.edits]
  );

  useTimelineShortcuts({
    enabled: Boolean(mainTrack),
    inspectedEditId: inspectedEdit?.id ?? null,
    onDuplicateEdit: (id) => { void ctx.duplicateEdit(id); setInspectedEditId(null); },
    onDropCue: handleDropCue,
  });

  const { masterEdits, stemEditsMap, layerEdits } = useMemo(
    () => partitionEditsByLane(project?.edits ?? []),
    [project?.edits]
  );

  const downloadableRefs = useMemo(
    () => (project?.references ?? []).filter((r) => r.source_type === 'local' || r.audio_downloaded),
    [project?.references]
  );

  const stemsProcessing = mainTrack?.stems_status === 'processing' || actions.startingStems;
  const stemsError = mainTrack?.stems_status === 'error';
  const combinedError = actions.uploadError || playback.audioError || (stemsError && mainTrack?.stems_error ? `Stem error: ${mainTrack.stems_error}` : null);

  return (
    <main className={styles.main}>
      <input
        ref={fileInputRef} type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void actions.handleFileSelected(f); }}
        className={styles.hiddenInput}
      />

      {!mainTrack ? (
        <EmptyTrackState
          hasProject={Boolean(project)} references={project?.references ?? []}
          anyMainBusy={actions.anyMainBusy} loadingYoutube={actions.loadingYoutube}
          uploading={actions.uploading} promotingRefId={actions.promotingRefId}
          uploadError={actions.uploadError} onDismissError={() => actions.setUploadError(null)}
          onSubmitYoutube={actions.handleYoutubeMainSubmit} onPromoteReference={actions.handlePromoteReference}
          onFileSelected={actions.handleFileSelected} onBrowseClick={() => fileInputRef.current?.click()}
        />
      ) : (
        <div className={styles.workspace}>
          <TrackHeader
            mainTrack={mainTrack} anyMainBusy={actions.anyMainBusy} uploading={actions.uploading}
            loadingYoutube={actions.loadingYoutube} stemsReady={stemsReady} stemsProcessing={stemsProcessing}
            stemsError={stemsError} cudaAvailable={Boolean(ctx.health?.cuda_available)} stemDevice={ctx.health?.stem_device}
            speedPitchOpen={speedPitchOpen} hooksOpen={hooksOpen} bpmKeyOpen={bpmKeyOpen}
            speedPitchBtnRef={speedPitchBtnRef} hooksBtnRef={hooksBtnRef} bpmKeyBtnRef={bpmKeyBtnRef}
            errorMessage={combinedError}
            onDismissError={() => { actions.setUploadError(null); playback.setAudioError(null); }}
            onToggleSpeedPitch={() => { setHooksOpen(false); setBpmKeyOpen(false); setSpeedPitchOpen((v) => !v); }}
            onToggleHooks={() => { setSpeedPitchOpen(false); setBpmKeyOpen(false); setHooksOpen((v) => !v); }}
            onToggleBpmKey={() => { setSpeedPitchOpen(false); setHooksOpen(false); setBpmKeyOpen((v) => !v); }}
            onBrowseReplace={() => fileInputRef.current?.click()}
            onSubmitYoutubeSwap={actions.handleYoutubeMainSubmit}
            onSeparateStems={() => void actions.handleSeparateStems()}
          />
          <TransportBar
            isPlaying={playback.isPlaying} loopSelection={playback.loopSelection}
            hasSelection={Boolean(ctx.selection)} displayTime={playback.displayTime}
            trackDuration={effectiveDuration} loadingAudio={playback.loadingAudio}
            isStemPreviewActive={playback.isStemPreviewActive} bakingMix={actions.bakingMix}
            abMode={ctx.abMode} beatSnap={beatSnap} metronomeEnabled={metronomeEnabled} zoom={zoom}
            onPlayPause={playback.handlePlayPause} onStop={playback.handleStop}
            onToggleLoop={() => playback.setLoopSelection((v) => !v)} onDropCue={handleDropCue}
            onBakeStemPreview={() => void actions.handleBakeStemPreview()}
            onResetStems={playback.resetStemChannels} onAbModeChange={ctx.setAbMode}
            onToggleBeatSnap={() => setBeatSnap((v) => !v)}
            onToggleMetronome={() => setMetronomeEnabled((v) => !v)} onZoomChange={setZoom}
          />
          <TimelineTracks
            mainTrack={mainTrack} trackDuration={effectiveDuration} displayTime={playback.displayTime}
            zoom={zoom} stemsReady={stemsReady} stemsProcessing={stemsProcessing} peaks={peaks}
            selection={ctx.selection} laneDragSelection={laneSel.laneDragSelection}
            stemChannels={playback.stemChannels} masterEdits={masterEdits} stemEditsMap={stemEditsMap}
            layerEdits={layerEdits} clipDragPreview={clipDrag.clipDragPreview}
            timelineScrollRef={timelineScrollRef} playheadLineRef={playheadLineRef}
            playheadDiamondRef={playheadDiamondRef} addLayerBtnRef={addLayerBtnRef} laneRefs={laneRefs}
            onSeekToTime={playback.seekToTime} onSelectionChange={ctx.setSelection}
            onUpdateChannel={playback.updateStemChannel} onLanePointerDown={laneSel.handleLanePointerDown}
            onClipPointerDown={clipDrag.handleClipPointerDown}
            onInspectClip={(ed, el) => { clipAnchorRef.current = el; setInspectedEditId(ed.id); }}
            onToggleLayerEnabled={(ed) => void ctx.updateEdit(ed.id, { enabled: !ed.enabled }).catch(() => {})}
            onDeleteEdit={(id) => void ctx.deleteEdit(id).catch(() => {})}
            onDeleteCue={(id) => void ctx.deleteCue(id)}
            onToggleAddLayer={() => setAddLayerOpen((v) => !v)}
          />
          <SegmentActionBar
            selection={ctx.selection} stemsReady={stemsReady} busy={actions.busySegment}
            barRef={laneSel.actionBarRef} coords={laneSel.actionBarCoords}
            onLayoutChange={laneSel.updateActionBarPosition} onSetBars={actions.handleSetBars}
            onAdjustVolume={(db) => void actions.handleSegmentVolume(db).catch(() => {})}
            onApplyFade={(c) => void actions.handleSegmentFade(c).catch(() => {})}
            onCutSection={() => void actions.handleCutSection().catch(() => {})}
            onRepeatSection={(n) => void actions.handleRepeatSection(n).catch(() => {})}
            onApplyFx={(fx) => void actions.handleSegmentFx(fx).catch(() => {})}
            onAskGemini={ctx.requestFocusChat} onClearSelection={() => ctx.setSelection(null)}
          />
          <ClipInspector
            edit={inspectedEdit} anchorRef={clipAnchorRef} onClose={() => setInspectedEditId(null)}
            onUpdateEdit={ctx.updateEdit} onDuplicateEdit={(id) => ctx.duplicateEdit(id)} onDeleteEdit={ctx.deleteEdit}
          />
          <SpeedPitchPopover
            open={speedPitchOpen} anchorRef={speedPitchBtnRef} selection={ctx.selection} stemsReady={stemsReady}
            applying={actions.applyingSpeedPitch} onClose={() => setSpeedPitchOpen(false)}
            onApply={async (p) => { await actions.handleApplySpeedPitch(p); setSpeedPitchOpen(false); }}
          />
          <LyricsHooksPopover
            open={hooksOpen} anchorRef={hooksBtnRef} hooks={mainTrack.lyric_hooks ?? []}
            extracting={actions.extractingHooks} onClose={() => setHooksOpen(false)}
            onExtractHooks={() => void actions.handleExtractHooks()}
            onSelectHook={(h) => { ctx.setSelection({ start: h.start, end: h.end, lane: 'all' }); playback.seekToTime(h.start); setHooksOpen(false); }}
          />
          <BpmKeyPopover
            open={bpmKeyOpen} anchorRef={bpmKeyBtnRef} bpm={mainTrack.bpm} musicalKey={mainTrack.key}
            onClose={() => setBpmKeyOpen(false)} onApply={ctx.updateMainTrackMeta}
          />
          <AddLayerPopover
            open={addLayerOpen} anchorRef={addLayerBtnRef}
            dropTime={ctx.selection ? ctx.selection.start : playback.displayTime}
            mainTrackBpm={mainTrack.bpm} sfxItems={ctx.sfxItems} downloadableRefs={downloadableRefs}
            busy={actions.busyLayerAdd} onClose={() => setAddLayerOpen(false)}
            onDropSfx={async (sfx) => { await actions.handleDropSfx(sfx); setAddLayerOpen(false); }}
            onDropReference={async (opts) => { await actions.handleDropReference(opts); setAddLayerOpen(false); }}
          />
        </div>
      )}
    </main>
  );
};
