// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReservicePage from './ReservicePage';

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

function bookablePayload(overrides = {}) {
  return {
    state: 'bookable',
    customerFirstName: 'Pat',
    lanes: [
      { key: 'pest', label: 'Pest Control Re-Service', alreadyBooked: null },
    ],
    availability: {
      slots: [],
      nearby: false,
      rangeFrom: '2026-07-11',
      rangeTo: '2026-07-24',
      days: [
        {
          date: '2026-07-12',
          fullDate: 'Sunday, July 12',
          nearby: false,
          slots: [
            {
              start_time: '13:00',
              end_time: '13:45',
              start_label: '1:00 PM',
              end_label: '1:45 PM',
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
    <MemoryRouter initialEntries={['/reservice/deadbeef']}>
      <Routes>
        <Route path="/reservice/:token" element={<ReservicePage />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// URL-aware fetch stub — same shape as ReschedulePage.test.jsx's (the page
// also fetches /public/ui-flags on mount via the glass release rider).
function stubFetch({ get, post, findSlots } = {}) {
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
    return Promise.resolve(get || jsonResponse(bookablePayload()));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ReservicePage states', () => {
  it('renders the friendly not-eligible state — never a dead link', async () => {
    stubFetch({ get: jsonResponse({ state: 'not_eligible', customerFirstName: 'Pat', lanes: [] }) });
    renderPage();
    expect(await screen.findByText(/let's get you taken care of/)).toBeInTheDocument();
    expect(screen.getByText(/active recurring plan/)).toBeInTheDocument();
  });

  it('an already-booked lane pivots to the existing visit + its reschedule link instead of double-booking', async () => {
    stubFetch({
      get: jsonResponse({
        state: 'already_booked',
        customerFirstName: 'Pat',
        lanes: [{
          key: 'pest',
          label: 'Pest Control Re-Service',
          alreadyBooked: {
            date: '2026-07-15',
            windowStart: '09:00',
            serviceType: 'Pest Control Re-Service',
            rescheduleUrl: '/reschedule/feedface',
          },
        }],
        availability: null,
      }),
    });
    renderPage();
    expect(await screen.findByText(/you're covered/)).toBeInTheDocument();
    const move = screen.getByRole('link', { name: /Move that visit/ });
    expect(move).toHaveAttribute('href', '/reschedule/feedface');
  });

  it('books the free visit: single lane auto-selects, slot pick + confirm posts lane/date/start, success card links the rescheduler', async () => {
    const fetchMock = stubFetch({
      post: jsonResponse({
        success: true,
        lane: 'pest',
        serviceType: 'Pest Control Re-Service',
        date: '2026-07-12',
        window: { start: '13:00', end: '13:45' },
        startLabel: '1:00 PM',
        endLabel: '1:45 PM',
        confirmationCode: 'WVS-123',
        rescheduleUrl: '/reschedule/feedface',
      }),
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: '1:00 PM' }));
    fireEvent.click(screen.getByRole('button', { name: /Book Sunday, July 12, 1:00 PM — free/ }));

    await waitFor(() => {
      expect(screen.getByText("You're all set")).toBeInTheDocument();
    });
    // Arrival promise is start + 2h, not the job block.
    expect(screen.getByText('1:00 PM–3:00 PM')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Reschedule it/ })).toHaveAttribute('href', '/reschedule/feedface');

    const commit = fetchMock.mock.calls.find(([, opts]) => opts?.method === 'POST'
      && !String(fetchMock.mock.calls[0][0]).includes('find-slots'));
    const body = JSON.parse(commit[1].body);
    expect(body).toMatchObject({ lane: 'pest', date: '2026-07-12', start_time: '13:00' });
  });

  it('an ALREADY_BOOKED race on commit reloads the truthful state instead of leaving a dead confirm', async () => {
    let loads = 0;
    vi.stubGlobal('fetch', vi.fn((url, opts = {}) => {
      const u = String(url);
      if (u.includes('/public/ui-flags')) return Promise.resolve(jsonResponse({ portalGlass: false }));
      if (opts.method === 'POST') {
        return Promise.resolve(jsonResponse({
          error: 'You already have a re-service visit on the books.',
          code: 'ALREADY_BOOKED',
        }, 409));
      }
      loads += 1;
      // First load: bookable. Reload after the 409: the office's booking won.
      return Promise.resolve(jsonResponse(loads === 1 ? bookablePayload() : {
        state: 'already_booked',
        customerFirstName: 'Pat',
        lanes: [{
          key: 'pest',
          label: 'Pest Control Re-Service',
          alreadyBooked: { date: '2026-07-15', windowStart: '09:00', serviceType: 'Pest Control Re-Service', rescheduleUrl: null },
        }],
        availability: null,
      }));
    }));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: '1:00 PM' }));
    fireEvent.click(screen.getByRole('button', { name: /Book Sunday, July 12/ }));

    expect(await screen.findByText(/you're covered/)).toBeInTheDocument();
  });
});
