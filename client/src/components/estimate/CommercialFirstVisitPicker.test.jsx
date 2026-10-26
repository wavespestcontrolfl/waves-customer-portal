// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CommercialFirstVisitPicker, { firstVisitLabel } from './CommercialFirstVisitPicker';

// "Pick your first visit" (GATE_COMMERCIAL_FIRST_VISIT): loads the open times, books one, and handles a taken time,
// an already-booked visit, a call-us answer and a failed load. Synthetic data only.
const DAY = {
  date: '2026-11-03',
  fullDate: 'Tuesday, November 3',
  dayOfWeek: 'Tue',
  dayNum: 3,
  month: 'Nov',
  slots: [
    { start_time: '09:00', end_time: '10:00', start_label: '9:00 AM' },
    { start_time: '13:00', end_time: '14:00', start_label: '1:00 PM' },
  ],
};
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function pickNineAm() {
  fireEvent.click(await screen.findByRole('button', { name: /Choose 9:00 AM on Tuesday, November 3/ }));
  return screen.findByRole('button', { name: 'Book this time' });
}

describe('CommercialFirstVisitPicker', () => {
  it('books the picked time and shows the booked visit', async () => {
    const fetchMock = vi.fn(async (url) => (url.endsWith('/availability')
      ? json(200, { ok: true, days: [DAY], slots: [] })
      : json(200, { booked: true, visit: { date: '2026-11-03', windowStart: '09:00', windowEnd: '10:00' } })));
    vi.stubGlobal('fetch', fetchMock);
    render(<CommercialFirstVisitPicker token="tok-1" durationMinutes={30} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Pick your first visit' })).toBeInTheDocument();
    fireEvent.click(await pickNineAm());
    expect(await screen.findByTestId('commercial-first-visit-booked')).toHaveTextContent('Tuesday, November 3 at 9 AM.');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/estimates/tok-1/first-visit');
    expect(JSON.parse(init.body)).toEqual({ date: '2026-11-03', time: '09:00' });
  });

  it('the Book button is the gold accent CTA', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { ok: true, days: [DAY], slots: [] })));
    render(<CommercialFirstVisitPicker token="tok-1" />);
    expect(await pickNineAm()).toHaveAttribute('data-glass-accent');
  });

  it('a time taken meanwhile reloads the times and says to pick another', async () => {
    let loads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.endsWith('/availability')) { loads += 1; return json(200, { ok: true, days: [DAY], slots: [] }); }
      return json(409, { code: 'slot_taken', error: 'That time is no longer open. Please pick another.' });
    }));
    render(<CommercialFirstVisitPicker token="tok-1" />);
    fireEvent.click(await pickNineAm());
    expect(await screen.findByRole('alert')).toHaveTextContent('That time was just taken. Please pick another.');
    expect(loads).toBe(2);
    expect(screen.queryByTestId('commercial-first-visit-booked')).not.toBeInTheDocument();
  });

  it('a double tap sends one booking', async () => {
    let release;
    const fetchMock = vi.fn((url) => (url.endsWith('/availability')
      ? Promise.resolve(json(200, { ok: true, days: [DAY], slots: [] }))
      : new Promise((resolve) => { release = () => resolve(json(200, { booked: true, visit: { date: '2026-11-03', windowStart: '09:00' } })); })));
    vi.stubGlobal('fetch', fetchMock);
    render(<CommercialFirstVisitPicker token="tok-1" />);
    const book = await pickNineAm();
    fireEvent.click(book);
    fireEvent.click(book);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/first-visit'))).toHaveLength(1);
    release();
    await screen.findByTestId('commercial-first-visit-booked');
  });

  it('already booked (another tab): shows the booked visit, no picker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { code: 'already_booked', visit: { date: '2026-11-03', windowStart: '13:00' } })));
    render(<CommercialFirstVisitPicker token="tok-1" />);
    expect(await screen.findByTestId('commercial-first-visit-booked')).toHaveTextContent('Tuesday, November 3 at 1 PM.');
  });

  it('call us (no booking location): the server message, no picker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { code: 'call_us', error: 'Please call us at (941) 297-5749 and we will book your first visit with you.' })));
    render(<CommercialFirstVisitPicker token="tok-1" />);
    expect(await screen.findByText(/we will book your first visit with you/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Choose/ })).not.toBeInTheDocument();
  });

  it('no open times: the call-us empty state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { ok: true, days: [], slots: [] })));
    render(<CommercialFirstVisitPicker token="tok-1" />);
    expect(await screen.findByText(/We don’t have an open time in the next two weeks/)).toBeInTheDocument();
  });

  it('a failed load offers a retry', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(json(200, { ok: true, days: [DAY], slots: [] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<CommercialFirstVisitPicker token="tok-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: /Choose 9:00 AM/ })).toBeInTheDocument();
  });
});

describe('firstVisitLabel', () => {
  it('reads the day and the start in the customer\'s words', () => {
    expect(firstVisitLabel({ date: '2026-11-03', windowStart: '09:30' })).toBe('Tuesday, November 3 at 9:30 AM');
    expect(firstVisitLabel({ date: '2026-11-03', windowStart: '13:00' })).toBe('Tuesday, November 3 at 1 PM');
    expect(firstVisitLabel({ date: '2026-11-03' })).toBe('Tuesday, November 3');
    expect(firstVisitLabel(null)).toBeNull();
  });
});
