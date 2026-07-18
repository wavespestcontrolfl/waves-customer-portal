// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicBookingPage from './PublicBookingPage';

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

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PublicBookingPage custom-date failures', () => {
  it('shows a retryable outage instead of claiming the selected date has no openings', async () => {
    const fetchMock = vi.fn(async (url) => {
      const parsed = new URL(String(url), 'https://portal.test');
      if (parsed.searchParams.has('date_from')) return jsonResponse({ error: 'unavailable' }, 503);
      return jsonResponse({
        capture_token: 'capture-1',
        days: [{ date: '2026-07-20', fullDate: 'Monday, July 20', nearby: true, slots: [{ start_time: '09:00', start_label: '9:00 AM' }] }],
        slots: [{ start_time: '09:00' }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<MemoryRouter initialEntries={['/book']}><PublicBookingPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Service address'), { target: { value: '123 Main St' } });
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
