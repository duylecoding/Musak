import React from 'react';
import { Bell, Flag, Loader2, Magnet, Minus, Pause, Play, Plus, Repeat, RotateCcw, Sparkles, Square, ZoomIn } from 'lucide-react';
import { HelpTip } from '../../../shared/components/Tooltip/Tooltip';
import { formatTime } from '../../../shared/utils/format';
import styles from './TransportBar.module.css';

export interface TransportBarProps {
  isPlaying: boolean;
  loopSelection: boolean;
  hasSelection: boolean;
  displayTime: number;
  trackDuration: number;
  loadingAudio: boolean;
  isStemPreviewActive: boolean;
  bakingMix: boolean;
  abMode: 'original' | 'remix';
  beatSnap: boolean;
  metronomeEnabled?: boolean;
  zoom: number;
  onPlayPause: () => void;
  onStop: () => void;
  onToggleLoop: () => void;
  onDropCue?: () => void;
  onBakeStemPreview: () => void;
  onResetStems: () => void;
  onAbModeChange: (mode: 'original' | 'remix') => void;
  onToggleBeatSnap: () => void;
  onToggleMetronome?: () => void;
  onZoomChange: (zoom: number) => void;
}

export const TransportBar: React.FC<TransportBarProps> = ({
  isPlaying, loopSelection, hasSelection, displayTime, trackDuration, loadingAudio,
  isStemPreviewActive, bakingMix, abMode, beatSnap, metronomeEnabled = false, zoom,
  onPlayPause, onStop, onToggleLoop, onDropCue, onBakeStemPreview, onResetStems,
  onAbModeChange, onToggleBeatSnap, onToggleMetronome, onZoomChange,
}) => (
  <div className={styles.bar}>
    <div className={styles.leftGroup}>
      <HelpTip content="Play or pause the track (Spacebar).">
        <button type="button" onClick={onPlayPause} aria-label={isPlaying ? 'Pause' : 'Play'} className={styles.playBtn}>
          {isPlaying ? <Pause className={styles.pauseIcon} /> : <Play className={styles.playIcon} />}
        </button>
      </HelpTip>

      <HelpTip content="Stop and jump back to the start of your selection or song.">
        <button type="button" onClick={onStop} aria-label="Stop" className={styles.stopBtn}>
          <Square className={styles.stopIcon} />
        </button>
      </HelpTip>

      <HelpTip content="Loop your highlighted selection continuously while auditing.">
        <button
          type="button"
          onClick={onToggleLoop}
          disabled={!hasSelection}
          className={loopSelection && hasSelection ? `${styles.loopBtn} ${styles.loopBtnActive}` : styles.loopBtn}
        >
          <Repeat className={styles.smallIcon} />
          Loop
        </button>
      </HelpTip>

      {onDropCue && (
        <HelpTip content="Drop a cue marker at the current playhead (shortcut: M).">
          <button type="button" onClick={onDropCue} className={styles.cueBtn} aria-label="Drop Cue (M)">
            <Flag className={styles.smallIcon} />
            <span>Drop Cue</span>
            <span className={styles.kbdHint}>M</span>
          </button>
        </HelpTip>
      )}

      <div className={styles.timecode}>
        <span>{formatTime(displayTime)}</span>
        <span className={styles.timeSep}>/</span>
        <span className={styles.timeTotal}>{formatTime(trackDuration)}</span>
      </div>

      {loadingAudio && <Loader2 className={styles.loadingIcon} />}

      {isStemPreviewActive && (
        <div className={styles.bakeBanner}>
          <span>Live Mute/Solo Preview</span>
          <button type="button" disabled={bakingMix} onClick={onBakeStemPreview} className={styles.bakeBtn}>
            {bakingMix ? 'Applying...' : 'Apply to Remix'}
          </button>
          <button type="button" onClick={onResetStems} title="Reset stem mute/solo/volumes" className={styles.resetStemBtn}>
            <RotateCcw className={styles.smallIcon} />
          </button>
        </div>
      )}
    </div>

    <div className={styles.rightGroup}>
      <HelpTip
        title="Before / After Comparison"
        content="Flip between the untouched Original song and your live Remix at the exact same spot."
      >
        <div className={styles.segmentedGroup}>
          <button
            type="button"
            onClick={() => onAbModeChange('original')}
            className={abMode === 'original' ? `${styles.abBtn} ${styles.abOriginalActive}` : styles.abBtn}
          >
            Before · Original
          </button>
          <button
            type="button"
            onClick={() => onAbModeChange('remix')}
            className={abMode === 'remix' ? `${styles.abBtn} ${styles.abRemixActive}` : styles.abBtn}
          >
            <Sparkles className={styles.smallIcon} />
            After · Remix
          </button>
        </div>
      </HelpTip>

      <HelpTip
        content={
          beatSnap
            ? 'Beat Snap On: drag selections and clip nudges snap cleanly to musical beats.'
            : 'Beat Snap Off: drag freely to any exact millisecond.'
        }
      >
        <button
          type="button"
          onClick={onToggleBeatSnap}
          className={beatSnap ? `${styles.snapBtn} ${styles.snapBtnActive}` : styles.snapBtn}
        >
          <Magnet className={styles.smallIcon} />
          Beat Snap: {beatSnap ? 'On' : 'Off'}
        </button>
      </HelpTip>

      {onToggleMetronome && (
        <HelpTip content="Audible metronome click on detected beats during playback.">
          <button
            type="button"
            onClick={onToggleMetronome}
            aria-pressed={metronomeEnabled}
            className={metronomeEnabled ? `${styles.snapBtn} ${styles.snapBtnActive}` : styles.snapBtn}
          >
            <Bell className={styles.smallIcon} />
            Click
          </button>
        </HelpTip>
      )}

      <HelpTip content="Stretch the timeline horizontally (1x–16x) or hold Ctrl + Mouse Wheel to zoom in for fine-tuning clips and beats.">
        <div className={styles.segmentedGroup}>
          <ZoomIn className={styles.zoomIcon} />
          <button
            type="button"
            aria-label="Zoom out"
            disabled={zoom <= 1}
            onClick={() => onZoomChange(Math.max(1, Number((zoom / 1.5).toFixed(2))))}
            className={styles.zoomBtn}
          >
            <Minus className={styles.smallIcon} />
          </button>
          {([1, 2, 4, 8, 16] as const).map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => onZoomChange(z)}
              className={Math.abs(zoom - z) < 0.05 ? `${styles.zoomBtn} ${styles.zoomBtnActive}` : styles.zoomBtn}
            >
              {z}x
            </button>
          ))}
          <button
            type="button"
            aria-label="Zoom in"
            disabled={zoom >= 16}
            onClick={() => onZoomChange(Math.min(16, Number((zoom * 1.5).toFixed(2))))}
            className={styles.zoomBtn}
          >
            <Plus className={styles.smallIcon} />
          </button>
        </div>
      </HelpTip>
    </div>
  </div>
);
