// @vitest-environment jsdom
// A text to the tech's own Twilio line (tech-line.js → tech_line_sms) renders
// as a kept card: sender, body, "Got it" dismiss — never the 5-minute timer.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GeofenceArrivalPrompt from './GeofenceArrivalPrompt';

const TEXT = {
  id: 'n-text', type: 'tech_line_sms', message: 'server message', created_at: '2026-09-08T18:41:00Z',
  payload: { headline: 'Text on your line', customer_name: 'Maria Ruiz', from: '+19415550199', body: 'Gate code is 4412, dog is friendly', media_count: 0 },
};
const PHOTOS = {
  id: 'n-photos', type: 'tech_line_sms', message: 'server message', created_at: '2026-09-08T18:42:00Z',
  payload: { headline: 'Text on your line', customer_name: '(941) 555-0199', from: '+19415550199', body: '', media_count: 2 },
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

describe('GeofenceArrivalPrompt — tech line text card', () => {
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

  it('shows who texted and what they said; a photos-only text names the media', async () => {
    stubFeed([TEXT, PHOTOS]);
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });
    const cards = await screen.findAllByTestId('tech-line-text');
    expect(cards).toHaveLength(2);
    // newest first
    expect(cards[0]).toHaveTextContent('(941) 555-0199');
    expect(cards[0]).toHaveTextContent('2 photos');
    expect(cards[1]).toHaveTextContent('Text on your line');
    expect(cards[1]).toHaveTextContent('Maria Ruiz');
    expect(cards[1]).toHaveTextContent('Gate code is 4412, dog is friendly');
  });

  it('stays until "Got it" (dismiss); the reminder timer never marks it read', async () => {
    const calls = stubFeed([TEXT]);
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByTestId('tech-line-text')).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(6 * 60 * 1000); });
    expect(screen.getByTestId('tech-line-text')).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/read'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('tech-line-text')).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/n-text/dismiss'))).toBe(true);
  });
});
