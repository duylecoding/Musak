"""One-click auto-mashup EditBlock construction logic."""

from __future__ import annotations

from fastapi import HTTPException

from musak.audio_analysis import semitone_diff_between_keys
from musak.config import STEM_NAMES
from musak.models import EditBlock, EditOperation, MashupRequest, ProjectState
from musak.routers.deps import store
from musak.storage import generate_id, utc_now_iso


def build_mashup_edit(project_id: str, project: ProjectState, body: MashupRequest) -> EditBlock:
    """Resolve mashup mode and build the non-destructive `EditBlock` for `body.ref_id`."""
    if project.main_track is None:
        raise HTTPException(status_code=400, detail="Upload a main track before creating a mashup.")

    ref = next((r for r in project.references if r.id == body.ref_id), None)
    if ref is None:
        raise HTTPException(status_code=404, detail=f"Reference '{body.ref_id}' not found.")

    mt = project.main_track
    duration = mt.duration

    if body.start is not None or body.end is not None:
        m_start = max(0.0, min(float(body.start if body.start is not None else 0.0), duration))
        m_end = max(m_start, min(float(body.end if body.end is not None else duration), duration))
        if m_end <= m_start:
            raise HTTPException(status_code=400, detail="Mashup end time must be greater than start time.")
    elif mt.sections:
        best_sec = max(mt.sections, key=lambda s: (s.label in ("Drop", "Chorus"), s.energy))
        m_start, m_end = best_sec.start, best_sec.end
    else:
        m_start, m_end = 0.0, min(duration, 16.0)

    span = max(0.5, m_end - m_start)
    ref_dur = max(0.5, float(ref.duration or span))
    if ref.moments:
        ref_start = max(0.0, min(float(ref.moments[0].start), max(0.0, ref_dur - 0.5)))
        ref_end = min(ref_dur, max(ref_start + 0.5, float(ref.moments[0].end)))
    else:
        ref_start, ref_end = 0.0, min(ref_dur, span)

    ref_audio_ok = ref.audio_downloaded and store.reference_audio_path(project_id, ref.id).is_file()
    ref_stems_ok = ref.stems_status == "ready" and all(
        store.reference_stem_path(project_id, ref.id, s).is_file() for s in STEM_NAMES
    )
    main_stems_ok = mt.stems_status == "ready" and all(
        store.main_stem_path(project_id, s).is_file() for s in STEM_NAMES
    )

    mode = body.mode
    if mode == "smart_auto":
        if ref_stems_ok:
            semi_dist = abs(semitone_diff_between_keys(ref.key, mt.key)) if (ref.key and mt.key) else 0
            mode = "ref_drums_on_main" if (semi_dist >= 4 and main_stems_ok) else "ref_vocals_on_main"
        elif main_stems_ok and ref_audio_ok:
            mode = "main_vocals_on_ref"
        elif ref_audio_ok:
            mode = "full_blend"  # type: ignore[assignment]
        else:
            raise HTTPException(
                status_code=400,
                detail="Extract stems (or download audio) on this reference first to create a mashup.",
            )

    def _borrow(
        ref_stem: str,
        replace: list[str],
        match_key: bool = True,
    ) -> EditOperation:
        return EditOperation(
            type="borrow_stem",
            ref_id=ref.id,
            ref_stem=ref_stem,  # type: ignore[arg-type]
            ref_start=round(ref_start, 3),
            ref_end=round(ref_end, 3),
            target_start=round(m_start, 3),
            target_end=round(m_end, 3),
            replace_main_stems=replace,
            match_bpm=True,
            match_key=match_key,
            snap_to_beat=True,
        )

    ops: list[EditOperation] = []
    if mode == "ref_vocals_on_main":
        if not ref_stems_ok:
            raise HTTPException(status_code=400, detail="Extract stems on this reference first to mash up its vocals.")
        title = f"Mashup: {ref.title} Vocals"
        desc = f"BPM- & key-matched vocals from '{ref.title}' blended over your track."
        ops.append(_borrow("vocals", ["vocals"]))
        if main_stems_ok:
            ops.append(
                EditOperation(
                    type="stem_gain",
                    stems=["other"],
                    start=round(m_start, 3),
                    end=round(m_end, 3),
                    gain_db=-2.0,
                    fade_ms=40.0,
                    snap_to_beat=True,
                )
            )
    elif mode == "main_vocals_on_ref":
        if not main_stems_ok:
            raise HTTPException(
                status_code=400,
                detail="Separate stems on your main track first to keep your vocals over the reference.",
            )
        if not ref_audio_ok:
            raise HTTPException(
                status_code=400,
                detail="Download or extract stems on this reference first to use its instrumental.",
            )
        title = f"Mashup: Your Vocals × {ref.title}"
        desc = f"Your isolated vocals riding over '{ref.title}' matched to your BPM & key."
        ops.append(
            EditOperation(
                type="stem_gain",
                stems=["drums", "bass", "other"],
                start=round(m_start, 3),
                end=round(m_end, 3),
                gain_db=-80.0,
                fade_ms=40.0,
                snap_to_beat=True,
            )
        )
        if ref_stems_ok:
            for stem_name in ("drums", "bass", "other"):
                ops.append(_borrow(stem_name, [], match_key=(stem_name != "drums")))
        else:
            ops.append(_borrow("full", []))
    elif mode == "ref_drums_on_main":
        if not ref_stems_ok:
            raise HTTPException(status_code=400, detail="Extract stems on this reference first to swap in its drums.")
        title = f"Mashup: {ref.title} Drums"
        desc = f"BPM-synced drums from '{ref.title}' driving your track."
        ops.append(_borrow("drums", ["drums"], match_key=False))
    else:
        title = f"Mashup Blend: {ref.title}"
        desc = f"BPM- & key-matched blend from '{ref.title}' layered into your track."
        ops.append(_borrow("full", ["other"]))

    return EditBlock(
        id=generate_id("edit"),
        title=title[:120],
        description=desc[:300],
        start=round(m_start, 3),
        end=round(m_end, 3),
        enabled=True,
        operations=ops,
        created_at=utc_now_iso(),
    )
