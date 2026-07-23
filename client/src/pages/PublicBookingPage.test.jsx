// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PublicBookingPage from './PublicBookingPage';
import { ESTIMATE_QUOTE_URL } from '../lib/estimateMarketingRedirects';

vi.mock('../components/AddressAutocomplete', () => ({
  default: ({ value, onChange, placeholder }) => (
    <input aria-label="Service address" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock('../components/brand', () => ({ WavesShell: ({ children }) => <div>{children}</div> }));
vi.mock('../components/BrandFooter', () => ({ default: () => null }));
vi.mock('../components/booking/WavesAIScheduleSearch', () => ({ default: () => null }));
vi.mock('../glass/glass-engine', () => ({ fireGlassConfetti: vi.fn() }));
vi.mock('../lib/analytics/events', () => ({
  track: vi.fn(),
  FUNNEL_EVENTS: new Proxy({}, { get: (_target, key) => String(key) }),
}));

// Controllable auth surface for the customers-only gate: default = signed
// out. Tests flip fields per scenario; the component re-reads on render.
const authState = vi.hoisted(() => ({
  customer: null,
  isAuthenticated: false,
  error: null,
  sendCode: vi.fn(async () => true),
  verifyCode: vi.fn(async () => false),
  clearError: vi.fn(),
}));
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => authState,
}));

// Ambient portal session surface: token present + a fetchRaw spy that
// delegates to the (stubbed) global fetch, so tests can prove which path a
// confirm rode without breaking the walk.
const apiMock = vi.hoisted(() => ({
  token: 'ambient-token',
  fetchRaw: vi.fn((url, opts) => globalThis.fetch(url, opts)),
}));
vi.mock('../utils/api', () => ({ api: apiMock, default: apiMock }));

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// The availability payload the wizard walks are driven with. Days must be
// FUTURE-dated or the funnel's staleness guard (correctly) hides them.
const futureDay = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const availabilityPayload = () => ({
  capture_token: 'capture-1',
  days: [{ date: futureDay(3), fullDate: 'Thursday, July 30', nearby: true, slots: [{ start_time: '09:00', start_label: '9:00 AM' }] }],
  slots: [{ start_time: '09:00' }],
});

function stubFetch({ config } = {}) {
  const fetchMock = vi.fn(async (url) => {
    const parsed = new URL(String(url), 'https://portal.test');
    if (parsed.pathname.endsWith('/booking/config')) {
      if (config === 'error') return jsonResponse({ error: 'nope' }, 500);
      return jsonResponse(config || { enabled: true });
    }
    if (parsed.pathname.endsWith('/booking/confirm')) return jsonResponse({ confirmationCode: 'WPC-1234' });
    if (parsed.searchParams.has('date_from')) return jsonResponse({ error: 'unavailable' }, 503);
    return jsonResponse(availabilityPayload());
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  authState.customer = null;
  authState.isAuthenticated = false;
  authState.error = null;
  authState.sendCode = vi.fn(async () => true);
  authState.verifyCode = vi.fn(async () => false);
  apiMock.fetchRaw.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PublicBookingPage custom-date failures', () => {
  it('shows a retryable outage instead of claiming the selected date has no openings', async () => {
    const fetchMock = stubFetch();

    render(<MemoryRouter initialEntries={['/book']}><PublicBookingPage /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('Service address'), { target: { value: '123 Main St' } });
    fireEvent.click(screen.getByRole('button', { name: /Find my best times/ }));

    const dateInput = await screen.findByLabelText(/Need a date further out/);
    fireEvent.change(dateInput, { target: { value: '2026-08-01' } });

    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't check that date right now");
    expect(screen.queryByText(/No open times on that date/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      const customDateCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('date_from=2026-08-01'));
      expect(customDateCalls).toHaveLength(2);
    });
  });
});

describe('PublicBookingPage customers-only gate (GATE_BOOKING_CUSTOMERS_ONLY)', () => {
  it('bare entries see the verification gate, with the quote wizard as the standing new-customer path', async () => {
    stubFetch({ config: { enabled: true, customers_only: true } });

    render(<MemoryRouter initialEntries={['/book']}><PublicBookingPage /></MemoryRouter>);

    expect(await screen.findByText('Book your next visit')).toBeInTheDocument();
    expect(screen.getByLabelText('Mobile number')).toBeInTheDocument();
    const quoteLink = screen.getByRole('link', { name: /Get your free quote/ });
    expect(quoteLink).toHaveAttribute('href', ESTIMATE_QUOTE_URL);
    // The wizard itself stays hidden until verification.
    expect(screen.queryByLabelText('Service address')).not.toBeInTheDocument();
  });

  it('two failed verifies surface the "may not be on file" hint without leaking which numbers exist', async () => {
    stubFetch({ config: { enabled: true, customers_only: true } });

    render(<MemoryRouter initialEntries={['/book']}><PublicBookingPage /></MemoryRouter>);

    // Pasted/autofilled E.164 shape — the leading US "1" must not dead-end
    // the gate (Codex round-2 P3); the send still goes out as 10 digits.
    fireEvent.change(await screen.findByLabelText('Mobile number'), { target: { value: '+1 (941) 555-0101' } });
    fireEvent.click(screen.getByRole('button', { name: 'Text me a sign-in code' }));
    await waitFor(() => expect(authState.sendCode).toHaveBeenCalledWith('+19415550101'));

    const codeInput = await screen.findByLabelText(/Enter the 6-digit code/);
    fireEvent.change(codeInput, { target: { value: '123456' } });
    const verifyButton = screen.getByRole('button', { name: 'Verify & continue' });

    fireEvent.click(verifyButton);
    await waitFor(() => expect(authState.verifyCode).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/may not be on file/)).not.toBeInTheDocument();

    fireEvent.click(verifyButton);
    await waitFor(() => expect(authState.verifyCode).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/may not be on file/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '(941) 297-5749' })).toHaveAttribute('href', 'tel:+19412975749');
    // The quote path stays visible beside the failure.
    expect(screen.getByRole('link', { name: /Get your free quote/ })).toBeInTheDocument();
  });

  it('accepted-estimate links (?accept_token=) skip the gate — the server re-verifies at confirm', async () => {
    stubFetch({ config: { enabled: true, customers_only: true } });

    render(
      <MemoryRouter initialEntries={['/book?service=lawn_care&source=estimate-accept&estimate_id=est-1&accept_token=tok']}>
        <PublicBookingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText('Service address')).toBeInTheDocument();
    expect(screen.queryByText('Book your next visit')).not.toBeInTheDocument();
  });

  it('a signed-in customer skips the gate and lands on the wizard', async () => {
    authState.isAuthenticated = true;
    authState.customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Lee', phone: '9415550101', email: 'pat@example.com' };
    stubFetch({ config: { enabled: true, customers_only: true } });

    render(<MemoryRouter initialEntries={['/book']}><PublicBookingPage /></MemoryRouter>);

    expect(await screen.findByLabelText('Service address')).toBeInTheDocument();
    expect(screen.queryByText('Book your next visit')).not.toBeInTheDocument();
  });

  it('token entries never ride the ambient portal session — no bearer, no prefill, no body customer_id', async () => {
    // A household member's signed-in session must not re-point a booking
    // link that belongs to the ESTIMATE's customer (Codex round-2 P2).
    authState.isAuthenticated = true;
    authState.customer = { id: 'cust-ambient', first_name: 'Alex', last_name: 'Ambient', phone: '9415559999', email: 'alex@example.com' };
    const fetchMock = stubFetch({ config: { enabled: true, customers_only: true } });

    render(
      <MemoryRouter initialEntries={['/book?service=lawn_care&source=estimate-accept&estimate_id=est-1&accept_token=tok']}>
        <PublicBookingPage />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText('Service address'), { target: { value: '123 Main St' } });
    fireEvent.click(screen.getByRole('button', { name: /Find my best times/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Thursday, July 30.*opening/ }));
    fireEvent.click(await screen.findByRole('button', { name: /9:00 AM/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue →' }));

    // Contact step is EMPTY — the ambient customer was not prefilled in.
    const firstName = await screen.findByLabelText('First name');
    expect(firstName).toHaveValue('');
    fireEvent.change(firstName, { target: { value: 'Pat' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Lee' } });
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '9415550101' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));

    await waitFor(() => {
      const confirmCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/booking/confirm'));
      expect(confirmCall).toBeTruthy();
      expect(confirmCall[1].headers.Authorization).toBeUndefined();
      const body = JSON.parse(confirmCall[1].body);
      expect(body.customer_id).toBeNull();
      expect(body.accept_token).toBe('tok');
    });
    expect(apiMock.fetchRaw).not.toHaveBeenCalled();
  });

  it('a config outage fails OPEN client-side (server still enforces at /confirm)', async () => {
    stubFetch({ config: 'error' });

    render(<MemoryRouter initialEntries={['/book']}><PublicBookingPage /></MemoryRouter>);

    expect(await screen.findByLabelText('Service address')).toBeInTheDocument();
    expect(screen.queryByText('Book your next visit')).not.toBeInTheDocument();
  });

  it('a signed-in customer still sends the bearer when the config fetch failed open', async () => {
    // The Authorization decision keys on the SESSION, not the config-derived
    // gate flag — otherwise a /booking/config blip would strip the header
    // while the server gate is on, 403ing a real customer (Codex round-4 P2).
    authState.isAuthenticated = true;
    authState.customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Lee', phone: '9415550101', email: 'pat@example.com' };
    stubFetch({ config: 'error' });

    render(<MemoryRouter initialEntries={['/book']}><PublicBookingPage /></MemoryRouter>);

    fireEvent.change(await screen.findByLabelText('Service address'), { target: { value: '123 Main St' } });
    fireEvent.click(screen.getByRole('button', { name: /Find my best times/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Thursday, July 30.*opening/ }));
    fireEvent.click(await screen.findByRole('button', { name: /9:00 AM/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue →' }));

    const firstName = await screen.findByLabelText('First name');
    fireEvent.change(firstName, { target: { value: 'Pat' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Lee' } });
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '9415550101' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));

    await waitFor(() => {
      const confirmCalls = apiMock.fetchRaw.mock.calls.filter(([url]) => String(url).includes('/booking/confirm'));
      expect(confirmCalls).toHaveLength(1);
    });
  });
});
