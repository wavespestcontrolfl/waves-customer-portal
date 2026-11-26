// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../native/platform', () => ({
  isNativeApp: () => true,
  hasSessionToken: () => true,
}));
vi.mock('../native/biometric', () => ({
  NEEDS_PHONE_CODE: 'needs-phone-code',
  authenticateBiometric: vi.fn(() => new Promise(() => {})),
}));
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));

import BiometricGate from './BiometricGate';
import CustomerDialogHost, { showCustomerAlert } from './brand/CustomerDialogHost';

beforeEach(() => {
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true });
});

afterEach(() => cleanup());

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
