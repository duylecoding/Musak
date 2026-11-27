//! Lock-free real-time DSP math: envelopes, sidechain pump, biquad filters, stereo width, limiter.

use std::f32::consts::PI;

#[inline]
pub fn db_to_gain(db: f32) -> f32 {
    if db <= -60.0 {
        0.0
    } else {
        10.0_f32.powf(db / 20.0)
    }
}

/// Smooth tanh soft-limiter above 0.95 matching backend `soft_limit`.
#[inline]
pub fn soft_limit(x: f32) -> f32 {
    if !x.is_finite() {
        return 0.0;
    }
    let abs_x = x.abs();
    if abs_x <= 0.95 {
        return x;
    }
    let excess = (abs_x - 0.95) / 0.05;
    let limited = 0.95 + 0.05 * excess.tanh();
    (x.signum() * limited).clamp(-0.998, 0.998)
}

/// Asymmetric cosine crossfade mask `[0..1]` at `pos` inside `[0..len)`.
#[inline]
pub fn cosine_edge_mask(pos: usize, len: usize, fade_in: usize, fade_out: usize) -> f32 {
    if len == 0 {
        return 0.0;
    }
    let fi = fade_in.min(len / 2);
    let fo = fade_out.min(len / 2);
    if fi > 0 && pos < fi {
        let r = (pos as f32) / (fi as f32);
        return 0.5 * (1.0 - (PI * r).cos());
    }
    if fo > 0 && pos >= len.saturating_sub(fo) {
        let tail = pos - (len - fo);
        let r = (tail as f32) / (fo as f32);
        return 0.5 * (1.0 + (PI * r).cos());
    }
    1.0
}

/// Beat-synced exponential sidechain pump envelope matching backend `_apply_sidechain_pump_range`.
#[inline]
pub fn sidechain_pump_gain(
    rel_frame: usize,
    total_len: usize,
    sr: f32,
    bpm: f32,
    division_beats: f32,
    depth: f32,
) -> f32 {
    let safe_bpm = bpm.max(40.0);
    let period_sec = (division_beats.clamp(0.0625, 2.0)) * (60.0 / safe_bpm);
    let depth_c = depth.clamp(0.05, 0.95);
    let t = (rel_frame as f32) / sr.max(1.0);
    let phase = (t % period_sec) / period_sec.max(1e-6);
    let attack_frac = (0.008 / period_sec.max(1e-6)).clamp(1.0 / (period_sec * sr).max(16.0), 0.25);

    let env = if phase < attack_frac {
        let r = (phase / attack_frac).clamp(0.0, 1.0);
        1.0 - depth_c * 0.5 * (1.0 - (PI * r).cos())
    } else {
        let rec_r = ((phase - attack_frac) / (1.0 - attack_frac).max(1e-6)).clamp(0.0, 1.0);
        let k = 4.5_f32;
        let norm_exp = ((-k * rec_r).exp() - (-k).exp()) / (1.0 - (-k).exp());
        1.0 - depth_c * norm_exp
    };

    let edge = cosine_edge_mask(rel_frame, total_len, (0.015 * sr) as usize, (0.015 * sr) as usize);
    1.0 + edge * (env - 1.0)
}

/// Mid-side stereo widening (`width = 1.0` neutral, `1.5` wide).
#[inline]
pub fn apply_stereo_width(l: f32, r: f32, width: f32) -> (f32, f32) {
    let mid = 0.5 * (l + r);
    let side = 0.5 * (l - r) * width.clamp(0.5, 2.0);
    (mid + side, mid - side)
}

/// Lightweight stereo 2nd-order RBJ biquad filter for real-time sweeps, lo-fi EQ, and bass boost.
#[derive(Debug, Clone, Copy, Default)]
pub struct StereoBiquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1_l: f32,
    z2_l: f32,
    z1_r: f32,
    z2_r: f32,
}

impl StereoBiquad {
    pub fn reset(&mut self) {
        self.z1_l = 0.0;
        self.z2_l = 0.0;
        self.z1_r = 0.0;
        self.z2_r = 0.0;
    }

