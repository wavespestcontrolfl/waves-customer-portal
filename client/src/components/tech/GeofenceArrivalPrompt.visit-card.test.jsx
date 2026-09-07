// @vitest-environment jsdom
// The tech-home feed renders the four visit-change notices from
// tech-visit-notifications.js as one card shape, and never auto-dismisses
// them: the card stays until the tech taps "Got it" (a dismiss, not a read).
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GeofenceArrivalPrompt from './GeofenceArrivalPrompt';

function notification(type, payload, id = `n-${type}`) {
  return { id, type, message: 'server message', payload, created_at: '2026-09-08T18:41:00Z' };
}

const ASSIGNED = notification('visit_assigned', {
  headline: 'New visit on your route', customer_name: 'Ruiz', service_type: 'Pest Control',
  when: 'Thu Sep 10, 9–11 AM', address: '4312 Cortez Rd W, Bradenton', actor: 'by Virginia',
});
const MOVED = notification('visit_rescheduled', {
  headline: 'Visit moved', customer_name: 'Ruiz', service_type: 'Pest Control',
  previous_when: 'Thu Sep 10, 9–11 AM', when: 'Fri Sep 11, 1–3 PM', actor: 'by the customer online',
});
const OFF = notification('visit_unassigned', {
  headline: 'Moved off your route', customer_name: 'Ruiz', service_type: 'Pest Control',
  when: 'Thu Sep 10, 9–11 AM', now_with: 'Adam Benetti', actor: 'by Virginia',
});
const OFF_ENDED = notification('visit_unassigned', {
  headline: 'Moved off your route', customer_name: 'Ruiz', service_type: 'Pest Control',
  when: 'Thu Sep 10, 9–11 AM', now_with: null, ended: 'cancelled', actor: 'by Virginia',
});
const GONE = notification('visit_cancelled', {
  headline: 'Visit cancelled', customer_name: 'Ruiz', service_type: 'Pest Control',
  when: 'Thu Sep 10, 9–11 AM', actor: 'by the office',
});

// `notifications` may be a function of the poll number (1-based) to vary
// the feed across polls; a poll may also be `{ error: status }`.
function stubFeed(notifications, { failPosts = false } = {}) {
  const calls = [];
  let polls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (!init.method) {
      const feed = typeof notifications === 'function' ? notifications(++polls) : notifications;
      if (feed && feed.error) return { ok: false, status: feed.error, json: async () => ({}) };
      return { ok: true, json: async () => ({ notifications: feed }) };
    }
    if (failPosts) return { ok: false, status: 503, text: async () => 'down' };
    return { ok: true, json: async () => ({}) };
  }));
  return calls;
}

describe('GeofenceArrivalPrompt — visit cards', () => {
  beforeEach(() => {
    localStorage.setItem('waves_admin_token', 'tech-token');
    // shouldAdvanceTime keeps findBy* polling alive while the 5-min timer is faked.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    ['assigned', ASSIGNED, ['New visit on your route', 'Ruiz', 'Pest Control · Thu Sep 10, 9–11 AM', '4312 Cortez Rd W, Bradenton', 'Assigned by Virginia']],
    ['rescheduled', MOVED, ['Visit moved', 'Was Thu Sep 10, 9–11 AM', 'Now Fri Sep 11, 1–3 PM', 'Moved by the customer online']],
    ['unassigned', OFF, ['Moved off your route', 'Now with Adam Benetti', 'Reassigned by Virginia']],
    ['unassigned (visit since ended)', OFF_ENDED, ['Moved off your route', 'Now cancelled', 'Reassigned by Virginia']],
    ['cancelled', GONE, ['Visit cancelled', 'Cancelled by the office']],
  ])('renders the %s card with its headline, customer, details, and who acted', async (_kind, fixture, expected) => {
    stubFeed([fixture]);
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });

    const card = await screen.findByTestId('visit-notice');
    for (const text of expected) expect(card).toHaveTextContent(text);
    // No "Open visit": the tech home has no per-visit page to land on.
    expect(screen.queryByRole('button', { name: /open visit/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
  });

  it('caps the stack at two visit cards (newest first) behind any geofence prompt, and summarizes the rest', async () => {
    const prompt = notification('geofence_arrival_reminder', { customer_name: 'Okafor' }, 'n-prompt');
    const storm = { ...notification('storm_watch_alert', { job_id: 'j-storm', city: 'Venice' }, 'n-storm'), created_at: new Date().toISOString() };
    const many = [1, 2, 3, 4, 5].map((i) => ({
      ...notification('visit_assigned', { headline: 'New visit on your route', customer_name: `Customer ${i}` }, `n-v${i}`),
      created_at: `2026-09-08T18:4${i}:00Z`,
    }));
    stubFeed([...many, prompt, storm]);
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });

    const cards = await screen.findAllByTestId('visit-notice');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('Customer 5');
    expect(cards[1]).toHaveTextContent('Customer 4');
    expect(screen.getByTestId('visit-notice-more')).toHaveTextContent('3 more schedule changes');
    // Anything on an auto-dismiss timer (arrival prompt, storm warning)
    // renders ABOVE the persistent visit cards so it cannot expire unseen.
    const promptCard = screen.getByText('Okafor');
    const stormCard = screen.getByText(/Storm watch/);
    expect(promptCard.compareDocumentPosition(cards[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stormCard.compareDocumentPosition(cards[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Clearing one promotes the next unread card; held-back cards were never marked read.
    fireEvent.click(screen.getAllByRole('button', { name: 'Got it' })[0]);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getAllByTestId('visit-notice')[1]).toHaveTextContent('Customer 3');
    expect(screen.getByTestId('visit-notice-more')).toHaveTextContent('2 more schedule changes');
  });

  it('a visit card the feed no longer lists (dismissed on the tech\'s other device) leaves this screen without a dismiss call, and comes back if the feed lists it again; a failed poll changes nothing', async () => {
    const calls = stubFeed((poll) => {
      if (poll === 2) return [MOVED]; // ASSIGNED was dismissed elsewhere
      if (poll === 3) return { error: 503 }; // a bad poll is not an empty feed
      return [ASSIGNED, MOVED]; // poll 4: the feed lists it again (it had only been pushed out of the window)
    });
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findAllByTestId('visit-notice')).toHaveLength(2);

    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    const after = await screen.findAllByTestId('visit-notice');
    expect(after).toHaveLength(1);
    expect(after[0]).toHaveTextContent('Visit moved');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(screen.getAllByTestId('visit-notice')).toHaveLength(1);

    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(await screen.findAllByTestId('visit-notice')).toHaveLength(2);
  });

  it('a "Got it" the network lost brings the card back on the next poll instead of hiding it for the session', async () => {
    const calls = stubFeed([ASSIGNED], { failPosts: true });
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByTestId('visit-notice')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByTestId('visit-notice')).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/dismiss'))).toBe(true);

    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(await screen.findByTestId('visit-notice')).toBeInTheDocument();
  });

  it('stays until "Got it" (dismiss) — the 5-minute reminder timer never marks it read', async () => {
    const calls = stubFeed([ASSIGNED]);
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByTestId('visit-notice')).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(6 * 60 * 1000); });
    expect(screen.getByTestId('visit-notice')).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/read'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('visit-notice')).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/n-visit_assigned/dismiss'))).toBe(true);
  });
});
