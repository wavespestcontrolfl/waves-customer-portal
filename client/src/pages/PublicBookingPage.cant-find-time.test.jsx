// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PublicBookingPage from './PublicBookingPage';
import { ESTIMATE_QUOTE_URL } from '../lib/estimateMarketingRedirects';

vi.mock('../components/AddressAutocomplete', () => ({
  default: ({ value, onChange, onSelect, placeholder }) => (
    <>
      <input aria-label="Service address" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      <button type="button" onClick={() => onSelect?.({
        line1: '123 Main St', line2: 'Apt A', formatted: '123 Main St Apt A, Sarasota, FL 34236',
        city: 'Sarasota', state: 'FL', zip: '34236', lat: 27.34, lng: -82.53,
      })}>Choose address with Apt A</button>
    </>
  ),
}));
vi.mock('../components/brand', async (importOriginal) => ({ ...(await importOriginal()), WavesShell: ({ children }) => <div>{children}</div> }));
vi.mock('../components/BrandFooter', () => ({ default: () => null }));
vi.mock('../components/booking/WavesAIScheduleSearch', () => ({
  default: ({ onSearch }) => <button type="button" onClick={() => onSearch('Tuesday afternoon')}>Test AI search</button>,
}));
vi.mock('../glass/glass-engine', () => ({ fireGlassConfetti: vi.fn(), useGlassSurface: () => {} }));
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

const futureDay = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function stubFetch({ config, empty, submitStatus = 200, submitBody = { ok: true } } = {}) {
  const fetchMock = vi.fn(async (url) => {
    const parsed = new URL(String(url), 'https://portal.test');
    if (parsed.pathname.endsWith('/booking/config')) return jsonResponse(config || { enabled: true });
    if (parsed.pathname.endsWith('/booking/preferred-time')) return jsonResponse(submitBody, submitStatus);
    if (empty) return jsonResponse({ capture_token: 'capture-1', days: [], slots: [] });
    return jsonResponse({
      capture_token: 'capture-1',
      days: [{ date: futureDay(3), fullDate: 'Thursday, July 30', nearby: true, slots: [{ start_time: '09:00', start_label: '9:00 AM' }] }],
      slots: [{ start_time: '09:00' }],
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function reachStep2() {
  render(<MemoryRouter initialEntries={['/book']}><PublicBookingPage /></MemoryRouter>);
  fireEvent.change(await screen.findByLabelText('Service address'), { target: { value: '123 Main St' } });
  fireEvent.click(screen.getByRole('button', { name: 'Choose address with Apt A' }));
  fireEvent.click(screen.getByRole('button', { name: /Find my best times/ }));
}

beforeEach(() => {
  authState.customer = null;
  authState.isAuthenticated = false;
  authState.error = null;
  apiMock.fetchRaw.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PublicBookingPage \"Can't find a time?\" block (GATE_BOOK_PREFERRED_TIME)", () => {
  it('gate off: no block on the time step', async () => {
    stubFetch({ config: { enabled: true } });
    await reachStep2();
    await screen.findByRole('button', { name: /^Choose 9:00 AM/ });
    expect(screen.queryByTestId('cant-find-time')).not.toBeInTheDocument();
    expect(screen.queryByText(/Can't find a time that works/)).not.toBeInTheDocument();
  });

  it('gate on: the block sits under the picker with a text link to the business line and a collapsed form', async () => {
    stubFetch({ config: { enabled: true, preferred_time: true } });
    await reachStep2();
    await screen.findByRole('button', { name: /^Choose 9:00 AM/ });
    const block = await screen.findByTestId('cant-find-time');
    expect(within(block).getByText("Can't find a time that works?")).toBeInTheDocument();
    expect(within(block).getByText("Text our team and we'll fit you in.")).toBeInTheDocument();
    const link = within(block).getByRole('link', { name: /Text us at \(941\) 297-5749/ });
    expect(link).toHaveAttribute('href', 'sms:+19412975749');
    expect(within(block).queryByLabelText('Preferred day')).not.toBeInTheDocument();
    fireEvent.click(within(block).getByRole('button', { name: /tell us your preferred day and time/i }));
    expect(within(block).getByLabelText('Preferred day')).toBeInTheDocument();
  });

  it('zero times: the form opens by itself and the standing call/text copy has no owner name or signature', async () => {
    stubFetch({ config: { enabled: true, preferred_time: true }, empty: true });
    await reachStep2();
    const block = await screen.findByTestId('cant-find-time');
    expect(within(block).getByLabelText('Preferred day')).toBeInTheDocument();
    expect(block.textContent).not.toMatch(/Adam|Lawn Care/);
  });

  it('submits the request with the funnel token and shows the confirmation; nothing else is sent', async () => {
    const fetchMock = stubFetch({ config: { enabled: true, preferred_time: true }, empty: true });
    await reachStep2();
    const block = await screen.findByTestId('cant-find-time');

    // Missing phone/name are caught before any request.
    fireEvent.click(within(block).getByRole('button', { name: 'Send request' }));
    expect(await within(block).findByRole('alert')).toHaveTextContent(/name/i);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/booking/preferred-time'))).toBe(false);

    fireEvent.change(within(block).getByLabelText('Your name'), { target: { value: 'Pat Sample' } });
    fireEvent.change(within(block).getByLabelText('Mobile phone'), { target: { value: '(941) 555-0100' } });
    fireEvent.change(within(block).getByLabelText('Preferred day'), { target: { value: futureDay(6) } });
    fireEvent.click(within(block).getByLabelText('Afternoon'));
    fireEvent.change(within(block).getByLabelText(/Anything else/), { target: { value: 'Cortez' } });
    fireEvent.click(within(block).getByRole('button', { name: 'Send request' }));

    expect(await within(block).findByText('Got it — our team will text you to set a time.')).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/booking/preferred-time'));
    const sent = JSON.parse(call[1].body);
    expect(sent).toMatchObject({
      capture_token: 'capture-1', name: 'Pat Sample', phone: '(941) 555-0100',
      preferred_date: futureDay(6), time_of_day: 'afternoon', note: 'Cortez',
      address_line1: '123 Main St', city: 'Sarasota', zip: '34236', website: '',
    });
    // The only other calls are the page's own reads: no capture-intent staging.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/booking/capture-intent'))).toBe(false);
  });

  it('an expired funnel token tells the visitor to refresh or text, and keeps the form', async () => {
    stubFetch({ config: { enabled: true, preferred_time: true }, empty: true, submitStatus: 400, submitBody: { error: 'session_expired' } });
    await reachStep2();
    const block = await screen.findByTestId('cant-find-time');
    fireEvent.change(within(block).getByLabelText('Your name'), { target: { value: 'Pat Sample' } });
    fireEvent.change(within(block).getByLabelText('Mobile phone'), { target: { value: '9415550100' } });
    fireEvent.change(within(block).getByLabelText('Preferred day'), { target: { value: futureDay(6) } });
    fireEvent.click(within(block).getByRole('button', { name: 'Send request' }));
    expect(await within(block).findByRole('alert')).toHaveTextContent(/refresh it and try again, or text us at \(941\) 297-5749/);
    expect(within(block).getByRole('button', { name: 'Send request' })).toBeEnabled();
  });
});
