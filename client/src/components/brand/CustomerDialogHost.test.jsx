// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CustomerDialogHost, { showCustomerAlert, showCustomerConfirm } from './CustomerDialogHost';

beforeEach(() => Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true }));
afterEach(() => cleanup());

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
});
