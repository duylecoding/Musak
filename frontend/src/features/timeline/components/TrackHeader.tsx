import React, { useState } from 'react';
import { AlertCircle, AudioLines, Check, Gauge, Layers, Loader2, Quote, Upload, X, Youtube } from 'lucide-react';
import type { MainTrack, StemDevice } from '../../../shared/api';
import { HelpTip } from '../../../shared/components/Tooltip/Tooltip';
import { formatBpm } from '../../../shared/utils/format';
import styles from './TrackHeader.module.css';

export interface TrackHeaderProps {
  mainTrack: MainTrack;
  anyMainBusy: boolean;
  uploading: boolean;
  loadingYoutube: boolean;
  stemsReady: boolean;
  stemsProcessing: boolean;
  stemsError: boolean;
  cudaAvailable: boolean;
  stemDevice?: StemDevice;
  speedPitchOpen: boolean;
  hooksOpen: boolean;
  speedPitchBtnRef: React.RefObject<HTMLDivElement>;
  hooksBtnRef: React.RefObject<HTMLDivElement>;
  errorMessage: string | null;
  onDismissError: () => void;
  onToggleSpeedPitch: () => void;
  onToggleHooks: () => void;
  onBrowseReplace: () => void;
  onSubmitYoutubeSwap: (url: string) => Promise<void>;
  onSeparateStems: () => void;
}

