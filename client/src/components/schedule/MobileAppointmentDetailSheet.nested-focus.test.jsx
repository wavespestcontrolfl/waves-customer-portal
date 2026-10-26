// @vitest-environment jsdom
import { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('does not pull Tab behind the real portaled Quick Move dialog and resumes its own focus contract afterward', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open appointment' });
    fireEvent.click(opener);
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Appointment details' })).toHaveFocus());

    const quickMoveOpener = screen.getByRole('button', { name: 'Quick Move Appointment' });
    quickMoveOpener.focus();
    fireEvent.click(quickMoveOpener);
    const quickMove = screen.getByRole('dialog', { name: 'Quick Move Appointment' });
    const quickMoveClose = within(quickMove).getByRole('button', { name: 'Close' });
    quickMoveClose.focus();

    const childTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(childTab);
    expect(childTab.defaultPrevented).toBe(false);
    expect(quickMoveClose).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Quick Move Appointment' })).toBeInTheDocument();

    fireEvent.click(quickMoveClose);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Quick Move Appointment' })).not.toBeInTheDocument());
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Appointment details' })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});
