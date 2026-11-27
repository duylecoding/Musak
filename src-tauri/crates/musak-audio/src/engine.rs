//! Native `cpal` real-time audio engine with lock-free snapshot hot-swapping and WAV buffer caching.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use serde::{Deserialize, Serialize};

use crate::buffer::{load_wav_resampled, AudioBuffer};
use crate::graph::{
    compile_edits, compute_stem_gains, stem_name_to_idx, AbMode, EditBlockInput, StemMixerInput,
    TimelineSnapshot,
};
use crate::mixer::MixerState;

#[derive(Debug, Clone, Deserialize)]
pub struct PreparedClipInput {
    pub path: String,
    pub stem_bucket: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EngineManifestInput {
    pub project_id: String,
    pub track_id: String,
    pub sample_rate: u32,
    pub duration: f64,
    pub bpm: f32,
    pub main_wav: String,
    pub stems: HashMap<String, String>,
    pub clips: HashMap<String, PreparedClipInput>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TransportState {
    pub playing: bool,
    pub current_time: f64,
    pub duration: f64,
    pub sample_rate: u32,
    pub device_ready: bool,
}

struct LoadedProjectAssets {
    project_id: String,
    track_id: String,
    bpm: f32,
    total_frames: usize,
    main_buffer: Option<Arc<AudioBuffer>>,
    stems: [Option<Arc<AudioBuffer>>; 4],
    clip_map: HashMap<String, (Arc<AudioBuffer>, usize)>,
}

pub struct AudioEngine {
    device_sr: u32,
    device_ready: bool,
    _stream: Option<Stream>,
    snapshot: Arc<ArcSwap<TimelineSnapshot>>,
    playing: Arc<AtomicBool>,
    playhead_frame: Arc<AtomicU64>,
    seek_gen: Arc<AtomicU64>,
    file_cache: Mutex<HashMap<(String, u64, u64), Arc<AudioBuffer>>>,
    loaded: Mutex<Option<LoadedProjectAssets>>,
    last_mixer: Mutex<([f32; 4], bool)>,
    last_ab: Mutex<AbMode>,
    last_edits: Mutex<Vec<EditBlockInput>>,
    last_loop: Mutex<Option<(usize, usize)>>,
}

// `cpal::Stream` is kept alive inside `AudioEngine` (never sent across threads after init).
unsafe impl Send for AudioEngine {}
unsafe impl Sync for AudioEngine {}

impl AudioEngine {
    pub fn new() -> Self {
        let playing = Arc::new(AtomicBool::new(false));
        let playhead_frame = Arc::new(AtomicU64::new(0));
        let seek_gen = Arc::new(AtomicU64::new(0));

        let (device_sr, stream) = Self::open_output_stream(
            Arc::clone(&playing),
            Arc::clone(&playhead_frame),
            Arc::clone(&seek_gen),
        );
        let (sr, snap, opt_stream) = match stream {
            Some((s, snap_arc)) => (device_sr, snap_arc, Some(s)),
            None => (44100, Arc::new(ArcSwap::from_pointee(TimelineSnapshot::empty(44100))), None),
        };

        Self {
            device_sr: sr,
            device_ready: opt_stream.is_some(),
            _stream: opt_stream,
            snapshot: snap,
            playing,
            playhead_frame,
            seek_gen,
            file_cache: Mutex::new(HashMap::new()),
            loaded: Mutex::new(None),
            last_mixer: Mutex::new(([1.0; 4], false)),
            last_ab: Mutex::new(AbMode::Remix),
            last_edits: Mutex::new(Vec::new()),
            last_loop: Mutex::new(None),
        }
    }

    fn open_output_stream(
        playing: Arc<AtomicBool>,
        playhead_frame: Arc<AtomicU64>,
        seek_gen: Arc<AtomicU64>,
    ) -> (u32, Option<(Stream, Arc<ArcSwap<TimelineSnapshot>>)>) {
        let host = cpal::default_host();
        let Some(device) = host.default_output_device() else {
            return (44100, None);
        };
        let Ok(default_cfg) = device.default_output_config() else {
            return (44100, None);
        };
        let sr = default_cfg.sample_rate().0;
        let channels = default_cfg.channels().max(1) as usize;
        let snapshot = Arc::new(ArcSwap::from_pointee(TimelineSnapshot::empty(sr)));
        let snap_cb = Arc::clone(&snapshot);
        let cfg: StreamConfig = default_cfg.clone().into();

        let err_fn = |err| eprintln!("[musak-audio] stream error: {err}");
        let mut mixer = MixerState::new(sr);
        let mut last_seek = 0u64;
        let mut scratch: Vec<f32> = Vec::with_capacity(4096);

        let stream_res = match default_cfg.sample_format() {
            SampleFormat::F32 => device.build_output_stream(
                &cfg,
                move |data: &mut [f32], _| {
                    fill_callback(
                        data,
                        channels,
                        &playing,
                        &playhead_frame,
                        &seek_gen,
                        &mut last_seek,
                        &snap_cb,
                        &mut mixer,
                        &mut scratch,
                        |v| v,
                    );
                },
                err_fn,
                None,
            ),
            SampleFormat::I16 => device.build_output_stream(
                &cfg,
                move |data: &mut [i16], _| {
                    fill_callback(
                        data,
                        channels,
                        &playing,
                        &playhead_frame,
                        &seek_gen,
                        &mut last_seek,
                        &snap_cb,
                        &mut mixer,
                        &mut scratch,
                        |v| (v.clamp(-1.0, 1.0) * 32767.0) as i16,
                    );
                },
                err_fn,
                None,
            ),
            _ => return (sr, None),
        };

        let Ok(stream) = stream_res else {
            return (sr, None);
        };
        if stream.play().is_err() {
            return (sr, None);
        }
        (sr, Some((stream, snapshot)))
    }

    fn load_cached(&self, path_str: &str) -> Result<Arc<AudioBuffer>, String> {
        let path = Path::new(path_str);
        let meta = std::fs::metadata(path)
            .map_err(|e| format!("Audio file missing '{}': {e}", path_str))?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let key = (path_str.to_string(), mtime, meta.len());

        if let Ok(cache) = self.file_cache.lock() {
            if let Some(hit) = cache.get(&key) {
                return Ok(Arc::clone(hit));
            }
        }

        let buf = load_wav_resampled(path, self.device_sr)?;
        if let Ok(mut cache) = self.file_cache.lock() {
            if cache.len() > 64 {
                cache.clear();
            }
            cache.insert(key, Arc::clone(&buf));
        }
        Ok(buf)
    }

    pub fn load_manifest(
        &self,
        manifest: EngineManifestInput,
        edits: Vec<EditBlockInput>,
        ab_mode: AbMode,
        stem_mixer: Option<StemMixerInput>,
    ) -> Result<TransportState, String> {
        let main_buf = self.load_cached(&manifest.main_wav)?;
        let mut stems: [Option<Arc<AudioBuffer>>; 4] = [None, None, None, None];
        let mut total_frames = main_buf.frames;

        for (name, p) in &manifest.stems {
            if let Some(idx) = stem_name_to_idx(name) {
                if let Ok(buf) = self.load_cached(p) {
                    total_frames = total_frames.max(buf.frames);
                    stems[idx] = Some(buf);
                }
            }
        }

        let mut clip_map = HashMap::new();
        for (key, entry) in &manifest.clips {
            if let Ok(buf) = self.load_cached(&entry.path) {
                let bucket = stem_name_to_idx(&entry.stem_bucket).unwrap_or(3);
                clip_map.insert(key.clone(), (buf, bucket));
            }
        }

        let track_changed = {
            let guard = self.loaded.lock().unwrap();
            guard
                .as_ref()
                .map(|l| l.project_id != manifest.project_id || l.track_id != manifest.track_id)
                .unwrap_or(true)
        };
        if track_changed {
            self.playing.store(false, Ordering::Release);
            self.playhead_frame.store(0, Ordering::Release);
            self.seek_gen.fetch_add(1, Ordering::AcqRel);
        }

        *self.loaded.lock().unwrap() = Some(LoadedProjectAssets {
            project_id: manifest.project_id,
            track_id: manifest.track_id,
            bpm: manifest.bpm.max(40.0),
            total_frames,
            main_buffer: Some(main_buf),
            stems,
            clip_map,
        });
        *self.last_edits.lock().unwrap() = edits;
        *self.last_ab.lock().unwrap() = ab_mode;
        if let Some(m) = stem_mixer {
            *self.last_mixer.lock().unwrap() = compute_stem_gains(&m);
        }
        self.publish_snapshot();
        Ok(self.transport_state())
    }

    pub fn sync_timeline(
        &self,
        edits: Vec<EditBlockInput>,
        ab_mode: AbMode,
        stem_mixer: StemMixerInput,
        loop_range: Option<(f64, f64)>,
    ) -> TransportState {
        *self.last_edits.lock().unwrap() = edits;
        *self.last_ab.lock().unwrap() = ab_mode;
        *self.last_mixer.lock().unwrap() = compute_stem_gains(&stem_mixer);
        let sr = self.device_sr as f64;
        *self.last_loop.lock().unwrap() = loop_range
            .filter(|(s, e)| *e > *s)
            .map(|(s, e)| ((s.max(0.0) * sr).round() as usize, (e.max(0.0) * sr).round() as usize));
        self.publish_snapshot();
        self.transport_state()
    }

    pub fn set_stem_mixer(&self, stem_mixer: StemMixerInput) {
        *self.last_mixer.lock().unwrap() = compute_stem_gains(&stem_mixer);
        self.publish_snapshot();
    }

    pub fn play(&self, start_secs: Option<f64>) -> TransportState {
        if let Some(sec) = start_secs {
            self.seek(sec);
        }
        self.playing.store(true, Ordering::Release);
        self.transport_state()
    }

    pub fn pause(&self) -> TransportState {
        self.playing.store(false, Ordering::Release);
        self.transport_state()
    }

    pub fn seek(&self, secs: f64) -> TransportState {
        let total = self.snapshot.load().total_frames;
        let frame = ((secs.max(0.0) * (self.device_sr as f64)).round() as usize).min(total);
        self.playhead_frame.store(frame as u64, Ordering::Release);
        self.seek_gen.fetch_add(1, Ordering::AcqRel);
        self.transport_state()
    }

    pub fn transport_state(&self) -> TransportState {
        let snap = self.snapshot.load();
        let sr = self.device_sr.max(1) as f64;
        let cur = self.playhead_frame.load(Ordering::Acquire) as f64;
        TransportState {
            playing: self.playing.load(Ordering::Acquire),
            current_time: cur / sr,
            duration: (snap.total_frames as f64) / sr,
            sample_rate: self.device_sr,
            device_ready: self.device_ready,
        }
    }

    fn publish_snapshot(&self) {
        let loaded_guard = self.loaded.lock().unwrap();
        let Some(assets) = loaded_guard.as_ref() else {
            return;
        };
        let edits = self.last_edits.lock().unwrap().clone();
        let ab_mode = *self.last_ab.lock().unwrap();
        let (stem_gains, any_stem_solo) = *self.last_mixer.lock().unwrap();
        let loop_range = *self.last_loop.lock().unwrap();
        let (layers, fx_regions) =
            compile_edits(&edits, &assets.clip_map, self.device_sr, assets.total_frames);

        self.snapshot.store(Arc::new(TimelineSnapshot {
            sample_rate: self.device_sr,
            total_frames: assets.total_frames,
            bpm: assets.bpm,
            ab_mode,
            main_buffer: assets.main_buffer.clone(),
            stems: assets.stems.clone(),
            stem_gains,
            any_stem_solo,
            layers,
            fx_regions,
            loop_range,
        }));
    }
}

#[allow(clippy::too_many_arguments)]
fn fill_callback<T: Copy>(
    data: &mut [T],
    channels: usize,
    playing: &AtomicBool,
    playhead_frame: &AtomicU64,
    seek_gen: &AtomicU64,
    last_seek: &mut u64,
    snapshot: &ArcSwap<TimelineSnapshot>,
    mixer: &mut MixerState,
    scratch: &mut Vec<f32>,
    convert: fn(f32) -> T,
) {
    let frames = data.len() / channels;
    if !playing.load(Ordering::Acquire) {
        let zero = convert(0.0);
        data.fill(zero);
        return;
    }

    let sg = seek_gen.load(Ordering::Acquire);
    if sg != *last_seek {
        *last_seek = sg;
        mixer.reset();
    }

    let snap = snapshot.load();
    let start_frame = playhead_frame.load(Ordering::Acquire) as usize;
    if snap.total_frames == 0 || start_frame >= snap.total_frames {
        playing.store(false, Ordering::Release);
        data.fill(convert(0.0));
        return;
    }

    if scratch.len() < frames * 2 {
        scratch.resize(frames * 2, 0.0);
    }
    let next_frame = mixer.render_block(&snap, start_frame, &mut scratch[..frames * 2]);
    playhead_frame.store(next_frame as u64, Ordering::Release);
    if next_frame >= snap.total_frames && snap.loop_range.is_none() {
        playing.store(false, Ordering::Release);
    }

    for f in 0..frames {
        let l = scratch[f * 2];
        let r = scratch[f * 2 + 1];
        if channels == 1 {
            data[f] = convert(0.5 * (l + r));
        } else {
            data[f * channels] = convert(l);
            data[f * channels + 1] = convert(r);
            for ch in 2..channels {
                data[f * channels + ch] = convert(0.0);
            }
        }
    }
}
