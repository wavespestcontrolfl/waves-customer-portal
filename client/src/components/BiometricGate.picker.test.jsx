// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const appListeners = vi.hoisted(() => []);

vi.mock('../native/platform', () => ({
  isNativeApp: () => true,
  hasSessionToken: () => true,
}));
vi.mock('../native/biometric', () => ({
  authenticateBiometric: vi.fn(async () => true),
}));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_event, fn) => {
      appListeners.push(fn);
      return { remove: vi.fn() };
    }),
  },
}));

import BiometricGate from './BiometricGate';
import { NATIVE_PICKER_EVENT } from '../native/camera';
import { authenticateBiometric } from '../native/biometric';

let visibility = 'visible';

function setVisibility(state) {
  visibility = state;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

function appState(isActive) {
  act(() => { appListeners.forEach((fn) => fn({ isActive })); });
}

async function renderUnlocked() {
  render(
    <BiometricGate>
      <input data-testid="camera" type="file" accept="image/*" capture="environment" style={{ display: 'none' }} />
    </BiometricGate>,
  );
  await waitFor(() => expect(screen.queryByRole('dialog', { name: /Waves is locked/i })).not.toBeInTheDocument());
  await waitFor(() => expect(appListeners.length).toBeGreaterThan(0));
}

const lockShown = () => screen.queryByRole('dialog', { name: /Waves is locked/i });

beforeEach(() => {
  visibility = 'visible';
  appListeners.length = 0;
  authenticateBiometric.mockClear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => cleanup());

it('does not lock while the app\'s own camera picker covers the page', async () => {
  await renderUnlocked();
  fireEvent.click(screen.getByTestId('camera'));

  setVisibility('hidden');
  setVisibility('visible');

  expect(lockShown()).not.toBeInTheDocument();
  expect(authenticateBiometric).toHaveBeenCalledTimes(1); // launch unlock only — no re-prompt
});

it('still locks on a real app switch while the camera is open', async () => {
  await renderUnlocked();
  fireEvent.click(screen.getByTestId('camera'));
  setVisibility('hidden');

  appState(false);

  expect(lockShown()).toBeInTheDocument();
});

it('still locks on a real background once the picker has reported back', async () => {
  await renderUnlocked();
  const camera = screen.getByTestId('camera');
  fireEvent.click(camera);
  fireEvent.change(camera);

  setVisibility('hidden');

  expect(lockShown()).toBeInTheDocument();
});

it('still locks on a real background when no picker was opened', async () => {
  await renderUnlocked();

  appState(false);

  expect(lockShown()).toBeInTheDocument();
});

it('waits for the camera to close before asking Face ID after a real app switch', async () => {
  await renderUnlocked();
  fireEvent.click(screen.getByTestId('camera'));
  setVisibility('hidden');

  appState(false); // real app switch with the camera up
  appState(true);  // back to the app, camera still covering the page
  expect(lockShown()).toBeInTheDocument();
  expect(authenticateBiometric).toHaveBeenCalledTimes(1); // no prompt under the camera

  fireEvent.change(screen.getByTestId('camera'));
  setVisibility('visible'); // camera closed
  await waitFor(() => expect(lockShown()).not.toBeInTheDocument());
  expect(authenticateBiometric).toHaveBeenCalledTimes(2);
});

it('discards a Face ID success when a real background hides the page mid-prompt, even under a picker', async () => {
  await renderUnlocked();
  appState(false);
  expect(lockShown()).toBeInTheDocument();

  let finish;
  authenticateBiometric.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Unlock/i })); });
  fireEvent.click(screen.getByTestId('camera'));
  setVisibility('hidden');
  await act(async () => { finish(true); });

  expect(lockShown()).toBeInTheDocument();
});

it('discards a Face ID success when a picker opened but a real background hid the page', async () => {
  await renderUnlocked();
  appState(false);
  expect(lockShown()).toBeInTheDocument();

  // Picker opened and dismissed without reporting back, and without ever hiding the page.
  fireEvent.click(screen.getByTestId('camera'));
  let finish;
  authenticateBiometric.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Unlock/i })); });
  visibility = 'hidden'; // a real background lands mid-prompt
  await act(async () => { finish(true); });

  expect(lockShown()).toBeInTheDocument();
});

function nativePicker(open) {
  act(() => { document.dispatchEvent(new CustomEvent(NATIVE_PICKER_EVENT, { detail: { open } })); });
}

it('does not lock while the native camera sheet covers the page', async () => {
  await renderUnlocked();
  nativePicker(true);

  setVisibility('hidden');
  setVisibility('visible');
  nativePicker(false);

  expect(lockShown()).not.toBeInTheDocument();
  expect(authenticateBiometric).toHaveBeenCalledTimes(1);
});

it('keeps the deferred Face ID prompt when the pick lands before the page is visible', async () => {
  await renderUnlocked();
  fireEvent.click(screen.getByTestId('camera'));
  setVisibility('hidden');
  appState(false); // real app switch under the picker
  appState(true);

  fireEvent.change(screen.getByTestId('camera')); // picked while still hidden
  expect(authenticateBiometric).toHaveBeenCalledTimes(1);

  setVisibility('visible');
  await waitFor(() => expect(lockShown()).not.toBeInTheDocument());
  expect(authenticateBiometric).toHaveBeenCalledTimes(2);
});

it('prompts once the picker closes when the real app switch arrives before the hidden event', async () => {
  await renderUnlocked();
  fireEvent.click(screen.getByTestId('camera'));
  appState(false); // resign first
  setVisibility('hidden');
  appState(true);
  expect(authenticateBiometric).toHaveBeenCalledTimes(1);

  setVisibility('visible');
  fireEvent.change(screen.getByTestId('camera'));
  await waitFor(() => expect(lockShown()).not.toBeInTheDocument());
  expect(authenticateBiometric).toHaveBeenCalledTimes(2);
});

it('does not prompt under a picker that stays open on a visible page (iPad popover)', async () => {
  await renderUnlocked();
  fireEvent.click(screen.getByTestId('camera'));
  appState(false); // real app switch, popover picker stays open
  appState(true);
  setVisibility('visible');
  expect(lockShown()).toBeInTheDocument();
  expect(authenticateBiometric).toHaveBeenCalledTimes(1);

  fireEvent(screen.getByTestId('camera'), new Event('cancel')); // picker closes
  await waitFor(() => expect(lockShown()).not.toBeInTheDocument());
  expect(authenticateBiometric).toHaveBeenCalledTimes(2);
});

it('runs the deferred Face ID prompt when a picker never reports back', async () => {
  await renderUnlocked();
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByTestId('camera')); // older iOS: no cancel will come
    appState(false);
    appState(true);
    expect(authenticateBiometric).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(3 * 60 * 1000 + 100); });
    expect(authenticateBiometric).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it('treats the camera\'s own hide → show as closing it when no change/cancel comes (older iOS)', async () => {
  await renderUnlocked();
  fireEvent.click(screen.getByTestId('camera'));
  setVisibility('hidden');   // camera covers the page
  setVisibility('visible');  // camera dismissed, no change/cancel event
  await act(async () => { await new Promise((r) => setTimeout(r, 750)); }); // launch prompt's suppression window

  appState(false); // real app switch afterwards
  appState(true);
  await waitFor(() => expect(authenticateBiometric).toHaveBeenCalledTimes(2));
});
