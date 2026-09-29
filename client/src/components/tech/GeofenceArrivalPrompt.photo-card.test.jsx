// @vitest-environment jsdom
// A customer's visit-prep photo submission (customer_visit_photos —
// visit-prep-tech-alert.js) renders as its own persistent card: stays
// until "Got it" like a visit card, exact copy, no customer detail on the
// card, and the visit's date instead of a tap-through (the tech app only
// opens today's route; Codex #5303 r1 P1).
import '@testing-library/jest-dom/vitest';
import { act, waitFor, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GeofenceArrivalPrompt from './GeofenceArrivalPrompt';

function notification(type, payload, id = `n-${type}`) {
  return { id, type, message: 'A customer sent photos for a visit on your route', payload, created_at: '2026-09-28T18:41:00Z' };
}

const PHOTOS = notification('customer_visit_photos', { scheduled_service_id: 'svc-1', visit_id: 'visit-9', scheduled_date: '2026-10-02' });
const PHOTOS_UNGROUPED = notification('customer_visit_photos', { scheduled_service_id: 'svc-2', visit_id: null }, 'n-photos-2');

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

describe('GeofenceArrivalPrompt — visit-prep photo card', () => {
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

  it('renders the exact copy, no "Open visit" wording, and a "Got it" dismiss', async () => {
    stubFeed([PHOTOS]);
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });

    const card = await screen.findByTestId('photo-notice');
    expect(card).toHaveTextContent('A customer sent photos for a visit on your route');
    // No customer name/address/note ever rides this card (owner ruling,
    // scope doc §5.4 item 4) — nothing in the fixture's payload is a
    // customer detail, and the card renders none of it besides the fixed copy.
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
  });

  it('stays until "Got it" — the 5-minute reminder timer never marks it read', async () => {
    const calls = stubFeed([PHOTOS]);
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByTestId('photo-notice')).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(6 * 60 * 1000); });
    expect(screen.getByTestId('photo-notice')).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/read'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('photo-notice')).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith(`/${PHOTOS.id}/dismiss`))).toBe(true);
  });

  it('names the visit date and has exactly one action, "Got it" (no dead-end tap-through)', async () => {
    stubFeed([PHOTOS]);
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });

    const card = await screen.findByTestId('photo-notice');
    expect(card).toHaveTextContent("Visit on Fri, Oct 2. The photos are in that stop's Visit Brief.");
    expect(card.querySelectorAll('button')).toHaveLength(1);
  });

  it('a card already on screen takes the new date when its visit moves (same tech)', async () => {
    const moved = { ...PHOTOS, payload: { ...PHOTOS.payload, scheduled_date: '2026-10-09' } };
    stubFeed((poll) => (poll === 1 ? [PHOTOS] : [moved]));
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByTestId('photo-notice')).toHaveTextContent('Visit on Fri, Oct 2.');
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByTestId('photo-notice')).toHaveTextContent('Visit on Fri, Oct 9.'));
  });

  it('an older card with no date still renders the copy and "Got it"', async () => {
    stubFeed([PHOTOS_UNGROUPED]);
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });

    const card = await screen.findByTestId('photo-notice');
    expect(card).toHaveTextContent('A customer sent photos for a visit on your route');
    expect(card).not.toHaveTextContent('Visit on');
  });

  it('shares the visit-card cap and slot: a photo card and a visit card together are capped at two, newest first', async () => {
    const assigned = notification('visit_assigned', { headline: 'New visit on your route', customer_name: 'Ruiz' }, 'n-assigned');
    const older = { ...PHOTOS, created_at: '2026-09-28T10:00:00Z' };
    const newer = { ...assigned, created_at: '2026-09-28T20:00:00Z' };
    stubFeed([older, newer]);
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });

    expect(await screen.findByTestId('photo-notice')).toBeInTheDocument();
    expect(screen.getByTestId('visit-notice')).toBeInTheDocument();
  });
});
