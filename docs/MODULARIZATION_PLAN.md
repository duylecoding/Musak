# Musak Modular Architecture & Clean-Code Overhaul Plan

## Problem Statement (Current Line Audit)
Rapid iteration produced unmaintainable monoliths with inline styling soup and zero frontend tests:
- `frontend/src/components/MainCanvas.tsx` — **3,324 lines** (plus 593 lines of unused `StemMixer.tsx` & unused `wavesurfer.js`)
- `frontend/src/components/ReferenceShelf.tsx` — **1,340 lines**
- `frontend/src/components/ProducerChat.tsx` — **1,267 lines**
- `frontend/src/App.tsx` — **912 lines**
- `frontend/src/components/TopBar.tsx` — **716 lines**
- `backend/musak/main.py` — **1,394 lines**
- `backend/musak/dsp.py` — **1,156 lines**

## Design Principles ("30-Person Team Ready")
1. **Strict File Size Ceiling:** Target **< 250 lines** per `.tsx` / `.py` file (single responsibility; no god components or god routers).
2. **Zero CSS-in-JS / Hardcoded Colors in TSX:** Move all colors, radii, spacing, and z-index layers into `frontend/src/styles/tokens.css`, and style every component via co-located **CSS Modules (`*.module.css`)** so TypeScript contains clean structure + logic only.
3. **Feature-Sliced Ownership:** Every feature folder owns its own UI components, hooks, CSS modules, API helpers, and **co-located real tests**—multiple engineers/agents can build sub-features in parallel without merge conflicts.
4. **Small, Real Frontend Tests:** Add `vitest`, `@testing-library/react`, `@testing-library/user-event`, and `jsdom` (devDependencies only) to test real math, state hooks, and component interactions in ~1–2 seconds—alongside all 44 existing backend `pytest` tests.

---

## 1. Frontend Feature-Sliced Layout (`frontend/src/`)

```text
frontend/src/
├── styles/
│   ├── tokens.css                 # Colors, spacing, radii, z-index scale (single source of truth)
│   └── base.css                   # Resets, scrollbars, typography
├── shared/
│   ├── api/
│   │   ├── http.ts                # Timeout-safe fetch + FastAPI 422 error parser (+ http.test.ts)
│   │   └── types.ts               # Shared API contract types
│   ├── components/
│   │   ├── Tooltip/               # Tooltip.tsx + Tooltip.module.css + Tooltip.test.tsx
│   │   └── Popover/               # Reusable viewport-clamped Portal Popover (replaces 5 copies!)
│   └── utils/
│       ├── format.ts              # Time/BPM formatting (+ format.test.ts)
│       └── timelineMath.ts        # Beat snapping, bar lengths, drag/resize math (+ timelineMath.test.ts)
├── state/
│   └── ProjectContext.tsx         # Project state, polling, undo/redo, toast (shrinks App.tsx to ~80 lines)
├── features/
│   ├── topbar/
│   │   ├── TopBar.tsx + TopBar.module.css
│   │   ├── ProjectSwitcher.tsx    # Inline rename, create, switch, delete (+ TopBar.test.tsx)
│   │   └── ExportMenu.tsx         # Master polish + WAV/MP3/Stems ZIP
│   ├── timeline/
│   │   ├── api.ts                 # Track, peaks, edit mutation API calls
│   │   ├── hooks/
│   │   │   ├── usePlaybackEngine.ts   # Main <audio> + synced 4-stem WebAudio + RAF playhead
│   │   │   ├── useLaneSelection.ts    # Beat-snapped per-lane drag selection
│   │   │   └── useClipDrag.ts         # Horizontal nudge & edge resize interactions
│   │   ├── components/
│   │   │   ├── TimelineWorkspace.tsx  # Clean ~150-line orchestrator + TimelineWorkspace.module.css
│   │   │   ├── EmptyTrackState.tsx    # YouTube hero + Shelf picker + Local dropzone
│   │   │   ├── TrackHeader.tsx        # Title, BPM/Key, stem status, Swap/Replace
│   │   │   ├── TransportBar.tsx       # Play/Pause, Loop, A/B, Beat Snap, Zoom
│   │   │   ├── TimelineRuler.tsx      # Time ticks, sections, playhead diamond
│   │   │   ├── LaneWaveform.tsx       # High-DPI Canvas waveform peaks
│   │   │   ├── StemLaneRow.tsx        # Sticky M/S/Vol header + waveform + edit blocks
│   │   │   ├── SoundLayerRow.tsx      # Custom SFX & borrowed layers + Add Layer trigger
│   │   │   ├── ClipBlock.tsx          # Draggable/resizable block (+ ClipBlock.test.tsx)
│   │   │   ├── ClipInspector.tsx      # Toggle, gain, delete popover
│   │   │   ├── SegmentActionBar.tsx   # Floating Mute/Vol/FX/Ask Gemini bar (+ SegmentActionBar.test.tsx)
│   │   │   ├── SpeedPitchPopover.tsx
│   │   │   └── LyricsHooksPopover.tsx
│   ├── library/
│   │   ├── api.ts                 # SFX + Reference Shelf API calls
│   │   ├── LibraryPanel.tsx + LibraryPanel.module.css
│   │   ├── SoundsTab.tsx          # Built-in SFX preview + drop (+ SoundsTab.test.tsx)
│   │   ├── ReferencesTab.tsx
│   │   ├── ReferenceCard.tsx
│   │   ├── MomentPinsList.tsx
│   │   └── MashupMenu.tsx
│   ├── chat/
│   │   ├── api.ts                 # Chat + Voice transcribe API calls
│   │   ├── hooks/useVoiceRecorder.ts  # MediaRecorder + AnalyserNode + clean teardown
│   │   ├── ProducerChat.tsx + ProducerChat.module.css
│   │   ├── ProposalCard.tsx       # Subtle↔Bold slider, tweak chips, preview/apply (+ ProposalCard.test.tsx)
│   │   └── ChatComposer.tsx       # Input, lane/ref chips, mic bar
│   └── settings/
│       ├── api.ts                 # Health, API key, stem device
│       └── SettingsModal.tsx + SettingsModal.module.css
└── App.tsx                        # Clean ~80-line shell mounting providers + 3 panes
```

