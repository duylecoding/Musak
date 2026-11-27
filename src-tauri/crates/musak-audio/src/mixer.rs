//! Lock-free, zero-allocation real-time multi-track audio mixer callback.

use std::f32::consts::PI;

use crate::dsp::{
    apply_stereo_width, cosine_edge_mask, sidechain_pump_gain, soft_limit, StereoBiquad,
    StereoDelayLine, StereoReverb,
};
use crate::graph::{AbMode, CompiledLayer, FadeCurve, FxKind, TimelineSnapshot};

/// Pre-allocated per-stem real-time filter/delay/reverb states (zero RT heap allocations).
pub struct MixerState {
    sweep_filters: [StereoBiquad; 4],
    lofi_hp: [StereoBiquad; 4],
    lofi_lp: [StereoBiquad; 4],
    bass_shelf: [StereoBiquad; 4],
    delay_lines: [StereoDelayLine; 4],
    reverbs: [StereoReverb; 4],
}

impl MixerState {
    pub fn new(sample_rate: u32) -> Self {
        let max_delay = (sample_rate as usize) * 2 + 512;
        Self {
            sweep_filters: [StereoBiquad::default(); 4],
            lofi_hp: [StereoBiquad::default(); 4],
            lofi_lp: [StereoBiquad::default(); 4],
            bass_shelf: [StereoBiquad::default(); 4],
            delay_lines: std::array::from_fn(|_| StereoDelayLine::new(max_delay)),
            reverbs: std::array::from_fn(|_| StereoReverb::new(sample_rate)),
        }
    }

    pub fn reset(&mut self) {
        for i in 0..4 {
            self.sweep_filters[i].reset();
            self.lofi_hp[i].reset();
            self.lofi_lp[i].reset();
            self.bass_shelf[i].reset();
            self.delay_lines[i].clear();
            self.reverbs[i].clear();
        }
    }

