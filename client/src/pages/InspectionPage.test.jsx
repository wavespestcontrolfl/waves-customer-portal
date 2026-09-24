// @vitest-environment jsdom
//
// Public consultation-booking link (/inspection/:token) — the `inspection`
// flow in ScheduleFlowPage.jsx ("Book with Adam", scope doc
// lead-inspection-link-scope.md §3). Gone/expired/already_booked/converted
// terminal cards, the address-first gate (including its own out-of-area
// stop), the page-level out-of-area stop raised from the commit response
// (+ waitlist join), the happy-path booking, SLOT_TAKEN recovery, and the
// ?slot= preselect with its nearest-slot fallback notice.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ScheduleFlowPage from './ScheduleFlowPage';

// PublicStateCard and BrandCard come through for real — see ReservicePage.test.jsx.
vi.mock('../components/brand', async (importOriginal) => ({
  ...(await importOriginal()),
  WavesShell: ({ children }) => <div>{children}</div>,
  CustomerColumn: ({ children, ...props }) => <div {...props}>{children}</div>,
}));

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function okPayload(overrides = {}) {
  return {
    state: 'ok',
    lead: { first_name: 'Pat', phone_masked: '***0101', has_address: true, address_display: '123 Palm Ave, Bradenton 34209' },
    needs_address: false,
    selfServeNotice: true,
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
            { start_time: '13:00', end_time: '13:30', start_label: '1:00 PM', end_label: '1:30 PM', technician_id: 'tech-1' },
          ],
        },
      ],
    },
    ...overrides,
  };
}

