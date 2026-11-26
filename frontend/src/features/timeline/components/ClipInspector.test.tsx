import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EditBlock } from '../../../shared/api';
import { ClipInspector } from './ClipInspector';

function makeAnchorRef() {
  const el = document.createElement('button');
  el.getBoundingClientRect = () => ({
    top: 100, bottom: 130, left: 100, right: 200, width: 100, height: 30, x: 100, y: 100, toJSON: () => {},
  });
  document.body.appendChild(el);
  return { current: el } as React.RefObject<HTMLElement | null>;
}

function makeEdit(overrides: Partial<EditBlock> = {}): EditBlock {
  return {
    id: 'edit-1',
    title: 'Test Clip',
    description: 'Clip description',
    start: 4,
    end: 12,
    enabled: true,
    operations: [{ type: 'stem_gain', stems: ['vocals'], gain_db: 0 }],
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ClipInspector', () => {
  it('supports inline clip rename, fade pills, and duplicate button', async () => {
    const onUpdateEdit = vi.fn().mockResolvedValue(undefined);
    const onDuplicateEdit = vi.fn().mockResolvedValue(undefined);

    render(
      <ClipInspector
        edit={makeEdit()}
        anchorRef={makeAnchorRef()}
        onClose={vi.fn()}
        onUpdateEdit={onUpdateEdit}
        onDuplicateEdit={onDuplicateEdit}
        onDeleteEdit={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const titleInput = screen.getByLabelText('Clip title');
    fireEvent.change(titleInput, { target: { value: 'Vocal Boosted' } });
    fireEvent.blur(titleInput);
    await waitFor(() => expect(onUpdateEdit).toHaveBeenCalledWith('edit-1', { title: 'Vocal Boosted' }));

    fireEvent.click(screen.getByRole('button', { name: 'Fade In 1s' }));
    await waitFor(() => expect(onUpdateEdit).toHaveBeenCalledWith('edit-1', { fade_in_ms: 1000 }));

    fireEvent.click(screen.getByRole('button', { name: 'Fade Out 2s' }));
    await waitFor(() => expect(onUpdateEdit).toHaveBeenCalledWith('edit-1', { fade_out_ms: 2000 }));

    fireEvent.click(screen.getByRole('button', { name: /Duplicate \(Ctrl\+D\)/i }));
    await waitFor(() => expect(onDuplicateEdit).toHaveBeenCalledWith('edit-1'));
  });

  it('renders filter_sweep and reverb_throw FX controls and commits updates', async () => {
    const onUpdateEdit = vi.fn().mockResolvedValue(undefined);
    const anchorRef = makeAnchorRef();

    const { rerender } = render(
      <ClipInspector
        edit={makeEdit({
          operations: [{ type: 'filter_sweep', mode: 'highpass', start_hz: 120, end_hz: 2600 }],
        })}
        anchorRef={anchorRef}
        onClose={vi.fn()}
        onUpdateEdit={onUpdateEdit}
        onDeleteEdit={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Low-Pass' }));
    await waitFor(() =>
      expect(onUpdateEdit).toHaveBeenCalledWith('edit-1', {
        mode: 'lowpass', start_hz: 280, end_hz: 14000,
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sweep Down' }));
    await waitFor(() =>
      expect(onUpdateEdit).toHaveBeenCalledWith('edit-1', {
        mode: 'highpass', start_hz: 2600, end_hz: 120,
      })
    );

    rerender(
      <ClipInspector
        edit={makeEdit({
          operations: [{ type: 'reverb_throw', room_size: 0.8, wet_level: 0.45 }],
        })}
        anchorRef={anchorRef}
        onClose={vi.fn()}
        onUpdateEdit={onUpdateEdit}
        onDeleteEdit={vi.fn()}
      />
    );

    const wetSlider = screen.getByLabelText('Wet Mix');
    fireEvent.change(wetSlider, { target: { value: '0.7' } });
    fireEvent.pointerUp(wetSlider);
    await waitFor(() => expect(onUpdateEdit).toHaveBeenCalledWith('edit-1', { wet_level: 0.7 }));
  });

  it('renders borrow_stem Auto-Duck and Loop Audio to Fit controls', async () => {
    const onUpdateEdit = vi.fn().mockResolvedValue(undefined);
    render(
      <ClipInspector
        edit={makeEdit({
          operations: [{
            type: 'borrow_stem',
            ref_id: 'ref-1',
            ref_stem: 'vocals',
            ref_start: 10,
            ref_end: 18,
            match_bpm: true,
            match_key: true,
            loop_to_fit: false,
            replace_main_stems: [],
          }],
        })}
        anchorRef={makeAnchorRef()}
        onClose={vi.fn()}
        onUpdateEdit={onUpdateEdit}
        onDeleteEdit={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Melody' }));
    await waitFor(() =>
      expect(onUpdateEdit).toHaveBeenCalledWith('edit-1', {
        replace_main_stems: ['other'],
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Drums + Melody' }));
    await waitFor(() =>
      expect(onUpdateEdit).toHaveBeenCalledWith('edit-1', {
        replace_main_stems: ['drums', 'other'],
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Instrumental' }));
    await waitFor(() =>
      expect(onUpdateEdit).toHaveBeenCalledWith('edit-1', {
        replace_main_stems: ['drums', 'bass', 'other'],
      })
    );

    fireEvent.click(screen.getByLabelText('Loop Audio to Fit'));
    await waitFor(() => expect(onUpdateEdit).toHaveBeenCalledWith('edit-1', { loop_to_fit: true }));
  });

  it('renders sidechain_pump and stereo_wash FX controls and commits updates', async () => {
    const onUpdateEdit = vi.fn().mockResolvedValue(undefined);
    const anchorRef = makeAnchorRef();

    const { rerender } = render(
      <ClipInspector
        edit={makeEdit({
          operations: [{ type: 'sidechain_pump', division_beats: 1.0, depth: 0.7, apply_to_layers: true }],
        })}
        anchorRef={anchorRef}
        onClose={vi.fn()}
        onUpdateEdit={onUpdateEdit}
        onDeleteEdit={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '1/2 Beat' }));
    await waitFor(() => expect(onUpdateEdit).toHaveBeenCalledWith('edit-1', { division_beats: 0.5 }));

    const depthSlider = screen.getByLabelText('Pump Depth');
    fireEvent.change(depthSlider, { target: { value: '0.85' } });
    fireEvent.pointerUp(depthSlider);
    await waitFor(() => expect(onUpdateEdit).toHaveBeenCalledWith('edit-1', { depth: 0.85 }));

    rerender(
      <ClipInspector
        edit={makeEdit({
          operations: [{ type: 'stereo_wash', width: 1.45, chorus_mix: 0.35 }],
        })}
        anchorRef={anchorRef}
        onClose={vi.fn()}
        onUpdateEdit={onUpdateEdit}
        onDeleteEdit={vi.fn()}
      />
    );

    const widthSlider = screen.getByLabelText('Stereo Width');
    fireEvent.change(widthSlider, { target: { value: '1.8' } });
    fireEvent.pointerUp(widthSlider);
    await waitFor(() => expect(onUpdateEdit).toHaveBeenCalledWith('edit-1', { width: 1.8 }));

    const chorusSlider = screen.getByLabelText('Chorus Shimmer');
    fireEvent.change(chorusSlider, { target: { value: '0.55' } });
    fireEvent.pointerUp(chorusSlider);
    await waitFor(() => expect(onUpdateEdit).toHaveBeenCalledWith('edit-1', { chorus_mix: 0.55 }));
  });
});
