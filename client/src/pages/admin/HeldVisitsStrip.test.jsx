// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HeldVisitsStrip, { heldVisitFormDefaults } from './HeldVisitsStrip';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const timed = {
  call_log_id: 'call-1', kind: 'confirmed', date_et: '2026-10-14', minutes: 660, time_label: '11:00 AM',
  caller_name: 'Pat Sample', phone: '+19415550100', address: { line1: '12 Test Lane', city: 'Bradenton', zip: '34205' },
  service: 'General Pest Control', call_at: '2026-10-12T14:30:00.000Z', customer_id: 'cust-1', notes: null,
};
const dayOnly = {
  ...timed, call_log_id: 'call-2', kind: 'day_only', minutes: null, time_label: null,
  caller_name: 'Lee Sample', customer_id: null, phone: '+15005550006',
};

describe('HeldVisitsStrip', () => {
  it('renders each held visit with its time, caller, address, service, call time and phone', () => {
    render(<HeldVisitsStrip heldVisits={[timed]} onBook={() => {}} />);
    expect(screen.getByText('From calls, not on the calendar')).toBeInTheDocument();
    expect(screen.getByText('11:00 AM')).toBeInTheDocument();
    expect(screen.getByText('Pat Sample')).toBeInTheDocument();
    expect(screen.getByText('12 Test Lane, Bradenton · General Pest Control')).toBeInTheDocument();
    expect(screen.getByText(/Promised on a call Monday, 10:30 AM/)).toBeInTheDocument();
    expect(screen.getByText('+19415550100')).toBeInTheDocument();
    expect(screen.getByText('PROMISED · not booked')).toBeInTheDocument();
  });

  it('shows "Time not set" for a day-only row', () => {
    render(<HeldVisitsStrip heldVisits={[dayOnly]} onBook={() => {}} />);
    expect(screen.getByText('Time not set')).toBeInTheDocument();
  });

  it('shows the part of the day the caller asked for and the scheduling note from the call', () => {
    render(<HeldVisitsStrip heldVisits={[{ ...dayOnly, daypart: 'morning', notes: 'Caller can meet after 10:30.' }]} onBook={() => {}} />);
    expect(screen.getByText('Time not set · asked for the morning')).toBeInTheDocument();
    expect(screen.getByText('From the call: Caller can meet after 10:30.')).toBeInTheDocument();
  });

  it('shows the unit the caller stated', () => {
    render(<HeldVisitsStrip heldVisits={[{ ...timed, address: { line1: '40 Sample Rd', line2: 'Unit 4', city: 'Bradenton', zip: '34205' } }]} onBook={() => {}} />);
    expect(screen.getByText('40 Sample Rd, Unit 4, Bradenton · General Pest Control')).toBeInTheDocument();
  });

  it('never calls a day-only row a promise', () => {
    render(<HeldVisitsStrip heldVisits={[dayOnly]} onBook={() => {}} />);
    expect(screen.getByText('NOT CONFIRMED · not booked')).toBeInTheDocument();
    expect(screen.getByText(/Day discussed on a call Monday, 10:30 AM/)).toBeInTheDocument();
    expect(screen.queryByText(/Promised/)).not.toBeInTheDocument();
  });

  it('says an off-hour time cannot be booked as is', () => {
    render(<HeldVisitsStrip heldVisits={[{ ...timed, minutes: 870, time_label: '2:30 PM' }]} onBook={() => {}} />);
    expect(screen.getByText('Visits start on the hour. Agree a whole-hour time with the caller; the form does not take 2:30 PM and opens with no time selected.')).toBeInTheDocument();
  });

  it('links Open call to the call in Communications', () => {
    render(<HeldVisitsStrip heldVisits={[timed]} onBook={() => {}} />);
    expect(screen.getByRole('link', { name: 'Open call' })).toHaveAttribute('href', '/admin/communications#tab=calls&call=call-1');
  });

  it('renders nothing for an empty or missing list', () => {
    const { container, rerender } = render(<HeldVisitsStrip heldVisits={[]} onBook={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<HeldVisitsStrip heldVisits={undefined} onBook={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('calls its handler with the row when Book it is pressed', () => {
    const onBook = vi.fn();
    render(<HeldVisitsStrip heldVisits={[timed, dayOnly]} onBook={onBook} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Book it' })[1]);
    expect(onBook).toHaveBeenCalledWith(dayOnly);
  });
});

// Owner 2026-10-19: a move agreed for this day with no time. It books nothing; the button
// opens the visit that would move.
describe('a day-only move row', () => {
  const move = {
    ...timed, call_log_id: 'call-mv', kind: 'move_day_only', minutes: null, time_label: null, daypart: null,
    from_date_et: '2026-11-06', from_visit_id: 'visit-old',
  };

  it('says the move, the day it moves from and that the time is not set, and is not confirmed', () => {
    render(<HeldVisitsStrip heldVisits={[move]} onBook={() => {}} />);
    expect(screen.getByText('Time not set')).toBeInTheDocument();
    expect(screen.getByText('NOT CONFIRMED · not moved')).toBeInTheDocument();
    expect(screen.getByText(/Move discussed on a call \u2014 from Fri, Nov 6, time not set \(call Monday, 10:30 AM\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Promised/)).not.toBeInTheDocument();
  });

  it('opens the visit to move instead of booking, with no Book it button', () => {
    const onBook = vi.fn();
    render(<HeldVisitsStrip heldVisits={[move]} onBook={onBook} />);
    expect(screen.queryByRole('button', { name: 'Book it' })).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open the Fri, Nov 6 visit' });
    expect(link).toHaveAttribute('href', '/admin/dispatch?tab=schedule&date=2026-11-06&appointment=visit-old');
    expect(onBook).not.toHaveBeenCalled();
  });

  it('falls back to the old day\'s schedule when the visit id is missing', () => {
    render(<HeldVisitsStrip heldVisits={[{ ...move, from_visit_id: null }]} onBook={() => {}} />);
    // No single visit named: the words say "schedule", never "the visit" (Codex #6345 r3).
    expect(screen.getByRole('link', { name: 'Open Fri, Nov 6 on the schedule' })).toHaveAttribute('href', '/admin/dispatch?tab=schedule&date=2026-11-06');
  });
});

describe('heldVisitFormDefaults (what Book it opens the form on)', () => {
  it('a whole-hour confirmed slot: the time, the call marker and the stated address', () => {
    expect(heldVisitFormDefaults(timed)).toEqual({
      date: '2026-10-14', windowStart: '11:00', requireTimeChoice: false,
      internalNotes: 'Booked from a phone call. Call ID: call-1. Address stated on the call: 12 Test Lane, Bradenton, 34205.',
    });
  });

  it('an off-hour slot or a day-only row: no time, a required choice, and what the call said in the notes', () => {
    const offHour = heldVisitFormDefaults({ ...timed, minutes: 870, time_label: '2:30 PM' });
    expect(offHour).toMatchObject({ windowStart: undefined, requireTimeChoice: true });
    expect(offHour.internalNotes).toContain('Time agreed on the call: 2:30 PM.');
    const day = heldVisitFormDefaults({ ...dayOnly, daypart: 'morning', address: { line1: '40 Sample Rd', line2: 'Unit 4', city: 'Bradenton', zip: '34205' } });
    expect(day).toMatchObject({ windowStart: undefined, requireTimeChoice: true });
    expect(day).not.toHaveProperty('addressLine1');
    expect(day.internalNotes).toBe('Booked from a phone call. Call ID: call-2. The caller asked for the morning. Address stated on the call: 40 Sample Rd, Unit 4, Bradenton, 34205.');
  });
});
