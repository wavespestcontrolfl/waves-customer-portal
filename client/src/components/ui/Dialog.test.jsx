// @vitest-environment jsdom
import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('contains focus while a pending fieldset disables every control', async () => {
    render(<Dialog open onClose={() => {}} aria-label="Saving visit"><fieldset disabled><input aria-label="Visit note" /><button>Complete</button></fieldset></Dialog>);
    const dialog = screen.getByRole('dialog', { name: 'Saving visit' });
    const panel = dialog.querySelector('[tabindex="-1"]');
    await waitFor(() => expect(panel).toHaveFocus());
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(panel).toHaveFocus();
  });
  it('uses the actual title ID and follows conditional titles and custom-ID changes', () => {
    const content = (id, showTitle = true) => (
      <Dialog open onClose={() => {}} aria-label={showTitle ? undefined : 'Edit customer'}>
        {showTitle && <DialogTitle id={id}>Edit customer</DialogTitle>}
      </Dialog>
    );
    const { rerender } = render(content('customer-edit-title'));
    for (const id of ['customer-edit-title', 'replacement-title', undefined]) {
      rerender(content(id));
      const dialog = screen.getByRole('dialog', { name: 'Edit customer' });
      const tokens = dialog.getAttribute('aria-labelledby').split(/\s+/);
      expect(tokens).toHaveLength(1);
      expect(document.getElementById(tokens[0])).toBe(screen.getByRole('heading', { name: 'Edit customer' }));
      if (id) expect(tokens[0]).toBe(id);
    }
    rerender(content('customer-edit-title', false));
    expect(screen.getByRole('dialog', { name: 'Edit customer' })).not.toHaveAttribute('aria-labelledby');
    rerender(content('customer-edit-title'));
    expect(screen.getByRole('dialog', { name: 'Edit customer' })).toHaveAttribute('aria-labelledby', 'customer-edit-title');
  });

  it('preserves an explicit label when a custom title is also present', () => {
    render(<Dialog open onClose={() => {}} aria-label="Customer action"><DialogTitle id="visible-title">Edit</DialogTitle></Dialog>);
    expect(screen.getByRole('dialog', { name: 'Customer action' })).not.toHaveAttribute('aria-labelledby');
  });

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

describe('Dialog layering', () => {
  it('paints at layer 120 by default and honors a caller layer above a higher overlay', () => {
    const { unmount } = render(
      <Dialog open onClose={() => {}} aria-label="Default layer">
        <div>Body</div>
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Default layer' }).style.zIndex).toBe('120');
    unmount();

    // The Customer 360 profile is a z-[1000] overlay; a dialog opened from
    // inside it must be able to sit above that layer.
    render(
      <Dialog open onClose={() => {}} aria-label="Raised layer" layer={1120}>
        <div>Body</div>
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Raised layer' }).style.zIndex).toBe('1120');
  });
});

describe('Dialog click boundary', () => {
  it('keeps clicks inside the dialog (and on its backdrop) from reaching the React ancestor that opened it', () => {
    const parentClick = vi.fn();
    const onClose = vi.fn();
    render(
      <div onClick={parentClick}>
        <Dialog open onClose={onClose} aria-label="Boundary">
          <button type="button">Inside</button>
        </Dialog>
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    expect(parentClick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Backdrop click closes THIS dialog only — the ancestor never hears it.
    const dialog = screen.getByRole('dialog', { name: 'Boundary' });
    fireEvent.click(dialog.firstChild);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });
});
