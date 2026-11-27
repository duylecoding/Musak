//! Fast stereo f32 WAV decoding and linear resampling into immutable `Arc<AudioBuffer>`s.

use std::path::Path;
use std::sync::Arc;

use hound::{SampleFormat, WavReader};

/// Interleaved stereo `[L0, R0, L1, R1, ...]` f32 audio buffer at a fixed sample rate.
#[derive(Debug, Clone)]
pub struct AudioBuffer {
    pub sample_rate: u32,
    pub frames: usize,
    pub samples: Vec<f32>,
}

impl AudioBuffer {
    pub fn from_stereo(sample_rate: u32, samples: Vec<f32>) -> Self {
        let frames = samples.len() / 2;
        Self {
            sample_rate,
            frames,
            samples,
        }
    }

    #[inline]
    pub fn frame(&self, idx: usize) -> (f32, f32) {
        if idx >= self.frames {
            return (0.0, 0.0);
        }
        let base = idx * 2;
        (self.samples[base], self.samples[base + 1])
    }
}

/// Decode a WAV file (PCM 16/24/32 or IEEE f32, mono/stereo/multi-channel) and resample to `target_sr`.
pub fn load_wav_resampled(path: &Path, target_sr: u32) -> Result<Arc<AudioBuffer>, String> {
    let mut reader = WavReader::open(path)
        .map_err(|e| format!("Failed to open WAV '{}': {e}", path.display()))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let src_sr = spec.sample_rate.max(1);

    let raw: Vec<f32> = match (spec.sample_format, spec.bits_per_sample) {
        (SampleFormat::Float, _) => reader
            .samples::<f32>()
            .map(|s| s.unwrap_or(0.0))
            .collect(),
        (SampleFormat::Int, bits) => {
            let max_val = ((1_i64 << (bits.saturating_sub(1).min(31))) as f32).max(1.0);
            reader
                .samples::<i32>()
                .map(|s| (s.unwrap_or(0) as f32) / max_val)
                .collect()
        }
    };

    let src_frames = raw.len() / channels;
    let mut stereo = Vec::with_capacity(src_frames * 2);
    for f in 0..src_frames {
        let base = f * channels;
        let l = raw[base];
        let r = if channels >= 2 { raw[base + 1] } else { l };
        stereo.push(if l.is_finite() { l } else { 0.0 });
        stereo.push(if r.is_finite() { r } else { 0.0 });
    }

    if src_sr == target_sr || src_frames <= 1 {
        return Ok(Arc::new(AudioBuffer::from_stereo(target_sr, stereo)));
    }

    let ratio = (target_sr as f64) / (src_sr as f64);
    let dst_frames = ((src_frames as f64) * ratio).round().max(1.0) as usize;
    let mut resampled = Vec::with_capacity(dst_frames * 2);
    let inv_ratio = (src_sr as f64) / (target_sr as f64);

    for i in 0..dst_frames {
        let src_pos = (i as f64) * inv_ratio;
        let i0 = (src_pos.floor() as usize).min(src_frames - 1);
        let i1 = (i0 + 1).min(src_frames - 1);
        let frac = (src_pos - (i0 as f64)) as f32;
        let b0 = i0 * 2;
        let b1 = i1 * 2;
        let l = stereo[b0] + (stereo[b1] - stereo[b0]) * frac;
        let r = stereo[b0 + 1] + (stereo[b1 + 1] - stereo[b0 + 1]) * frac;
        resampled.push(l);
        resampled.push(r);
    }

    Ok(Arc::new(AudioBuffer::from_stereo(target_sr, resampled)))
}
