# Musak

Local Windows AI-assisted music remixing studio powered by **Gemini**, **Demucs (CUDA GPU)**, **Pedalboard**, and **WaveSurfer**.

## Features
- **Reference Shelf (Inspiration Board):** Add local MP3/WAV files or paste public YouTube URLs. Play embedded YouTube previews, pin standout moments (manually or with Gemini **Auto-Tag**), and extract stems on demand.
- **Main Track Canvas:** Auto-detects BPM, musical key, beat grid, and song sections (`Intro`, `Verse`, `Buildup`, `Drop`, `Chorus`, `Outro`). Drag to highlight any moment, toggle **Before (Original) / After (Remix)** A/B playback, inspect collapsible 4-stem lanes (`Vocals`, `Drums`, `Bass`, `Other`), Undo/Redo, and export WAV/MP3.
- **Gemini Producer Chat:** Highlight a moment, attach `@Reference` tracks, and describe the vibe in plain English. Gemini listens to your clip + YouTube/audio references and returns 2–3 clickable **Preview / Apply** options (both *Style Match* on your stems and *Mashup* borrowing tempo/key-matched reference stems).
- **Private & Local-First:** Your Gemini API key is encrypted by Windows DPAPI (`safeStorage`) outside the repository (`%APPDATA%\musak-frontend\gemini_key.enc`) and never committed to git.

## Quick Start (Windows)

### Launch the Desktop App
Double-click `start-musak.bat` in the repo root, or run in PowerShell:
```powershell
cd C:\Users\duyle\Documents\vscode\Musak\frontend
& ".\node_modules\.bin\electron.cmd" .
```
Electron automatically starts the local Python audio backend (`backend/.venv`) and stops it when you close the app.

### Development Mode (Hot Reload)
```powershell
# Terminal 1 — Python backend
C:\Users\duyle\Documents\vscode\Musak\backend\.venv\Scripts\python.exe C:\Users\duyle\Documents\vscode\Musak\backend\run_server.py

# Terminal 2 — Vite + Electron
cd C:\Users\duyle\Documents\vscode\Musak\frontend
& "C:\Program Files\nodejs\npm.cmd" run dev
```

### Setting Your Gemini API Key
1. Get a free Google AI Studio key at https://aistudio.google.com/apikey (no credit card required for the free tier; Google AI Pro subscribers can also claim monthly developer credits).
2. Click **Settings** (gear icon) in Musak and paste your key.

## Tests & Verification
```powershell
# Backend tests
& "C:\Users\duyle\Documents\vscode\Musak\backend\.venv\Scripts\pytest.exe" -v "C:\Users\duyle\Documents\vscode\Musak\backend\tests"

# Frontend typecheck & production build
cd C:\Users\duyle\Documents\vscode\Musak\frontend
& "C:\Program Files\nodejs\npm.cmd" run typecheck
& "C:\Program Files\nodejs\npm.cmd" run build
```
