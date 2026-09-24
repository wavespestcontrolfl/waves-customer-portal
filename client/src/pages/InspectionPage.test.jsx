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

  // Codex #4737 r4 P2: a converted lead with no upcoming visit is never told
  // they are "on the calendar".
  it('converted with no visit: customer wording, never "already on the calendar"', async () => {
    stubFetch({
      get: jsonResponse({
        state: 'converted',
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: true, address_display: null },
        visit: null,
        rescheduleUrl: null,
      }),
    });
    renderPage();
    expect((await screen.findAllByText(/already a Waves customer/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/already on the calendar/i)).toBeNull();
  });

  // Codex #4737 r4 P2: the page shows the catalog duration the server books with.
  it('ok: shows the server-supplied catalog duration, not a hardcoded one', async () => {
    stubFetch({ get: jsonResponse({ ...okPayload(), durationMinutes: 45 }) });
    renderPage();
    expect(await screen.findByText(/About 45 minutes/)).toBeInTheDocument();
    expect(screen.queryByText(/About 30 minutes/)).toBeNull();
  });

  // Round 9 (Codex pre-push P1, 2026-09-24): GET now routes through
  // finalizeBookingLocation, same as every other producer of a booking
  // location — a stored address outside the service area stops the page
  // right from initial load instead of falling through to needs_address:
  // false with an empty calendar.
  it('out_of_area (GET): a stored address that resolves outside the service area gets the same stop card as the commit-time version', async () => {
    stubFetch({
      get: jsonResponse({
        state: 'out_of_area',
        county: 'Hardee',
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: true, address_display: '1 Somewhere Rd, Wauchula 33873' },
      }),
      waitlist: jsonResponse({ ok: true }),
    });
    renderPage();

    expect(await screen.findByText(/we don.t service this area yet/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'pat@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Notify me/i }));
    expect(await screen.findByText(/you.re on the list/i)).toBeInTheDocument();
  });

  it('service_area_unavailable (GET): a recoverable retry message where the calendar would be, never an empty-times card', async () => {
    const fetchMock = stubFetch({
      get: jsonResponse({
        state: 'ok',
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: true, address_display: '123 Palm Ave, Bradenton 34209' },
        needs_address: false,
        availability: null,
        selfServeNotice: true,
        service_area_unavailable: true,
      }),
    });
    renderPage();

    expect(await screen.findByText(/couldn.t confirm your service area/i)).toBeInTheDocument();
    expect(screen.queryByText(/don.t have open times to offer online/i)).not.toBeInTheDocument();

    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
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

  // Codex #4737 r5 P1: the lead can correct a stored address; the typed one
  // then rides the commit and wins on the server.
  it('"Different address?" re-opens the address form, and the corrected address drives availability', async () => {
    const fetchMock = stubFetch({
      get: jsonResponse(okPayload({
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: true, address_display: '1 First Try Rd, Bradenton' },
      })),
      availability: jsonResponse({ availability: okPayload().availability, needs_address: false }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Different address\?/i }));
    fireEvent.change(await screen.findByLabelText('Address for the visit'), { target: { value: '2 Corrected Ave, Bradenton, FL 34209' } });
    fireEvent.click(screen.getByRole('button', { name: /Show open times/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/availability'));
      expect(JSON.parse(call[1].body)).toEqual({ address: '2 Corrected Ave, Bradenton, FL 34209' });
    });
    // Codex #4737 r6 P2: the hero shows the address being booked.
    expect(await screen.findByText('2 Corrected Ave, Bradenton, FL 34209')).toBeInTheDocument();
    expect(screen.queryByText('1 First Try Rd, Bradenton')).not.toBeInTheDocument();
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

  it('needs_address + address_unresolved: stays on the form with an inline message, never the waitlist stop', async () => {
    stubFetch({
      get: jsonResponse(okPayload({
        needs_address: true,
        availability: null,
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: false, address_display: null },
      })),
      availability: jsonResponse({ error: 'address_unresolved' }, 422),
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Address for the visit'), { target: { value: 'gibberish text' } });
    fireEvent.click(screen.getByRole('button', { name: /Show open times/i }));

    expect(await screen.findByText(/couldn.t find that address/i)).toBeInTheDocument();
    // Still on the address form — never the out-of-area stop.
    expect(screen.getByLabelText('Address for the visit')).toBeInTheDocument();
    expect(screen.queryByText(/we don.t service this area yet/i)).not.toBeInTheDocument();
  });

  it('needs_address + service_area_unavailable: stays on the form with a retry message — not a verdict either way', async () => {
    stubFetch({
      get: jsonResponse(okPayload({
        needs_address: true,
        availability: null,
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: false, address_display: null },
      })),
      availability: jsonResponse({ error: 'service_area_unavailable' }, 503),
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Address for the visit'), { target: { value: '123 Palm Ave, Bradenton, FL 34209' } });
    fireEvent.click(screen.getByRole('button', { name: /Show open times/i }));

    expect(await screen.findByText(/couldn.t confirm your service area/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Address for the visit')).toBeInTheDocument();
    expect(screen.queryByText(/we don.t service this area yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText('service_area_unavailable')).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /^Book /i }));

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
    fireEvent.click(screen.getByRole('button', { name: /^Book /i }));
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
    fireEvent.click(screen.getByRole('button', { name: /^Book /i }));
    expect(await screen.findByText(/just taken/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Book /i })).not.toBeInTheDocument();
  });

  it('out_of_area on commit: stops on the dedicated card, not a generic error', async () => {
    stubFetch({
      post: jsonResponse({ error: 'out_of_area', county: 'Hardee' }, 422),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Book /i }));
    expect(await screen.findByText(/we don.t service this area yet/i)).toBeInTheDocument();
  });

  it('address_unresolved on commit: an inline message, never the raw error code or the out-of-area stop', async () => {
    stubFetch({
      post: jsonResponse({ error: 'address_unresolved' }, 422),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Book /i }));
    expect(await screen.findByText(/couldn.t verify that address/i)).toBeInTheDocument();
    expect(screen.queryByText('address_unresolved')).not.toBeInTheDocument();
    expect(screen.queryByText(/we don.t service this area yet/i)).not.toBeInTheDocument();
  });

  it('service_area_unavailable on commit: a retry message, never the raw error code or the out-of-area stop', async () => {
    stubFetch({
      post: jsonResponse({ error: 'service_area_unavailable' }, 503),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Book /i }));
    expect(await screen.findByText(/couldn.t confirm your service area/i)).toBeInTheDocument();
    expect(screen.queryByText('service_area_unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText(/we don.t service this area yet/i)).not.toBeInTheDocument();
  });

  // P1, 2026-09-24: eligibility can change between page load and commit
  // (idempotent replay, or a race with another booking) — the commit's 200
  // response then carries a terminal `state` other than 'ok'. Previously
  // only ALREADY_BOOKED (via `code`) triggered a reload; converted and gone
  // fell through to a generic "something went wrong" line. Both must now
  // render the SAME terminal card GET itself would show, straight from the
  // commit response — no reload, no generic error.
  it('converted on commit: replaces the picker with the existing-visit card, not a generic error', async () => {
    stubFetch({
      post: jsonResponse({
        state: 'converted',
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: true, address_display: null },
        visit: { date: '2026-08-01', window: { start: '10:00', end: '11:00' }, serviceType: 'General Pest Control' },
        rescheduleUrl: '/reschedule/abc123',
      }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Book /i }));
    expect(await screen.findByText(/already a Waves customer/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Move that visit/i })).toHaveAttribute('href', '/reschedule/abc123');
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it('gone on commit: replaces the picker with the gone card, not a generic error', async () => {
    stubFetch({
      post: jsonResponse({ state: 'gone', lead: null, visit: null, rescheduleUrl: null }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Book /i }));
    expect(await screen.findByText(/couldn.t find that lead/i)).toBeInTheDocument();
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it('the confirm button names the picked day and arrival window (brief copy contract)', async () => {
    stubFetch();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));
    expect(screen.getByRole('button', { name: /^Book Sun 1:00 PM.3:00 PM$/ })).toBeInTheDocument();
  });

  it('the AI search sends an address the gate already resolved this page-life', async () => {
    const fetchMock = stubFetch({
      get: jsonResponse(okPayload({
        needs_address: true,
        availability: null,
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: false, address_display: null },
      })),
      availability: jsonResponse({ availability: okPayload().availability, needs_address: false }),
      findSlots: jsonResponse({ availability: okPayload().availability, summary: 'Open Sunday afternoon.' }),
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Address for the visit'), { target: { value: '123 Palm Ave, Bradenton, FL 34209' } });
    fireEvent.click(screen.getByRole('button', { name: /Show open times/i }));
    await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i });

    fireEvent.change(screen.getByLabelText('Search for a service date or time'), { target: { value: 'this weekend' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      const search = fetchMock.mock.calls.find(([url]) => String(url).includes('/find-slots'));
      expect(search).toBeTruthy();
      expect(JSON.parse(search[1].body)).toMatchObject({ query: 'this weekend', address: '123 Palm Ave, Bradenton, FL 34209' });
    });
  });
});

// Round-10 P2 :1682 — a LOCATION_CHANGED_RETRY/CUSTOMER_CHANGED_RETRY race
// answers SLOT_TAKEN with the customer's CURRENT address (address_changed +
// lead). The client must drop its held resolvedAddress and update the hero,
// so a retry never resubmits the stale supplied address.
describe('InspectionPage: an address race resets the held address (round-10 P2 :1682)', () => {
  it('after a 409 with address_changed, the hero shows the current address and the next commit carries no stale address', async () => {
    let commitCalls = 0;
    const fetchMock = vi.fn((url, opts = {}) => {
      const u = String(url);
      if (u.includes('/public/ui-flags')) return Promise.resolve(jsonResponse({ portalGlass: false }));
      if (u.includes('/find-slots')) return Promise.resolve(jsonResponse({ error: 'unexpected find-slots call' }, 500));
      if (u.includes('/waitlist')) return Promise.resolve(jsonResponse({ error: 'unexpected waitlist call' }, 500));
      if (u.includes('/availability') && opts.method === 'POST') {
        // The address gate's own resolve call — the STALE supplied address.
        return Promise.resolve(jsonResponse({ availability: okPayload().availability, needs_address: false }));
      }
      if (opts.method === 'POST') {
        commitCalls += 1;
        if (commitCalls === 1) {
          // First confirm loses a race: the customer's stored address moved
          // under the booking fence. The server answers with the address
          // actually on file NOW, never the stale one the gate resolved.
          return Promise.resolve(jsonResponse({
            error: 'Your address just changed — please pick a time again.',
            code: 'SLOT_TAKEN',
            address_changed: true,
            lead: { first_name: 'Pat', phone_masked: '***0101', has_address: true, address_display: '456 New Moved-To St, Sarasota 34231' },
            availability: okPayload().availability,
          }, 409));
        }
        return Promise.resolve(jsonResponse({
          success: true, state: 'ok',
          visit: { date: '2026-07-12', window: { start: '13:00', end: '13:30' } },
          startLabel: '1:00 PM', endLabel: '1:30 PM', rescheduleUrl: null,
        }));
      }
      // Initial GET — addressless lead, asked for one (the address-first gate).
      return Promise.resolve(jsonResponse(okPayload({
        needs_address: true,
        availability: null,
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: false, address_display: null },
      })));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.change(await screen.findByLabelText('Address for the visit'), { target: { value: '123 Palm Ave, Bradenton, FL 34209' } });
    fireEvent.click(screen.getByRole('button', { name: /Show open times/i }));
    await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i });
    // The gate's own resolve already shows the supplied address in the hero.
    expect(await screen.findByText(/123 Palm Ave/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Book /i }));
    await waitFor(() => expect(screen.getByText(/just taken/i)).toBeInTheDocument());

    // The hero now shows the CURRENT address, never the stale supplied one.
    expect(await screen.findByText(/456 New Moved-To St/i)).toBeInTheDocument();
    expect(screen.queryByText(/123 Palm Ave/i)).not.toBeInTheDocument();

    // Retry — the next commit must NOT resubmit the stale supplied address.
    fireEvent.click(screen.getByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Book /i }));
    await waitFor(() => expect(screen.getByText(/you.re on the calendar/i)).toBeInTheDocument());

    const commitReqs = fetchMock.mock.calls.filter(([url, opts]) => opts?.method === 'POST'
      && !String(url).includes('find-slots') && !String(url).includes('availability') && !String(url).includes('waitlist'));
    expect(commitReqs).toHaveLength(2);
    expect(JSON.parse(commitReqs[1][1].body).address).toBeUndefined();
  });
});

