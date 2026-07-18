// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useModalFocus from '../../hooks/useModalFocus';
import { BiometricLockContext } from '../BiometricGate';
import CustomerDialogHost, { showCustomerAlert, showCustomerConfirm } from './CustomerDialogHost';

beforeEach(() => Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true }));
afterEach(() => cleanup());

function UnderlyingModal({ onEscape }) {
  const dialogRef = useModalFocus(true, onEscape);
  return <div ref={dialogRef} role="dialog" aria-label="Underlying modal" />;
}

describe('CustomerDialogHost', () => {
  it('renders confirmations as glass alert dialogs and treats Escape as cancel', async () => {
    render(<CustomerDialogHost />);

    const result = showCustomerConfirm('Remove this payment method?', {
      title: 'Remove payment method?',
      confirmLabel: 'Remove',
      danger: true,
    });

    const dialog = await screen.findByRole('alertdialog', { name: 'Remove payment method?' });
    expect(dialog).toHaveAttribute('data-glass', 'modal');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });

    await expect(result).resolves.toBe(false);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('resolves alerts after the customer acknowledges them', async () => {
    render(<CustomerDialogHost />);

    const result = showCustomerAlert('Could not save the PDF. Please try again.');
    const button = await screen.findByRole('button', { name: 'OK' });
    fireEvent.click(button);

    await expect(result).resolves.toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps an underlying modal open when Escape dismisses a stacked alert', async () => {
    const closeUnderlying = vi.fn();
    render(
      <>
        <UnderlyingModal onEscape={closeUnderlying} />
        <CustomerDialogHost />
      </>,
    );

    const result = showCustomerAlert('The request could not be submitted.');
    await screen.findByRole('dialog', { name: 'Something went wrong' });

    fireEvent.keyDown(document, { key: 'Escape' });

    await expect(result).resolves.toBe(false);
    expect(closeUnderlying).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Underlying modal' })).toBeInTheDocument();
  });

  it('queues dialogs while the biometric lock is active and shows them on unlock', async () => {
    const { rerender } = render(
      <BiometricLockContext.Provider value={true}>
        <CustomerDialogHost />
      </BiometricLockContext.Provider>,
    );

    const result = showCustomerAlert('Your card could not be charged.');
    // Locked: nothing may portal under document.body where AT could reach it.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(
      <BiometricLockContext.Provider value={false}>
        <CustomerDialogHost />
      </BiometricLockContext.Provider>,
    );

    const button = await screen.findByRole('button', { name: 'OK' });
    fireEvent.click(button);
    await expect(result).resolves.toBe(true);
  });
});
