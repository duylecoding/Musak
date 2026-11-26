import React, { useEffect, useRef, useState } from 'react';
import {
  AudioWaveform,
  Check,
  ChevronDown,
  Cpu,
  Download,
  FolderPlus,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Redo2,
  Settings,
  Sparkles,
  Trash2,
  Undo2,
  WifiOff,
  X,
} from 'lucide-react';
import type { HealthStatus, ProjectState, ProjectSummary } from '../api/types';

interface TopBarProps {
  health: HealthStatus | null;
  backendOnline: boolean;
  projects: ProjectSummary[];
  currentProject: ProjectState | null;
  onSelectProject: (projectId: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  onRenameProject: (projectId: string, name: string) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
  onUndo: () => Promise<void>;
  onRedo: () => Promise<void>;
  onExport: (format: 'wav' | 'mp3') => Promise<void>;
  onOpenSettings: () => void;
  historyBusy: boolean;
  exportingFormat: 'wav' | 'mp3' | null;
}

export const TopBar: React.FC<TopBarProps> = ({
  health,
  backendOnline,
  projects,
  currentProject,
  onSelectProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onUndo,
  onRedo,
  onExport,
  onOpenSettings,
  historyBusy,
  exportingFormat,
}) => {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);

  const projectMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCommittedRef = useRef(false);

  useEffect(() => {
    setIsRenaming(false);
    setRenameDraft('');
    renameCommittedRef.current = false;
  }, [currentProject?.id]);

  useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  const startRenaming = () => {
    if (!currentProject || renaming) return;
    setProjectMenuOpen(false);
    renameCommittedRef.current = false;
    setRenameDraft(currentProject.name);
    setIsRenaming(true);
  };

  const cancelRenaming = () => {
    renameCommittedRef.current = true;
    setIsRenaming(false);
    setRenameDraft('');
  };