    /// Mix `out.len() / 2` interleaved stereo frames starting at `start_frame`.
    /// Main Track stems (`main_bus`) and Extra Layer tracks (`layer_bus`) are kept cleanly decoupled:
    /// - Muting a Main Track stem (M) mutes ONLY that main stem, never silencing Extra Layers!
    /// - Soloing a Main Track stem (S) isolates ONLY the soloed Main Track stem(s).
    /// - Borrow `replace_main_stems` ducks ONLY `main_bus` (overlapping layers never erase each other).
    pub fn render_block(
        &mut self,
        snap: &TimelineSnapshot,
        start_frame: usize,
        out: &mut [f32],
    ) -> usize {
        let frames = out.len() / 2;
        if snap.total_frames == 0 || frames == 0 {
            out.fill(0.0);
            return start_frame;
        }

        let sr = snap.sample_rate.max(1) as f32;
        let has_stems = snap.stems.iter().any(|s| s.is_some());
        let duck_fade = ((0.030 * sr) as usize).max(16);
        let loop_xfade = ((0.020 * sr) as usize).max(16);
        let mut cursor = start_frame;

        for i in 0..frames {
            if let Some((ls, le)) = snap.loop_range {
                if le > ls && cursor >= le {
                    cursor = ls;
                }
            }
            if cursor >= snap.total_frames {
                out[i * 2] = 0.0;
                out[i * 2 + 1] = 0.0;
                continue;
            }

            let (mix_l, mix_r) = if !has_stems {
                let (mut l, mut r) = snap
                    .main_buffer
                    .as_ref()
                    .map_or((0.0, 0.0), |b| b.frame(cursor));
                if snap.ab_mode == AbMode::Remix {
                    for layer in &snap.layers {
                        if cursor >= layer.start_frame && cursor < layer.end_frame {
                            let (ll, lr) = sample_layer(layer, cursor - layer.start_frame, layer.end_frame - layer.start_frame, loop_xfade);
                            l += ll;
                            r += lr;
                        }
                    }
                }
                (l, r)
            } else {
                // 1. Read Main Track's 4 stems and apply Main Track M/S/Volume
                let mut main_bus = [(0.0_f32, 0.0_f32); 4];
                for s in 0..4 {
                    if let Some(buf) = &snap.stems[s] {
                        let g = snap.stem_gains[s];
                        if g > 0.0 {
                            let (l, r) = buf.frame(cursor);
                            main_bus[s] = (l * g, r * g);
                        }
                    }
                }

                let mut layer_bus = [(0.0_f32, 0.0_f32); 4];

                if snap.ab_mode == AbMode::Remix {
                    // 2. Duck ONLY Main Track stems (`main_bus`) and mix Extra Layers into `layer_bus`
                    let mut main_keep = [1.0_f32; 4];
                    for layer in &snap.layers {
                        if cursor < layer.start_frame || cursor >= layer.end_frame {
                            continue;
                        }
                        let rel = cursor - layer.start_frame;
                        let span = layer.end_frame - layer.start_frame;
                        if layer.duck_mask != 0 {
                            let d_mask = cosine_edge_mask(rel, span, duck_fade, duck_fade);
                            let keep = 1.0 - d_mask;
                            for s in 0..4 {
                                if (layer.duck_mask & (1u8 << s)) != 0 {
                                    main_keep[s] = main_keep[s].min(keep);
                                }
                            }
                        }
                        if !snap.any_stem_solo {
                            let (ll, lr) = sample_layer(layer, rel, span, loop_xfade);
                            let b = layer.stem_bucket.min(3);
                            layer_bus[b].0 += ll;
                            layer_bus[b].1 += lr;
                        }
                    }
                    for s in 0..4 {
                        main_bus[s].0 *= main_keep[s];
                        main_bus[s].1 *= main_keep[s];
                    }

                    // 3. Apply StemGain FX to `main_bus` only (e.g. Mute Vocals in Finale never mutes Layers!)
                    for fx in &snap.fx_regions {
                        if cursor < fx.start_frame || cursor >= fx.end_frame {
                            continue;
                        }
                        if let FxKind::StemGain { gain, fade_in, fade_out, fade_curve } = fx.kind {
                            let rel = cursor - fx.start_frame;
                            let span = (fx.end_frame - fx.start_frame).max(1);
                            let frac = (rel as f32) / (span as f32);
                            let mult = match fade_curve {
                                FadeCurve::In => 0.5 * (1.0 - (PI * frac).cos()) * gain,
                                FadeCurve::Out => 0.5 * (1.0 + (PI * frac).cos()) * if gain > 0.0 { gain } else { 1.0 },
                                FadeCurve::Both => cosine_edge_mask(rel, span, fade_in, fade_out) * gain,
                                FadeCurve::None => {
                                    let m = cosine_edge_mask(rel, span, fade_in, fade_out);
                                    1.0 + m * (gain - 1.0)
                                }
                            };
                            for s in 0..4 {
                                if (fx.stem_mask & (1u8 << s)) != 0 {
                                    main_bus[s].0 *= mult;
                                    main_bus[s].1 *= mult;
                                }
                            }
                        }
                    }

                    // 4. Combine Main Bus + Layer Bus per stem bucket, then run live FX (pump, filters, reverb, delay)
                    let mut combined = [(0.0_f32, 0.0_f32); 4];
                    for s in 0..4 {
                        combined[s] = (main_bus[s].0 + layer_bus[s].0, main_bus[s].1 + layer_bus[s].1);
                    }

                    let update_coeffs = (i & 31) == 0;
                    for fx in &snap.fx_regions {
                        if cursor < fx.start_frame || cursor >= fx.end_frame {
                            continue;
                        }
                        if matches!(fx.kind, FxKind::StemGain { .. }) {
                            continue;
                        }
                        let rel = cursor - fx.start_frame;
                        let span = (fx.end_frame - fx.start_frame).max(1);
                        let frac = (rel as f32) / (span as f32);

                        for s in 0..4 {
                            if (fx.stem_mask & (1u8 << s)) == 0 {
                                continue;
                            }
                            let (mut l, mut r) = combined[s];
                            match fx.kind {
                                FxKind::SidechainPump { division_beats, depth } => {
                                    let g = sidechain_pump_gain(rel, span, sr, snap.bpm, division_beats, depth);
                                    l *= g;
                                    r *= g;
                                }
                                FxKind::StereoWash { width } => {
                                    let (wl, wr) = apply_stereo_width(l, r, width);
                                    let m = cosine_edge_mask(rel, span, (0.025 * sr) as usize, (0.025 * sr) as usize);
                                    l += m * (wl - l);
                                    r += m * (wr - r);
                                }
                                FxKind::FilterSweep { highpass, start_hz, end_hz } => {
                                    if update_coeffs || rel == 0 {
                                        let hz = (start_hz.max(25.0).ln() + frac * (end_hz.max(25.0).ln() - start_hz.max(25.0).ln())).exp();
                                        if highpass {
                                            self.sweep_filters[s].set_highpass(sr, hz, 0.707);
                                        } else {
                                            self.sweep_filters[s].set_lowpass(sr, hz, 0.707);
                                        }
                                    }
                                    let (fl, fr) = self.sweep_filters[s].process(l, r);
                                    let m = cosine_edge_mask(rel, span, (0.025 * sr) as usize, (0.025 * sr) as usize);
                                    l += m * (fl - l);
                                    r += m * (fr - r);
                                }
                                FxKind::LofiEq { low_cut_hz, high_cut_hz } => {
                                    if update_coeffs || rel == 0 {
                                        self.lofi_hp[s].set_highpass(sr, low_cut_hz, 0.707);
                                        self.lofi_lp[s].set_lowpass(sr, high_cut_hz, 0.707);
                                    }
                                    let (h_l, h_r) = self.lofi_hp[s].process(l, r);
                                    let (f_l, f_r) = self.lofi_lp[s].process(h_l, h_r);
                                    let m = cosine_edge_mask(rel, span, (0.020 * sr) as usize, (0.020 * sr) as usize);
                                    l += m * (f_l - l);
                                    r += m * (f_r - r);
                                }
                                FxKind::BassBoost { gain_db, cutoff_hz } => {
                                    if update_coeffs || rel == 0 {
                                        self.bass_shelf[s].set_lowshelf(sr, cutoff_hz, gain_db);
                                    }
                                    let (bl, br) = self.bass_shelf[s].process(l, r);
                                    let m = cosine_edge_mask(rel, span, (0.020 * sr) as usize, (0.020 * sr) as usize);
                                    l += m * (bl - l);
                                    r += m * (br - r);
                                }
                                FxKind::DelayThrow { delay_beats, feedback, mix } => {
                                    let delay_sec = ((60.0 / snap.bpm.max(40.0)) * delay_beats).clamp(0.02, 1.9);
                                    let d_frames = (delay_sec * sr) as usize;
                                    let (dl, dr) = self.delay_lines[s].tap(l, r, d_frames, feedback);
                                    let m = cosine_edge_mask(rel, span, (0.015 * sr) as usize, (0.040 * sr) as usize);
                                    l += dl * mix.clamp(0.0, 1.0) * m;
                                    r += dr * mix.clamp(0.0, 1.0) * m;
                                }
                                FxKind::ReverbThrow { wet_level, room_size } => {
                                    let (rl, rr) = self.reverbs[s].process_wet(l, r, room_size);
                                    let m = cosine_edge_mask(rel, span, (0.020 * sr) as usize, (0.040 * sr) as usize);
                                    let wet = wet_level.clamp(0.0, 1.0) * m;
                                    l += rl * wet;
                                    r += rr * wet;
                                }
                                FxKind::StemGain { .. } => {}
                            }
                            combined[s] = (l, r);
                        }
                    }

                    let mut sum_l = 0.0_f32;
                    let mut sum_r = 0.0_f32;
                    for s in 0..4 {
                        sum_l += combined[s].0;
                        sum_r += combined[s].1;
                    }
                    (sum_l, sum_r)
                } else {
                    let mut sum_l = 0.0_f32;
                    let mut sum_r = 0.0_f32;
                    for s in 0..4 {
                        sum_l += main_bus[s].0;
                        sum_r += main_bus[s].1;
                    }
                    (sum_l, sum_r)
                }
            };

            out[i * 2] = soft_limit(mix_l);
            out[i * 2 + 1] = soft_limit(mix_r);
            cursor += 1;
        }
        cursor
    }
}