    pub fn set_lowpass(&mut self, sr: f32, freq_hz: f32, q: f32) {
        let f = freq_hz.clamp(25.0, sr * 0.45);
        let w0 = 2.0 * PI * f / sr.max(1.0);
        let cos_w = w0.cos();
        let alpha = w0.sin() / (2.0 * q.max(0.2));
        let a0 = 1.0 + alpha;
        self.b0 = ((1.0 - cos_w) * 0.5) / a0;
        self.b1 = (1.0 - cos_w) / a0;
        self.b2 = self.b0;
        self.a1 = (-2.0 * cos_w) / a0;
        self.a2 = (1.0 - alpha) / a0;
    }

    pub fn set_highpass(&mut self, sr: f32, freq_hz: f32, q: f32) {
        let f = freq_hz.clamp(25.0, sr * 0.45);
        let w0 = 2.0 * PI * f / sr.max(1.0);
        let cos_w = w0.cos();
        let alpha = w0.sin() / (2.0 * q.max(0.2));
        let a0 = 1.0 + alpha;
        self.b0 = ((1.0 + cos_w) * 0.5) / a0;
        self.b1 = -(1.0 + cos_w) / a0;
        self.b2 = self.b0;
        self.a1 = (-2.0 * cos_w) / a0;
        self.a2 = (1.0 - alpha) / a0;
    }

    pub fn set_lowshelf(&mut self, sr: f32, freq_hz: f32, gain_db: f32) {
        let f = freq_hz.clamp(35.0, sr * 0.4);
        let a = 10.0_f32.powf(gain_db.clamp(-12.0, 18.0) / 40.0);
        let w0 = 2.0 * PI * f / sr.max(1.0);
        let cos_w = w0.cos();
        let sin_w = w0.sin();
        let sqrt_a = a.sqrt();
        let alpha = sin_w * 0.5 * 2.0_f32.sqrt();
        let a0 = (a + 1.0) + (a - 1.0) * cos_w + 2.0 * sqrt_a * alpha;
        self.b0 = (a * ((a + 1.0) - (a - 1.0) * cos_w + 2.0 * sqrt_a * alpha)) / a0;
        self.b1 = (2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w)) / a0;
        self.b2 = (a * ((a + 1.0) - (a - 1.0) * cos_w - 2.0 * sqrt_a * alpha)) / a0;
        self.a1 = (-2.0 * ((a - 1.0) + (a + 1.0) * cos_w)) / a0;
        self.a2 = ((a + 1.0) + (a - 1.0) * cos_w - 2.0 * sqrt_a * alpha) / a0;
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let yl = self.b0 * l + self.z1_l;
        self.z1_l = self.b1 * l - self.a1 * yl + self.z2_l;
        self.z2_l = self.b2 * l - self.a2 * yl;

        let yr = self.b0 * r + self.z1_r;
        self.z1_r = self.b1 * r - self.a1 * yr + self.z2_r;
        self.z2_r = self.b2 * r - self.a2 * yr;
        (yl, yr)
    }
}

/// Fixed-capacity stereo delay/reverb ring buffer (allocated once at engine startup — zero RT allocs).
pub struct StereoDelayLine {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    write_pos: usize,
}

impl StereoDelayLine {
    pub fn new(max_frames: usize) -> Self {
        let cap = max_frames.max(256);
        Self {
            buf_l: vec![0.0; cap],
            buf_r: vec![0.0; cap],
            write_pos: 0,
        }
    }

    pub fn clear(&mut self) {
        self.buf_l.fill(0.0);
        self.buf_r.fill(0.0);
        self.write_pos = 0;
    }

    #[inline]
    pub fn tap(&mut self, in_l: f32, in_r: f32, delay_frames: usize, feedback: f32) -> (f32, f32) {
        let cap = self.buf_l.len();
        let d_l = delay_frames.clamp(1, cap - 1);
        let d_r = (delay_frames + 173).clamp(1, cap - 1); // subtle stereo decorrelation
        let rl = self.buf_l[(self.write_pos + cap - d_l) % cap];
        let rr = self.buf_r[(self.write_pos + cap - d_r) % cap];
        let fb = feedback.clamp(0.0, 0.88);
        self.buf_l[self.write_pos] = in_l + rl * fb;
        self.buf_r[self.write_pos] = in_r + rr * fb;
        self.write_pos = (self.write_pos + 1) % cap;
        (rl, rr)
    }
}
