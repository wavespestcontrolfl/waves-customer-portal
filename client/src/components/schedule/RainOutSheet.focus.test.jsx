// @vitest-environment jsdom
import { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../hooks/useIsMobile', () => ({ default: () => false }));
vi.mock('./useBestTimes', () => ({
  useBestTimes: () => ({ pickedByTech: [], availability: null, checking: false }),
}));

import RainOutSheet from './RainOutSheet';

const json = (body) => ({ ok: true, json: async () => body });

function Harness({ onDone }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open quick move</button>
      <button type="button">Other control behind</button>
      {open && (
        <RainOutSheet
          service={{ id: 'visit-1', customerId: 'c-1', customerName: 'Fixture Customer' }}
          onClose={() => setOpen(false)}
          onDone={onDone}
        />
      )}
    </>
  );
}

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/rain-out-options')) {
      return json({
        sameDay: [], days: [{ kind: 'day', date: '2099-01-02', window: { start: '09:00', end: '10:00' }, display: 'Fri, Jan 2, 9:00 AM-10:00 AM' }],
        service: { window: { start: '10:00', end: '11:00' } }, remainingRouteCount: 0,
      });
    }
    return json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

async function openSheet() {
  render(<Harness onDone={vi.fn()} />);
  const opener = screen.getByRole('button', { name: 'Open quick move' });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole('dialog', { name: 'Quick Move Appointment' });
  await screen.findByRole('combobox', { name: 'Reason' });
  return { opener, dialog };
}

describe('Quick Move sheet keyboard focus', () => {
  it('moves focus into the dialog on open, away from the control that opened it', async () => {
    const { opener, dialog } = await openSheet();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(opener).not.toHaveFocus();
  });

  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    const { dialog } = await openSheet();
    const behind = screen.getByRole('button', { name: 'Other control behind' });
    const stops = new Set();
    for (let i = 0; i < 40; i += 1) {
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(dialog.contains(document.activeElement)).toBe(true);
      stops.add(document.activeElement);
    }
    expect(stops.size).toBeGreaterThan(3);
    expect(behind).not.toHaveFocus();
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(back);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const { opener } = await openSheet();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Quick Move Appointment' })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('gives the Custom time date and start inputs accessible names', async () => {
    const { dialog } = await openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: /Custom time/ }));
    const date = within(dialog).getByLabelText('DATE');
    const start = within(dialog).getByLabelText('START (ON THE HOUR)');
    expect(date).toHaveAttribute('type', 'date');
    expect(date).toHaveValue('2099-01-02');
    expect(start).toHaveAttribute('type', 'time');
    expect(date.id).not.toBe(start.id);
  });

  it('shows the dialog’s own notices and labels at 14px or larger', async () => {
    const { dialog } = await openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: /Custom time/ }));
    const small = [...dialog.querySelectorAll('[style]')]
      .filter((el) => /font-size:\s*(1[0-3]|[0-9])px/.test(el.getAttribute('style')));
    expect(small.map((el) => el.textContent)).toEqual([]);
  });
});
