//! Tauri IPC command handlers exposing the lock-free Rust real-time audio engine to React.

use tauri::State;

use musak_audio::engine::{AudioEngine, EngineManifestInput, TransportState};
use musak_audio::graph::{AbMode, EditBlockInput, StemMixerInput};

#[tauri::command]
pub fn audio_load_manifest(
    engine: State<'_, AudioEngine>,
    manifest: EngineManifestInput,
    edits: Vec<EditBlockInput>,
    ab_mode: AbMode,
    stem_mixer: Option<StemMixerInput>,
) -> Result<TransportState, String> {
    engine.load_manifest(manifest, edits, ab_mode, stem_mixer)
}

#[tauri::command]
pub fn audio_sync_timeline(
    engine: State<'_, AudioEngine>,
    edits: Vec<EditBlockInput>,
    ab_mode: AbMode,
    stem_mixer: StemMixerInput,
    loop_range: Option<(f64, f64)>,
) -> TransportState {
    engine.sync_timeline(edits, ab_mode, stem_mixer, loop_range)
}

#[tauri::command]
pub fn audio_set_stem_mixer(engine: State<'_, AudioEngine>, stem_mixer: StemMixerInput) {
    engine.set_stem_mixer(stem_mixer);
}

#[tauri::command]
pub fn audio_play(engine: State<'_, AudioEngine>, start_secs: Option<f64>) -> TransportState {
    engine.play(start_secs)
}

#[tauri::command]
pub fn audio_pause(engine: State<'_, AudioEngine>) -> TransportState {
    engine.pause()
}

#[tauri::command]
pub fn audio_seek(engine: State<'_, AudioEngine>, secs: f64) -> TransportState {
    engine.seek(secs)
}

#[tauri::command]
pub fn audio_transport_state(engine: State<'_, AudioEngine>) -> TransportState {
    engine.transport_state()
}
