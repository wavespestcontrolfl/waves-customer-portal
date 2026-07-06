// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReschedulePage from './ReschedulePage';

vi.mock('../components/brand', () => ({
  WavesShell: ({ children }) => <div>{children}</div>,
}));

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function reschedulablePayload(overrides = {}) {
  return {
    state: 'reschedulable',
    reason: null,
    customerFirstName: 'Pat',
    service: { type: 'Pest Control' },
    isRecurring: false,
    current: {
      date: '2026-07-10',
      windowStart: '09:00',
      windowEnd: '10:00',
    },
    availability: {
      days: [
        {
          date: '2026-07-12',
          fullDate: 'Sunday, July 12',
          nearby: false,
          slots: [
            {
              start_time: '13:00',
              end_time: '14:00',
              start_label: '1:00 PM',
              end_label: '2:00 PM',
              technician_id: 'tech-1',
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/reschedule/deadbeef']}>
      <Routes>
        <Route path="/reschedule/:token" element={<ReschedulePage />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// URL-aware fetch stub: the page also fetches /public/ui-flags on mount
// (portal glass release rider), so response queues keyed by call order would
// be consumed by the wrong request.
function stubFetch({ post, findSlots } = {}) {
  const fetchMock = vi.fn((url, opts = {}) => {
    const u = String(url);
    if (u.includes('/public/ui-flags')) {
      return Promise.resolve(jsonResponse({ portalGlass: false }));
    }
    if (u.includes('/find-slots')) {
      return Promise.resolve(findSlots || jsonResponse({ error: 'unexpected find-slots call' }, 500));
    }
    if (opts.method === 'POST') {
      return Promise.resolve(post || jsonResponse({ error: 'unexpected POST' }, 500));
    }
    return Promise.resolve(jsonResponse(reschedulablePayload()));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ReschedulePage arrival windows', () => {
  it('shows the current visit as a 2-hour arrival window, not the job block', async () => {
    stubFetch();

    renderPage();

    // window_start 09:00 with job-block window_end 10:00 → the promise is
    // 9:00–11:00 AM, never 9:00–10:00 AM.
    expect(await screen.findByText('9:00 AM–11:00 AM')).toBeInTheDocument();
    expect(screen.queryByText('9:00 AM–10:00 AM')).not.toBeInTheDocument();
  });

  it('shows the success message as start + 2 hours even though the server echoes the job-block endLabel', async () => {
    stubFetch({
      post: jsonResponse({
        success: true,
        originalDate: '2026-07-10',
        newDate: '2026-07-12',
        window: { start: '13:00', end: '14:00' },
        startLabel: '1:00 PM',
        endLabel: '2:00 PM',
      }),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: '1:00 PM' }));
    fireEvent.click(screen.getByRole('button', { name: /Move to Sunday, July 12/ }));

    await waitFor(() => {
      expect(screen.getByText('You\'re all set')).toBeInTheDocument();
    });
    expect(screen.getByText('1:00 PM–3:00 PM')).toBeInTheDocument();
    expect(screen.queryByText('1:00 PM–2:00 PM')).not.toBeInTheDocument();
  });
});

describe('ReschedulePage Waves AI search', () => {
  it('replaces the day list with search results and offers a reset back to all times', async () => {
    stubFetch({
      findSlots: jsonResponse({
        summary: 'Two openings Tuesday afternoon.',
        understood: true,
        window: { date_from: '2026-07-14', date_to: '2026-07-14' },
        time_of_day: 'afternoon',
        availability: {
          slots: [],
          nearby: true,
          days: [
            {
              date: '2026-07-14',
              fullDate: 'Tuesday, July 14',
              nearby: true,
              slots: [
                {
                  start_time: '14:00',
                  end_time: '15:00',
                  start_label: '2:00 PM',
                  end_label: '3:00 PM',
                  technician_id: 'tech-1',
                },
              ],
            },
          ],
          rangeFrom: '2026-07-11',
          rangeTo: '2026-07-24',
        },
      }),
    });

    renderPage();

    const input = await screen.findByLabelText('Search for a service date or time');
    fireEvent.change(input, { target: { value: 'tuesday afternoon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    // Search results replace the full window's day list…
    expect(await screen.findByText('Tuesday, July 14')).toBeInTheDocument();
    expect(screen.queryByText('Sunday, July 12')).not.toBeInTheDocument();
    expect(screen.getByText('Two openings Tuesday afternoon.')).toBeInTheDocument();

    // …and the reset restores the full window AND clears the stale AI recap.
    fireEvent.click(screen.getByRole('button', { name: 'Show all open times' }));
    expect(await screen.findByText('Sunday, July 12')).toBeInTheDocument();
    expect(screen.queryByText('Tuesday, July 14')).not.toBeInTheDocument();
    expect(screen.queryByText('Two openings Tuesday afternoon.')).not.toBeInTheDocument();
  });

  it('keeps the filtered list AND the reset link when the full-window refetch fails', async () => {
    let getCalls = 0;
    const findSlotsBody = {
      summary: 'One match.',
      availability: {
        slots: [],
        nearby: true,
        days: [{
          date: '2026-07-14',
          fullDate: 'Tuesday, July 14',
          nearby: true,
          slots: [{ start_time: '14:00', end_time: '15:00', start_label: '2:00 PM', end_label: '3:00 PM', technician_id: 'tech-1' }],
        }],
        rangeFrom: '2026-07-11',
        rangeTo: '2026-07-24',
      },
    };
    vi.stubGlobal('fetch', vi.fn((url, opts = {}) => {
      const u = String(url);
      if (u.includes('/public/ui-flags')) return Promise.resolve(jsonResponse({ portalGlass: false }));
      if (u.includes('/find-slots')) return Promise.resolve(jsonResponse(findSlotsBody));
      if (!opts.method || opts.method === 'GET') {
        getCalls += 1;
        return Promise.resolve(getCalls === 1 ? jsonResponse(reschedulablePayload()) : jsonResponse({ error: 'boom' }, 500));
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected POST' }, 500));
    }));

    renderPage();

    const input = await screen.findByLabelText('Search for a service date or time');
    fireEvent.change(input, { target: { value: 'tuesday afternoon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Tuesday, July 14')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all open times' }));

    // Refetch 500s: the filtered list is still on screen, so the reset link
    // must survive for another try — never a dead end.
    expect(await screen.findByRole('button', { name: 'Show all open times' })).toBeInTheDocument();
    expect(screen.getByText('Tuesday, July 14')).toBeInTheDocument();
    expect(screen.queryByText('Sunday, July 12')).not.toBeInTheDocument();
  });
});
