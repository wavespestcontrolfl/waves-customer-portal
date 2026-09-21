// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../glass/glass-engine', () => ({ useGlassSurface: () => {} }));

import CareersInterviewPage from './CareersInterviewPage';

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function openPayload(overrides = {}) {
  return {
    first_name: 'Jordan',
    status: 'open',
    mode_options: ['phone', 'in_person'],
    in_person_address: '13649 Luxe Ave #110, Bradenton',
    timezone: 'America/New_York',
    booked: null,
    slots: [
      { start: '2026-09-22T20:30:00.000Z', end: '2026-09-22T21:00:00.000Z', date: '2026-09-22', label: 'Tue Sep 22, 4:30 PM' },
      { start: '2026-09-22T21:00:00.000Z', end: '2026-09-22T21:30:00.000Z', date: '2026-09-22', label: 'Tue Sep 22, 5:00 PM' },
      { start: '2026-09-23T16:00:00.000Z', end: '2026-09-23T16:30:00.000Z', date: '2026-09-23', label: 'Wed Sep 23, 12:00 PM' },
    ],
    ...overrides,
  };
}

function bookedPayload(overrides = {}) {
  return openPayload({
    status: 'booked',
    booked: { mode: 'phone', start: '2026-09-22T20:30:00.000Z', end: '2026-09-22T21:00:00.000Z', label: 'Tue Sep 22, 4:30 PM' },
    ...overrides,
  });
}

function renderPage(path = '/careers/interview/tok-123') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/careers/interview/:token" element={<CareersInterviewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CareersInterviewPage — open state', () => {
  it('renders the greeting and slots grouped by day, then books a chosen time', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse(bookedPayload()));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    expect(await screen.findByText(/Hi Jordan/)).toBeInTheDocument();
    expect(screen.getByText('Tue Sep 22')).toBeInTheDocument();
    expect(screen.getByText('Wed Sep 23')).toBeInTheDocument();

    const slotButton = screen.getByRole('button', { name: '4:30 PM' });
    expect(slotButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('radio', { name: /Phone call/i }));
    fireEvent.click(slotButton);
    expect(slotButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm interview time' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, bookCall] = fetchMock.mock.calls;
    expect(bookCall[0]).toBe('/api/public/careers/interview/tok-123/book');
    expect(JSON.parse(bookCall[1].body)).toEqual({ mode: 'phone', start: '2026-09-22T20:30:00.000Z' });

    expect(await screen.findByText(/You’re booked|You're booked/)).toBeInTheDocument();
    expect(screen.getByText('Change time')).toBeInTheDocument();
  });
});

describe('CareersInterviewPage — booking failure clears the selected slot', () => {
  it('a non-409 failed book response clears the picked time before refreshing, disabling Confirm', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'That time is no longer available.' }, 400))
      .mockResolvedValueOnce(jsonResponse(openPayload()));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    expect(await screen.findByText(/Hi Jordan/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Phone call/i }));
    const slotButton = screen.getByRole('button', { name: '4:30 PM' });
    fireEvent.click(slotButton);
    expect(slotButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm interview time' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await screen.findByText(/no longer available/i);

    // selectedSlot was cleared BEFORE the refresh — Confirm stays disabled
    // rather than showing the now-vanished time as still picked.
    expect(screen.getByRole('button', { name: 'Confirm interview time' })).toBeDisabled();
  });
});

describe('CareersInterviewPage — a slow slot refresh never undoes a booking that committed after it', () => {
  it('keeps the booked state when the conflict-triggered GET resolves after a later successful POST', async () => {
    let releaseRefresh;
    const slowRefresh = new Promise((resolve) => { releaseRefresh = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))                                  // initial load
      .mockResolvedValueOnce(jsonResponse({ error: 'That time is no longer available.' }, 400)) // first book: conflict
      .mockReturnValueOnce(slowRefresh)                                                      // conflict refresh (slow)
      .mockResolvedValueOnce(jsonResponse(bookedPayload({ booked: { mode: 'phone', start: '2026-09-22T21:00:00.000Z', end: '2026-09-22T21:30:00.000Z', label: 'Tue Sep 22, 5:00 PM' } }))); // second book: success
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    expect(await screen.findByText(/Hi Jordan/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Phone call/i }));
    fireEvent.click(screen.getByRole('button', { name: '4:30 PM' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm interview time' }));
    await screen.findByText(/no longer available/i);

    // the applicant picks another time and books it while the refresh is still in flight
    fireEvent.click(screen.getByRole('button', { name: '5:00 PM' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm interview time' }));
    expect(await screen.findByText(/booked/i)).toBeInTheDocument();
    expect(screen.getByText(/Tue Sep 22, 5:00 PM/)).toBeInTheDocument();

    // the stale refresh finally resolves with "open" data — it must be ignored
    releaseRefresh(jsonResponse(openPayload()));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(/Tue Sep 22, 5:00 PM/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm interview time' })).not.toBeInTheDocument();
  });
});

describe('CareersInterviewPage — book returns 404 (application left the Interview stage)', () => {
  it('a 404 from /book is treated as the same inactive-link terminal state as a 409, not a slot conflict', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    expect(await screen.findByText(/Hi Jordan/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Phone call/i }));
    fireEvent.click(screen.getByRole('button', { name: '4:30 PM' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm interview time' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // Same terminal state a 409 gets — not the "pick another time" slot-
    // conflict banner, since the application isn't in the Interview stage
    // any more (withdrawn/advanced), not merely racing on one slot.
    expect(await screen.findByText(/This interview link is no longer active/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm interview time' })).not.toBeInTheDocument();
    expect(screen.queryByText(/no longer available/i)).not.toBeInTheDocument();
  });
});

describe('CareersInterviewPage — inactive link', () => {
  it('renders the inactive-link state on a 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Not found' }, 404)));

    renderPage();

    expect(await screen.findByText(/This interview link is no longer active/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm interview time' })).not.toBeInTheDocument();
  });
});

describe('CareersInterviewPage — withdraw', () => {
  it('confirms before withdrawing and shows the thank-you state after', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(bookedPayload()))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(await screen.findByText(/no longer interested/i));
    expect(screen.getByText(/Are you sure/i)).toBeInTheDocument();

    // Cancel backs out without calling withdraw.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Are you sure/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/no longer interested/i));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, withdraw' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe('/api/public/careers/interview/tok-123/withdraw');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });

    expect(await screen.findByText(/Thanks for letting us know/)).toBeInTheDocument();
  });
});
