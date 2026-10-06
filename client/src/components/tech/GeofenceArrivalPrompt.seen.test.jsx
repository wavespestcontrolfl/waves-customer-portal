// @vitest-environment jsdom
// Owner 2026-10-06, "keep notices": an arrival, timer or storm notice stays
// until the tech has SEEN it. Its 5-minute (stop toast: 15 s) clock starts at
// first sight; an unseen card is never marked read by the clock.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GeofenceArrivalPrompt from './GeofenceArrivalPrompt';

const MIN = 60 * 1000;
const n = (id, type, payload = {}, message = 'server message') => ({ id, type, message, payload, created_at: new Date().toISOString() });
const REMINDER = n('n-remind', 'geofence_arrival_reminder', { customer_name: 'Okafor' });
const STARTED = n('n-started', 'geofence_timer_started', {}, 'Timer started for Okafor');
const STOPPED = n('n-stopped', 'geofence_timer_stopped', { customer_name: 'Okafor' }, 'Timer stopped');
const STORM = n('n-storm', 'storm_watch_alert', { job_id: 'job-1', city: 'Bradenton' });

let observers;
class FakeObserver {
  constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this); }
  observe(el) { this.targets.add(el); }
  unobserve(el) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
  takeRecords() { return []; }
}
// Report the card containing `text` as in view (ratio) or out of view.
function setView(el, ratio, { height = 100, viewport = 800 } = {}) {
  const wrapper = el.closest('[data-testid="notice-stack"] > div');
  for (const o of observers) {
    if (!o.targets.has(wrapper)) continue;
    act(() => o.cb([{
      target: wrapper, isIntersecting: ratio > 0, intersectionRatio: ratio,
      intersectionRect: { height: height * ratio }, rootBounds: { height: viewport },
    }]));
  }
}

function stubFeed(notifications) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (!init.method) return { ok: true, json: async () => ({ notifications }) };
    return { ok: true, json: async () => ({}) };
  }));
  return calls;
}
const posts = (calls, suffix) => calls.filter((c) => c.method === 'POST' && c.url.endsWith(suffix));
const advance = (ms) => act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); });

function mount(props = {}) {
  return render(<MemoryRouter><GeofenceArrivalPrompt placement="page" {...props} /></MemoryRouter>);
}
function setDocumentVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

