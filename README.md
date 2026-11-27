# Musak

Native Windows music remixing studio built with **Tauri v2**, a lock-free **Rust real-time audio engine (`musak-audio`)**, **React + CSS Modules**, and a slim local **Python CUDA sidecar** (Demucs stems, Rubber Band time/pitch stretching, `yt-dlp`, mastering exports, and optional Gemini AI co-pilot).

## Architecture
- **`src-tauri/crates/musak-audio/`**: Lock-free real-time multi-track audio engine (`cpal` WASAPI output, `arc-swap` atomic timeline hot-swapping, `hound` WAV loader, real-time sidechain pump, Freeverb reverb, biquad filter sweeps, stereo widening, decoupled main-stem mute/solo + extra layers).
- **`src-tauri/`**: Tauri v2 desktop shell (~7.7 MB native Windows binary with embedded frontend) + automatic Python sidecar lifecycle management.
- **`frontend/`**: Modular React + TypeScript + semantic CSS Modules multi-track timeline (`Vocals`, `Drums`, `Bass`, `Melody`, draggable track-label column, 1×–16× zoom, clip drag/resize, cue markers, sound & reference layers, collapsible Gemini side panel).
- **`backend/`**: Local FastAPI sidecar on `127.0.0.1:8765` handling GPU stem separation (Demucs/CUDA), YouTube oEmbed/`yt-dlp`, harmonic CQT key/BPM analysis, Rubber Band clip preparation (`/engine-manifest`), mastered WAV/MP3/stems-ZIP export, and optional Gemini Producer Chat & voice transcription.

## Quick Start (Windows)

### Launch the Native App
Double-click `start-musak.bat` in the repo root (or run `src-tauri\target\release\musak.exe`). The app automatically starts the local Python CUDA sidecar and shuts it down on exit.

### Build from Source
```powershell
# 1. Build frontend bundle (embedded into musak.exe)
cd C:\Users\duyle\Documents\vscode\Musak\frontend
& "C:\Program Files\nodejs\npm.cmd" run build

# 2. Build native Tauri + Rust release binary
cd C:\Users\duyle\Documents\vscode\Musak\src-tauri
cargo build --release --bin musak
```

### Optional Gemini AI Setup
Musak works fully standalone without an API key, and the Gemini side panel can be hidden from the top bar. To enable Gemini Producer Chat, Voice input, or Lyric Hooks:
1. Create a key at https://aistudio.google.com/apikey
2. Open **Settings** (gear icon) in Musak and paste your key (held in local backend memory only).

## Tests & Verification
```powershell
# Rust real-time audio engine tests
cd C:\Users\duyle\Documents\vscode\Musak\src-tauri
cargo test -p musak-audio

# Backend tests
& "C:\Users\duyle\Documents\vscode\Musak\backend\.venv\Scripts\pytest.exe" -q "C:\Users\duyle\Documents\vscode\Musak\backend\tests"

# Frontend typecheck, unit/component tests & production build
cd C:\Users\duyle\Documents\vscode\Musak\frontend
& "C:\Program Files\nodejs\npm.cmd" run typecheck
& "C:\Program Files\nodejs\npm.cmd" test
& "C:\Program Files\nodejs\npm.cmd" run build
```
