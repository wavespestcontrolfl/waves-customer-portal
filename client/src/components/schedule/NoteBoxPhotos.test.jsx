// @vitest-environment jsdom
// Photos in the notes box (GATE_NOTE_BOX_PHOTOS): an open description always
// belongs to the photo it was opened for, and dictated words land only in
// the editor session that started the mic (pre-push P1 ×2 on the PR).
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dictation = { listening: false, supported: true, uploading: false, toggle: vi.fn(), cancel: vi.fn() };
let transcript = null;
vi.mock('../../hooks/useSpeechDictation', () => ({
  default: (onTranscript) => {
    transcript = onTranscript;
    return dictation;
  },
}));
const { default: NoteBoxPhotos } = await import('./NoteBoxPhotos');

const palette = { text: '#111', muted: '#737373', border: '#E5E5E5', card: '#FFF', danger: '#C2410C', onDanger: '#FFF' };
const start = [
  { name: 'a.jpg', data: 'data:a', caption: 'First photo' },
  { name: 'b.jpg', data: 'data:b', caption: '' },
  { name: 'c.jpg', data: 'data:c', caption: 'Third photo' },
];

function Harness({ disabled = false }) {
  const [photos, setPhotos] = useState(start);
  return (
    <>
      <NoteBoxPhotos
        photos={photos}
        max={5}
        disabled={disabled}
        palette={palette}
        dictationServiceId="svc-1"
        onAdd={() => {}}
        onRemove={(index) => setPhotos((prev) => prev.filter((_, i) => i !== index))}
        onCaption={(index, caption) => setPhotos((prev) => prev.map((p, i) => (i === index ? { ...p, caption } : p)))}
        summary=""
      />
      <output data-testid="captions">{photos.map((p) => `${p.name}:${p.caption}`).join('|')}</output>
    </>
  );
}

beforeEach(() => {
  dictation.listening = false;
  dictation.toggle.mockReset();
  dictation.cancel.mockReset();
  dictation.toggle.mockImplementation(() => { dictation.listening = !dictation.listening; });
});
afterEach(cleanup);

describe('NoteBoxPhotos', () => {
  it('removing another photo closes the open description instead of saving onto the photo that shifted into its place', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Describe photo 2' }));
    fireEvent.change(screen.getByLabelText('Description for photo 2'), { target: { value: 'Gap under the garage door' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo 1' }));
    expect(screen.queryByLabelText(/Description for photo/)).toBeNull();
    expect(screen.getByTestId('captions').textContent).toBe('b.jpg:|c.jpg:Third photo');
  });

  it('each photo\'s description gets its own mic: words from a closed editor never land in the next one', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Describe photo 1' }));
    const photoOneWords = transcript;
    fireEvent.click(screen.getByRole('button', { name: 'Describe photo 2' }));
    expect(transcript).not.toBe(photoOneWords);
    // Photo 1's editor is gone; its late words reach nothing.
    act(() => photoOneWords('trap by the AC chase'));
    expect(screen.getByLabelText('Description for photo 2').value).toBe('');
  });

  it('words from the open session land in its description', () => {
    // The mic answers without staying open, so Save is free to take them.
    dictation.toggle.mockImplementation(() => {});
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Describe photo 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Describe by voice' }));
    act(() => transcript('gap under the garage door'));
    expect(screen.getByLabelText('Description for photo 2').value).toBe('gap under the garage door');
    fireEvent.click(screen.getByRole('button', { name: 'Save description' }));
    expect(screen.getByTestId('captions').textContent).toBe('a.jpg:First photo|b.jpg:gap under the garage door|c.jpg:Third photo');
  });

  it('while the form is busy writing a report, an open description is locked (pre-push P1)', () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Describe photo 2' }));
    fireEvent.change(screen.getByLabelText('Description for photo 2'), { target: { value: 'Gap under the garage door' } });
    view.rerender(<Harness disabled />);
    expect(screen.getByLabelText('Description for photo 2').disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Save description' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Describe by voice' }).disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText('Description for photo 2'), { key: 'Enter' });
    expect(screen.getByTestId('captions').textContent).toBe('a.jpg:First photo|b.jpg:|c.jpg:Third photo');
  });

  it('Escape cancels the description from anywhere in the editor, not only the input (codex local r2 on #5589)', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Describe photo 1' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Save description' }), { key: 'Escape' });
    expect(screen.queryByLabelText('Description for photo 1')).toBeNull();
  });

  it('tells the form whenever a description is open', () => {
    const onEditingChange = vi.fn();
    render(<NoteBoxPhotos photos={start} max={5} disabled={false} palette={palette} dictationServiceId="svc-1" onAdd={() => {}} onRemove={() => {}} onCaption={() => {}} onEditingChange={onEditingChange} summary="" />);
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Describe photo 1' }));
    expect(onEditingChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });

  it('a draft that replaces the photos under an open description closes it, and the form is released (codex local r3 on #5589)', () => {
    const onEditingChange = vi.fn();
    const props = { max: 5, disabled: false, palette, dictationServiceId: 'svc-1', onAdd: () => {}, onRemove: () => {}, onCaption: vi.fn(), onEditingChange, summary: '' };
    const view = render(<NoteBoxPhotos photos={start} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Describe photo 2' }));
    expect(onEditingChange).toHaveBeenLastCalledWith(true);
    // A restored draft puts a different photo at index 1.
    view.rerender(<NoteBoxPhotos photos={[start[0], { name: 'z.jpg', data: 'data:z', caption: '' }]} {...props} />);
    expect(screen.queryByLabelText('Description for photo 2')).toBeNull();
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
    // A discarded draft clears them: nothing stays open.
    fireEvent.click(screen.getByRole('button', { name: 'Describe photo 1' }));
    view.rerender(<NoteBoxPhotos photos={[]} {...props} />);
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });

  it('the description mic waits while the notes mic is recording or transcribing', () => {
    render(<NoteBoxPhotos photos={start} max={5} disabled={false} micBusy palette={palette} dictationServiceId="svc-1" onAdd={() => {}} onRemove={() => {}} onCaption={() => {}} summary="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Describe photo 1' }));
    expect(screen.getByRole('button', { name: 'Describe by voice' }).disabled).toBe(true);
  });
});
