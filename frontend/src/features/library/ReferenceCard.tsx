import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight, AtSign, Check, ChevronDown, ChevronUp, ExternalLink,
  Layers, Loader2, Music, Play, Plus, Sparkles, Trash2, Youtube,
} from 'lucide-react';
import {
  getReferenceAudioUrl,
  type MashupCompatibility,
  type MashupMode,
  type MomentPin,
  type ReferenceTrack,
} from '../../shared/api';
import { Popover } from '../../shared/components/Popover/Popover';
import { HelpTip } from '../../shared/components/Tooltip/Tooltip';
import { formatBpm } from '../../shared/utils/format';
import { useProject } from '../../state/ProjectContext';
import styles from './LibraryCard.module.css';
import { MashupMenu } from './MashupMenu';
import { MomentPinsList } from './MomentPinsList';

const STEM_OPTIONS = [
  { stem: 'full', label: 'Full Clip' },
  { stem: 'vocals', label: 'Vocals Only' },
  { stem: 'drums', label: 'Drums Only' },
  { stem: 'bass', label: 'Bass Only' },
  { stem: 'other', label: 'Melody / Other' },
] as const;

const COMPAT_STYLE: Record<MashupCompatibility['rating'], { prefix: string; badgeClass: string }> = {
  great: { prefix: 'Great', badgeClass: styles.badgeCompatGreat },
  good: { prefix: 'Good', badgeClass: styles.badgeCompatGood },
  tricky: { prefix: 'Tricky', badgeClass: styles.badgeCompatTricky },
};

function getMatchBadge(compat: MashupCompatibility) {
  const cfg = COMPAT_STYLE[compat.rating];
  return { label: `${cfg.prefix} ${Math.round(compat.score)}%`, badgeClass: cfg.badgeClass };
}

export interface ReferenceCardProps {
  reference: ReferenceTrack;
  onOpenSettings: () => void;
}

