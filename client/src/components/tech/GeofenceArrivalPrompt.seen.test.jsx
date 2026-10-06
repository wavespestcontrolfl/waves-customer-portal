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
const VIEWPORT = { w: 400, h: 800 };
// The observer only says "near the viewport"; the seen check measures the
// card itself at the end of the dwell. place() sets what that measurement
// reads (the card's rect) and tells the observer whether the card intersects.
let covered; // true while a modal sits on top of the card
function place(el, { top = 100, height = 100 } = {}) {
  const wrapper = el.closest('[data-testid="notice-stack"] > div');
  const rect = { top, bottom: top + height, left: 0, right: VIEWPORT.w, width: VIEWPORT.w, height };
  wrapper.getBoundingClientRect = () => rect;
  const intersects = rect.bottom > 0 && rect.top < VIEWPORT.h;
  for (const o of observers) {
    if (!o.targets.has(wrapper)) continue;
    act(() => o.cb([{ target: wrapper, isIntersecting: intersects }]));
  }
  return wrapper;
}
// Convenience: fully in view.
const setView = (el, ratio) => (ratio > 0 ? place(el, { top: 100, height: 100 }) : place(el, { top: -500, height: 100 }));

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
    covered = false;
    vi.stubGlobal('innerWidth', VIEWPORT.w);
    vi.stubGlobal('innerHeight', VIEWPORT.h);
    // jsdom has no layout: the point at the card's visible middle hits the
    // card, unless a modal covers it.
    document.elementFromPoint = (x, y) => (covered ? document.body : document.querySelector('[data-testid="notice-stack"] > div'));
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    localStorage.setItem('waves_admin_token', 'tech-token');
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear();
    delete document.visibilityState;
    delete document.elementFromPoint;
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

  it('a card that is in view for less than 1.5 s is not seen', async () => {
    const calls = stubFeed([STARTED]);
    mount();
    const text = await screen.findByText(/Timer auto-started/);
    setView(text, 1);
    await advance(1000);
    setView(text, 0); // scrolled away
    await advance(10 * MIN);
    expect(screen.getByText(/Timer auto-started/)).toBeInTheDocument();
    expect(posts(calls, '/read')).toHaveLength(0);
  });

  it('a tall card needs half the SCREEN showing: 399 px of an 800 px screen is not enough, 400 px is', async () => {
    const calls = stubFeed([STARTED]);
    mount();
    const text = await screen.findByText(/Timer auto-started/);
    // 3000 px card whose top 399 px shows: under both half the card and half the screen.
    place(text, { top: VIEWPORT.h - 399, height: 3000 });
    await advance(10 * MIN);
    expect(screen.getByText(/Timer auto-started/)).toBeInTheDocument();
    expect(posts(calls, '/read')).toHaveLength(0);
    // Scrolled so 400 px (half the screen) of it shows: counts at the next check.
    place(text, { top: VIEWPORT.h - 400, height: 3000 });
    await advance(1500);
    await advance(5 * MIN + 1000);
    expect(screen.queryByText(/Timer auto-started/)).not.toBeInTheDocument();
    expect(posts(calls, '/read')).toHaveLength(1);
  });

  it('a short card with less than half showing is not seen; half showing is', async () => {
    const calls = stubFeed([STARTED]);
    mount();
    const text = await screen.findByText(/Timer auto-started/);
    place(text, { top: VIEWPORT.h - 49, height: 100 }); // 49% shows
    await advance(10 * MIN);
    expect(posts(calls, '/read')).toHaveLength(0);
    place(text, { top: VIEWPORT.h - 50, height: 100 }); // 50% shows
    await advance(1500);
    await advance(5 * MIN + 1000);
    expect(posts(calls, '/n-started/read')).toHaveLength(1);
  });

  it('a card under a fixed modal is not seen, though the observer reports it intersecting; it counts once the modal closes', async () => {
    const calls = stubFeed([STARTED]);
    mount();
    const text = await screen.findByText(/Timer auto-started/);
    covered = true;
    place(text, { top: 100, height: 100 });
    await advance(10 * MIN);
    expect(screen.getByText(/Timer auto-started/)).toBeInTheDocument();
    expect(posts(calls, '/read')).toHaveLength(0);
    covered = false; // modal closed: no observer event, the recheck finds the card
    await advance(1500);
    await advance(5 * MIN + 1000);
    expect(screen.queryByText(/Timer auto-started/)).not.toBeInTheDocument();
    expect(posts(calls, '/n-started/read')).toHaveLength(1);
  });

  it('a card that scrolled out before the dwell ended is not seen', async () => {
    stubFeed([STARTED]);
    mount();
    const text = await screen.findByText(/Timer auto-started/);
    place(text, { top: 100, height: 100 });
    await advance(1000);
    place(text, { top: -500, height: 100 });
    await advance(10 * MIN);
    expect(screen.getByText(/Timer auto-started/)).toBeInTheDocument();
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
    const text = await screen.findByText(/Timer auto-started/);
    text.closest('[data-testid="notice-stack"] > div').getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 0, right: VIEWPORT.w, width: VIEWPORT.w, height: 100 });
    await advance(1500);
    await advance(5 * MIN + 1000);
    expect(screen.queryByText(/Timer auto-started/)).not.toBeInTheDocument();
    expect(posts(calls, '/n-started/read')).toHaveLength(1);
  });
  // Server age rules (ET-midnight cap on arrival prompts, the 30-minute Undo
  // window on stop notices, the 6-hour storm cap) stop listing the row; a
  // mounted Today page must drop the card, not keep it past the cap.
  it('a card the feed stops listing leaves the screen without a /read post (arrival prompt at ET midnight)', async () => {
    let feed = [REMINDER, STORM];
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET' });
      if (!init.method) return { ok: true, json: async () => ({ notifications: feed }) };
      return { ok: true, json: async () => ({}) };
    }));
    mount();
    await screen.findByText('Okafor');
    expect(screen.getByText(/Storm watch/)).toBeInTheDocument();
    feed = []; // the server's day cap and storm cap stop serving them
    await advance(10_000);
    expect(screen.queryByText('Okafor')).not.toBeInTheDocument();
    expect(screen.queryByText(/Storm watch/)).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('a stop toast older than the 30-minute Undo window shows no Undo button', async () => {
    const old = { ...STOPPED, created_at: new Date(Date.now() - 31 * MIN).toISOString() };
    stubFeed([old]);
    mount();
    await screen.findByText(/Timer stopped/);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    cleanup();
    stubFeed([STOPPED]);
    mount();
    await screen.findByText(/Timer stopped/);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });
});
