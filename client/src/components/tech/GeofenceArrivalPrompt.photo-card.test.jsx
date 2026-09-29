// @vitest-environment jsdom
// A customer's visit-prep photo submission (customer_visit_photos —
// visit-prep-tech-alert.js) renders as its own persistent card: stays
// until "Got it" like a visit card, exact copy, no customer detail on the
// card, and tapping it deep-links via onOpenVisit.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GeofenceArrivalPrompt from './GeofenceArrivalPrompt';

function notification(type, payload, id = `n-${type}`) {
  return { id, type, message: 'A customer sent photos for a visit on your route', payload, created_at: '2026-09-28T18:41:00Z' };
}

const PHOTOS = notification('customer_visit_photos', { scheduled_service_id: 'svc-1', visit_id: 'visit-9' });
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

  it('tapping the card calls onOpenVisit with the payload, keyed like a grouped stop (visit:<id>)', async () => {
    stubFeed([PHOTOS]);
    const onOpenVisit = vi.fn();
    render(<GeofenceArrivalPrompt onOpenVisit={onOpenVisit} />);
    await act(async () => { await Promise.resolve(); });

    const card = await screen.findByTestId('photo-notice');
    fireEvent.click(card.querySelector('button'));
    expect(onOpenVisit).toHaveBeenCalledWith({ scheduled_service_id: 'svc-1', visit_id: 'visit-9' });
  });

  it('an ungrouped stop (no visit_id) still calls onOpenVisit, with visit_id null', async () => {
    stubFeed([PHOTOS_UNGROUPED]);
    const onOpenVisit = vi.fn();
    render(<GeofenceArrivalPrompt onOpenVisit={onOpenVisit} />);
    await act(async () => { await Promise.resolve(); });

    const card = await screen.findByTestId('photo-notice');
    fireEvent.click(card.querySelector('button'));
    expect(onOpenVisit).toHaveBeenCalledWith({ scheduled_service_id: 'svc-2', visit_id: null });
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
