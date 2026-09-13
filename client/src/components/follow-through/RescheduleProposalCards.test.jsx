// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import RescheduleProposalCards from './RescheduleProposalCards';
import { adminFetch } from '../../utils/admin-fetch';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));

const ui = {
  Card: ({ children }) => <article>{children}</article>,
  Text: ({ children }) => <p>{children}</p>,
  Button: ({ secondary: _secondary, ...props }) => <button {...props} />,
  Select: (props) => <select {...props} />,
  Link: (props) => <a {...props} />,
};

const candidate = (id, date, start, end, address = '100 Test Lane') => ({
  id,
  status: 'confirmed',
  scheduled_date: date,
  current_window: { start_at: start, end_at: end },
  service_name: 'Pest control',
  property: { id: `property-${id}`, address_line1: address, city: 'Bradenton', state: 'FL', zip: '34205' },
  display_address: { address_line1: address, city: 'Bradenton', state: 'FL', zip: '34205' },
});

const FIRST = candidate('visit-a', '2026-10-10', '2026-10-10T13:00:00.000Z', '2026-10-10T15:00:00.000Z');
const SECOND = candidate('visit-b', '2026-10-12', '2026-10-12T18:00:00.000Z', '2026-10-12T20:00:00.000Z', '200 Test Lane');
const ROW = {
  id: 'proposal-1',
  call_log_id: 'call-1',
  updated_at: '2026-10-01T13:00:00.000Z',
  first_name: 'Synthetic',
  last_name: 'Caller',
  phone: '+15555550176',
  call_at: '2026-10-01T14:30:00.000Z',
  proposal: { quote: 'Please move it to one Thursday afternoon.', proposed_start_at: '2026-10-15T17:00:00.000Z' },
  requested_window: { start_at: '2026-10-15T17:00:00.000Z', end_at: '2026-10-15T19:00:00.000Z' },
  matched_visit_id: null,
  candidates: [FIRST, SECOND],
};
const FEED = { proposals_enabled: true, proposals: [ROW], has_more: false, next_offset: 100 };
const PREVIEW = {
  preview_hash: 'a'.repeat(64),
  visit_id: SECOND.id,
  from: { date: '2026-10-12', start: '14:00', end: '15:00' },
  new_date: '2026-10-15',
  new_window: { start: '13:00', end: '14:00' },
  selected: SECOND,
  customer: { id: 'customer-1', first_name: 'Synthetic', last_name: 'Caller' },
  quote: ROW.proposal.quote,
  overlap: { count: 0, appointments: [] },
  series: {
    collective: true,
    movableCount: 2,
    occurrenceIds: [SECOND.id, 'visit-future'],
    occurrences: [
      { id: SECOND.id, from_date: '2026-10-12', from_start: '14:00', from_end: '15:00', to_date: '2026-10-15', to_start: '13:00', to_end: '14:00' },
      { id: 'visit-future', from_date: '2026-11-12', from_start: '10:00', from_end: '11:30', to_date: '2026-11-15', to_start: '10:00', to_end: '11:30' },
    ],
    skippedCount: 1,
    exceptionCount: 1,
    conflictCount: 1,
  },
};

const LIST = '/admin/call-recordings/proposals?offset=0';

function selectSecond() {
  fireEvent.change(screen.getByLabelText('Appointment discussed for Synthetic Caller'), { target: { value: SECOND.id } });
}