#[inline]
fn sample_layer(layer: &CompiledLayer, rel: usize, span: usize, loop_xfade: usize) -> (f32, f32) {
    let buf_frames = layer.buffer.frames;
    if buf_frames == 0 {
        return (0.0, 0.0);
    }
    let (l, r) = if layer.loop_to_fit && buf_frames > loop_xfade * 4 {
        let stride = buf_frames - loop_xfade;
        let cycle = rel / stride;
        let pos = rel % stride;
        if cycle > 0 && pos < loop_xfade {
            let frac = (pos as f32) / (loop_xfade as f32);
            let fi = 0.5 * (1.0 - (PI * frac).cos());
            let fo = 1.0 - fi;
            let (a_l, a_r) = layer.buffer.frame(pos);
            let (b_l, b_r) = layer.buffer.frame(stride + pos);
            (a_l * fi + b_l * fo, a_r * fi + b_r * fo)
        } else {
            layer.buffer.frame(pos)
        }
    } else if layer.loop_to_fit {
        layer.buffer.frame(rel % buf_frames)
    } else if rel < buf_frames {
        layer.buffer.frame(rel)
    } else {
        return (0.0, 0.0);
    };

    let active_span = if layer.loop_to_fit { span } else { span.min(buf_frames) };
    let env = cosine_edge_mask(rel, active_span, layer.fade_in_frames, layer.fade_out_frames) * layer.gain;
    (l * env, r * env)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use super::*;
    use crate::buffer::AudioBuffer;
    use crate::graph::{CompiledFx, STEM_BASS, STEM_DRUMS, STEM_OTHER, STEM_VOCALS};

    fn make_const_buf(sr: u32, frames: usize, val: f32) -> Arc<AudioBuffer> {
        Arc::new(AudioBuffer::from_stereo(sr, vec![val; frames * 2]))
    }

    #[test]
    fn mute_melody_only_mutes_main_melody_and_keeps_extra_layers_playing() {
        let sr = 44100;
        let mut snap = TimelineSnapshot::empty(sr);
        snap.total_frames = 1000;
        snap.stems[STEM_OTHER] = Some(make_const_buf(sr, 1000, 0.35));
        snap.stem_gains = [1.0, 1.0, 1.0, 0.0]; // Main Melody muted!
        snap.any_stem_solo = false;
        snap.layers.push(CompiledLayer {
            buffer: make_const_buf(sr, 1000, 0.5),
            start_frame: 0,
            end_frame: 1000,
            gain: 1.0,
            fade_in_frames: 0,
            fade_out_frames: 0,
            loop_to_fit: false,
            stem_bucket: STEM_OTHER,
            duck_mask: 0,
        });

        let mut mixer = MixerState::new(sr);
        let mut out = vec![0.0; 200 * 2];
        mixer.render_block(&snap, 500, &mut out);
        // Main Melody (0.35) is muted, but Extra Layer Illenium synth (0.5) MUST STILL PLAY!
        assert!((out[100] - 0.5).abs() < 0.02, "expected extra layer ~0.5, got {}", out[100]);
    }

    #[test]
    fn solo_vocals_isolates_only_main_vocals_and_mutes_extra_layers() {
        let sr = 44100;
        let mut snap = TimelineSnapshot::empty(sr);
        snap.total_frames = 1000;
        snap.stems[STEM_VOCALS] = Some(make_const_buf(sr, 1000, 0.3));
        snap.stem_gains = [1.0, 0.0, 0.0, 0.0];
        snap.any_stem_solo = true;
        snap.layers.push(CompiledLayer {
            buffer: make_const_buf(sr, 1000, 0.5),
            start_frame: 0,
            end_frame: 1000,
            gain: 1.0,
            fade_in_frames: 0,
            fade_out_frames: 0,
            loop_to_fit: false,
            stem_bucket: STEM_OTHER,
            duck_mask: 0,
        });

        let mut mixer = MixerState::new(sr);
        let mut out = vec![0.0; 200 * 2];
        mixer.render_block(&snap, 500, &mut out);
        assert!((out[100] - 0.3).abs() < 0.02, "expected soloed vocals ~0.3, got {}", out[100]);
    }

    #[test]
    fn sidechain_pump_ducks_other_without_touching_vocals() {
        let sr = 44100;
        let mut snap = TimelineSnapshot::empty(sr);
        snap.total_frames = sr as usize;
        snap.bpm = 120.0;
        snap.stems[STEM_VOCALS] = Some(make_const_buf(sr, sr as usize, 0.3));
        snap.stems[STEM_OTHER] = Some(make_const_buf(sr, sr as usize, 0.5));
        snap.fx_regions.push(CompiledFx {
            start_frame: 0,
            end_frame: sr as usize,
            stem_mask: (1 << STEM_OTHER) | (1 << STEM_BASS),
            kind: FxKind::SidechainPump { division_beats: 1.0, depth: 0.8 },
        });

        let mut mixer = MixerState::new(sr);
        let mut out = vec![0.0; (sr as usize) * 2];
        mixer.render_block(&snap, 0, &mut out);
        let ducked = out[22403 * 2];
        let recovered = out[41895 * 2];
        assert!(ducked >= 0.35 && ducked <= 0.45, "unexpected ducked level: {ducked}");
        assert!(recovered > 0.72, "unexpected recovered level: {recovered}");
        assert!(out.iter().all(|v| v.is_finite() && v.abs() <= 1.0));
    }

    #[test]
    fn original_mode_ignores_remix_layers_and_fx() {
        let sr = 44100;
        let mut snap = TimelineSnapshot::empty(sr);
        snap.ab_mode = AbMode::Original;
        snap.total_frames = 500;
        snap.stems[STEM_DRUMS] = Some(make_const_buf(sr, 500, 0.25));
        snap.layers.push(CompiledLayer {
            buffer: make_const_buf(sr, 500, 0.6),
            start_frame: 0,
            end_frame: 500,
            gain: 1.0,
            fade_in_frames: 0,
            fade_out_frames: 0,
            loop_to_fit: false,
            stem_bucket: STEM_DRUMS,
            duck_mask: 0,
        });

        let mut mixer = MixerState::new(sr);
        let mut out = vec![0.0; 100 * 2];
        mixer.render_block(&snap, 0, &mut out);
        assert!((out[20] - 0.25).abs() < 0.001);
    }

    #[test]
    fn snapshot_hotswap_moves_clip_on_next_block_immediately() {
        let sr = 44100;
        let mut snap = TimelineSnapshot::empty(sr);
        snap.total_frames = 2000;
        snap.stems[STEM_OTHER] = Some(make_const_buf(sr, 2000, 0.0));
        snap.layers.push(CompiledLayer {
            buffer: make_const_buf(sr, 400, 0.6),
            start_frame: 0,
            end_frame: 400,
            gain: 1.0,
            fade_in_frames: 0,
            fade_out_frames: 0,
            loop_to_fit: false,
            stem_bucket: STEM_OTHER,
            duck_mask: 0,
        });

        let mut mixer = MixerState::new(sr);
        let mut out_a = vec![0.0; 200 * 2];
        mixer.render_block(&snap, 600, &mut out_a);
        assert!(out_a[100].abs() < 0.001);

        snap.layers[0].start_frame = 500;
        snap.layers[0].end_frame = 900;
        let mut out_b = vec![0.0; 200 * 2];
        mixer.render_block(&snap, 600, &mut out_b);
        assert!((out_b[100] - 0.6).abs() < 0.01);
    }
}