  const commitRename = async () => {
    if (renameCommittedRef.current || renaming || !currentProject) return;
    renameCommittedRef.current = true;
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === currentProject.name) {
      setIsRenaming(false);
      return;
    }
    setRenaming(true);
    try {
      await onRenameProject(currentProject.id, trimmed);
    } catch {
      // Error toast is already displayed by App
    } finally {
      setRenaming(false);
      setIsRenaming(false);
    }
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(event.target as Node)) {
        setProjectMenuOpen(false);
      }
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newProjectName.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      await onCreateProject(trimmed);
      setNewProjectName('');
      setProjectMenuOpen(false);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    if (deletingId) return;
    setDeletingId(projectId);
    try {
      await onDeleteProject(projectId);
    } finally {
      setDeletingId(null);
    }
  };

  const canUndo = Boolean(currentProject && currentProject.edits.length > 0 && !historyBusy);
  const canRedo = Boolean(currentProject && currentProject.redo_stack.length > 0 && !historyBusy);
  const hasMainTrack = Boolean(currentProject?.main_track);

  const gpuShortName = health?.cuda_available
    ? (health.gpu_name || 'CUDA GPU').replace(/^NVIDIA\s+GeForce\s+/i, '')
    : 'CPU';

  return (
    <header className="h-14 shrink-0 bg-[#12141c] border-b border-white/[0.07] px-4 flex items-center justify-between gap-3 select-none z-30">
      {/* Left: Brand & Project Switcher */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 via-fuchsia-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-950/50">
            <AudioWaveform className="w-4 h-4 text-white" />
          </div>
          <div className="leading-tight">
            <span className="font-semibold tracking-tight text-sm text-white block">Musak</span>
            <span className="text-[10px] text-zinc-400 uppercase tracking-widest block">
              Producer Studio
            </span>
          </div>
        </div>

        <div className="h-5 w-px bg-white/10 mx-1 shrink-0" />

        {/* Project Switcher Dropdown & Inline Rename */}
        <div className="relative flex items-center gap-1.5" ref={projectMenuRef}>
          {isRenaming && currentProject ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                commitRename();
              }}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  commitRename();
                }
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[#0b0c10] border border-violet-500/60"
            >
              <input
                ref={renameInputRef}
                type="text"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRenaming();
                  }
                }}
                disabled={renaming}
                maxLength={120}
                aria-label="Rename project"
                className="w-44 sm:w-52 bg-transparent text-sm font-medium text-zinc-100 focus:outline-none select-text"
              />
              <button
                type="submit"
                disabled={renaming || !renameDraft.trim()}
                onMouseDown={(e) => e.preventDefault()}
                title="Save name (Enter)"
                className="p-1 rounded-md text-emerald-400 hover:bg-emerald-500/15 disabled:opacity-40 transition-colors"
              >
                {renaming ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
              </button>
              <button
                type="button"
                disabled={renaming}
                onMouseDown={(e) => e.preventDefault()}
                onClick={cancelRenaming}
                title="Cancel (Esc)"
                className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.08] transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </form>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setProjectMenuOpen((v) => !v)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRenaming();
                }}
                title={currentProject ? 'Click to switch projects · Double-click to rename' : 'Select Project'}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#181b26] hover:bg-[#1f2332] border border-white/[0.08] text-sm text-zinc-100 transition-colors max-w-[260px]"
              >
                <span className="truncate font-medium">
                  {currentProject ? currentProject.name : 'Select Project'}
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
              </button>

              {currentProject && (
                <button
                  type="button"
                  onClick={startRenaming}
                  title="Rename remix project"
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06] transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
            </>
          )}

          {projectMenuOpen && (
            <div className="absolute left-0 top-full mt-2 w-80 rounded-xl bg-[#151822] border border-white/10 shadow-2xl shadow-black/70 overflow-hidden z-50">
              <div className="p-2.5 border-b border-white/[0.07]">
                <form onSubmit={handleCreate} className="flex items-center gap-1.5">
                  <div className="relative flex-1">
                    <FolderPlus className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={newProjectName}
                      onChange={(e) => setNewProjectName(e.target.value)}
                      maxLength={120}
                      placeholder="New project name..."
                      className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded-lg bg-[#0b0c10] border border-white/10 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500/60"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={!newProjectName.trim() || creating}
                    className="px-2.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium text-white flex items-center gap-1 transition-colors shrink-0"
                  >
                    {creating ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Plus className="w-3.5 h-3.5" />
                    )}
                    New
                  </button>
                </form>
              </div>

              <div className="max-h-64 overflow-y-auto py-1">
                {projects.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-zinc-500 text-center">
                    No projects yet. Create one above.
                  </div>
                ) : (
                  projects.map((proj) => {
                    const isActive = proj.id === currentProject?.id;
                    return (
                      <div
                        key={proj.id}
                        onClick={() => {
                          onSelectProject(proj.id);
                          setProjectMenuOpen(false);
                        }}
                        className={`group px-3 py-2 flex items-center justify-between gap-2 cursor-pointer transition-colors ${
                          isActive
                            ? 'bg-violet-500/15 text-white'
                            : 'text-zinc-300 hover:bg-white/[0.05]'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                isActive ? 'bg-violet-400' : 'bg-zinc-600'
                              }`}
                            />
                            <span className="text-xs font-medium truncate">{proj.name}</span>
                          </div>
                          <div className="text-[10px] text-zinc-500 pl-3.5 mt-0.5">
                            {proj.has_main_track ? 'Track loaded' : 'No track'} ·{' '}
                            {proj.reference_count} refs · {proj.edit_count} edits
                          </div>
                        </div>
                        <button
                          type="button"
                          title="Delete project"
                          onClick={(e) => handleDelete(e, proj.id)}
                          disabled={deletingId === proj.id}
                          className="p-1 rounded-md text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100 transition-all"
                        >
                          {deletingId === proj.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Center: Status Pills */}
      <div className="hidden lg:flex items-center gap-2">
        {!backendOnline ? (
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-rose-500/15 text-rose-300 border border-rose-500/30"
          >
            <WifiOff className="w-3 h-3" />
            Backend Offline
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onOpenSettings}
              title={health?.gpu_name || 'Audio compute device'}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                health?.cuda_available
                  ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25 hover:bg-emerald-500/15'
                  : 'bg-zinc-800/80 text-zinc-300 border-white/10 hover:bg-zinc-800'
              }`}
            >
              <Cpu className="w-3 h-3" />
              <span>{gpuShortName}</span>
              {health?.cuda_available && (
                <span className="text-[10px] text-emerald-400/80 font-normal">CUDA</span>
              )}
            </button>

            <button
              type="button"
              onClick={onOpenSettings}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                health?.api_key_configured
                  ? 'bg-violet-500/12 text-violet-200 border-violet-500/30 hover:bg-violet-500/20'
                  : 'bg-amber-500/15 text-amber-200 border-amber-500/35 hover:bg-amber-500/25'
              }`}
            >
              {health?.api_key_configured ? (
                <>
                  <Sparkles className="w-3 h-3 text-violet-400" />
                  <span>Gemini Ready</span>
                </>
              ) : (
                <>
                  <KeyRound className="w-3 h-3 text-amber-400" />
                  <span>Set Gemini Key</span>
                </>
              )}
            </button>
          </>
        )}
      </div>

      {/* Right: Undo/Redo, Export, Settings */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex items-center rounded-lg bg-[#181b26] border border-white/[0.08] p-0.5">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo last edit"
            className="px-2 py-1.5 rounded-md text-zinc-300 hover:text-white hover:bg-white/[0.07] disabled:opacity-35 disabled:cursor-not-allowed transition-colors flex items-center gap-1 text-xs"
          >
            <Undo2 className="w-3.5 h-3.5" />
            <span className="hidden xl:inline">Undo</span>
          </button>
          <div className="w-px h-4 bg-white/10" />
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo}
            title="Redo edit"
            className="px-2 py-1.5 rounded-md text-zinc-300 hover:text-white hover:bg-white/[0.07] disabled:opacity-35 disabled:cursor-not-allowed transition-colors flex items-center gap-1 text-xs"
          >
            <Redo2 className="w-3.5 h-3.5" />
            <span className="hidden xl:inline">Redo</span>
          </button>
        </div>

        {/* Export Dropdown */}
        <div className="relative" ref={exportMenuRef}>
          <button
            type="button"
            disabled={!hasMainTrack || Boolean(exportingFormat)}
            onClick={() => setExportMenuOpen((v) => !v)}
            className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium flex items-center gap-1.5 transition-colors shadow-sm shadow-violet-950/50"
          >
            {exportingFormat ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Exporting {exportingFormat.toUpperCase()}...
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                Export
                <ChevronDown className="w-3 h-3 opacity-80" />
              </>
            )}
          </button>

          {exportMenuOpen && hasMainTrack && (
            <div className="absolute right-0 mt-2 w-52 rounded-xl bg-[#151822] border border-white/10 shadow-2xl shadow-black/70 py-1.5 z-50">
              <button
                type="button"
                onClick={() => {
                  setExportMenuOpen(false);
                  onExport('wav');
                }}
                className="w-full px-3 py-2 text-left hover:bg-white/[0.06] transition-colors"
              >
                <div className="text-xs font-medium text-zinc-100">Export WAV</div>
                <div className="text-[10px] text-zinc-400">Lossless studio master</div>
              </button>
              <button
                type="button"
                onClick={() => {
                  setExportMenuOpen(false);
                  onExport('mp3');
                }}
                className="w-full px-3 py-2 text-left hover:bg-white/[0.06] transition-colors"
              >
                <div className="text-xs font-medium text-zinc-100">Export MP3</div>
                <div className="text-[10px] text-zinc-400">Lightweight for sharing</div>
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onOpenSettings}
          title="Studio Settings & API Key"
          className="p-2 rounded-lg bg-[#181b26] hover:bg-[#222636] border border-white/[0.08] text-zinc-300 hover:text-white transition-colors relative"
        >
          <Settings className="w-4 h-4" />
          {backendOnline && !health?.api_key_configured && (
            <span className="w-2 h-2 rounded-full bg-amber-400 absolute -top-0.5 -right-0.5 ring-2 ring-[#12141c]" />
          )}
        </button>
      </div>
    </header>
  );
};
