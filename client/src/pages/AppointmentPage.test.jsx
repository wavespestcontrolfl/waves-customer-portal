// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppointmentPage from './AppointmentPage';

vi.mock('../components/brand', () => ({
  WavesShell: ({ children }) => <div>{children}</div>,
}));

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function upcomingPayload(overrides = {}) {
  return {
    state: 'upcoming',
    // The server no longer sends this. It stays in the fixture on purpose:
    // the greeting assertions prove the page ignores it even when present.
    customerFirstName: 'Pat',
    service: { type: 'Quarterly Pest Control' },
    // arrivalWindow is derived SERVER-side by the canonical helper; the page
    // renders it verbatim and must not recompute it from windowStart.
    // windowStart is still sent so the confirm POST can pin the slot.
    appointment: { date: '2026-08-05', windowStart: '09:00', arrivalWindow: '9:00 AM - 11:00 AM' },
    confirmed: false,
    confirmable: true,
    tech: { firstName: 'Adam', photoUrl: null, sameAsLastVisit: true },
    plan: { isRecurring: true, collectiveAnchor: true },
    weather: { rainChance: 15, stormy: false },
    rescheduleToken: 'deadbeef',
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/appointment/deadbeef']}>
      <Routes>
        <Route path="/appointment/:token" element={<AppointmentPage />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function stubFetch({ get, post } = {}) {
  const fetchMock = vi.fn((url, opts = {}) => {
    if (opts.method === 'POST') {
      return Promise.resolve(post || jsonResponse({ error: 'unexpected POST' }, 500));
    }
    return Promise.resolve(get || jsonResponse(upcomingPayload()));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('AppointmentPage upcoming visit', () => {
  it('renders the server-derived arrival window verbatim, never the job block', async () => {
    stubFetch();

    renderPage();

    // The server sends the canonical range; the page prints what it is given.
    expect(await screen.findByText(/2-hour arrival window · 9:00 AM - 11:00 AM/)).toBeInTheDocument();
    expect(screen.getByText(/no waiting on a whole morning/)).toBeInTheDocument();
  });

  it('omits the window line and its promise when the server sends no range', async () => {
    // A missing or malformed window_start yields arrivalWindow: null. The
    // page must not fall back to computing one, and "inside this 2-hour
    // window" must not dangle with no window on the card.
    stubFetch({
      get: jsonResponse(upcomingPayload({
        appointment: { date: '2026-08-05', windowStart: null, arrivalWindow: null },
      })),
    });

    renderPage();

    expect(await screen.findByText(/Wednesday, August 5/)).toBeInTheDocument();
    expect(screen.queryByText(/2-hour arrival window/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no waiting on a whole morning/)).not.toBeInTheDocument();
  });

  it('names the service in the heading and shows the tech with the tracking promise', async () => {
    stubFetch();

    renderPage();

    // No greeting by name: the token is per-visit and reaches spouses,
    // tenants and buyers, each of whom the SMS greeted by THEIR name.
    expect(await screen.findByText(/Your quarterly pest control is/)).toBeInTheDocument();
    expect(screen.queryByText(/Hi Pat/)).not.toBeInTheDocument();
    expect(screen.getByText('Adam is your technician')).toBeInTheDocument();
    expect(screen.getByText('The same technician as your last visit.')).toBeInTheDocument();
    expect(screen.getByText(/live tracking link/)).toBeInTheDocument();
  });

  it('shows the plan note for a recurring visit and a neutral note for a one-time', async () => {
    stubFetch();
    renderPage();
    expect(await screen.findByText(/Part of your regular plan/)).toBeInTheDocument();
    expect(screen.getByText(/re-anchor around the new date/)).toBeInTheDocument();
    cleanup();

    stubFetch({ get: jsonResponse(upcomingPayload({ plan: { isRecurring: false, collectiveAnchor: false } })) });
    renderPage();
    expect(await screen.findByText(/One-time treatment/)).toBeInTheDocument();
    // NO guarantee language on one-time visits: coverage varies by service
    // and some one-time work (Bora-Care) carries a SIGNED no-retreatment
    // agreement a blanket promise would contradict (codex P1).
    expect(screen.queryByText(/Guarantee/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/activity comes back/i)).not.toBeInTheDocument();
    expect(screen.getByText(/service report will cover/)).toBeInTheDocument();
  });

  it('shows the storm heads-up only when the forecast is stormy', async () => {
    stubFetch();
    renderPage();
    await screen.findByText(/15% rain/);
    expect(screen.queryByText(/Storms are possible/)).not.toBeInTheDocument();
    cleanup();

    stubFetch({ get: jsonResponse(upcomingPayload({ weather: { rainChance: 70, stormy: true } })) });
    renderPage();
    expect(await screen.findByText(/Storms are possible that day/)).toBeInTheDocument();
    expect(screen.getByText(/dry hours to bond/)).toBeInTheDocument();
  });

  it('confirms in place and drops the CTA once confirmed', async () => {
    const fetchMock = stubFetch({ post: jsonResponse({ success: true, confirmed: true }) });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm this appointment' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Confirm this appointment' })).not.toBeInTheDocument();
    });
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    const posted = fetchMock.mock.calls.find(([, o]) => o?.method === 'POST');
    expect(String(posted[0])).toContain('/confirm');
    // The POST carries the slot on screen so the server can refuse to
    // confirm a visit an office bulk reschedule moved underneath it.
    expect(JSON.parse(posted[1].body)).toEqual({ date: '2026-08-05', windowStart: '09:00' });
  });

  it('an already-confirmed visit shows no Confirm CTA', async () => {
    stubFetch({ get: jsonResponse(upcomingPayload({ confirmed: true })) });

    renderPage();

    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm this appointment' })).not.toBeInTheDocument();
  });

  it('honors the server confirmable flag — no CTA that would deterministically 409', async () => {
    // Dispatch-owned pending rows return confirmable:false with the visit
    // still viewable; the button must not render (codex P1).
    stubFetch({ get: jsonResponse(upcomingPayload({ confirmable: false })) });

    renderPage();

    expect(await screen.findByText(/quarterly pest control/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm this appointment' })).not.toBeInTheDocument();
  });

  it('a visit that changed under the customer reloads instead of retrying a stale action', async () => {
    const fetchMock = stubFetch({
      post: jsonResponse({ error: 'gone', code: 'NOT_CONFIRMABLE' }, 409),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm this appointment' }));

    expect(await screen.findByText(/just changed/)).toBeInTheDocument();
    await waitFor(() => {
      const loads = fetchMock.mock.calls.filter(([, o]) => o?.method !== 'POST');
      expect(loads.length).toBeGreaterThan(1);
    });
  });

  it('links the calendar file and the reschedule page', async () => {
    stubFetch();

    renderPage();

    const cal = await screen.findByText('Add to calendar');
    expect(cal.closest('a')).toHaveAttribute('href', expect.stringContaining('/calendar.ics'));
    expect(screen.getByText('See open times').closest('a')).toHaveAttribute('href', '/reschedule/deadbeef');
  });
});

describe('AppointmentPage non-upcoming states', () => {
  it('each terminal state gets its own copy and contact options, never the appointment card', async () => {
    const cases = [
      ['completed', /This visit is complete/],
      ['cancelled', /This appointment was cancelled/],
      ['in_progress', /Your technician is on the way/],
      ['past', /time has passed/],
      ['not_available', /can't show this appointment/],
    ];
    for (const [state, matcher] of cases) {
      stubFetch({ get: jsonResponse({ state, service: { type: 'Pest Control' }, appointment: {} }) });
      renderPage();
      expect(await screen.findByText(matcher)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Confirm this appointment' })).not.toBeInTheDocument();
      expect(screen.queryByText('Add to calendar')).not.toBeInTheDocument();
      expect(screen.getByText('Text Waves')).toBeInTheDocument();
      cleanup();
    }
  });

  it('a 404 token shows the friendly not-found card', async () => {
    stubFetch({ get: jsonResponse({ error: 'Not found' }, 404) });

    renderPage();

    expect(await screen.findByText("We couldn't find that appointment")).toBeInTheDocument();
  });

  it('a temporary outage is distinguished from a bad link and can be retried', async () => {
    const fetchMock = stubFetch({ get: jsonResponse({ error: 'unavailable' }, 503) });

    renderPage();

    expect(await screen.findByText("We couldn't load that appointment")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
  });
});
