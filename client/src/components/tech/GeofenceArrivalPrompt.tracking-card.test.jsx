// @vitest-environment jsdom
// codex P1 (pre-push audit, feat/noshow-tracking-recut-20260911): a
// follow_through_tracking notification (no-show-detector.js) reaching this
// feed must actually render — not silently occupy a slot with no card —
// and, like a visit card, must never auto-dismiss.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GeofenceArrivalPrompt from './GeofenceArrivalPrompt';

function notification(type, payload, id = `n-${type}`) {
  return { id, type, message: 'server message', payload, created_at: '2026-09-08T18:41:00Z' };
}

const STAGE1 = notification('follow_through_tracking', { stage: 1, customer_name: 'Ichi', when: 'Thu Sep 10, 9–11 AM' }, 'n-track-1');
STAGE1.message = 'No departure or arrival is recorded for this window yet.';
const STAGE2 = notification('follow_through_tracking', { stage: 2, customer_name: 'Magno', when: 'Thu Sep 10, 9–11 AM' }, 'n-track-2');
STAGE2.message = 'The promised window ended over 30 minutes ago; no arrival is recorded.';

function stubFeed(notifications, { failPosts = false } = {}) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (!init.method) return { ok: true, json: async () => ({ notifications }) };
    if (failPosts) return { ok: false, status: 503, text: async () => 'down' };
    return { ok: true, json: async () => ({}) };
  }));
  return calls;
}

describe('GeofenceArrivalPrompt — missing-tracking cards', () => {
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

  it('renders a stage-1 tracking card with the server message and a Got it dismiss', async () => {
    stubFeed([STAGE1]);
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });

    const card = await screen.findByTestId('tracking-notice');
    expect(card).toHaveTextContent('No departure or arrival is recorded for this window yet.');
    // Identifies the visit — a tech with more than one open stop can't tell
    // which one a bare stage message is about (codex P1).
    expect(card).toHaveTextContent('Ichi');
    expect(card).toHaveTextContent('Thu Sep 10, 9–11 AM');
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
  });

  it('does not auto-dismiss a stage-2 card after the 5-minute reminder timer', async () => {
    stubFeed([STAGE2]);
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });
    await screen.findByTestId('tracking-notice');

    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000 + 1000); await Promise.resolve(); });
    expect(screen.getByTestId('tracking-notice')).toBeInTheDocument();
  });

  it('"Got it" dismisses it and posts the dismiss endpoint', async () => {
    const calls = stubFeed([STAGE1], { failPosts: false });
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });
    await screen.findByTestId('tracking-notice');

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('tracking-notice')).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.includes(`${STAGE1.id}/dismiss`))).toBe(true);
  });
});
