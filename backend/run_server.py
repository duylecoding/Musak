"""Local Uvicorn entrypoint for Musak backend (127.0.0.1:8765 by default)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import uvicorn

_BACKEND_DIR = str(Path(__file__).resolve().parent)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)


def main() -> None:
    port_raw = os.environ.get("MUSAK_PORT", "8765").strip()
    try:
        port = int(port_raw)
    except ValueError:
        port = 8765

    uvicorn.run(
        "musak.main:app",
        host="127.0.0.1",
        port=port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
