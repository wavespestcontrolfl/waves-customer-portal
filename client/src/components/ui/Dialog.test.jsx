// @vitest-environment jsdom
import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog, DialogTitle } from './Dialog';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open filters</button>
      <Dialog open={open} onClose={() => setOpen(false)}>
        <DialogTitle>Filter customers</DialogTitle>
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </Dialog>
    </>
  );
}

describe('Dialog keyboard accessibility', () => {
  it('names the dialog, contains Tab focus, closes on Escape, and restores focus', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open filters' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Filter customers' });
    expect(dialog).toBeInTheDocument();
    const first = screen.getByRole('button', { name: 'First action' });
    const last = screen.getByRole('button', { name: 'Last action' });
    await waitFor(() => expect(dialog.querySelector('[tabindex="-1"]')).toHaveFocus());
    expect(document.body).toHaveStyle({ overflow: 'hidden' });

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(document.body).not.toHaveStyle({ overflow: 'hidden' });
  });

  it('honors an explicit aria-label for titleless dialogs', () => {
    render(
      <Dialog open onClose={() => {}} aria-label="Confirmation">
        <div>Are you sure?</div>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Confirmation' });
    expect(dialog).not.toHaveAttribute('aria-labelledby');
  });

  it('never points aria-labelledby at a title that does not render', () => {
    render(
      <Dialog open onClose={() => {}}>
        <div>Body-only dialog</div>
      </Dialog>,
    );

    // No DialogTitle mounted — a generated aria-labelledby would be a
    // dangling reference, so the attribute must be absent entirely.
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-labelledby');
  });
});
