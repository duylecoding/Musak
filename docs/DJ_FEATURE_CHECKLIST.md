# Musak — DJ & Solo-Remix Feature Checklist ("Cursor for Music")

> **Core Principle:** A beginner should be able to open Musak and craft a solid, fun remix completely on their own—without ever being forced to talk to Gemini. Gemini is an optional co-pilot that accelerates your workflow, never a gatekeeper.

## Audit Summary (Current v0.3 Baseline)
- **Already strong solo:** 4-stem auto-separation, live Mute/Solo/Volume mixer + bake to remix, beat-snapped per-lane selection, draggable/resizable timeline blocks, 6 built-in BPM-synced transition SFX, Reference Shelf with BPM/Key Match badges, and Master Polish + Stem ZIP exports.
- **Biggest parity gaps found:** Manual borrowing always grabs `0:00` with no auto-ducking; placed FX blocks can't be tweaked manually (and low-pass sweeps are missing); no fade-in/fade-out envelopes; no duplicate/loop-extend; no cut/repeat arrangement; per-stem pitch hidden in UI; BPM/Key read-only; track bookmarks require Gemini; no real audio vinyl tape-stop or beat stutter.

---

## Prioritized Delivery Checklist (One Feature at a Time)

- [x] **1. Pick Reference Timestamp Slice & Auto-Duck Main Stems When Borrowing** (`Medium`)
  - **Why:** Borrowing a reference song should grab the exact hook/drop you pinned—not always `0:00–0:08`—and cleanly duck clashing main vocals or drums underneath.
  - **Deliverables:**
    - Add **"Drop on Timeline"** button directly on every Pinned Moment in `ReferenceShelf.tsx`.
    - Add source slice controls (`Moment` picker or `Start / End`), **Auto-Duck Main (`None / Vocals / Drums / Instrumental / All`)**, and **Match BPM / Match Key** toggles in `+ Add Sound Layer` & the Clip Popover (backed by `PATCH /edits/{edit_id}`).

- [x] **2. Low-Pass ("Underwater") Filter Sweeps & Manual Clip FX Tweaker** (`Medium`)
  - **Why:** Classic DJ transitions rely on both rising high-pass AND muffled low-pass sweeps, and users must be able to dial echo speed, reverb tail, filter direction, or lo-fi grit by ear without re-prompting Gemini.
  - **Deliverables:**
    - Add **Low-Pass ("Underwater")** sweep and **Sweep Up / Down** options to the Floating Segment Bar's FX menu.
    - Extend `PATCH /api/projects/{id}/edits/{edit_id}` to accept safe FX param updates (`wet_level`, `room_size`, `delay_beats`, `feedback`, `mix`, `mode`, `start_hz`, `end_hz`, `drive_db`, `cutoff_hz`) + Clip Rename (`title`).
    - Render 1–3 plain-English sliders/pills inside the Clip Popover matching the selected block's effect type.

- [x] **3. Fade-In, Fade-Out & Smooth Crossfade Envelopes** (`Medium`)
  - **Why:** Clean remixes need smooth vocal fade-ins, outro fade-outs, and gentle entries/exits on borrowed clips and SFX rather than abrupt 25ms edges.
  - **Deliverables:**
    - Add asymmetric `fade_in_ms` / `fade_out_ms` (plus `fade_in` / `fade_out` ramp curves) in `dsp.py` for `stem_gain`, `borrow_stem`, and `add_sfx`.
    - Add **Fade In** and **Fade Out** buttons in the Floating Segment Bar's Volume menu and quick `Fade In / Out` pills (`None / 0.5s / 1s / 2s / 4s`) in the Clip Popover.

- [x] **4. Duplicate Clip (`Ctrl+D`) & Loop-Extend Borrowed Clips** (`Small`)
  - **Why:** Once a riser or 4-bar reference drum break hits right, you want to clone it onto Drop 2 in one click or drag its right edge to seamlessly tile the loop across 16 bars.
  - **Deliverables:**
    - Add **Duplicate** button (`Ctrl+D` shortcut) in the Clip Popover cloning the block cleanly to the playhead (or immediately after the clip).
    - Add `loop_to_fit: bool` on `borrow_stem` (`models.py` + `dsp.py`) with a **"Loop to Fit"** toggle in the Clip Popover so resizing wider tiles the beat cleanly instead of padding silence.

- [x] **5. Non-Destructive Arrangement: Cut Out Section & Repeat Section (`×2`)** (`Medium`)
  - **Why:** Real remixing includes trimming a slow intro, cutting a weak bridge, or doubling a great 8-bar drop—while keeping Undo/Redo intact.
  - **Deliverables:**
    - Add non-destructive `cut_section` and `repeat_section` operations in `dsp.py` (beat-snapped splice with smooth short crossfade).
    - Expose **Cut Out** and **Repeat ×2** actions in the Floating Segment Bar when selecting across `All Stems` (or clicking a Section pill).

- [x] **6. Per-Stem Speed & Pitch Targeting (Full `±12 st` / `0.5x–1.6x` Range)** (`Small`)
  - **Why:** Pitching just the vocals (deep drop or pitched-up hook) while keeping drums punchy is already supported in `dsp.py`—it just needs to be exposed in the UI.
  - **Deliverables:**
    - Add **Target Lane** chips (`All / Vocals / Drums / Bass / Melody`), Reverb Wet slider, and expanded `±12 st` / `0.5x–1.6x` range in the Speed & Pitch popover (auto-selecting the active lane if a lane selection exists).

- [x] **7. Clickable BPM (`÷2`, `×2`, Manual Override), Key Override & Metronome Click** (`Medium`)
  - **Why:** If auto-detection guesses half/double BPM (70 vs 140), Beat Snap, `4/8 Bars`, `Snare Roll`, `Echo Out`, and tempo-matched mashups drift off-grid.
  - **Deliverables:**
    - Add `PATCH /api/projects/{id}/main-track/meta` to override BPM (rebuilding beat grid & compatibility scores) and Key.
    - Make BPM & Key badges clickable popovers with `÷2`, `×2`, and manual inputs, plus a subtle **Click / Metronome** toggle next to Beat Snap.

- [x] **8. Manual Main-Track Cue Markers (`M` Shortcut — Zero-AI Navigation)** (`Small`)
  - **Why:** DJs drop quick hot-cues ("Vocal In", "Drop 1", "Switch") to jump instantly around a 3–4 minute track without needing a Gemini API key.
  - **Deliverables:**
    - Add `cues` list on `MainTrack` with add/rename/delete endpoints.
    - Add a **Drop Cue (`M`)** button on the transport bar rendering clickable color-coded cue flags on the timeline ruler (click to jump, Shift+click two cues to select the span between them).

- [x] **9. 1-Click DJ Moves: Beat-Repeat Stutter, Real Track Vinyl Brake & Buildup Recipes** (`Medium`)
  - **Why:** Beginners love iconic DJ moves ("stutter the beat into the drop", "slow the actual song to a vinyl stop", "classic 4-bar club buildup") without manually stacking 3 blocks.
  - **Deliverables:**
    - Implement `beat_repeat` (stutter `1/2`, `1/4`, `1/8` beat) and real audio `tape_stop` (actually braking the track/stem audio!) in `dsp.py`.
    - Add a **DJ Moves** group in the Floating Bar's FX menu (*Club Buildup*, *Beat Stutter*, *Real Vinyl Stop*, *Echo Freeze*) emitting standard editable blocks.
