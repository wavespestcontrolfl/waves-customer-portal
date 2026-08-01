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
    customerFirstName: 'Pat',
    service: { type: 'Quarterly Pest Control' },
    appointment: { date: '2026-08-05', windowStart: '09:00' },
    confirmed: false,
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
  it('quotes the 2-hour arrival window from the start, never the job block', async () => {
    stubFetch();

    renderPage();

    // windowStart 09:00 -> the promise is 9:00-11:00 AM.
    expect(await screen.findByText(/2-hour arrival window · 9:00 AM–11:00 AM/)).toBeInTheDocument();
    expect(screen.getByText(/no waiting on a whole morning/)).toBeInTheDocument();
  });

  it('names the service in the heading and shows the tech with the tracking promise', async () => {
    stubFetch();

    renderPage();

    expect(await screen.findByText(/Hi Pat — your quarterly pest control is/)).toBeInTheDocument();
    expect(screen.getByText('Adam is your technician')).toBeInTheDocument();
    expect(screen.getByText('The same technician as your last visit.')).toBeInTheDocument();
    expect(screen.getByText(/live tracking link/)).toBeInTheDocument();
  });

  it('shows the plan note for a recurring visit and the guarantee note for a one-time', async () => {
    stubFetch();
    renderPage();
    expect(await screen.findByText(/Part of your regular plan/)).toBeInTheDocument();
    expect(screen.getByText(/re-anchor around the new date/)).toBeInTheDocument();
    cleanup();

    stubFetch({ get: jsonResponse(upcomingPayload({ plan: { isRecurring: false, collectiveAnchor: false } })) });
    renderPage();
    expect(await screen.findByText(/One-time treatment/)).toBeInTheDocument();
    expect(screen.getByText(/Waves Guarantee/)).toBeInTheDocument();
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
  });

  it('an already-confirmed visit shows no Confirm CTA', async () => {
    stubFetch({ get: jsonResponse(upcomingPayload({ confirmed: true })) });

    renderPage();

    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
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
