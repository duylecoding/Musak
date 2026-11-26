"""Project workspace CRUD routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from musak.models import (
    CreateProjectRequest,
    DeleteProjectResponse,
    ProjectListResponse,
    ProjectState,
    RenameProjectRequest,
)
from musak.routers.deps import _enrich_project, store
from musak.stems import recover_project_processing_state
from musak.storage import validate_id

router = APIRouter(tags=["projects"])


@router.get("/api/projects", response_model=ProjectListResponse)
def list_projects() -> ProjectListResponse:
    return ProjectListResponse(projects=store.list_projects())


@router.post("/api/projects", response_model=ProjectState)
def create_project(body: CreateProjectRequest) -> ProjectState:
    try:
        return _enrich_project(store.create_project(body.name))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/projects/{project_id}", response_model=ProjectState)
def get_project(project_id: str) -> ProjectState:
    project = store.get_project(project_id)
    return _enrich_project(recover_project_processing_state(store, project))


@router.patch("/api/projects/{project_id}", response_model=ProjectState)
def rename_project(project_id: str, body: RenameProjectRequest) -> ProjectState:
    validate_id(project_id, "project_id")

    def _rename(proj: ProjectState) -> None:
        proj.name = body.name

    return _enrich_project(store.update_project(project_id, _rename))


@router.delete("/api/projects/{project_id}", response_model=DeleteProjectResponse)
def delete_project(project_id: str) -> DeleteProjectResponse:
    store.delete_project(project_id)
    return DeleteProjectResponse(deleted=True)
