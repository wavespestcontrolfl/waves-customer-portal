// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import CallBookingConflictNotice from './CallBookingConflictNotice';

const conflict = {
  code: 'duplicate_call_booking',
  key: 'one-time',
  existingVisits: [
    { id: 'v1', serviceType: 'General Pest Control', scheduledDate: '2026-10-02', windowStart: '09:00', status: 'confirmed' },
    { id: 'v2', serviceType: 'General Pest Control', matchedService: 'Mosquito Control', scheduledDate: '2026-10-03', windowStart: null, status: 'pending' },
  ],
};

afterEach(() => { cleanup(); });

describe('CallBookingConflictNotice', () => {
  it('renders nothing without a conflict', () => {
    const { container } = render(<CallBookingConflictNotice conflict={null} canSubmit onBookAnother={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('lists each phone-agent visit by the line that matched, with an Open link; a missing time reads "No time set"', () => {
    render(<CallBookingConflictNotice conflict={conflict} canSubmit onBookAnother={() => {}} />);
    expect(screen.getByText('The phone agent already booked this')).toBeTruthy();
    expect(screen.getByText('General Pest Control · 2026-10-02 · 09:00 · confirmed')).toBeTruthy();
    // Matched through an add-on: the notice names that line (codex #5183 r3 P2).
    expect(screen.getByText('Mosquito Control (add-on to General Pest Control) · 2026-10-03 · No time set · pending')).toBeTruthy();
    const links = screen.getAllByRole('link', { name: 'Open existing visit' });
    expect(links[0].getAttribute('href')).toBe('/admin/dispatch?tab=schedule&date=2026-10-02&appointment=v1');
  });

  it('"Book another anyway" calls back, and is disabled while saving is blocked', () => {
    const onBookAnother = vi.fn();
    const { rerender } = render(<CallBookingConflictNotice conflict={conflict} canSubmit onBookAnother={onBookAnother} />);
    fireEvent.click(screen.getByRole('button', { name: 'Book another anyway' }));
    expect(onBookAnother).toHaveBeenCalledTimes(1);
    rerender(<CallBookingConflictNotice conflict={conflict} canSubmit={false} onBookAnother={onBookAnother} />);
    expect(screen.getByRole('button', { name: 'Book another anyway' }).disabled).toBe(true);
  });
});
