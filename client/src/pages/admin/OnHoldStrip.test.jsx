// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OnHoldStrip from './OnHoldStrip';
import { adminFetch } from '../../utils/admin-fetch';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const ROW = {
  id: 'v-1', customerId: 'c-1', customerName: 'Pat Sample', serviceType: 'Quarterly Pest Control',
  scheduledDate: '2026-11-20', daysOnHold: 9, holdNote: 'will call after the trip', inSeries: true,
};

describe('OnHoldStrip', () => {
  it('reads nothing and renders nothing while the gate is off', () => {
    const { container } = render(<OnHoldStrip enabled={false} />);
    expect(adminFetch).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('offers Reschedule, handing the row to the page', async () => {
    adminFetch.mockResolvedValueOnce({ enabled: true, visits: [ROW] });
    const onReschedule = vi.fn();
    render(<OnHoldStrip enabled onReschedule={onReschedule} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reschedule' }));
    expect(onReschedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'v-1' }));
  });

  it('lists held visits with the note and how long, and Release hold removes the row', async () => {
    adminFetch.mockResolvedValueOnce({ enabled: true, visits: [ROW] });
    adminFetch.mockResolvedValueOnce({ success: true });
    const onChanged = vi.fn();
    render(<OnHoldStrip enabled onChanged={onChanged} />);
    expect(await screen.findByText(/On hold - customer will call \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Pat Sample/)).toBeInTheDocument();
    expect(screen.getByText(/on hold 9 days/)).toBeInTheDocument();
    expect(screen.getByText('will call after the trip')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Release hold' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(adminFetch).toHaveBeenLastCalledWith('/admin/schedule/v-1/hold/release', expect.objectContaining({ method: 'POST' }));
    expect(screen.queryByTestId('on-hold-strip')).not.toBeInTheDocument();
  });
});
