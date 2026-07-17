// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../native/platform', () => ({
  isNativeApp: () => true,
  hasSessionToken: () => true,
}));
vi.mock('../native/biometric', () => ({
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
