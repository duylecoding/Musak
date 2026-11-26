import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import type { HealthStatus } from '../api/types';
import { clearBackendApiKey, getBackendBaseUrl, setBackendApiKey } from '../api/client';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  health: HealthStatus | null;
  backendOnline: boolean;
  onRefreshHealth: () => Promise<void>;
}

const GEMINI_KEY_URL = 'https://aistudio.google.com/apikey';

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  health,
  backendOnline,
  onRefreshHealth,
}) => {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );
  const [electronKeyStored, setElectronKeyStored] = useState<boolean | null>(null);

  const isElectron = Boolean(window.musakBridge);

  useEffect(() => {
    if (!open) return;
    setFeedback(null);
    if (window.musakBridge?.getKeyStatus) {
      window.musakBridge
        .getKeyStatus()
        .then((status) => setElectronKeyStored(status.configured))
        .catch(() => setElectronKeyStored(null));
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [open, onClose]);

  if (!open) return null;

  const isConfigured = Boolean(health?.api_key_configured || electronKeyStored);

  const handleOpenExternal = async () => {
    if (window.musakBridge?.openExternal) {
      await window.musakBridge.openExternal(GEMINI_KEY_URL);
    } else {
      window.open(GEMINI_KEY_URL, '_blank', 'noopener,noreferrer');
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      setFeedback({ type: 'error', text: 'Please paste your Gemini API key first.' });
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      if (window.musakBridge?.saveApiKey) {
        const res = await window.musakBridge.saveApiKey(trimmed);
        if (!res.ok) {
          throw new Error(res.error || 'Failed to save API key securely.');
        }
        setElectronKeyStored(true);
        // Also ensure backend receives it immediately if online
        if (backendOnline && !res.synced) {
          await setBackendApiKey(trimmed);
        }
        setApiKeyInput('');
        setFeedback({
          type: 'success',
          text: 'API key encrypted with Windows DPAPI and synced to local studio engine.',
        });
      } else {
        await setBackendApiKey(trimmed);
        setApiKeyInput('');
        setFeedback({
          type: 'success',
          text: 'API key sent to local backend memory (browser dev mode).',
        });
      }
      await onRefreshHealth();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save API key.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    setFeedback(null);
    try {
      if (window.musakBridge?.clearApiKey) {
        const res = await window.musakBridge.clearApiKey();
        if (!res.ok) {
          throw new Error(res.error || 'Failed to clear stored key.');
        }
        setElectronKeyStored(false);
      } else {
        await clearBackendApiKey();
      }
      await onRefreshHealth();
      setFeedback({ type: 'success', text: 'Gemini API key removed.' });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to clear API key.',
      });
    } finally {
      setClearing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshHealth();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-[#12141c] border border-white/10 shadow-2xl shadow-black/80 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/[0.07] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-violet-500/15 border border-violet-500/30 flex items-center justify-center">
              <KeyRound className="w-4 h-4 text-violet-300" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Studio Settings</h2>
              <p className="text-[11px] text-zinc-400">Gemini API credentials & system health</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5">
          {/* Gemini API Key Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">
                Gemini API Key
              </label>
              <span
                className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${
                  isConfigured
                    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                    : 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                }`}
              >
                {isConfigured ? 'Configured' : 'Not Configured'}
              </span>
            </div>

            <form onSubmit={handleSave} className="space-y-3">
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={
                    isConfigured
                      ? '•••••••••••••••••••• (paste a new key to replace)'
                      : 'AIzaSy...'
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full pl-3.5 pr-10 py-2.5 rounded-xl bg-[#0b0c10] border border-white/10 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500/60"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-200"
                  title={showKey ? 'Hide key' : 'Show key'}
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              <div className="flex items-start gap-2.5 p-3 rounded-xl bg-[#181b26] border border-white/[0.06] text-[11px] text-zinc-400 leading-relaxed">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  {isElectron ? (
                    <>
                      Encrypted locally using <span className="text-zinc-200">Windows DPAPI</span>{' '}
                      (Electron <code className="text-zinc-300">safeStorage</code>) in your private
                      OS app-data folder. Never saved in the project folder or browser storage.
                    </>
                  ) : (
                    <>
                      Running in browser dev mode: key is held only in local Python backend memory
                      and never written to disk or <code className="text-zinc-300">localStorage</code>.
                    </>
                  )}
                </div>
              </div>

              {feedback && (
                <div
                  className={`text-xs px-3 py-2 rounded-lg border ${
                    feedback.type === 'success'
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                  }`}
                >
                  {feedback.text}
                </div>
              )}

              <div className="flex items-center justify-between gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleOpenExternal}
                  className="text-xs text-violet-300 hover:text-violet-200 flex items-center gap-1.5 transition-colors"
                >
                  Get a free key at Google AI Studio
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>

                <div className="flex items-center gap-2">
                  {isConfigured && (
                    <button
                      type="button"
                      onClick={handleClear}
                      disabled={clearing}
                      className="px-3 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 text-rose-300 text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
                    >
                      {clearing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                      Clear
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={saving || !apiKeyInput.trim()}
                    className="px-4 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium flex items-center gap-1.5 transition-colors"
                  >
                    {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Save Key
                  </button>
                </div>
              </div>
            </form>
          </div>

          <div className="h-px bg-white/[0.07]" />

          {/* System Diagnostics */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">
                System Diagnostics
              </span>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1 transition-colors"
              >
                <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="p-3 rounded-xl bg-[#181b26] border border-white/[0.06]">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">Backend</div>
                <div className="mt-1 flex items-center gap-1.5 text-xs font-medium">
                  {backendOnline ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-300">Online</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="w-3.5 h-3.5 text-rose-400" />
                      <span className="text-rose-300">Offline</span>
                    </>
                  )}
                </div>
                <div className="text-[10px] text-zinc-500 mt-0.5 truncate">{getBackendBaseUrl()}</div>
              </div>

              <div className="p-3 rounded-xl bg-[#181b26] border border-white/[0.06]">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">GPU / Compute</div>
                <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-zinc-200">
                  <Cpu
                    className={`w-3.5 h-3.5 shrink-0 ${
                      health?.cuda_available ? 'text-emerald-400' : 'text-zinc-400'
                    }`}
                  />
                  <span className="truncate">
                    {health?.cuda_available ? health.gpu_name || 'CUDA GPU' : 'CPU Fallback'}
                  </span>
                </div>
                <div className="text-[10px] text-zinc-500 mt-0.5">
                  {health?.cuda_available ? 'Demucs GPU accelerated' : 'CUDA unavailable'}
                </div>
              </div>

              <div className="p-3 rounded-xl bg-[#181b26] border border-white/[0.06]">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">FFmpeg</div>
                <div className="mt-1 flex items-center gap-1.5 text-xs font-medium">
                  {health?.ffmpeg_available ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-zinc-200">Available</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="w-3.5 h-3.5 text-amber-400" />
                      <span className="text-amber-300">Not detected</span>
                    </>
                  )}
                </div>
              </div>

              <div className="p-3 rounded-xl bg-[#181b26] border border-white/[0.06]">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">Gemini Model</div>
                <div className="mt-1 text-xs font-medium text-violet-200 truncate">
                  {health?.model || '—'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
