"""Edits, proposal apply/tune, undo/redo history, and mix export routes."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse

from musak.dsp import export_mix, render_proposal_preview
from musak.models import (
    CreateEditRequest,
    DuplicateEditRequest,
    EditBlock,
    ExportRequest,
    ProjectState,
    TuneProposalRequest,
    UpdateEditRequest,
)
from musak.routers.deps import (
    NO_STORE_HEADERS,
    _enrich_project,
    _find_proposal,
    _mutate_and_render,
    _sync_proposal_applied_flags,
    store,
)
from musak.routers.edit_patch import apply_patch_to_edit, apply_proposal_tune_fields, build_duplicated_edit
from musak.storage import generate_id, utc_now_iso, validate_id

logger = logging.getLogger(__name__)
router = APIRouter(tags=["edits"])


@router.post("/api/projects/{project_id}/edits", response_model=ProjectState)
def create_edit(project_id: str, body: CreateEditRequest, skip_render: bool = False) -> ProjectState:
    validate_id(project_id, "project_id")
    if store.get_project(project_id).main_track is None:
        raise HTTPException(status_code=400, detail="Upload a main track before adding edits.")

    edit = EditBlock(
        id=generate_id("edit"),
        title=body.title.strip(),
        description=body.description.strip(),
        start=round(body.start, 3),
        end=round(body.end, 3),
        enabled=True,
        operations=body.operations,
        created_at=utc_now_iso(),
    )

    def _apply(proj: ProjectState) -> bool:
        if proj.main_track is None:
            raise HTTPException(status_code=400, detail="Upload a main track before adding edits.")
        proj.edits.append(edit)
        proj.redo_stack.clear()
        return True

    return _mutate_and_render(project_id, _apply, skip_render=skip_render)


@router.post("/api/projects/{project_id}/edits/apply-proposal/{proposal_id}", response_model=ProjectState)
def apply_proposal(project_id: str, proposal_id: str) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(proposal_id, "proposal_id")
    project = store.get_project(project_id)
    if project.main_track is None:
        raise HTTPException(status_code=400, detail="Upload a main track before applying proposals.")
    if _find_proposal(project, proposal_id) is None:
        raise HTTPException(status_code=404, detail=f"Proposal '{proposal_id}' not found.")

    def _apply(proj: ProjectState) -> bool:
        prop = _find_proposal(proj, proposal_id)
        if prop is None:
            raise HTTPException(status_code=404, detail=f"Proposal '{proposal_id}' not found.")
        proj.edits.append(
            EditBlock(
                id=generate_id("edit"),
                title=prop.title,
                description=prop.summary,
                start=prop.start,
                end=prop.end,
                enabled=True,
                operations=list(prop.operations),
                created_at=utc_now_iso(),
                source_proposal_id=prop.id,
            )
        )
        proj.redo_stack.clear()
        prop.applied = True
        return True

    return _mutate_and_render(project_id, _apply)


@router.post("/api/projects/{project_id}/proposals/{proposal_id}/tune", response_model=ProjectState)
def tune_proposal(project_id: str, proposal_id: str, body: TuneProposalRequest) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(proposal_id, "proposal_id")

    with store.get_render_lock(project_id):
        working = store.get_project(project_id)
        if working.main_track is None:
            raise HTTPException(status_code=400, detail="Upload a main track before tuning proposals.")

        prop = _find_proposal(working, proposal_id)
        if prop is None:
            raise HTTPException(status_code=404, detail=f"Proposal '{proposal_id}' not found.")
        apply_proposal_tune_fields(working, prop, body)

        try:
            render_proposal_preview(store, working, prop, nonce=generate_id("t"))
        except Exception as exc:
            logger.exception("Preview re-render failed while tuning proposal %s", proposal_id)
            raise HTTPException(status_code=500, detail=f"Preview rendering failed: {exc}") from exc

        updated_prop = prop.model_copy(deep=True)

        def _save_tuned(proj: ProjectState) -> None:
            if (target := _find_proposal(proj, proposal_id)) is None:
                return
            for field in (
                "base_operations", "operations", "intensity", "keep_vocals_clear",
                "shift_beats", "start", "end", "preview_url", "preview_start", "preview_end",
            ):
                setattr(target, field, getattr(updated_prop, field))

        return _enrich_project(store.update_project(project_id, _save_tuned))


@router.patch("/api/projects/{project_id}/edits/{edit_id}", response_model=ProjectState)
def patch_edit(
    project_id: str, edit_id: str, body: UpdateEditRequest, skip_render: bool = False
) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(edit_id, "edit_id")
    if not any(e.id == edit_id for e in store.get_project(project_id).edits):
        raise HTTPException(status_code=404, detail=f"Edit '{edit_id}' not found.")

    def _patch(proj: ProjectState) -> bool:
        target = next((e for e in proj.edits if e.id == edit_id), None)
        if target is None:
            raise HTTPException(status_code=404, detail=f"Edit '{edit_id}' not found.")
        apply_patch_to_edit(proj, target, body)
        return True

    return _mutate_and_render(project_id, _patch, skip_render=skip_render)


@router.post("/api/projects/{project_id}/edits/{edit_id}/duplicate", response_model=ProjectState)
def duplicate_edit(
    project_id: str,
    edit_id: str,
    body: DuplicateEditRequest | None = Body(default=None),
    skip_render: bool = False,
) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(edit_id, "edit_id")
    project = store.get_project(project_id)
    if project.main_track is None:
        raise HTTPException(status_code=400, detail="Upload a main track before duplicating edits.")
    if not any(e.id == edit_id for e in project.edits):
        raise HTTPException(status_code=404, detail=f"Edit '{edit_id}' not found.")

    def _duplicate(proj: ProjectState) -> bool:
        if proj.main_track is None:
            raise HTTPException(status_code=400, detail="Upload a main track before duplicating edits.")
        orig = next((e for e in proj.edits if e.id == edit_id), None)
        if orig is None:
            raise HTTPException(status_code=404, detail=f"Edit '{edit_id}' not found.")
        cloned = build_duplicated_edit(proj, orig, body.start if body is not None else None)
        proj.edits.append(cloned)
        proj.redo_stack.clear()
        return True

    return _mutate_and_render(project_id, _duplicate, skip_render=skip_render)


@router.delete("/api/projects/{project_id}/edits/{edit_id}", response_model=ProjectState)
def delete_edit(project_id: str, edit_id: str, skip_render: bool = False) -> ProjectState:
    validate_id(project_id, "project_id")
    validate_id(edit_id, "edit_id")
    if not any(e.id == edit_id for e in store.get_project(project_id).edits):
        raise HTTPException(status_code=404, detail=f"Edit '{edit_id}' not found.")

    def _delete(proj: ProjectState) -> bool:
        removed = next((e for e in proj.edits if e.id == edit_id), None)
        if removed is None:
            raise HTTPException(status_code=404, detail=f"Edit '{edit_id}' not found.")
        proj.edits = [e for e in proj.edits if e.id != edit_id]
        _sync_proposal_applied_flags(proj, removed.source_proposal_id, False)
        return True

    return _mutate_and_render(project_id, _delete, skip_render=skip_render)


def _step_history(project_id: str, undo: bool, skip_render: bool = False) -> ProjectState:
    validate_id(project_id, "project_id")
    store.get_project(project_id)

    def _mutate(proj: ProjectState) -> bool:
        src, dst = (proj.edits, proj.redo_stack) if undo else (proj.redo_stack, proj.edits)
        if not src:
            return False
        item = src.pop()
        dst.append(item)
        _sync_proposal_applied_flags(proj, item.source_proposal_id, not undo)
        return True

    return _mutate_and_render(project_id, _mutate, skip_render=skip_render)


@router.post("/api/projects/{project_id}/undo", response_model=ProjectState)
def undo_edit(project_id: str, skip_render: bool = False) -> ProjectState:
    return _step_history(project_id, undo=True, skip_render=skip_render)


@router.post("/api/projects/{project_id}/redo", response_model=ProjectState)
def redo_edit(project_id: str, skip_render: bool = False) -> ProjectState:
    return _step_history(project_id, undo=False, skip_render=skip_render)


@router.post("/api/projects/{project_id}/export")
def export_project_mix(project_id: str, body: ExportRequest) -> FileResponse:
    validate_id(project_id, "project_id")
    with store.get_render_lock(project_id):
        project = store.get_project(project_id)
        try:
            out_path = export_mix(store, project, fmt=body.format, target=body.target, master_preset=body.master_preset)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    is_zip = body.target == "stems_zip" or body.format == "zip"
    ext = "zip" if is_zip else ("mp3" if body.format == "mp3" else "wav")
    media_type = "application/zip" if is_zip else ("audio/mpeg" if ext == "mp3" else "audio/wav")
    suffix = "stems" if is_zip else body.target
    safe_base = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in project.name).strip("_") or "musak_mix"
    return FileResponse(path=str(out_path), media_type=media_type, filename=f"{safe_base}_{suffix}.{ext}", headers=NO_STORE_HEADERS)
