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
