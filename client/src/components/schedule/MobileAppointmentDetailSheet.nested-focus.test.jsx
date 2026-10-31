// @vitest-environment jsdom
import { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./MobileCustomerDetailSheet', () => ({ default: () => null }));
vi.mock('./EstimateProvenanceCard', () => ({ default: () => null }));
vi.mock('../../hooks/useCustomerCards', () => ({
  useCustomerCards: () => ({ cards: [], loading: false, error: null }),
}));
vi.mock('../../lib/cardHoldCancel', () => ({
  confirmCardHoldFeeChoice: vi.fn(),
}));
vi.mock('../../hooks/useIsMobile', () => ({ default: () => true }));
vi.mock('./useBestTimes', () => ({
  useBestTimes: () => ({ pickedByTech: [], availability: null, checking: false }),
}));

import MobileAppointmentDetailSheet from './MobileAppointmentDetailSheet';

window.scrollTo = vi.fn();

const json = (body) => ({ ok: true, json: async () => body });

function Harness() {
  const [open, setOpen] = useState(false);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          setOpen(true);
        }}
      >
        Open appointment
      </button>
      {open && (
        <MobileAppointmentDetailSheet
          service={{
            id: 'visit-1',
            customerId: 'customer-1',
            customerName: 'Fixture Customer',
            serviceType: 'Fixture Pest Control',
            scheduledDate: today,
            windowStart: '10:00',
            windowEnd: '11:00',
            status: 'confirmed',
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/rain-out-options')) {
      return json({
        sameDay: [],
        days: [],
        service: { window: { start: '10:00', end: '11:00' } },
      });
    }
    return json({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MobileAppointmentDetailSheet nested focus containment', () => {
  it('keeps Tab and Escape inside the portaled Quick Move dialog, returns focus to its opener, then resumes the Details focus contract', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open appointment' });
    fireEvent.click(opener);
    const details = await screen.findByRole('dialog', { name: 'Appointment details' });
    await waitFor(() => expect(details).toHaveFocus());

    const quickMoveOpener = screen.getByRole('button', { name: 'Quick Move Appointment' });
    quickMoveOpener.focus();
    fireEvent.click(quickMoveOpener);
    const quickMove = screen.getByRole('dialog', { name: 'Quick Move Appointment' });
    // Focus moves into Quick Move, off the Details sheet underneath.
    await waitFor(() => expect(quickMove.contains(document.activeElement)).toBe(true));
    expect(details.contains(document.activeElement)).toBe(false);

    // Tab (and Shift+Tab) cycle inside Quick Move and never reach Details.
    for (let i = 0; i < 12; i += 1) {
      const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: i % 2 === 1, bubbles: true, cancelable: true });
      document.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(true);
      expect(quickMove.contains(document.activeElement)).toBe(true);
    }

    // Escape closes Quick Move only; Details stays and focus returns to the
    // control that opened Quick Move.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Quick Move Appointment' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Appointment details' })).toBeInTheDocument();
    expect(quickMoveOpener).toHaveFocus();

    // Details owns Tab and Escape again.
    const detailsTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(detailsTab);
    expect(detailsTab.defaultPrevented).toBe(true);
    expect(details.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Appointment details' })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});
