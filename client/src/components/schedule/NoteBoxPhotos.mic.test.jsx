// @vitest-environment jsdom
// With the REAL dictation hook (upload mode: no SpeechRecognition): closing a
// photo description while the microphone permission is still pending
// releases the microphone when the permission resolves and never starts a
// recording nobody could stop (pre-push P1 on the notes-box PR).
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NoteBoxPhotos from './NoteBoxPhotos';

const palette = { text: '#111', muted: '#737373', border: '#E5E5E5', card: '#FFF', danger: '#C2410C', onDanger: '#FFF' };
let resolveMic;
let recorders;
beforeEach(() => {
  recorders = 0;
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ available: true }) })));
  vi.stubGlobal('MediaRecorder', class {
    static isTypeSupported() { return true; }
    constructor() { recorders += 1; }
    start() {}
    stop() {}
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(() => new Promise((resolve) => { resolveMic = resolve; })) },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it('closing the description during the permission prompt releases the microphone and starts no recording', async () => {
  render(
    <NoteBoxPhotos
      photos={[{ name: 'a.jpg', data: 'data:a', caption: '' }]}
      max={5}
      disabled={false}
      palette={palette}
      dictationServiceId="svc-1"
      onAdd={() => {}}
      onRemove={() => {}}
      onCaption={() => {}}
      summary=""
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Describe photo 1' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Describe by voice' }));
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  const track = { stop: vi.fn() };
  await act(async () => { resolveMic({ getTracks: () => [track] }); });
  expect(track.stop).toHaveBeenCalled();
  expect(recorders).toBe(0);
});

it('Save waits while a dictation records and transcribes, then saves the words (codex local r1 on #5589)', async () => {
  let finishUpload;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/dictation/availability')) return { ok: true, json: async () => ({ available: true }) };
    return new Promise((resolve) => { finishUpload = () => resolve({ ok: true, json: async () => ({ text: 'gap under the garage door' }) }); });
  }));
  vi.stubGlobal('MediaRecorder', class {
    static isTypeSupported() { return true; }
    constructor() { recorders += 1; this.mimeType = 'audio/webm'; }
    start() {}
    stop() {
      this.ondataavailable?.({ data: new Blob(['clip']) });
      this.onstop?.();
    }
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })) },
  });
  const onCaption = vi.fn();
  render(
    <NoteBoxPhotos
      photos={[{ name: 'a.jpg', data: 'data:a', caption: '' }]}
      max={5}
      disabled={false}
      palette={palette}
      dictationServiceId="svc-1"
      onAdd={() => {}}
      onRemove={() => {}}
      onCaption={onCaption}
      summary=""
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Describe photo 1' }));
  const mic = await screen.findByRole('button', { name: 'Describe by voice' });
  await act(async () => { fireEvent.click(mic); });
  expect(screen.getByRole('button', { name: 'Save description' }).disabled).toBe(true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop describing by voice' })); });
  expect(screen.getByRole('button', { name: 'Transcribing…' }).disabled).toBe(true);
  fireEvent.keyDown(screen.getByLabelText('Description for photo 1'), { key: 'Enter' });
  expect(onCaption).not.toHaveBeenCalled();
  await act(async () => { finishUpload(); });
  expect(screen.getByLabelText('Description for photo 1').value).toBe('gap under the garage door');
  fireEvent.click(screen.getByRole('button', { name: 'Save description' }));
  expect(onCaption).toHaveBeenCalledWith(0, 'gap under the garage door');
});
