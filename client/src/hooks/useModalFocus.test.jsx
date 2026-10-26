// @vitest-environment jsdom
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import useModalFocus from './useModalFocus';

afterEach(cleanup);

function NestedDialog({ onClose }) {
  const ref = useModalFocus(true);
  return (
    <div ref={ref} role="dialog" aria-label="Nested dialog">
      <button>Nested first</button>
      <button disabled>Disabled choice</button>
      <button hidden>Hidden choice</button>
      <button tabIndex={-1}>Negative choice</button>
      <details><summary>More choices</summary><button>Closed detail choice</button></details>
      <span style={{ display: 'none' }}><button>CSS-hidden choice</button></span>
      <button onClick={onClose}>Close nested</button>
    </div>
  );
}

function OuterDialog({ onClose }) {
  const ref = useModalFocus(true);
  const [nested, setNested] = useState(false);
  return (
    <div ref={ref} role="dialog" aria-label="Outer dialog">
      <button>Outer action</button>
      <button onClick={() => setNested(true)}>Open nested</button>
      <button onClick={onClose}>Close outer</button>
      {nested && <NestedDialog onClose={() => setNested(false)} />}
    </div>
  );
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open outer</button>
      {open && <OuterDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function LegacyPortaledDialog({ onClose }) {
  return createPortal(
    <div role="dialog" aria-label="Legacy portaled dialog">
      <button>Legacy first</button>
      <button onClick={onClose}>Close legacy</button>
    </div>,
    document.body,
  );
}

function SuspendedOuterDialog({ onClose }) {
  const [nested, setNested] = useState(false);
  const ref = useModalFocus(true, null, !nested);
  return (
    <div ref={ref} role="dialog" aria-label="Suspended outer dialog">
      <button>Outer first</button>
      <button
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          setNested(true);
        }}
      >
        Open legacy
      </button>
      <button onClick={onClose}>Close suspended outer</button>
      {nested && <LegacyPortaledDialog onClose={() => setNested(false)} />}
    </div>
  );
}

function SuspendedHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open suspended outer</button>
      {open && <SuspendedOuterDialog onClose={() => setOpen(false)} />}
    </>
  );
}

describe('useModalFocus', () => {
  it('keeps every Tab step in the top modal and skips unavailable controls', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open outer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open nested' }));
    const nested = screen.getByRole('dialog', { name: 'Nested dialog' });
    await waitFor(() => expect(nested).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Nested first' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByText('More choices')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close nested' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Nested first' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Close nested' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByText('More choices')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Nested first' })).toHaveFocus();
  });

  it('restores the nested opener, then the original opener as dialogs close', async () => {
    render(<Harness />);
    const originalOpener = screen.getByRole('button', { name: 'Open outer' });
    originalOpener.focus();
    fireEvent.click(originalOpener);
    const nestedOpener = screen.getByRole('button', { name: 'Open nested' });
    nestedOpener.focus();
    fireEvent.click(nestedOpener);
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Nested dialog' })).toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: 'Close nested' }));
    await waitFor(() => expect(nestedOpener).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Close outer' }));
    await waitFor(() => expect(originalOpener).toHaveFocus());
  });

  it('suspends containment for a legacy portaled child, then resumes it without losing the original opener', async () => {
    render(<SuspendedHarness />);
    const originalOpener = screen.getByRole('button', { name: 'Open suspended outer' });
    originalOpener.focus();
    fireEvent.click(originalOpener);
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Suspended outer dialog' })).toHaveFocus());

    const nestedOpener = screen.getByRole('button', { name: 'Open legacy' });
    fireEvent.click(nestedOpener);
    const legacyFirst = screen.getByRole('button', { name: 'Legacy first' });
    legacyFirst.focus();
    const childTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(childTab);
    expect(childTab.defaultPrevented).toBe(false);
    expect(legacyFirst).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Close legacy' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Legacy portaled dialog' })).not.toBeInTheDocument());
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Outer first' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Close suspended outer' }));
    await waitFor(() => expect(originalOpener).toHaveFocus());
  });

  it('matches native Tab stops for named radio groups and their form owners', async () => {
    function RadioDialog() {
      const ref = useModalFocus(true);
      return (
        <div ref={ref} role="dialog" aria-label="Radio dialog">
          <button>Before radios</button>
          <form>
            <input type="radio" name="plan" aria-label="Main unchecked" />
            <input type="radio" name="plan" aria-label="Main checked" defaultChecked />
            <input type="radio" name="fallback" aria-label="Fallback first" />
            <input type="radio" name="fallback" aria-label="Fallback second" />
          </form>
          <form>
            <input type="radio" name="plan" aria-label="Other unchecked" />
            <input type="radio" name="plan" aria-label="Other checked" defaultChecked />
          </form>
          <button>After radios</button>
        </div>
      );
    }

    render(<RadioDialog />);
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Radio dialog' })).toHaveFocus());
    const stops = [['button', 'Before radios'], ['radio', 'Main checked'], ['radio', 'Fallback first'], ['radio', 'Other checked'], ['button', 'After radios'], ['button', 'Before radios']];
    for (const [role, name] of stops) {
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(screen.getByRole(role, { name })).toHaveFocus();
    }
  });
});
