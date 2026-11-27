// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const platformState = vi.hoisted(() => ({ platform: 'ios', listeners: [] }));

vi.mock('../native/platform', () => ({
  isNativeApp: () => true,
  hasSessionToken: () => true,
  nativePlatform: () => platformState.platform,
}));
vi.mock('../native/biometric', () => ({
  NEEDS_PHONE_CODE: 'needs-phone-code',
  authenticateBiometric: vi.fn(() => new Promise(() => {})),
}));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (name, fn) => {
      if (name === 'appStateChange') platformState.listeners.push(fn);
      return { remove: vi.fn() };
    }),
    minimizeApp: vi.fn(async () => {}),
    exitApp: vi.fn(async () => {}),
  },
}));

import BiometricGate, { UNLOCK_GRACE_MS } from './BiometricGate';
import CustomerDialogHost, { showCustomerAlert } from './brand/CustomerDialogHost';
import { handleAndroidBackButton, _resetNativeBackButtonForTests } from '../native/nativeBackButton';

beforeEach(async () => {
  platformState.platform = 'ios';
  platformState.listeners.length = 0;
  const { authenticateBiometric } = await import('../native/biometric');
  authenticateBiometric.mockReset();
  authenticateBiometric.mockImplementation(() => new Promise(() => {}));
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true });
});

afterEach(() => {
  cleanup();
  _resetNativeBackButtonForTests();
  vi.useRealTimers();
});

it('makes account content inert and suppresses portaled customer dialogs while locked', () => {
  render(
    <BiometricGate>
      <div data-testid="account-content">Private account details</div>
      <CustomerDialogHost />
    </BiometricGate>,
  );

  showCustomerAlert('Background request finished.');

  const lock = screen.getByRole('dialog', { name: /Waves is locked/i });
  expect(lock).toBeInTheDocument();
  expect(screen.getByTestId('account-content').parentElement).toHaveAttribute('aria-hidden', 'true');
  expect(screen.queryByText('Background request finished.')).not.toBeInTheDocument();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
});

it('keeps the lock and offers the phone code sign-in when Face ID cannot run', async () => {
  const { authenticateBiometric } = await import('../native/biometric');
  authenticateBiometric.mockImplementationOnce(async () => 'needs-phone-code');
  const assign = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true });
  localStorage.setItem('waves_token', 't');
  localStorage.setItem('waves_refresh_token', 'r');
  render(
    <BiometricGate>
      <div data-testid="account-content">Private account details</div>
    </BiometricGate>,
  );
  const btn = await screen.findByRole('button', { name: 'Sign in with a text code' });
  expect(screen.getByRole('dialog', { name: /Sign in with a text code/i })).toBeInTheDocument();
  expect(screen.getByTestId('account-content').parentElement).toHaveAttribute('aria-hidden', 'true');
  fireEvent.click(btn);
  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
  expect(localStorage.getItem('waves_token')).toBeNull();
  expect(localStorage.getItem('waves_refresh_token')).toBeNull();
});

it('uses platform-accurate lock copy on Android instead of hardcoding Face ID', () => {
  platformState.platform = 'android';
  render(
    <BiometricGate>
      <div data-testid="account-content">Private account details</div>
    </BiometricGate>,
  );
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveAttribute('aria-label', 'Waves is locked. Unlock to view your account.');
  expect(dialog.getAttribute('aria-label')).not.toMatch(/Face ID/i);
});

it('covers on background but skips re-prompting within the 5-minute grace window, then re-prompts after it expires', async () => {
  vi.useFakeTimers();
  const { authenticateBiometric } = await import('../native/biometric');
  authenticateBiometric.mockResolvedValue(true);

  render(
    <BiometricGate>
      <div data-testid="account-content">Private account details</div>
    </BiometricGate>,
  );

  // Initial launch unlock runs once.
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(authenticateBiometric).toHaveBeenCalledTimes(1);

  // Move past the 700ms prompt-dismiss suppression window, stay inside the 5-minute grace period.
  await vi.advanceTimersByTimeAsync(1500);
  platformState.listeners.forEach((fn) => fn({ isActive: false }));
  await vi.waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

  // Returning within 5 minutes clears the privacy cover without re-prompting.
  await vi.advanceTimersByTimeAsync(10_000);
  platformState.listeners.forEach((fn) => fn({ isActive: true }));
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(authenticateBiometric).toHaveBeenCalledTimes(1);

  // After the 5-minute grace period expires, a background/foreground cycle re-prompts.
  await vi.advanceTimersByTimeAsync(UNLOCK_GRACE_MS + 1000);
  platformState.listeners.forEach((fn) => fn({ isActive: false }));
  await vi.waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  platformState.listeners.forEach((fn) => fn({ isActive: true }));
  await vi.waitFor(() => expect(authenticateBiometric).toHaveBeenCalledTimes(2));
});

it('minimizes the app on Android Back while locked instead of dismissing the lock', async () => {
  platformState.platform = 'android';
  const { App } = await import('@capacitor/app');
  App.minimizeApp.mockClear();

  render(
    <BiometricGate>
      <div data-testid="account-content">Private account details</div>
    </BiometricGate>,
  );
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  const result = await handleAndroidBackButton({ canGoBack: true }, App);
  expect(result).toBe('handled');
  await vi.waitFor(() => expect(App.minimizeApp).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});