describe('notices stay until seen', () => {
  beforeEach(() => {
    observers = [];
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    localStorage.setItem('waves_admin_token', 'tech-token');
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear();
    delete document.visibilityState;
  });

  it('an unseen reminder, timer-started card and storm card are not cleared or marked read after 30 minutes', async () => {
    const calls = stubFeed([REMINDER, STARTED, STORM]);
    mount();
    await screen.findByText('Okafor');
    await advance(30 * MIN);
    expect(screen.getByText('Okafor')).toBeInTheDocument();
    expect(screen.getByText(/Timer auto-started/)).toBeInTheDocument();
    expect(screen.getByText(/Storm watch/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST' && /\/(read|dismiss)$/.test(c.url))).toEqual([]);
  });

  it('once seen for 1.5 s, the 5-minute clock starts and the card is then marked read and cleared', async () => {
    const calls = stubFeed([STARTED]);
    mount();
    const text = await screen.findByText(/Timer auto-started/);
    setView(text, 1);
    await advance(1500);
    await advance(4 * MIN + 55 * 1000);
    expect(screen.getByText(/Timer auto-started/)).toBeInTheDocument();
    expect(posts(calls, '/n-started/read')).toHaveLength(0);
    await advance(10 * 1000);
    expect(screen.queryByText(/Timer auto-started/)).not.toBeInTheDocument();
    expect(posts(calls, '/n-started/read')).toHaveLength(1);
  });

  it('a card that is in view for less than 1.5 s, or less than half in view, is not seen', async () => {
    const calls = stubFeed([STARTED]);
    mount();
    const text = await screen.findByText(/Timer auto-started/);
    setView(text, 1);
    await advance(1000);
    setView(text, 0); // scrolled away
    await advance(10 * MIN);
    setView(text, 0.3); // peeking in
    await advance(10 * MIN);
    expect(screen.getByText(/Timer auto-started/)).toBeInTheDocument();
    expect(posts(calls, '/read')).toHaveLength(0);
  });

  it('a card taller than the screen counts as seen once half the screen shows it', async () => {
    const calls = stubFeed([STARTED]);
    mount();
    const text = await screen.findByText(/Timer auto-started/);
    // 2000 px card, 1000 px of it in an 800 px viewport: ratio 0.5 is not reachable by a taller card in a short one.
    const wrapper = text.closest('[data-testid="notice-stack"] > div');
    for (const o of observers) {
      if (o.targets.has(wrapper)) act(() => o.cb([{ target: wrapper, isIntersecting: true, intersectionRatio: 0.4, intersectionRect: { height: 800 }, rootBounds: { height: 800 } }]));
    }
    await advance(1500);
    await advance(5 * MIN + 1000);
    expect(screen.queryByText(/Timer auto-started/)).not.toBeInTheDocument();
    expect(posts(calls, '/read')).toHaveLength(1);
  });

  it('a card in view while the page is hidden is not seen until the page is visible again', async () => {
    stubFeed([STARTED]);
    mount();
    const text = await screen.findByText(/Timer auto-started/);
    setDocumentVisibility('hidden');
    setView(text, 1);
    await advance(10 * MIN);
    expect(screen.getByText(/Timer auto-started/)).toBeInTheDocument();
    // Back on screen: the 1.5 s dwell starts now, then the 5-minute clock.
    setDocumentVisibility('visible');
    await advance(1500 + 4 * MIN);
    expect(screen.getByText(/Timer auto-started/)).toBeInTheDocument();
    await advance(MIN + 1000);
    expect(screen.queryByText(/Timer auto-started/)).not.toBeInTheDocument();
  });

  it('a tap on the card counts as seen', async () => {
    const calls = stubFeed([STARTED]);
    mount();
    const text = await screen.findByText(/Timer auto-started/);
    await advance(MIN);
    fireEvent.click(text);
    await advance(5 * MIN + 1000);
    expect(screen.queryByText(/Timer auto-started/)).not.toBeInTheDocument();
    expect(posts(calls, '/n-started/read')).toHaveLength(1);
  });

  it('the clock runs from first sight: a new card arriving later does not restart it', async () => {
    let feed = [REMINDER];
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET' });
      if (!init.method) return { ok: true, json: async () => ({ notifications: feed }) };
      return { ok: true, json: async () => ({}) };
    }));
    mount();
    const text = await screen.findByText('Okafor');
    setView(text, 1);
    await advance(1500 + 4 * MIN);
    feed = [REMINDER, STARTED]; // poll brings a second card; the first card's timers are rebuilt
    await advance(10_000);
    expect(screen.getByText(/Timer auto-started/)).toBeInTheDocument();
    await advance(MIN);
    expect(screen.queryByText('Okafor')).not.toBeInTheDocument();
    expect(posts(calls, '/n-remind/read')).toHaveLength(1);
    expect(screen.getByText(/Timer auto-started/)).toBeInTheDocument(); // unseen: still there
  });

  it('an actionable reminder keeps its buttons while unseen and is never acted on', async () => {
    const calls = stubFeed([REMINDER]);
    mount();
    await screen.findByText('Okafor');
    await advance(20 * MIN);
    expect(screen.getByRole('button', { name: /start/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not here yet' })).toBeInTheDocument();
    expect(posts(calls, '/confirm-start')).toHaveLength(0);
    expect(posts(calls, '/dismiss')).toHaveLength(0);
  });

  it('the stop toast keeps its 15 s clock but starts it at first sight', async () => {
    const calls = stubFeed([STOPPED]);
    mount();
    const text = await screen.findByText(/Timer stopped/);
    await advance(2 * MIN);
    expect(screen.getByText(/Timer stopped/)).toBeInTheDocument();
    setView(text, 1);
    await advance(1500 + 14_000);
    expect(screen.getByText(/Timer stopped/)).toBeInTheDocument();
    await advance(1500);
    expect(screen.queryByText(/Timer stopped/)).not.toBeInTheDocument();
    expect(posts(calls, '/n-stopped/read')).toHaveLength(1);
  });

  it('tapping the close or Got-it control still clears an unseen card at once', async () => {
    const calls = stubFeed([STARTED]);
    mount();
    await screen.findByText(/Timer auto-started/);
    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    await advance(0);
    expect(screen.queryByText(/Timer auto-started/)).not.toBeInTheDocument();
    expect(posts(calls, '/n-started/read')).toHaveLength(1);
  });

  it('with no IntersectionObserver, a mounted card on a visible page counts as seen after the dwell', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const calls = stubFeed([STARTED]);
    mount();
    await screen.findByText(/Timer auto-started/);
    await advance(1500);
    await advance(5 * MIN + 1000);
    expect(screen.queryByText(/Timer auto-started/)).not.toBeInTheDocument();
    expect(posts(calls, '/n-started/read')).toHaveLength(1);
  });
});