**Dead code & dependency cleanup:**
- Delete unused `frontend/src/components/StemMixer.tsx` (593 lines).
- Remove unused `wavesurfer.js` and Tailwind CSS utility soup from `frontend/package.json` (switching to pure CSS tokens + CSS Modules, which Vite supports natively out of the box with zero extra plugins!).

---

## 2. Backend Domain-Modular Layout (`backend/musak/`)

```text
backend/musak/
├── main.py                        # Clean ~60-line FastAPI app factory + lifespan + router mounts
├── config.py                      # Paths, GPU/CPU stem device, in-memory API key
├── models.py                      # Pydantic schemas
├── storage.py                     # Thread-safe project persistence & path safety
├── audio_analysis.py              # BPM, key, sections, waveform peaks, compatibility
├── stems.py                       # GPU/CPU Demucs stem worker
├── sfx.py                         # Built-in transition SFX synthesizer
├── youtube.py                     # Instant oEmbed metadata + on-demand yt-dlp
├── gemini_agent.py                # Token-lean Producer Chat, Voice Transcribe, Auto-Tag, Hooks
├── dsp/
│   ├── __init__.py                # Public exports (100% backwards-compatible imports)
│   ├── utils.py                   # Beat snapping, crossfades, soft limiter, audio I/O helpers
│   ├── effects.py                 # stem_gain, filter_sweep, reverb_throw, delay_throw, lofi_eq, bass_boost
│   ├── pitch.py                   # tempo_pitch (full-track & slice)
│   ├── borrow.py                  # borrow_stem (half/double-time BPM & key match)
│   ├── mastering.py               # Master presets (balanced/club/warm) & multi-target/ZIP export
│   ├── tuning.py                  # Deterministic local proposal tuning
│   └── pipeline.py                # _execute_dsp_pipeline, render_project_mix, fast sliced render_proposal_preview
└── routers/
    ├── deps.py                    # Shared store instance, _enrich_project, _mutate_and_render, track installer
    ├── health.py                  # /api/health, /api/settings/*
    ├── projects.py                # /api/projects CRUD + rename
    ├── tracks.py                  # Main track upload/youtube/promote/separate/hooks/peaks/audio streaming
    ├── references.py              # References upload/youtube/moments/auto-tag/extract-stems/mashup
    ├── edits.py                   # Edits CRUD/patch/apply-proposal/tune/undo/redo/export
    ├── sfx.py                     # /api/sfx, /api/sfx/{id}/preview
    └── chat.py                    # /api/projects/{id}/chat, /api/voice/transcribe
```

---

## 3. Dependencies Change (Approval Requested)
- **Add (frontend devDependencies for real testing):** `vitest`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `jsdom`.
- **Remove (unused frontend dependencies):** `wavesurfer.js`, `tailwindcss`, `@tailwindcss/postcss`, `postcss` (replaced by native Vite CSS Modules + `tokens.css`).

---

## 4. Parallel Execution & Verification Plan
Once approved, we execute cleanly in parallel with zero overlap:
1. **Backend Modular Split** (preserve 100% API compatibility; all **44 existing `pytest` tests** must pass untouched!).
2. **Frontend Design Tokens + Shared Primitives + Vitest Setup** (`tokens.css`, `Popover`, `Tooltip`, `timelineMath`, `http.ts`, `ProjectContext`).
3. **Frontend Feature Slices in Parallel** (`topbar`, `timeline`, `library`, `chat`, `settings` — each with its own `*.module.css` and real Vitest tests).
4. **Full Code Review + Size Audit:** Verify every file is clean, readable, and modular, **0** inline CSS-in-JS / hardcoded hex colors in TSX, `pytest` (44+ passed), `vitest run` (all real frontend tests passing), `tsc --noEmit` (0 errors), and `vite build` (clean).
