// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HeldVisitsStrip from './HeldVisitsStrip';

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
    expect(screen.getByText('Promised on a call, not booked')).toBeInTheDocument();
    expect(screen.getByText('11:00 AM')).toBeInTheDocument();
    expect(screen.getByText('Pat Sample')).toBeInTheDocument();
    expect(screen.getByText('12 Test Lane, Bradenton · General Pest Control')).toBeInTheDocument();
    expect(screen.getByText(/Promised on a call Monday, 10:30 AM/)).toBeInTheDocument();
    expect(screen.getByText('+19415550100')).toBeInTheDocument();
    expect(screen.getByText('HELD · not booked')).toBeInTheDocument();
  });

  it('shows "Time not set" for a day-only row', () => {
    render(<HeldVisitsStrip heldVisits={[dayOnly]} onBook={() => {}} />);
    expect(screen.getByText('Time not set')).toBeInTheDocument();
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