export const ReferenceCard: React.FC<ReferenceCardProps> = ({ reference, onOpenSettings }) => {
  const {
    currentProject, health, attachedRefIds, mainTrackBusy, playheadRef, showToast,
    toggleAttachRef, deleteReference, addMoment, deleteMoment,
    autoTagReference, extractReferenceStems, loadMainFromReference,
    createAutoMashup, addReferenceLayer, sendMomentToChat,
  } = useProject();

  const [playerOpen, setPlayerOpen] = useState(false);
  const [ytSeek, setYtSeek] = useState({ start: 0, autoplay: false, nonce: 0 });
  const [localSeek, setLocalSeek] = useState<{ start: number; nonce: number } | null>(null);
  const [busy, setBusy] = useState<'tag' | 'stems' | 'main' | 'layer' | 'delete' | null>(null);
  const [mashingMode, setMashingMode] = useState<MashupMode | null>(null);
  const [layerMenuOpen, setLayerMenuOpen] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const layerTriggerRef = useRef<HTMLButtonElement>(null);

  const projectId = currentProject?.id ?? '';
  const hasMainTrack = Boolean(currentProject?.main_track);
  const isAttached = attachedRefIds.includes(reference.id);
  const apiKeyConfigured = Boolean(health?.api_key_configured);
  const canPlayLocal = reference.source_type === 'local' || reference.audio_downloaded;
  const localAudioUrl = canPlayLocal && projectId
    ? getReferenceAudioUrl(projectId, reference.id, reference.audio_url)
    : null;
  const youtubeWatchUrl = reference.source_type === 'youtube'
    ? reference.youtube_url || (reference.youtube_id ? `https://www.youtube.com/watch?v=${reference.youtube_id}` : null)
    : null;

  useEffect(() => {
    if (!playerOpen || !localSeek || !canPlayLocal) return;
    const audio = audioRef.current;
    if (!audio) return;
    const applySeekAndPlay = () => {
      try { audio.currentTime = Math.max(0, localSeek.start); } catch { /* ignore */ }
      audio.play().catch(() => {});
    };
    if (audio.readyState >= 1) { applySeekAndPlay(); return; }
    audio.addEventListener('loadedmetadata', applySeekAndPlay, { once: true });
    return () => audio.removeEventListener('loadedmetadata', applySeekAndPlay);
  }, [playerOpen, localSeek, canPlayLocal]);

  const handlePlayMoment = (moment: MomentPin) => {
    setPlayerOpen(true);
    if (reference.source_type === 'youtube' && reference.youtube_id && !canPlayLocal) {
      setYtSeek((p) => ({ start: Math.max(0, Math.floor(moment.start)), autoplay: true, nonce: p.nonce + 1 }));
    } else if (canPlayLocal) {
      setLocalSeek((p) => ({ start: Math.max(0, moment.start), nonce: (p?.nonce ?? 0) + 1 }));
    }
  };

  const runBusy = async (kind: 'tag' | 'stems' | 'main' | 'layer' | 'delete', fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      if (kind === 'main') {
        showToast('error', err instanceof Error ? err.message : 'Failed to load reference as main track.');
      }
    } finally {
      setBusy(null);
    }
  };

  const handleAddLayer = (stem: 'vocals' | 'drums' | 'bass' | 'other' | 'full') => {
    setLayerMenuOpen(false);
    void runBusy('layer', () => addReferenceLayer(reference, stem, playheadRef.current));
  };

  const handleDropMoment = (moment: MomentPin) =>
    void runBusy('layer', () =>
      addReferenceLayer({ ref: reference, refStart: moment.start, refEnd: moment.end, targetStart: playheadRef.current, label: moment.label })
    );

  const stemsReady = reference.stems_status === 'ready';
  const stemsProcessing = reference.stems_status === 'processing' || busy === 'stems';
  const stemsError = reference.stems_status === 'error';
  const compatBadge = reference.compatibility ? getMatchBadge(reference.compatibility) : null;
  const stemBtnClass = stemsReady ? styles.actionBtnStemsReady : stemsProcessing ? styles.actionBtnStemsBusy : stemsError ? styles.actionBtnStemsError : '';

  return (
    <div className={`${styles.card} ${isAttached ? styles.cardAttached : ''}`}>
      <div className={styles.cardBody}>
        <div className={styles.cardTopRow}>
          <div className={styles.cardMetaWrap}>
            <div className={styles.badgeRow}>
              <span className={`${styles.badge} ${reference.source_type === 'youtube' ? styles.badgeYoutube : styles.badgeLocal}`}>
                {reference.source_type === 'youtube' ? <Youtube size={10} /> : <Music size={10} />}
                {reference.source_type === 'youtube' ? 'YouTube' : 'Local'}
              </span>
              {reference.bpm && (
                <HelpTip content="Detected tempo (beats per minute) of this reference song.">
                  <span className={`${styles.badge} ${styles.badgeMono}`}>{formatBpm(reference.bpm)}</span>
                </HelpTip>
              )}
              {reference.key && (
                <HelpTip content="Detected musical key of this reference song.">
                  <span className={`${styles.badge} ${styles.badgeMono}`}>{reference.key}</span>
                </HelpTip>
              )}
              {compatBadge && reference.compatibility && (
                <HelpTip title={`Mashup Match · ${Math.round(reference.compatibility.score)}%`} content={reference.compatibility.summary}>
                  <span className={`${styles.badge} ${compatBadge.badgeClass}`}>{compatBadge.label}</span>
                </HelpTip>
              )}
            </div>
            <h4 className={styles.cardTitle} title={reference.title}>{reference.title}</h4>
          </div>

          <div className={styles.cardTopActions}>
            <HelpTip content={isAttached ? 'Attached to Gemini Chat. Click to detach.' : 'Attach as @reference in Gemini Chat.'}>
              <button type="button" onClick={() => toggleAttachRef(reference.id)} className={`${styles.chatBtn} ${isAttached ? styles.chatBtnActive : ''}`}>
                {isAttached ? <Check size={10} /> : <AtSign size={10} />}
                Chat
              </button>
            </HelpTip>
            <HelpTip content="Remove this song from your Reference Shelf.">
              <button type="button" onClick={() => void runBusy('delete', () => deleteReference(reference.id))} disabled={busy === 'delete'} aria-label="Remove reference" className={styles.iconBtnDanger}>
                {busy === 'delete' ? <Loader2 size={14} className={styles.spinner} /> : <Trash2 size={14} />}
              </button>
            </HelpTip>
          </div>
        </div>

        <div className={styles.actionRow}>
          <button type="button" onClick={() => setPlayerOpen((v) => !v)} className={styles.actionBtn}>
            <Play size={12} /> Listen {playerOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>

          <HelpTip content="Promote this song onto the center waveform as your main track to remix.">
            <button type="button" onClick={() => void runBusy('main', () => loadMainFromReference(reference.id))} disabled={busy === 'main' || mainTrackBusy} className={`${styles.actionBtn} ${styles.actionBtnMain}`}>
              {busy === 'main' ? <><Loader2 size={12} className={styles.spinner} /> Loading...</> : <><ArrowUpRight size={12} /> Use as Main</>}
            </button>
          </HelpTip>

          <MashupMenu hasMainTrack={hasMainTrack} mashingMode={mashingMode} onSelectMode={async (mode) => { setMashingMode(mode); try { await createAutoMashup(reference.id, mode); } finally { setMashingMode(null); } }} />

          <HelpTip content="Ask Gemini to scan this track and pin drops, hooks, and transitions automatically.">
            <button type="button" onClick={() => (apiKeyConfigured ? void runBusy('tag', () => autoTagReference(reference.id)) : onOpenSettings())} disabled={busy === 'tag'} className={`${styles.actionBtn} ${styles.actionBtnAutoTag}`}>
              {busy === 'tag' ? <Loader2 size={12} className={styles.spinner} /> : <Sparkles size={12} />} Auto-Tag
            </button>
          </HelpTip>

          <button type="button" onClick={() => void runBusy('stems', () => extractReferenceStems(reference.id))} disabled={stemsProcessing || stemsReady} className={`${styles.actionBtn} ${stemBtnClass}`}>
            {stemsProcessing ? <><Loader2 size={12} className={styles.spinner} /> Separating...</> : stemsReady ? <><Check size={12} /> Stems Ready</> : <><Layers size={12} /> {stemsError ? 'Retry Stems' : 'Extract Stems'}</>}
          </button>

          {canPlayLocal && (
            <>
              <button ref={layerTriggerRef} type="button" disabled={!hasMainTrack || busy === 'layer'} onClick={() => (stemsReady ? setLayerMenuOpen((v) => !v) : handleAddLayer('full'))} className={`${styles.actionBtn} ${styles.actionBtnLayer}`}>
                {busy === 'layer' ? <Loader2 size={12} className={styles.spinner} /> : <Plus size={12} />}
                Add Layer {stemsReady && <ChevronDown size={12} />}
              </button>
              <Popover anchorRef={layerTriggerRef} open={layerMenuOpen && stemsReady} onClose={() => setLayerMenuOpen(false)} width={176} ariaLabel="Drop Stem Layer">
                <div className={styles.menuHeader}>Drop Stem Layer</div>
                {STEM_OPTIONS.map((opt) => (
                  <button key={opt.stem} type="button" onClick={() => handleAddLayer(opt.stem)} className={styles.menuItem}>
                    <div className={styles.menuItemTitle}>{opt.label}</div>
                  </button>
                ))}
              </Popover>
            </>
          )}

          {youtubeWatchUrl && (
            <button type="button" onClick={() => void window.open(youtubeWatchUrl, '_blank', 'noopener,noreferrer')} className={styles.actionBtn}>
              <ExternalLink size={12} /> Open on YouTube
            </button>
          )}
        </div>

        {stemsError && reference.stems_error && <p className={styles.errorText}>{reference.stems_error}</p>}

        {playerOpen && (
          <div className={styles.playerWrap}>
            {reference.source_type === 'youtube' && reference.youtube_id && !canPlayLocal ? (
              <div className={styles.ytEmbedBox}>
                <iframe key={`${reference.youtube_id}-${ytSeek.nonce}`} src={`https://www.youtube.com/embed/${encodeURIComponent(reference.youtube_id)}?start=${ytSeek.start}&autoplay=${ytSeek.autoplay ? 1 : 0}&rel=0`} title={reference.title} referrerPolicy="strict-origin-when-cross-origin" className={styles.ytIframe} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
              </div>
            ) : localAudioUrl ? (
              <audio ref={audioRef} controls src={localAudioUrl} className={styles.audioPlayer} />
            ) : (
              <div className={styles.previewFallback}>Preview unavailable for this reference.</div>
            )}
          </div>
        )}
      </div>

      <MomentPinsList
        moments={reference.moments}
        canDropMoment={hasMainTrack && canPlayLocal && busy !== 'layer'}
        onPlayMoment={handlePlayMoment}
        onAddMoment={(payload) => addMoment(reference.id, payload)}
        onDeleteMoment={(momentId) => deleteMoment(reference.id, momentId)}
        onDropMoment={handleDropMoment}
        onSendMomentToChat={(moment) => sendMomentToChat(reference, moment)}
      />
    </div>
  );
};
