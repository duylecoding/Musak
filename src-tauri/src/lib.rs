//! Musak Tauri v2 application entry library wiring the real-time audio engine and sidecar.

mod commands;
mod sidecar;

use musak_audio::engine::AudioEngine;
use tauri::Manager;

use crate::sidecar::SidecarManager;

pub fn run() {
    let sidecar = SidecarManager::new();
    sidecar.ensure_started();

    tauri::Builder::default()
        .manage(AudioEngine::new())
        .manage(sidecar)
        .invoke_handler(tauri::generate_handler![
            commands::audio_load_manifest,
            commands::audio_sync_timeline,
            commands::audio_set_stem_mixer,
            commands::audio_play,
            commands::audio_pause,
            commands::audio_seek,
            commands::audio_transport_state,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<AudioEngine>().pause();
                window.state::<SidecarManager>().shutdown();
            }
        })
        .run(tauri::generate_context!())
        .expect("Failed to run Musak Tauri application");
}
