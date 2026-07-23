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

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// The availability payload the pre-gate tests drive the wizard with.
const availabilityPayload = {
  capture_token: 'capture-1',
  days: [{ date: '2026-07-20', fullDate: 'Monday, July 20', nearby: true, slots: [{ start_time: '09:00', start_label: '9:00 AM' }] }],
  slots: [{ start_time: '09:00' }],
};

function stubFetch({ config } = {}) {
  const fetchMock = vi.fn(async (url) => {
    const parsed = new URL(String(url), 'https://portal.test');
    if (parsed.pathname.endsWith('/booking/config')) {
      if (config === 'error') return jsonResponse({ error: 'nope' }, 500);
      return jsonResponse(config || { enabled: true });
    }
    if (parsed.searchParams.has('date_from')) return jsonResponse({ error: 'unavailable' }, 503);
    return jsonResponse(availabilityPayload);
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

    fireEvent.change(await screen.findByLabelText('Mobile number'), { target: { value: '(941) 555-0101' } });
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

  it('a config outage fails OPEN client-side (server still enforces at /confirm)', async () => {
    stubFetch({ config: 'error' });

    render(<MemoryRouter initialEntries={['/book']}><PublicBookingPage /></MemoryRouter>);

    expect(await screen.findByLabelText('Service address')).toBeInTheDocument();
    expect(screen.queryByText('Book your next visit')).not.toBeInTheDocument();
  });
});
