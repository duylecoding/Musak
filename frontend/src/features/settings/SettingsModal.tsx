import React, { useEffect, useState } from 'react';
import { CheckCircle2, Cpu, ExternalLink, Eye, EyeOff, KeyRound, Loader2, RefreshCw, ShieldCheck, Trash2, X, XCircle } from 'lucide-react';
import { clearBackendApiKey, getBackendUrl, setBackendApiKey, setStemDevice, type StemDevice } from '../../shared/api';
import { useProject } from '../../state/ProjectContext';
import { HelpTip } from '../../shared/components/Tooltip/Tooltip';
import styles from './SettingsModal.module.css';

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const GEMINI_KEY_URL = 'https://aistudio.google.com/apikey';

export const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose }) => {
  const { health, backendOnline, refreshHealth } = useProject();
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingDevice, setSavingDevice] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [electronKeyStored, setElectronKeyStored] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) return;
    setFeedback(null);
    window.musakBridge?.getKeyStatus?.().then((s) => setElectronKeyStored(s.configured)).catch(() => setElectronKeyStored(null));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const isElectron = Boolean(window.musakBridge);
  const isConfigured = Boolean(health?.api_key_configured || electronKeyStored);
  const currentStemDevice: StemDevice = health?.stem_device ?? 'auto';
  const handleOpenExternal = () => window.musakBridge?.openExternal ? void window.musakBridge.openExternal(GEMINI_KEY_URL) : void window.open(GEMINI_KEY_URL, '_blank', 'noopener,noreferrer');

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = apiKeyInput.trim();
    if (!trimmed) { setFeedback({ type: 'error', text: 'Please paste your Gemini API key first.' }); return; }
    setSaving(true);
    setFeedback(null);
    try {
      if (window.musakBridge?.saveApiKey) {
        const res = await window.musakBridge.saveApiKey(trimmed);
        if (!res.ok) throw new Error(res.error || 'Failed to save API key securely.');
        setElectronKeyStored(true);
        if (backendOnline && !res.synced) await setBackendApiKey(trimmed);
        setFeedback({ type: 'success', text: 'API key encrypted with Windows DPAPI and synced to local studio engine.' });
      } else {
        await setBackendApiKey(trimmed);
        setFeedback({ type: 'success', text: 'API key sent to local backend memory (browser dev mode).' });
      }
      setApiKeyInput('');
      await refreshHealth();
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save API key.' });
    } finally { setSaving(false); }
  };

  const handleClear = async () => {
    setClearing(true);
    setFeedback(null);
    try {
      if (window.musakBridge?.clearApiKey) {
        const res = await window.musakBridge.clearApiKey();
        if (!res.ok) throw new Error(res.error || 'Failed to clear stored key.');
        setElectronKeyStored(false);
      } else { await clearBackendApiKey(); }
      await refreshHealth();
      setFeedback({ type: 'success', text: 'Gemini API key removed.' });
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'Failed to clear API key.' });
    } finally { setClearing(false); }
  };

  const handleSelectStemDevice = async (device: StemDevice) => {
    if (!backendOnline || savingDevice) return;
    setDeviceError(null);
    setSavingDevice(true);
    try { await setStemDevice(device); await refreshHealth(); }
    catch (err) { setDeviceError(err instanceof Error ? err.message : 'Failed to update stem engine.'); }
    finally { setSavingDevice(false); }
  };

  const stemOptions = [
    { id: 'auto' as const, label: 'Auto (GPU)', sub: 'Uses GPU if available', disabled: false },
    { id: 'cuda' as const, label: 'GPU (Fast)', sub: health?.cuda_available ? '~10–15s per song' : 'No CUDA GPU', disabled: !health?.cuda_available },
    { id: 'cpu' as const, label: 'CPU (Quiet)', sub: '~2–4m, low fan/VRAM', disabled: false },
  ];

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Studio Settings" className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.headerIcon}><KeyRound size={16} /></div>
            <div>
              <h2 className={styles.title}>Studio Settings</h2>
              <p className={styles.subtitle}>Gemini API credentials &amp; system health</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close settings" className={styles.closeBtn}><X size={16} /></button>
        </div>

        <div className={styles.body}>
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <label htmlFor="gemini-api-key" className={styles.sectionLabel}>Gemini API Key</label>
              <span className={`${styles.badge} ${isConfigured ? styles.badgeConfigured : styles.badgeMissing}`}>{isConfigured ? 'Configured' : 'Not Configured'}</span>
            </div>
            <form onSubmit={(e) => void handleSave(e)} className={styles.form}>
              <div className={styles.inputWrap}>
                <input id="gemini-api-key" type={showKey ? 'text' : 'password'} value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder={isConfigured ? '•••••••••••••••••••• (paste a new key to replace)' : 'Paste your Gemini API key...'} autoComplete="off" spellCheck={false} className={styles.keyInput} />
                <button type="button" onClick={() => setShowKey((s) => !s)} aria-label={showKey ? 'Hide key' : 'Show key'} className={styles.eyeBtn}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
              </div>
              <div className={styles.securityBox}>
                <ShieldCheck size={16} className={styles.securityIcon} />
                <div>
                  {isElectron
                    ? <>Encrypted locally using <span className={styles.emphasis}>Windows DPAPI</span> (Electron <code>safeStorage</code>) in your private OS app-data folder. Never saved in the project folder or browser storage.</>
                    : <>Running in browser dev mode: key is held only in local Python backend memory and never written to disk or <code>localStorage</code>.</>}
                </div>
              </div>
              {feedback && <div className={`${styles.feedback} ${feedback.type === 'success' ? styles.feedbackSuccess : styles.feedbackError}`}>{feedback.text}</div>}
              <div className={styles.actionsRow}>
                <button type="button" onClick={handleOpenExternal} className={styles.linkBtn}>
                  Get a free key at Google AI Studio <ExternalLink size={14} />
                </button>
                <div className={styles.btnGroup}>
                  {isConfigured && (
                    <HelpTip content="Erase your stored Gemini API key from this PC and disconnect AI features.">
                      <button type="button" onClick={() => void handleClear()} disabled={clearing} className={styles.dangerBtn}>
                        {clearing ? <Loader2 size={14} className={styles.spin} /> : <Trash2 size={14} />} Clear
                      </button>
                    </HelpTip>
                  )}
                  <HelpTip content="Encrypt and save your key so Gemini can power Producer Chat, Voice, and Lyric Hooks.">
                    <button type="submit" disabled={saving || !apiKeyInput.trim()} className={styles.primaryBtn}>
                      {saving && <Loader2 size={14} className={styles.spin} />} Save Key
                    </button>
                  </HelpTip>
                </div>
              </div>
            </form>
          </div>

          <div className={styles.divider} />

          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitleRow}>
                <span className={styles.sectionLabel}>Stem Splitting Engine</span>
                <HelpTip title="Local Demucs Stem Splitting" content="Demucs is 100% free & runs locally on your PC — no cloud upload needed. GPU takes ~10–15s per song, while CPU takes ~2–4m.">
                  <span className={styles.helpPill}>?</span>
                </HelpTip>
              </div>
              {savingDevice && <Loader2 size={14} className={`${styles.textAccent} ${styles.spin}`} />}
            </div>
            <div className={styles.deviceGrid}>
              {stemOptions.map((opt) => (
                <button key={opt.id} type="button" disabled={!backendOnline || savingDevice || opt.disabled} onClick={() => void handleSelectStemDevice(opt.id)} className={`${styles.deviceCard} ${currentStemDevice === opt.id ? styles.deviceCardActive : ''}`}>
                  <div className={styles.deviceTitle}>{opt.label}</div>
                  <div className={styles.deviceSub}>{opt.sub}</div>
                </button>
              ))}
            </div>
            {deviceError && <div className={`${styles.feedback} ${styles.feedbackError}`}>{deviceError}</div>}
          </div>

          <div className={styles.divider} />

          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>System Diagnostics</span>
              <HelpTip content="Re-check whether the local Python audio engine, GPU, and FFmpeg are ready.">
                <button type="button" onClick={() => { setRefreshing(true); void refreshHealth().finally(() => setRefreshing(false)); }} disabled={refreshing} className={styles.refreshBtn}>
                  <RefreshCw size={12} className={refreshing ? styles.spin : ''} /> Refresh
                </button>
              </HelpTip>
            </div>
            <div className={styles.diagGrid}>
              <div className={styles.diagCard}>
                <div className={styles.diagLabel}>Backend</div>
                <div className={styles.diagValue}>{backendOnline ? <><CheckCircle2 size={14} className={styles.textEmerald} /><span className={styles.textEmerald}>Online</span></> : <><XCircle size={14} className={styles.textRose} /><span className={styles.textRose}>Offline</span></>}</div>
                <div className={styles.diagSub}>{getBackendUrl()}</div>
              </div>
              <div className={styles.diagCard}>
                <div className={styles.diagLabel}>GPU / Compute</div>
                <div className={styles.diagValue}><Cpu size={14} className={health?.cuda_available ? styles.textEmerald : ''} /><span className={styles.truncate}>{health?.cuda_available ? health.gpu_name || 'CUDA GPU' : 'CPU Fallback'}</span></div>
                <div className={styles.diagSub}>{health?.cuda_available ? 'Demucs GPU accelerated' : 'CUDA unavailable'}</div>
              </div>
              <div className={styles.diagCard}>
                <div className={styles.diagLabel}>FFmpeg</div>
                <div className={styles.diagValue}>{health?.ffmpeg_available ? <><CheckCircle2 size={14} className={styles.textEmerald} /><span>Available</span></> : <><XCircle size={14} className={styles.textAmber} /><span className={styles.textAmber}>Not detected</span></>}</div>
              </div>
              <div className={styles.diagCard}>
                <div className={styles.diagLabel}>Gemini Model</div>
                <div className={`${styles.diagValue} ${styles.textAccent}`}><span className={styles.truncate}>{health?.model || '—'}</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
