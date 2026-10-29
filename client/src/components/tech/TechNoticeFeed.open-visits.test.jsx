// @vitest-environment jsdom
// The 7 PM open-visits reminder (tech-open-visit-nudge.js → tech_open_visit_nudge)
// renders as a kept card: headline + the server's stop lines, "Got it" dismiss —
// never the 5-minute timer (it is the durable copy when the push misses).
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TechNoticeFeed from './TechNoticeFeed';

const NUDGE = {
  id: 'n-open', type: 'tech_open_visit_nudge', created_at: '2026-09-28T23:00:00Z',
  message: '2 visits from today still open.\n9:00 AM - Ana R. - Pest Control\n11:00 AM - Bo L. - Lawn Care (not started)',
  payload: { headline: '2 visits from today still open', visit_ids: ['v1', 'v2'], count: 2 },
};

function stubFeed(notifications) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (!init.method) return { ok: true, json: async () => ({ notifications }) };
    return { ok: true, json: async () => ({}) };
  }));
  return calls;
}

describe('TechNoticeFeed — open visits card', () => {
  beforeEach(() => {
    localStorage.setItem('waves_admin_token', 'tech-token');
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows the headline and each open stop', async () => {
    stubFeed([NUDGE]);
    render(<TechNoticeFeed />);
    await act(async () => { await Promise.resolve(); });
    const card = await screen.findByTestId('tech-open-visits');
    expect(card).toHaveTextContent('2 visits from today still open');
    expect(card).toHaveTextContent('9:00 AM - Ana R. - Pest Control');
    expect(card).toHaveTextContent('11:00 AM - Bo L. - Lawn Care (not started)');
  });

  it('stays until "Got it" (dismiss); the reminder timer never marks it read', async () => {
    const calls = stubFeed([NUDGE]);
    render(<TechNoticeFeed />);
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByTestId('tech-open-visits')).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(6 * 60 * 1000); });
    expect(screen.getByTestId('tech-open-visits')).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/read'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('tech-open-visits')).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/n-open/dismiss'))).toBe(true);
  });

  it.each(['tech_clock_out_reminder', 'tech_auto_clock_out'])('renders the %s clock-out card the same way', async (type) => {
    stubFeed([{
      id: 'n-clock', type, created_at: '2026-09-28T23:00:00Z',
      message: 'Hey Ana, you have been clocked in for 10 hours.',
      payload: { headline: 'Clock out when you are done' },
    }]);
    render(<TechNoticeFeed />);
    await act(async () => { await Promise.resolve(); });
    const card = await screen.findByTestId('tech-open-visits');
    expect(card).toHaveTextContent('Clock out when you are done');
    expect(card).toHaveTextContent('you have been clocked in for 10 hours');
  });

  it('renders the one series_handover summary card the same way', async () => {
    stubFeed([{
      id: 'n-handover', type: 'series_handover', created_at: '2026-11-01T23:00:00Z',
      message: 'You now have 12 visits across 9 customers. They are on your schedule.',
      payload: { headline: 'Visits moved to your schedule', visits: 12, customers: 9, series: 7 },
    }]);
    render(<TechNoticeFeed />);
    await act(async () => { await Promise.resolve(); });
    const card = await screen.findByTestId('tech-open-visits');
    expect(card).toHaveTextContent('Visits moved to your schedule');
    expect(card).toHaveTextContent('You now have 12 visits across 9 customers');
  });
});