// Codex pre-push P1, round 8, 2026-09-24 — an addressless lead's held
// resolvedAddress must survive EVERY availability refresh path, not just
// the address gate's own initial resolve. Before this fix, "Show all open
// times" and the SLOT_TAKEN-without-availability fallback both called a
// bare GET with no address, which re-answered needs_address:true and
// yanked the picker back to a blank address form mid-session.
describe('InspectionPage availability refresh keeps a held address (P1, round 8)', () => {
  it('"Show all open times" after an AI search POSTs the held address — keeps the picker, never re-shows needs_address', async () => {
    const fetchMock = stubFetch({
      get: jsonResponse(okPayload({
        needs_address: true,
        availability: null,
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: false, address_display: null },
      })),
      availability: jsonResponse({ availability: okPayload().availability, needs_address: false }),
      findSlots: jsonResponse({ availability: okPayload().availability, summary: 'Open Sunday afternoon.' }),
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Address for the visit'), { target: { value: '123 Palm Ave, Bradenton, FL 34209' } });
    fireEvent.click(screen.getByRole('button', { name: /Show open times/i }));
    await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i });

    fireEvent.change(screen.getByLabelText('Search for a service date or time'), { target: { value: 'this weekend' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/find-slots'))).toBe(true));

    fetchMock.mockClear();
    fireEvent.click(await screen.findByRole('button', { name: 'Show all open times' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, opts]) => String(url).includes('/availability') && opts?.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ address: '123 Palm Ave, Bradenton, FL 34209' });
    });
    // Never a bare GET on the reset — that would have dropped the address
    // and re-answered needs_address:true.
    expect(fetchMock.mock.calls.some(([url, opts]) => String(url).endsWith('/inspection/deadbeef') && !opts?.method)).toBe(false);

    // The picker survives — never re-shows the address form.
    expect(screen.queryByText(/where should we come by/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i })).toBeInTheDocument();
  });

  it('a SLOT_TAKEN response with no fresh availability falls back to the SAME address-aware refresh, never a bare GET', async () => {
    const fetchMock = stubFetch({
      get: jsonResponse(okPayload({
        needs_address: true,
        availability: null,
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: false, address_display: null },
      })),
      availability: jsonResponse({ availability: okPayload().availability, needs_address: false }),
      // No `availability` field — the server's own refresh attempt came
      // back empty, forcing the client-side fallback.
      post: jsonResponse({ error: 'That time is no longer open.', code: 'SLOT_TAKEN' }, 409),
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Address for the visit'), { target: { value: '123 Palm Ave, Bradenton, FL 34209' } });
    fireEvent.click(screen.getByRole('button', { name: /Show open times/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Book /i }));

    expect(await screen.findByText(/just taken/i)).toBeInTheDocument();

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, opts]) => String(url).includes('/availability') && opts?.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ address: '123 Palm Ave, Bradenton, FL 34209' });
    });
    expect(fetchMock.mock.calls.some(([url, opts]) => String(url).endsWith('/inspection/deadbeef') && !opts?.method)).toBe(false);

    // Still on the picker (slot cleared, but no address form).
    expect(screen.queryByText(/where should we come by/i)).not.toBeInTheDocument();
  });
});

describe('InspectionPage ?slot= preselect', () => {
  it('preselects the requested slot without a click', async () => {
    stubFetch({ get: jsonResponse(okPayload()) });
    renderPage('/inspection/deadbeef?slot=2026-07-12|13:00');
    expect(await screen.findByRole('button', { name: /^Book /i })).toBeInTheDocument();
  });

  it('a requested slot that already filled falls back to the nearest open one, with a notice', async () => {
    stubFetch({ get: jsonResponse(okPayload()) }); // only 13:00 exists
    renderPage('/inspection/deadbeef?slot=2026-07-12|09:00');
    expect(await screen.findByRole('button', { name: /^Book /i })).toBeInTheDocument();
    expect(screen.getByText(/moved you to the next open time/i)).toBeInTheDocument();
  });
});
