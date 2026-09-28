// @vitest-environment jsdom
import React, { useState } from 'react';
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
