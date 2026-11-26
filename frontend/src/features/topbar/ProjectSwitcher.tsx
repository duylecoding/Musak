import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FolderPlus, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useProject } from '../../state/ProjectContext';
import { Popover } from '../../shared/components/Popover/Popover';
import { HelpTip } from '../../shared/components/Tooltip/Tooltip';
import styles from './TopBar.module.css';

export const ProjectSwitcher: React.FC = () => {
  const { projects, currentProject, selectProject, createProject, renameProject, deleteProject } = useProject();
  const [menuOpen, setMenuOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCommittedRef = useRef(false);

  useEffect(() => {
    setIsRenaming(false);
    setRenameDraft('');
    renameCommittedRef.current = false;
  }, [currentProject?.id]);

  useEffect(() => {
    if (isRenaming) { renameInputRef.current?.focus(); renameInputRef.current?.select(); }
  }, [isRenaming]);

  const startRenaming = () => {
    if (!currentProject || renaming) return;
    setMenuOpen(false);
    renameCommittedRef.current = false;
    setRenameDraft(currentProject.name);
    setIsRenaming(true);
  };

  const cancelRenaming = () => { renameCommittedRef.current = true; setIsRenaming(false); setRenameDraft(''); };

  const commitRename = async () => {
    if (renameCommittedRef.current || renaming || !currentProject) return;
    renameCommittedRef.current = true;
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === currentProject.name) { setIsRenaming(false); return; }
    setRenaming(true);
    try { await renameProject(currentProject.id, trimmed); }
    catch { /* Error toast displayed by ProjectContext */ }
    finally { setRenaming(false); setIsRenaming(false); }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newProjectName.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try { await createProject(trimmed); setNewProjectName(''); setMenuOpen(false); }
    catch { /* Error toast displayed by ProjectContext */ }
    finally { setCreating(false); }
  };

  const handleDelete = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    if (deletingId) return;
    setDeletingId(projectId);
    try { await deleteProject(projectId); }
    finally { setDeletingId(null); }
  };

  return (
    <div className={styles.switcherWrap}>
      {isRenaming && currentProject ? (
        <form
          className={styles.renameForm}
          onSubmit={(e) => { e.preventDefault(); void commitRename(); }}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void commitRename(); }}
        >
          <input
            ref={renameInputRef}
            type="text"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancelRenaming(); } }}
            disabled={renaming}
            maxLength={120}
            aria-label="Rename project"
            className={styles.renameInput}
          />
          <button
            type="submit"
            disabled={renaming || !renameDraft.trim()}
            onMouseDown={(e) => e.preventDefault()}
            title="Save name (Enter)"
            aria-label="Save project name"
            className={`${styles.iconBtn} ${styles.renameConfirm}`}
          >
            {renaming ? <Loader2 size={14} className={styles.spin} /> : <Check size={14} />}
          </button>
          <button
            type="button"
            disabled={renaming}
            onMouseDown={(e) => e.preventDefault()}
            onClick={cancelRenaming}
            title="Cancel (Esc)"
            aria-label="Cancel rename"
            className={styles.iconBtn}
          >
            <X size={14} />
          </button>
        </form>
      ) : (
        <>
          <HelpTip side="bottom" title="Project Workspace" content="Switch between saved remixes, start a new project, or double-click the title to rename.">
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              onDoubleClick={(e) => { e.stopPropagation(); startRenaming(); }}
              className={styles.switcherTrigger}
            >
              <span className={styles.switcherName}>{currentProject?.name ?? 'Select Project'}</span>
              <ChevronDown size={14} />
            </button>
          </HelpTip>
          {currentProject && (
            <HelpTip side="bottom" content="Give this remix project a memorable name.">
              <button type="button" onClick={startRenaming} aria-label="Rename remix project" className={styles.iconBtn}>
                <Pencil size={14} />
              </button>
            </HelpTip>
          )}
        </>
      )}

      <Popover anchorRef={triggerRef} open={menuOpen} onClose={() => setMenuOpen(false)} width={320} align="start" ariaLabel="Projects menu" className={styles.popoverBody}>
        <form onSubmit={(e) => void handleCreate(e)} className={styles.createForm}>
          <div className={styles.createInputWrap}>
            <FolderPlus size={14} className={styles.createInputIcon} />
            <input type="text" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} maxLength={120} placeholder="New project name..." aria-label="New project name" className={styles.createInput} />
          </div>
          <button type="submit" disabled={!newProjectName.trim() || creating} className={styles.createBtn}>
            {creating ? <Loader2 size={14} className={styles.spin} /> : <Plus size={14} />} New
          </button>
        </form>
        <div className={styles.projectList}>
          {projects.length === 0 ? (
            <div className={styles.emptyState}>No projects yet. Create one above.</div>
          ) : (
            projects.map((proj) => {
              const active = proj.id === currentProject?.id;
              return (
                <div
                  key={proj.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => { void selectProject(proj.id); setMenuOpen(false); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void selectProject(proj.id); setMenuOpen(false); } }}
                  className={`${styles.projectRow} ${active ? styles.projectRowActive : ''}`}
                >
                  <div className={styles.projectRowMain}>
                    <div className={styles.projectTitleRow}>
                      <span className={`${styles.statusDot} ${active ? styles.statusDotActive : ''}`} />
                      <span className={styles.projectRowName}>{proj.name}</span>
                    </div>
                    <div className={styles.projectMeta}>
                      {proj.has_main_track ? 'Track loaded' : 'No track'} · {proj.reference_count} refs · {proj.edit_count} edits
                    </div>
                  </div>
                  <button type="button" title="Delete project" aria-label={`Delete ${proj.name}`} onClick={(e) => void handleDelete(e, proj.id)} disabled={deletingId === proj.id} className={styles.deleteBtn}>
                    {deletingId === proj.id ? <Loader2 size={14} className={styles.spin} /> : <Trash2 size={14} />}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </Popover>
    </div>
  );
};