function renderPage(path = '/inspection/deadbeef') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/inspection/:token" element={<ScheduleFlowPage flow="inspection" />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// URL-aware fetch stub. `post` answers the commit (POST base token URL, no
// suffix); `availability` answers POST .../availability; `waitlist` answers
// POST .../waitlist; `findSlots` answers POST .../find-slots.
function stubFetch({ get, post, availability, waitlist, findSlots } = {}) {
  const fetchMock = vi.fn((url, opts = {}) => {
    const u = String(url);
    if (u.includes('/public/ui-flags')) {
      return Promise.resolve(jsonResponse({ portalGlass: false }));
    }
    if (u.includes('/find-slots')) {
      return Promise.resolve(findSlots || jsonResponse({ error: 'unexpected find-slots call' }, 500));
    }
    if (u.includes('/waitlist')) {
      return Promise.resolve(waitlist || jsonResponse({ error: 'unexpected waitlist call' }, 500));
    }
    if (u.includes('/availability') && opts.method === 'POST') {
      return Promise.resolve(availability || jsonResponse({ error: 'unexpected availability call' }, 500));
    }
    if (opts.method === 'POST') {
      return Promise.resolve(post || jsonResponse({ error: 'unexpected POST' }, 500));
    }
    return Promise.resolve(get || jsonResponse(okPayload()));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('InspectionPage terminal states', () => {
  it('gone: renders a helpful card, never a dead link', async () => {
    stubFetch({ get: jsonResponse({ state: 'gone' }) });
    renderPage();
    expect(await screen.findByText(/couldn.t find that lead/i)).toBeInTheDocument();
  });

  it('expired: link-expired card', async () => {
    stubFetch({ get: jsonResponse({ state: 'expired' }) });
    renderPage();
    expect(await screen.findByText(/this link has expired/i)).toBeInTheDocument();
  });

  it('already_booked: shows the existing visit and its reschedule link', async () => {
    stubFetch({
      get: jsonResponse({
        state: 'already_booked',
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: true, address_display: null },
        visit: { date: '2026-07-15', window: { start: '09:00', end: '09:30' }, serviceType: 'Waves Assessment' },
        rescheduleUrl: '/reschedule/feedface',
      }),
    });
    renderPage();
    expect(await screen.findByText(/already on the calendar/i)).toBeInTheDocument();
    const move = screen.getByRole('link', { name: /Move that visit/i });
    expect(move).toHaveAttribute('href', '/reschedule/feedface');
  });

  it('converted: same shape, "already a Waves customer" copy', async () => {
    stubFetch({
      get: jsonResponse({
        state: 'converted',
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: true, address_display: null },
        visit: { date: '2026-08-01', window: { start: '10:00', end: '11:00' }, serviceType: 'General Pest Control' },
        rescheduleUrl: '/reschedule/abc123',
      }),
    });
    renderPage();
    expect(await screen.findByText(/already a Waves customer/i)).toBeInTheDocument();
  });
});

describe('InspectionPage address-first gate', () => {
  it('needs_address: asks for an address, resolves it, then shows the picker', async () => {
    const fetchMock = stubFetch({
      get: jsonResponse(okPayload({
        needs_address: true,
        availability: null,
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: false, address_display: null },
      })),
      availability: jsonResponse({ availability: okPayload().availability, needs_address: false }),
    });
    renderPage();

    expect(await screen.findByText(/where should we come by/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Address for the visit')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Address for the visit'), { target: { value: '123 Palm Ave, Bradenton, FL 34209' } });
    fireEvent.click(screen.getByRole('button', { name: /Show open times/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i })).toBeInTheDocument();
    });
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/availability'));
    expect(JSON.parse(call[1].body)).toEqual({ address: '123 Palm Ave, Bradenton, FL 34209' });
  });

  it('needs_address + out of area: stops on the waitlist card instead of the picker', async () => {
    stubFetch({
      get: jsonResponse(okPayload({
        needs_address: true,
        availability: null,
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: false, address_display: null },
      })),
      availability: jsonResponse({ error: 'out_of_area', county: 'Hardee' }, 422),
      waitlist: jsonResponse({ ok: true }),
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Address for the visit'), { target: { value: '1 Somewhere Rd, Wauchula, FL 33873' } });
    fireEvent.click(screen.getByRole('button', { name: /Show open times/i }));

    expect(await screen.findByText(/we don.t service this area yet/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'pat@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Notify me/i }));
    expect(await screen.findByText(/you.re on the list/i)).toBeInTheDocument();
  });
});

describe('InspectionPage booking', () => {
  it('happy path: pick a time, confirm, success card links the rescheduler', async () => {
    const fetchMock = stubFetch({
      post: jsonResponse({
        success: true,
        state: 'ok',
        visit: { date: '2026-07-12', window: { start: '13:00', end: '13:30' } },
        startLabel: '1:00 PM',
        endLabel: '1:30 PM',
        rescheduleUrl: '/reschedule/feedface',
      }),
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));
    fireEvent.click(screen.getByRole('button', { name: /Book .* free/i }));

    await waitFor(() => {
      expect(screen.getByText(/you.re on the calendar/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /Reschedule it/i })).toHaveAttribute('href', '/reschedule/feedface');

    const commit = fetchMock.mock.calls.find(([url, opts]) => opts?.method === 'POST'
      && !String(url).includes('find-slots') && !String(url).includes('availability') && !String(url).includes('waitlist'));
    const body = JSON.parse(commit[1].body);
    expect(body).toMatchObject({ date: '2026-07-12', time: '13:00' });
  });

  it('optional notes ride the commit payload', async () => {
    const fetchMock = stubFetch({
      post: jsonResponse({
        success: true, state: 'ok',
        visit: { date: '2026-07-12', window: { start: '13:00', end: '13:30' } },
        startLabel: '1:00 PM', endLabel: '1:30 PM', rescheduleUrl: null,
      }),
    });
    renderPage();
    fireEvent.change(await screen.findByLabelText(/Anything we should know/i), { target: { value: 'Ants in the kitchen' } });
    fireEvent.click(screen.getByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));
    fireEvent.click(screen.getByRole('button', { name: /Book .* free/i }));
    await waitFor(() => expect(screen.getByText(/you.re on the calendar/i)).toBeInTheDocument());
    const commit = fetchMock.mock.calls.find(([url, opts]) => opts?.method === 'POST'
      && !String(url).includes('find-slots') && !String(url).includes('availability') && !String(url).includes('waitlist'));
    expect(JSON.parse(commit[1].body).notes).toBe('Ants in the kitchen');
  });

  it('slot_taken: clears the pick, refreshes availability, and shows a retry notice', async () => {
    stubFetch({
      post: jsonResponse({ error: 'That time is no longer open.', code: 'SLOT_TAKEN', availability: okPayload().availability }, 409),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));
    fireEvent.click(screen.getByRole('button', { name: /Book .* free/i }));
    expect(await screen.findByText(/just taken/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Book .* free/i })).not.toBeInTheDocument();
  });

  it('out_of_area on commit: stops on the dedicated card, not a generic error', async () => {
    stubFetch({
      post: jsonResponse({ error: 'out_of_area', county: 'Hardee' }, 422),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));
    fireEvent.click(screen.getByRole('button', { name: /Book .* free/i }));
    expect(await screen.findByText(/we don.t service this area yet/i)).toBeInTheDocument();
  });
});

describe('InspectionPage ?slot= preselect', () => {
  it('preselects the requested slot without a click', async () => {
    stubFetch({ get: jsonResponse(okPayload()) });
    renderPage('/inspection/deadbeef?slot=2026-07-12|13:00');
    expect(await screen.findByRole('button', { name: /Book .* free/i })).toBeInTheDocument();
  });

  it('a requested slot that already filled falls back to the nearest open one, with a notice', async () => {
    stubFetch({ get: jsonResponse(okPayload()) }); // only 13:00 exists
    renderPage('/inspection/deadbeef?slot=2026-07-12|09:00');
    expect(await screen.findByRole('button', { name: /Book .* free/i })).toBeInTheDocument();
    expect(screen.getByText(/moved you to the next open time/i)).toBeInTheDocument();
  });
});
