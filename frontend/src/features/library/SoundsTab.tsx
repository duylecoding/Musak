import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Drum, Flame, Loader2, Play, Plus, Square, Waves, Zap } from 'lucide-react';
import { getSfxPreviewUrl, type SfxItem } from '../../shared/api';
import { HelpTip } from '../../shared/components/Tooltip/Tooltip';
import { useProject } from '../../state/ProjectContext';
import cardStyles from './LibraryCard.module.css';
import panelStyles from './LibraryPanel.module.css';

const SFX_CATEGORY_META = {
  riser: { label: 'Riser', badgeClass: cardStyles.badgeRiser, icon: Waves },
  impact: { label: 'Impact', badgeClass: cardStyles.badgeImpact, icon: Flame },
  drums: { label: 'Drums', badgeClass: cardStyles.badgeDrums, icon: Drum },
  transition: { label: 'Transition', badgeClass: cardStyles.badgeTransition, icon: Zap },
} as const;

export const SoundsTab: React.FC = () => {
  const { sfxItems, currentProject, playheadRef, addSfxLayer } = useProject();
  const [auditioningSfxId, setAuditioningSfxId] = useState<string | null>(null);
  const [addingSfxId, setAddingSfxId] = useState<string | null>(null);
  const [sfxError, setSfxError] = useState<string | null>(null);

  const sfxAudioRef = useRef<HTMLAudioElement | null>(null);
  const hasMainTrack = Boolean(currentProject?.main_track);
  const mainTrackBpm = currentProject?.main_track?.bpm ?? null;
  const mainTrackKey = currentProject?.main_track?.key ?? undefined;

  const releaseAudio = useCallback((audio: HTMLAudioElement | null) => {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }, []);

  const stopSfxAudition = useCallback(() => {
    releaseAudio(sfxAudioRef.current);
    setAuditioningSfxId(null);
  }, [releaseAudio]);

  useEffect(() => {
    const audio = sfxAudioRef.current;
    return () => releaseAudio(audio);
  }, [releaseAudio]);

  const handleToggleAudition = (item: SfxItem) => {
    setSfxError(null);
    if (auditioningSfxId === item.id) {
      stopSfxAudition();
      return;
    }

    const audio = sfxAudioRef.current;
    if (!audio) return;

    releaseAudio(audio);
    audio.src = getSfxPreviewUrl(item.id, mainTrackBpm ?? undefined, item.default_duration, mainTrackKey);
    setAuditioningSfxId(item.id);
    try {
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => setAuditioningSfxId((cur) => (cur === item.id ? null : cur)));
      }
    } catch {
      setAuditioningSfxId(null);
    }
  };

  const handleAddLayer = async (item: SfxItem) => {
    if (!hasMainTrack || addingSfxId) return;
    stopSfxAudition();
    setSfxError(null);
    setAddingSfxId(item.id);
    try {
      await addSfxLayer(item, playheadRef.current);
    } catch (err) {
      setSfxError(err instanceof Error ? err.message : 'Could not add sound layer.');
    } finally {
      setAddingSfxId(null);
    }
  };

  return (
    <div className={panelStyles.scrollBody}>
      <audio
        ref={sfxAudioRef}
        preload="none"
        onEnded={() => setAuditioningSfxId(null)}
        onError={() => setAuditioningSfxId(null)}
      />

      {sfxError && <div className={panelStyles.errorBanner}>{sfxError}</div>}

      {sfxItems.length === 0 ? (
        <div className={panelStyles.emptyState}>
          <Loader2 className={`${panelStyles.headerIcon} ${panelStyles.spinner}`} />
          <p className={panelStyles.emptySubtitle}>Loading built-in transition sounds...</p>
        </div>
      ) : (
        sfxItems.map((item) => {
          const meta = SFX_CATEGORY_META[item.category] ?? SFX_CATEGORY_META.transition;
          const CategoryIcon = meta.icon;
          const isPlaying = auditioningSfxId === item.id;
          const isAdding = addingSfxId === item.id;

          return (
            <div key={item.id} className={cardStyles.card}>
              <div className={cardStyles.cardBody}>
                <div className={cardStyles.badgeRow}>
                  <span className={`${cardStyles.badge} ${meta.badgeClass}`}>
                    <CategoryIcon size={10} />
                    {meta.label}
                  </span>
                  {item.bpm_synced && (
                    <span className={`${cardStyles.badge} ${cardStyles.badgeMono}`}>
                      {mainTrackBpm ? `${Math.round(mainTrackBpm)} BPM` : 'BPM Synced'}
                    </span>
                  )}
                  <span className={`${cardStyles.badge} ${cardStyles.badgeMono}`}>
                    {item.default_duration}s
                  </span>
                </div>

                <h4 className={cardStyles.cardTitle}>{item.name}</h4>
                <p className={cardStyles.cardDesc}>{item.description}</p>

                <div className={cardStyles.sfxFooter}>
                  <HelpTip content="Audition this transition sound right now (matched to your song's BPM).">
                    <button
                      type="button"
                      onClick={() => handleToggleAudition(item)}
                      className={`${cardStyles.actionBtn} ${isPlaying ? cardStyles.actionBtnPlaying : ''}`}
                    >
                      {isPlaying ? <><Square size={10} fill="currentColor" /> Stop</> : <><Play size={10} fill="currentColor" /> Preview</>}
                    </button>
                  </HelpTip>

                  <HelpTip content={hasMainTrack ? 'Drop this sound straight onto a new Sound Layer at your timeline playhead.' : 'Load a main song first so you can drop sounds onto its timeline.'}>
                    <button
                      type="button"
                      disabled={!hasMainTrack || Boolean(addingSfxId)}
                      onClick={() => void handleAddLayer(item)}
                      className={`${cardStyles.actionBtn} ${cardStyles.actionBtnPrimary}`}
                    >
                      {isAdding ? <><Loader2 size={12} className={cardStyles.spinner} /> Adding...</> : <><Plus size={12} /> Add to Layer</>}
                    </button>
                  </HelpTip>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
};
