// @vitest-environment jsdom
import React, { useRef } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function FocusFallbackHarness({ open, showTransientOpener }) {
  const fallbackRef = useRef(null);
  const dialogRef = useModalFocus(open, null, fallbackRef);
  return (
    <>
      <button ref={fallbackRef} type="button">Stable trigger</button>
      {showTransientOpener && <button type="button">Transient trigger</button>}
      {open && <div ref={dialogRef} role="dialog" aria-label="Fallback modal"><button type="button">Inside</button></div>}
    </>
  );
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
    await waitFor(() => expect(dialog).toHaveAttribute('tabindex', '-1'));

    fireEvent.keyDown(document, { key: 'Escape' });

    await expect(result).resolves.toBe(false);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  }, 10000);

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

  it('keeps global dialogs out of the DOM while the biometric privacy lock is active', async () => {
    const { rerender } = render(
      <BiometricLockContext.Provider value>
        <CustomerDialogHost />
      </BiometricLockContext.Provider>,
    );

    const result = showCustomerAlert('A background request finished.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(
      <BiometricLockContext.Provider value={false}>
        <CustomerDialogHost />
      </BiometricLockContext.Provider>,
    );
    expect(await screen.findByRole('dialog', { name: 'Something went wrong' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await expect(result).resolves.toBe(true);
  });

  it('restores focus to a stable fallback when a menu opener unmounts', () => {
    const { rerender } = render(<FocusFallbackHarness open={false} showTransientOpener />);
    screen.getByRole('button', { name: 'Transient trigger' }).focus();

    rerender(<FocusFallbackHarness open showTransientOpener />);
    expect(screen.getByRole('dialog', { name: 'Fallback modal' })).toHaveFocus();

    rerender(<FocusFallbackHarness open={false} showTransientOpener={false} />);
    expect(screen.getByRole('button', { name: 'Stable trigger' })).toHaveFocus();
  });
});
