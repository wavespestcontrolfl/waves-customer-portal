// @vitest-environment jsdom
// A lawn visit whose watering text could not go out because two products clash
// (lawn-watering-sms.js → lawn_watering_tech_note) renders as a kept card:
// headline, customer, the server's message, "Got it" dismiss.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TechNoticeFeed from './TechNoticeFeed';

const NOTE = {
  id: 'n-water', type: 'lawn_watering_tech_note', created_at: '2026-10-24T20:00:00Z',
  message: 'Dylox needs watering in, and Advion needs time with no water. No text to the customer can do both. Water Dylox in on site before you leave.',
  payload: {
    headline: 'Water this in before you leave', customer_name: 'Pat Sample', address: '1 Example Way',
    service_id: 'svc-1', reason: 'water_in_conflict',
  },
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

describe('TechNoticeFeed — lawn watering note card', () => {
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

  it('shows the headline, the customer and the message', async () => {
    stubFeed([NOTE]);
    render(<TechNoticeFeed />);
    await act(async () => { await Promise.resolve(); });
    const card = await screen.findByTestId('lawn-watering-tech-note');
    expect(card).toHaveTextContent('Water this in before you leave');
    expect(card).toHaveTextContent('Pat Sample');
    expect(card).toHaveTextContent('Water Dylox in on site before you leave.');
  });

  it('falls back to the default headline when the payload has none', async () => {
    stubFeed([{ ...NOTE, payload: { customer_name: 'Pat Sample' } }]);
    render(<TechNoticeFeed />);
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByTestId('lawn-watering-tech-note')).toHaveTextContent('Water this in before you leave');
  });

  it('stays until "Got it"; the reminder timer never marks it read', async () => {
    const calls = stubFeed([NOTE]);
    render(<TechNoticeFeed />);
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByTestId('lawn-watering-tech-note')).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(6 * 60 * 1000); });
    expect(screen.getByTestId('lawn-watering-tech-note')).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/read'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('lawn-watering-tech-note')).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/n-water/dismiss'))).toBe(true);
  });
});
