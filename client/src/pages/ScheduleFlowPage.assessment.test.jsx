// @vitest-environment jsdom
//
// "Book a free Waves Assessment first" from an estimate (/estimate/:token/assessment,
// GATE_ESTIMATE_ASSESSMENT_FIRST): the `assessment` flow in ScheduleFlowPage.jsx, the inspection page
// keyed by the estimate's token (routes/estimate-assessment-public.js). It talks to its own API, names the
// visit a free Waves Assessment, never offers to change the address, and keeps the inspection terminal and
// SLOT_TAKEN behavior.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function renderPage(path = '/estimate/sampleestimatetoken1/assessment') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/estimate/:token/assessment" element={<ScheduleFlowPage flow="assessment" />} />
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


describe('assessment flow (estimate token)', () => {
  it('loads from its own API and names the visit a free Waves Assessment, with no address change', async () => {
    const fetchMock = stubFetch({ get: jsonResponse({ ...okPayload(), durationMinutes: 45 }) });
    renderPage();
    expect(await screen.findByText('Free Waves Assessment')).toBeInTheDocument();
    expect(screen.getByText(/About 45 minutes/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Different address/i })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/public/estimate-assessment/sampleestimatetoken1'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/public/inspection/'))).toBe(false);
  });

  it('books through its own API and confirms a free Waves Assessment', async () => {
    const fetchMock = stubFetch({
      post: jsonResponse({
        success: true, state: 'ok',
        visit: { date: '2026-07-12', window: { start: '13:00', end: '13:30' } },
        startLabel: '1:00 PM', endLabel: '1:30 PM', rescheduleUrl: '/reschedule/feedface',
      }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Book /i }));
    expect(await screen.findByText(/Your free Waves Assessment is set for/i)).toBeInTheDocument();
    const commit = fetchMock.mock.calls.find(([url, opts]) => opts?.method === 'POST' && !String(url).includes('find-slots'));
    expect(String(commit[0])).toMatch(/\/public\/estimate-assessment\/sampleestimatetoken1$/);
    expect(JSON.parse(commit[1].body)).toMatchObject({ date: '2026-07-12', time: '13:00' });
  });

  it('gone: an estimate card, never the lead wording', async () => {
    stubFetch({ get: jsonResponse({ state: 'gone' }) });
    renderPage();
    expect(await screen.findByText("This estimate can't book an assessment online")).toBeInTheDocument();
    expect(screen.queryByText(/find that lead/i)).toBeNull();
  });

  it('already_booked: the existing assessment and its reschedule link', async () => {
    stubFetch({
      get: jsonResponse({
        state: 'already_booked',
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: true, address_display: null },
        visit: { date: '2026-07-15', window: { start: '09:00', end: '09:30' }, serviceType: 'Waves Assessment' },
        rescheduleUrl: '/reschedule/feedface',
      }),
    });
    renderPage();
    expect(await screen.findByText(/Your free Waves Assessment is already scheduled/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Move that visit/i })).toHaveAttribute('href', '/reschedule/feedface');
  });

  it('a commit that finds the assessment already booked shows that state', async () => {
    stubFetch({
      post: jsonResponse({
        state: 'already_booked',
        lead: { first_name: 'Pat', phone_masked: '***0101', has_address: true, address_display: null },
        visit: { date: '2026-07-15', window: { start: '09:00', end: '09:30' } },
        rescheduleUrl: '/reschedule/feedface',
      }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Choose 1:00 PM on Sunday, July 12/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Book /i }));
    expect(await screen.findByText(/Your free Waves Assessment is already scheduled/i)).toBeInTheDocument();
  });

  it('a service-area hold shows the recoverable notice, never an empty calendar', async () => {
    stubFetch({ get: jsonResponse({ ...okPayload({ availability: null }), service_area_unavailable: true }) });
    renderPage();
    expect(await screen.findByText(/couldn.t confirm your service area/i)).toBeInTheDocument();
  });
});
