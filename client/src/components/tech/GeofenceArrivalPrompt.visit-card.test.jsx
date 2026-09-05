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
const GONE = notification('visit_cancelled', {
  headline: 'Visit cancelled', customer_name: 'Ruiz', service_type: 'Pest Control',
  when: 'Thu Sep 10, 9–11 AM', actor: 'by the office',
});

function stubFeed(notifications) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (!init.method) return { ok: true, json: async () => ({ notifications }) };
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

  it('renders each kind with its headline, customer, details, and who acted', async () => {
    stubFeed([ASSIGNED, MOVED, OFF, GONE]);
    render(<GeofenceArrivalPrompt />);
    await act(async () => { await Promise.resolve(); });

    const cards = await screen.findAllByTestId('visit-notice');
    expect(cards).toHaveLength(4);
    expect(cards[0]).toHaveTextContent('New visit on your route');
    expect(cards[0]).toHaveTextContent('Ruiz');
    expect(cards[0]).toHaveTextContent('Pest Control · Thu Sep 10, 9–11 AM');
    expect(cards[0]).toHaveTextContent('4312 Cortez Rd W, Bradenton');
    expect(cards[0]).toHaveTextContent('Assigned by Virginia');

    expect(cards[1]).toHaveTextContent('Was Thu Sep 10, 9–11 AM');
    expect(cards[1]).toHaveTextContent('Now Fri Sep 11, 1–3 PM');
    expect(cards[1]).toHaveTextContent('Moved by the customer online');

    expect(cards[2]).toHaveTextContent('Now with Adam Benetti');
    expect(cards[2]).toHaveTextContent('Reassigned by Virginia');

    expect(cards[3]).toHaveTextContent('Visit cancelled');
    expect(cards[3]).toHaveTextContent('Cancelled by the office');
    // No "Open visit": the tech home has no per-visit page to land on.
    expect(screen.queryByRole('button', { name: /open visit/i })).not.toBeInTheDocument();
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
