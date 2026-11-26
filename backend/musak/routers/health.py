"""Health check and runtime settings routes."""

from __future__ import annotations

from fastapi import APIRouter

from musak.config import (
    clear_api_key,
    get_cuda_info,
    get_gemini_model,
    get_stem_device,
    is_api_key_configured,
    is_ffmpeg_available,
    set_api_key,
    set_stem_device,
)
from musak.models import (
    ApiKeyRequest,
    ApiKeyStatusResponse,
    HealthResponse,
    StemDeviceRequest,
    StemDeviceResponse,
)

router = APIRouter(tags=["health"])


@router.get("/api/health", response_model=HealthResponse)
def health_check() -> HealthResponse:
    cuda_available, gpu_name = get_cuda_info()
    return HealthResponse(
        status="ok",
        cuda_available=cuda_available,
        gpu_name=gpu_name,
        ffmpeg_available=is_ffmpeg_available(),
        api_key_configured=is_api_key_configured(),
        model=get_gemini_model(),
        stem_device=get_stem_device(),
    )


@router.post("/api/settings/api-key", response_model=ApiKeyStatusResponse)
def configure_api_key(body: ApiKeyRequest) -> ApiKeyStatusResponse:
    return ApiKeyStatusResponse(api_key_configured=set_api_key(body.api_key))


@router.delete("/api/settings/api-key", response_model=ApiKeyStatusResponse)
def remove_api_key() -> ApiKeyStatusResponse:
    clear_api_key()
    return ApiKeyStatusResponse(api_key_configured=False)


@router.post("/api/settings/stem-device", response_model=StemDeviceResponse)
def configure_stem_device(body: StemDeviceRequest) -> StemDeviceResponse:
    return StemDeviceResponse(stem_device=set_stem_device(body.device))
