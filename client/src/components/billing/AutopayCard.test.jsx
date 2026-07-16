// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './AutopayCard';

beforeEach(() => {
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Auto Pay modal', () => {
  it('is a labelled, focus-managed dialog with a scroll-safe phone layout', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Set up Auto Pay" onClose={onClose}>
        <button type="button">Save card</button>
      </Modal>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Set up Auto Pay' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveStyle({ overflowY: 'auto' });
    expect(dialog.style.maxHeight).toContain('100dvh');
    expect(dialog).toHaveFocus();

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveStyle({ width: '44px', height: '44px' });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cannot be dismissed from the scrim, close button, or Escape while saving', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Saving payment method" onClose={onClose} closeDisabled>
        <div>Saving…</div>
      </Modal>,
    );

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toBeDisabled();
    fireEvent.click(close);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog', { name: 'Saving payment method' }).parentElement);
    expect(onClose).not.toHaveBeenCalled();
  });
});
