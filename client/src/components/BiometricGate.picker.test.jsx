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

it('stops excusing a hidden page once the camera has returned', async () => {
  await renderUnlocked();
  fireEvent.click(screen.getByTestId('camera'));
  setVisibility('hidden');
  setVisibility('visible');

  setVisibility('hidden');

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

it('keeps a Face ID success that lands while the camera still hides the page', async () => {
  await renderUnlocked();
  // Locked by a real background before the camera opened.
  appState(false);
  expect(lockShown()).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('camera'));
  visibility = 'hidden';
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Unlock/i })); });

  await waitFor(() => expect(lockShown()).not.toBeInTheDocument());
});