beforeEach(() => {
  adminFetch.mockReset().mockResolvedValue(FEED);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('reschedule proposal review', () => {
  it('stays absent while the independent server proposal gate is off', async () => {
    adminFetch.mockResolvedValue({ proposals_enabled: false, proposals: [], has_more: false });
    const { container } = render(<RescheduleProposalCards ui={ui} />);
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith(LIST));
    expect(container).toBeEmptyDOMElement();
  });

  it('requires an explicit ambiguous appointment, previews exact series times, then applies the bound preview', async () => {
    adminFetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/preview')) return PREVIEW;
      if (url.endsWith('/apply')) return { outcome: 'applied', visitId: SECOND.id, newDate: '2026-10-15', newWindow: { start: '13:00', end: '14:00' }, warnings: ['Heads up: this booking overlaps another appointment.'] };
      if (!options) return FEED;
      throw new Error(`Unexpected request ${url}`);
    });
    render(<RescheduleProposalCards ui={ui} />);

    const select = await screen.findByLabelText('Appointment discussed for Synthetic Caller');
    expect(select).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Preview change' })).toBeDisabled();
    expect(screen.getByText('Caller said: “Please move it to one Thursday afternoon.”')).toBeInTheDocument();

    selectSecond();
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    await screen.findByRole('button', { name: 'Apply change' });
    expect(adminFetch).toHaveBeenCalledWith('/admin/call-recordings/proposals/proposal-1/preview', {
      method: 'POST', body: JSON.stringify({ visit_id: SECOND.id }),
    });
    expect(screen.getByText('Recurring plan impact (2 visits)')).toBeInTheDocument();
    expect(screen.getAllByText(/Oct 12, 2026 at 2:00 PM–3:00 PM ET → Thu, Oct 15, 2026 at 1:00 PM–2:00 PM ET/)).toHaveLength(2);
    expect(screen.getByText(/Nov 12, 2026 at 10:00 AM–11:30 AM ET → Sun, Nov 15, 2026 at 10:00 AM–11:30 AM ET/)).toBeInTheDocument();
    expect(screen.getByText(/landing date.*overlap.*another appointment/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/call-recordings/proposals/proposal-1/apply', {
      method: 'POST', body: JSON.stringify({ visit_id: SECOND.id, preview_hash: PREVIEW.preview_hash }),
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('No immediate message was sent; normal reminders continue.');
    expect(screen.getByRole('status')).toHaveTextContent('Heads up: this booking overlaps another appointment.');
    expect(screen.queryByRole('button', { name: 'Apply change' })).not.toBeInTheDocument();
  });

  it.each([false, true])('discloses actual selected-appointment overlaps before Apply (collective=%s)', async (collective) => {
    const reviewed = { ...PREVIEW, series: { ...PREVIEW.series, collective }, overlap: { count: 1, appointments: [{
      id: 'conflict-1', service_name: 'Lawn care', status: 'confirmed', scheduled_date: '2026-10-15',
      current_window: { start_at: '2026-10-15T17:30:00Z', end_at: '2026-10-15T18:30:00Z' },
    }] } };
    adminFetch.mockImplementation(async (url) => url.endsWith('/preview') ? reviewed : FEED);
    render(<RescheduleProposalCards ui={ui} />);
    await screen.findByLabelText('Appointment discussed for Synthetic Caller');
    selectSecond();
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    expect(await screen.findByText('Selected appointment overlaps 1 existing appointment:')).toBeInTheDocument();
    expect(screen.getByText(/Lawn care.*1:30 PM–2:30 PM ET.*confirmed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply change' })).toBeEnabled();
    expect(adminFetch.mock.calls.some(([url]) => url.endsWith('/apply'))).toBe(false);
  });

  it('requires a complete overlap check before enabling Apply', async () => {
    adminFetch.mockImplementation(async (url) => url.endsWith('/preview') ? { ...PREVIEW, overlap: undefined } : FEED);
    render(<RescheduleProposalCards ui={ui} />);
    await screen.findByLabelText('Appointment discussed for Synthetic Caller');
    selectSecond();
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The preview was incomplete.');
    expect(screen.queryByRole('button', { name: 'Apply change' })).not.toBeInTheDocument();
  });

  it('clears a preview when the appointment selection changes', async () => {
    adminFetch.mockImplementation(async (url) => url.endsWith('/preview') ? PREVIEW : FEED);
    render(<RescheduleProposalCards ui={ui} />);
    await screen.findByLabelText('Appointment discussed for Synthetic Caller');
    selectSecond();
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    await screen.findByRole('button', { name: 'Apply change' });

    fireEvent.change(screen.getByLabelText('Appointment discussed for Synthetic Caller'), { target: { value: FIRST.id } });
    expect(screen.queryByRole('button', { name: 'Apply change' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preview for Synthetic Caller')).not.toBeInTheDocument();
  });

  it('requires a staff choice for a sole candidate and when another candidate appears', async () => {
    const unique = { ...ROW, candidates: [FIRST], matched_visit_id: FIRST.id };
    adminFetch.mockResolvedValueOnce({ ...FEED, proposals: [unique] }).mockResolvedValue(FEED);
    render(<RescheduleProposalCards ui={ui} />);
    expect(await screen.findByLabelText('Appointment discussed for Synthetic Caller')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Preview change' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Apply change' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByLabelText('Appointment discussed for Synthetic Caller')).toHaveValue(''));
    expect(screen.getByRole('button', { name: 'Preview change' })).toBeDisabled();
  });

  it('retains only a deliberate staff selection when the candidate list expands', async () => {
    const unique = { ...ROW, candidates: [FIRST], matched_visit_id: FIRST.id };
    adminFetch.mockResolvedValueOnce({ ...FEED, proposals: [unique] }).mockResolvedValue(FEED);
    render(<RescheduleProposalCards ui={ui} />);
    const select = await screen.findByLabelText('Appointment discussed for Synthetic Caller');
    expect(select).toHaveValue('');
    fireEvent.change(select, { target: { value: FIRST.id } });
    expect(screen.getByRole('button', { name: 'Preview change' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('option', { name: /200 Test Lane/ });
    expect(select).toHaveValue(FIRST.id);
    expect(screen.queryByRole('button', { name: 'Apply change' })).not.toBeInTheDocument();
  });

  it('rejects an incomplete preview instead of exposing Apply', async () => {
    adminFetch.mockImplementation(async (url) => url.endsWith('/preview')
      ? { ...PREVIEW, preview_hash: 'not-bound' }
      : FEED);
    render(<RescheduleProposalCards ui={ui} />);
    await screen.findByLabelText('Appointment discussed for Synthetic Caller');
    selectSecond();
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The preview was incomplete. Refresh and try again.');
    expect(screen.queryByRole('button', { name: 'Apply change' })).not.toBeInTheDocument();
  });

  it('accepts a bound preview whose eligible appointment has no current window', async () => {
    const noWindow = { ...PREVIEW, selected: { ...SECOND, property: null, current_window: null }, from: null };
    adminFetch.mockImplementation(async (url) => url.endsWith('/preview') ? noWindow : FEED);
    render(<RescheduleProposalCards ui={ui} />);
    await screen.findByLabelText('Appointment discussed for Synthetic Caller');
    selectSecond();
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));

    expect(await screen.findByRole('button', { name: 'Apply change' })).toBeEnabled();
    expect(screen.getByText(/Current appointment: Pest control · .*time needs review/)).toBeInTheDocument();
  });

  it('replaces list identity with the server-bound customer, quote, service and property before Apply', async () => {
    const reviewed = {
      ...PREVIEW,
      selected: { ...SECOND, service_name: 'Termite inspection', property: { ...SECOND.property, address_line1: '999 Reviewed Avenue' }, display_address: { ...SECOND.display_address, address_line1: '999 Reviewed Avenue' } },
      customer: { id: 'customer-1', first_name: 'Reviewed', last_name: 'Customer' },
      quote: 'Thursday at one works for me.',
    };
    adminFetch.mockImplementation(async (url) => url.endsWith('/preview') ? reviewed : FEED);
    render(<RescheduleProposalCards ui={ui} />);
    await screen.findByLabelText('Appointment discussed for Synthetic Caller');
    selectSecond();
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));

    await screen.findByRole('button', { name: 'Apply change' });
    expect(screen.getByText('Reschedule request · Reviewed Customer')).toBeInTheDocument();
    expect(screen.getByText('Caller said: “Thursday at one works for me.”')).toBeInTheDocument();
    expect(screen.getByText(/Current appointment: Termite inspection .*999 Reviewed Avenue/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Termite inspection .*999 Reviewed Avenue/ })).toBeInTheDocument();
  });

  it('keeps the selected appointment but requires a fresh preview after a stale Apply', async () => {
    let applyCalls = 0;
    adminFetch.mockImplementation(async (url) => {
      if (url.endsWith('/preview')) return PREVIEW;
      if (url.endsWith('/apply')) {
        applyCalls += 1;
        throw new Error('The appointment changed. Refresh the proposal.');
      }
      return FEED;
    });
    render(<RescheduleProposalCards ui={ui} />);
    await screen.findByLabelText('Appointment discussed for Synthetic Caller');
    selectSecond();
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply change' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The appointment changed. Refresh the proposal.');
    expect(applyCalls).toBe(1);
    expect(screen.getByLabelText('Appointment discussed for Synthetic Caller')).toHaveValue(SECOND.id);
    expect(screen.queryByRole('button', { name: 'Apply change' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    expect(await screen.findByRole('button', { name: 'Apply change' })).toBeEnabled();
  });

  it('suspends focus refresh while a preview is open and lets explicit Refresh invalidate it', async () => {
    adminFetch.mockImplementation(async (url) => url.endsWith('/preview') ? PREVIEW : FEED);
    render(<RescheduleProposalCards ui={ui} />);
    await screen.findByLabelText('Appointment discussed for Synthetic Caller');
    selectSecond();
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    await screen.findByRole('button', { name: 'Apply change' });
    adminFetch.mockClear();

    fireEvent(window, new Event('focus'));
    expect(adminFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith(LIST));
    expect(screen.queryByRole('button', { name: 'Apply change' })).not.toBeInTheDocument();
  });

  it('fences an older list read when a review action starts', async () => {
    let releaseRead;
    let listCalls = 0;
    adminFetch.mockImplementation((url) => {
      if (url.endsWith('/preview')) return Promise.resolve(PREVIEW);
      listCalls += 1;
      if (listCalls === 1) return Promise.resolve(FEED);
      return new Promise((resolve) => { releaseRead = () => resolve(FEED); });
    });
    render(<RescheduleProposalCards ui={ui} />);
    await screen.findByLabelText('Appointment discussed for Synthetic Caller');
    selectSecond();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(releaseRead).toBeTypeOf('function'));

    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    expect(await screen.findByRole('button', { name: 'Apply change' })).toBeEnabled();
    releaseRead();
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('button', { name: 'Apply change' })).toBeEnabled();
  });

  it('dismisses with the list version and reports that no appointment changed', async () => {
    adminFetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/dismiss')) return { dismissed: true };
      if (!options) return FEED;
      throw new Error(`Unexpected request ${url}`);
    });
    render(<RescheduleProposalCards ui={ui} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss proposal' }));

    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/call-recordings/proposals/proposal-1/dismiss', {
      method: 'POST', body: JSON.stringify({ expected_at: ROW.updated_at }),
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('No appointment changed.');
  });

  it('keeps loaded pages and re-reads them on refresh', async () => {
    const nextRow = { ...ROW, id: 'proposal-2', first_name: 'Second', candidates: [{ ...FIRST, id: 'visit-c' }] };
    adminFetch.mockImplementation(async (url) => url.endsWith('offset=100')
      ? { ...FEED, proposals: [nextRow] }
      : { ...FEED, has_more: true });
    render(<RescheduleProposalCards ui={ui} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more proposals' }));
    await screen.findByText('Reschedule request · Second Caller');
    adminFetch.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(adminFetch.mock.calls.map(([url]) => url)).toEqual([LIST, '/admin/call-recordings/proposals?offset=100']));
    expect(screen.getByText('Reschedule request · Synthetic Caller')).toBeInTheDocument();
    expect(screen.getByText('Reschedule request · Second Caller')).toBeInTheDocument();
  });
});


it('requires an address to preview an appointment', async () => {
  adminFetch.mockResolvedValue({ ...FEED, proposals: [{ ...ROW, candidates: [{ ...FIRST, display_address: null }] }] });
  render(<RescheduleProposalCards ui={ui} />);
  fireEvent.change(await screen.findByLabelText('Appointment discussed for Synthetic Caller'), { target: { value: FIRST.id } });
  await screen.findByText('The appointment address needs review. Use the schedule editor.');
  expect(screen.getByRole('button', { name: 'Preview change' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Apply change' })).not.toBeInTheDocument();
});
