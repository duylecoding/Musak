//! Immutable, lock-free `TimelineSnapshot` compiled from Musak's edits and mixer state.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::buffer::AudioBuffer;
use crate::dsp::db_to_gain;

pub const STEM_VOCALS: usize = 0;
pub const STEM_DRUMS: usize = 1;
pub const STEM_BASS: usize = 2;
pub const STEM_OTHER: usize = 3;
pub const STEM_MASK_ALL: u8 = 0b1111;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AbMode {
    Original,
    Remix,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StemChannelInput {
    pub volume: f32,
    pub muted: bool,
    pub solo: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StemMixerInput {
    pub vocals: StemChannelInput,
    pub drums: StemChannelInput,
    pub bass: StemChannelInput,
    pub other: StemChannelInput,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EditOpInput {
    #[serde(rename = "type")]
    pub op_type: String,
    pub stems: Option<Vec<String>>,
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub target_start: Option<f64>,
    pub target_end: Option<f64>,
    pub gain_db: Option<f32>,
    pub fade_ms: Option<f32>,
    pub fade_in_ms: Option<f32>,
    pub fade_out_ms: Option<f32>,
    pub fade_curve: Option<String>,
    pub mode: Option<String>,
    pub start_hz: Option<f32>,
    pub end_hz: Option<f32>,
    pub room_size: Option<f32>,
    pub wet_level: Option<f32>,
    pub delay_beats: Option<f32>,
    pub feedback: Option<f32>,
    pub mix: Option<f32>,
    pub low_cut_hz: Option<f32>,
    pub high_cut_hz: Option<f32>,
    pub cutoff_hz: Option<f32>,
    pub ref_stem: Option<String>,
    pub replace_main_stems: Option<Vec<String>>,
    pub loop_to_fit: Option<bool>,
    pub sfx_id: Option<String>,
    pub division_beats: Option<f32>,
    pub depth: Option<f32>,
    pub width: Option<f32>,
    pub apply_to_layers: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EditBlockInput {
    pub id: String,
    pub enabled: bool,
    pub start: f64,
    pub end: f64,
    pub operations: Vec<EditOpInput>,
}

#[derive(Debug, Clone)]
pub struct CompiledLayer {
    pub buffer: Arc<AudioBuffer>,
    pub start_frame: usize,
    pub end_frame: usize,
    pub gain: f32,
    pub fade_in_frames: usize,
    pub fade_out_frames: usize,
    pub loop_to_fit: bool,
    pub stem_bucket: usize,
    pub duck_mask: u8,
}

#[derive(Debug, Clone)]
pub enum FxKind {
    StemGain {
        gain: f32,
        fade_in: usize,
        fade_out: usize,
        fade_curve: FadeCurve,
    },
    FilterSweep {
        highpass: bool,
        start_hz: f32,
        end_hz: f32,
    },
    LofiEq {
        low_cut_hz: f32,
        high_cut_hz: f32,
    },
    BassBoost {
        gain_db: f32,
        cutoff_hz: f32,
    },
    SidechainPump {
        division_beats: f32,
        depth: f32,
    },
    StereoWash {
        width: f32,
    },
    ReverbThrow {
        wet_level: f32,
        room_size: f32,
    },
    DelayThrow {
        delay_beats: f32,
        feedback: f32,
        mix: f32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FadeCurve {
    None,
    In,
    Out,
    Both,
}

#[derive(Debug, Clone)]
pub struct CompiledFx {
    pub start_frame: usize,
    pub end_frame: usize,
    pub stem_mask: u8,
    pub kind: FxKind,
}

#[derive(Debug, Clone)]
pub struct TimelineSnapshot {
    pub sample_rate: u32,
    pub total_frames: usize,
    pub bpm: f32,
    pub ab_mode: AbMode,
    pub main_buffer: Option<Arc<AudioBuffer>>,
    pub stems: [Option<Arc<AudioBuffer>>; 4],
    pub stem_gains: [f32; 4],
    pub any_stem_solo: bool,
    pub layers: Vec<CompiledLayer>,
    pub fx_regions: Vec<CompiledFx>,
    pub loop_range: Option<(usize, usize)>,
}

impl TimelineSnapshot {
    pub fn empty(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            total_frames: 0,
            bpm: 120.0,
            ab_mode: AbMode::Remix,
            main_buffer: None,
            stems: [None, None, None, None],
            stem_gains: [1.0; 4],
            any_stem_solo: false,
            layers: Vec::new(),
            fx_regions: Vec::new(),
            loop_range: None,
        }
    }
}

pub fn stem_name_to_idx(name: &str) -> Option<usize> {
    match name {
        "vocals" => Some(STEM_VOCALS),
        "drums" => Some(STEM_DRUMS),
        "bass" => Some(STEM_BASS),
        "other" => Some(STEM_OTHER),
        _ => None,
    }
}

pub fn stems_to_mask(stems: Option<&Vec<String>>) -> u8 {
    let Some(list) = stems else {
        return STEM_MASK_ALL;
    };
    if list.is_empty() {
        return STEM_MASK_ALL;
    }
    let mut mask = 0u8;
    for s in list {
        if s == "all" || s == "full" {
            return STEM_MASK_ALL;
        }
        if let Some(i) = stem_name_to_idx(s) {
            mask |= 1u8 << i;
        }
    }
    if mask == 0 { STEM_MASK_ALL } else { mask }
}

pub fn compute_stem_gains(mixer: &StemMixerInput) -> ([f32; 4], bool) {
    let chans = [&mixer.vocals, &mixer.drums, &mixer.bass, &mixer.other];
    let any_solo = chans.iter().any(|c| c.solo);
    let mut out = [1.0_f32; 4];
    for (i, ch) in chans.iter().enumerate() {
        if (any_solo && !ch.solo) || ch.muted {
            out[i] = 0.0;
        } else {
            out[i] = (ch.volume / 100.0).clamp(0.0, 1.5);
        }
    }
    (out, any_solo)
}

pub fn compile_edits(
    edits: &[EditBlockInput],
    clip_map: &HashMap<String, (Arc<AudioBuffer>, usize)>,
    sr: u32,
    total_frames: usize,
) -> (Vec<CompiledLayer>, Vec<CompiledFx>) {
    let sr_f = sr as f64;
    let mut layers = Vec::new();
    let mut fx_regions = Vec::new();

    for edit in edits.iter().filter(|e| e.enabled) {
        for (op_idx, op) in edit.operations.iter().enumerate() {
            let s_sec = if op.op_type == "borrow_stem" {
                op.target_start.or(op.start).unwrap_or(edit.start)
            } else {
                op.start.unwrap_or(edit.start)
            };
            let e_sec = if op.op_type == "borrow_stem" {
                op.target_end.or(op.end).unwrap_or(edit.end)
            } else {
                op.end.unwrap_or(edit.end)
            };
            let s_frame = ((s_sec.max(0.0) * sr_f).round() as usize).min(total_frames);
            let e_frame = ((e_sec.max(0.0) * sr_f).round() as usize).min(total_frames);
            if e_frame <= s_frame {
                continue;
            }

            if op.op_type == "borrow_stem" || op.op_type == "add_sfx" {
                let key = format!("{}:{op_idx}", edit.id);
                if let Some((buf, bucket)) = clip_map.get(&key) {
                    let default_fade = if op.op_type == "borrow_stem" { 30.0 } else { 10.0 };
                    let fi_ms = op.fade_in_ms.unwrap_or(default_fade).clamp(0.0, 4000.0);
                    let fo_ms = op.fade_out_ms.unwrap_or(default_fade).clamp(0.0, 4000.0);
                    let duck_mask = if op.op_type == "borrow_stem" {
                        match op.replace_main_stems.as_ref() {
                            Some(list) if !list.is_empty() => stems_to_mask(Some(list)),
                            _ => 0,
                        }
                    } else {
                        0
                    };
                    layers.push(CompiledLayer {
                        buffer: Arc::clone(buf),
                        start_frame: s_frame,
                        end_frame: e_frame,
                        gain: db_to_gain(op.gain_db.unwrap_or(0.0)),
                        fade_in_frames: ((fi_ms as f64 / 1000.0) * sr_f).round() as usize,
                        fade_out_frames: ((fo_ms as f64 / 1000.0) * sr_f).round() as usize,
                        loop_to_fit: op.loop_to_fit.unwrap_or(false),
                        stem_bucket: *bucket,
                        duck_mask,
                    });
                }
                continue;
            }

            let stem_mask = if op.apply_to_layers == Some(true) {
                STEM_MASK_ALL
            } else {
                stems_to_mask(op.stems.as_ref())
            };
            let kind = match op.op_type.as_str() {
                "stem_gain" => {
                    let def_ms = op.fade_ms.unwrap_or(30.0);
                    let fi = ((op.fade_in_ms.unwrap_or(def_ms).clamp(0.0, 4000.0) as f64 / 1000.0) * sr_f).round() as usize;
                    let fo = ((op.fade_out_ms.unwrap_or(def_ms).clamp(0.0, 4000.0) as f64 / 1000.0) * sr_f).round() as usize;
                    let fc = match op.fade_curve.as_deref() {
                        Some("in") => FadeCurve::In,
                        Some("out") => FadeCurve::Out,
                        Some("both") => FadeCurve::Both,
                        _ => FadeCurve::None,
                    };
                    Some(FxKind::StemGain { gain: db_to_gain(op.gain_db.unwrap_or(0.0)), fade_in: fi, fade_out: fo, fade_curve: fc })
                }
                "filter_sweep" => {
                    let hp = op.mode.as_deref() == Some("highpass");
                    Some(FxKind::FilterSweep {
                        highpass: hp,
                        start_hz: op.start_hz.unwrap_or(if hp { 150.0 } else { 16000.0 }),
                        end_hz: op.end_hz.unwrap_or(if hp { 2400.0 } else { 350.0 }),
                    })
                }
                "lofi_eq" => Some(FxKind::LofiEq {
                    low_cut_hz: op.low_cut_hz.unwrap_or(300.0),
                    high_cut_hz: op.high_cut_hz.unwrap_or(3200.0),
                }),
                "bass_boost" => Some(FxKind::BassBoost {
                    gain_db: op.gain_db.unwrap_or(6.0),
                    cutoff_hz: op.cutoff_hz.unwrap_or(120.0),
                }),
                "sidechain_pump" => Some(FxKind::SidechainPump {
                    division_beats: op.division_beats.unwrap_or(1.0),
                    depth: op.depth.unwrap_or(0.65),
                }),
                "stereo_wash" => Some(FxKind::StereoWash {
                    width: op.width.unwrap_or(1.45),
                }),
                "reverb_throw" => Some(FxKind::ReverbThrow {
                    wet_level: op.wet_level.unwrap_or(0.35),
                    room_size: op.room_size.unwrap_or(0.75),
                }),
                "delay_throw" => Some(FxKind::DelayThrow {
                    delay_beats: op.delay_beats.unwrap_or(0.5),
                    feedback: op.feedback.unwrap_or(0.45),
                    mix: op.mix.unwrap_or(0.4),
                }),
                _ => None,
            };
            if let Some(k) = kind {
                fx_regions.push(CompiledFx { start_frame: s_frame, end_frame: e_frame, stem_mask, kind: k });
            }
        }
    }

    (layers, fx_regions)
}