export const TrackHeader: React.FC<TrackHeaderProps> = ({
  mainTrack, anyMainBusy, uploading, loadingYoutube, stemsReady, stemsProcessing, stemsError,
  cudaAvailable, stemDevice = 'auto', speedPitchOpen, hooksOpen, speedPitchBtnRef, hooksBtnRef,
  errorMessage, onDismissError, onToggleSpeedPitch, onToggleHooks, onBrowseReplace, onSubmitYoutubeSwap, onSeparateStems,
}) => {
  const [ytSwapOpen, setYtSwapOpen] = useState(false);
  const [ytSwapInput, setYtSwapInput] = useState('');
  const lyricHooks = mainTrack.lyric_hooks ?? [];

  const stemBtnClass = stemsReady
    ? `${styles.stemBtn} ${styles.stemBtnReady}`
    : stemsProcessing
    ? `${styles.stemBtn} ${styles.stemBtnProcessing}`
    : stemsError
    ? `${styles.stemBtn} ${styles.stemBtnError}`
    : styles.stemBtn;

  const handleSwapSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = ytSwapInput.trim();
    if (!url || anyMainBusy) return;
    await onSubmitYoutubeSwap(url);
    setYtSwapInput('');
    setYtSwapOpen(false);
  };

  return (
    <>
      <div className={styles.headerCard}>
        <div className={styles.leftGroup}>
          <AudioLines className={styles.trackIcon} />
          <h1 className={styles.trackTitle} title={mainTrack.name}>{mainTrack.name}</h1>

          <HelpTip title="BPM (Tempo)" content="Beats per minute — locks Beat Snap, transitions, and echoes to the rhythm.">
            <span className={styles.metaPill}>{formatBpm(mainTrack.bpm) || '— BPM'}</span>
          </HelpTip>
          <HelpTip title="Musical Key" content="Detected scale so mashups and borrowed clips stay in tune.">
            <span className={styles.metaPill}>{mainTrack.key || '—'}</span>
          </HelpTip>

          <div className={styles.triggerWrap} ref={speedPitchBtnRef}>
            <HelpTip content="Make Slowed + Reverb, Sped Up, or Deep Pitch edits in one tap.">
              <button
                type="button"
                onClick={onToggleSpeedPitch}
                className={speedPitchOpen ? `${styles.toolBtn} ${styles.toolBtnActive}` : styles.toolBtn}
              >
                <Gauge className={styles.iconViolet} />
                <span>Speed &amp; Pitch</span>
              </button>
            </HelpTip>
          </div>

          <div className={styles.triggerWrap} ref={hooksBtnRef}>
            <HelpTip content="Jump straight to catchy lyric lines & hooks instead of hunting by timestamp.">
              <button
                type="button"
                onClick={onToggleHooks}
                className={hooksOpen ? `${styles.toolBtn} ${styles.hooksBtnActive}` : styles.toolBtn}
              >
                <Quote className={styles.iconVocals} />
                <span>Lyrics &amp; Hooks</span>
                {lyricHooks.length > 0 && <span className={styles.hooksBadge}>{lyricHooks.length}</span>}
              </button>
            </HelpTip>
          </div>
        </div>

        <div className={styles.rightGroup}>
          <HelpTip content="Swap the main track with an audio file from your PC.">
            <button type="button" disabled={anyMainBusy} onClick={onBrowseReplace} className={styles.actionBtn}>
              {uploading ? <Loader2 className={styles.iconSmSpin} /> : <Upload className={styles.iconSm} />}
              <span>Replace</span>
            </button>
          </HelpTip>

          <HelpTip content="Load a new main song from a YouTube URL.">
            <button
              type="button"
              disabled={anyMainBusy}
              onClick={() => setYtSwapOpen((v) => !v)}
              className={ytSwapOpen ? `${styles.actionBtn} ${styles.actionBtnYtActive}` : styles.actionBtn}
            >
              {loadingYoutube ? <Loader2 className={styles.iconSmSpin} /> : <Youtube className={styles.iconRose} />}
              <span>From YouTube</span>
            </button>
          </HelpTip>

          <HelpTip
            title="4-Stem Separation"
            content={
              stemsReady
                ? 'Vocals, Drums, Bass, and Melody lanes are isolated and ready for Mute, Solo, and surgical FX.'
                : stemsProcessing
                ? 'Demucs is splitting your song into 4 instrument lanes locally.'
                : 'Split your song into Vocals, Drums, Bass, and Melody lanes.'
            }
          >
            <button type="button" onClick={onSeparateStems} disabled={stemsProcessing || stemsReady} className={stemBtnClass}>
              {stemsProcessing ? (
                <><Loader2 className={styles.iconSmSpin} />{cudaAvailable && stemDevice !== 'cpu' ? 'Splitting stems on GPU...' : 'Splitting stems...'}</>
              ) : stemsReady ? (
                <><Check className={styles.iconSm} />4 Stems Ready</>
              ) : (
                <><Layers className={styles.iconSm} />{stemsError ? 'Retry Stems' : 'Separate Stems'}</>
              )}
            </button>
          </HelpTip>
        </div>
      </div>

      {ytSwapOpen && (
        <form onSubmit={handleSwapSubmit} className={styles.swapBar}>
          <Youtube className={styles.iconRose} />
          <input
            type="text"
            value={ytSwapInput}
            onChange={(e) => setYtSwapInput(e.target.value)}
            disabled={anyMainBusy}
            placeholder="Paste a YouTube URL to swap the main track..."
            autoFocus
            className={styles.swapInput}
          />
          <button type="submit" disabled={!ytSwapInput.trim() || anyMainBusy} className={styles.swapSubmit}>
            {loadingYoutube ? <><Loader2 className={styles.iconSmSpin} />Downloading...</> : 'Load Song'}
          </button>
          <button type="button" disabled={anyMainBusy} onClick={() => { setYtSwapOpen(false); setYtSwapInput(''); }} className={styles.iconClose}>
            <X className={styles.iconMd} />
          </button>
        </form>
      )}

      {errorMessage && (
        <div className={styles.errorRow}>
          <div className={styles.errorLeft}>
            <AlertCircle className={styles.iconRose} />
            <span className={styles.errorText}>{errorMessage}</span>
          </div>
          <button type="button" onClick={onDismissError} className={styles.iconClose}>
            <X className={styles.iconMd} />
          </button>
        </div>
      )}
    </>
  );
};
