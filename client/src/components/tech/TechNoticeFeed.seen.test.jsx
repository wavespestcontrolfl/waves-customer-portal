// @vitest-environment jsdom
// Owner 2026-10-06, "keep notices": a storm notice stays until the tech has
// SEEN it. Its 5-minute clock starts at first sight; an unseen card is never
// marked read by the clock.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TechNoticeFeed from './TechNoticeFeed';

const MIN = 60 * 1000;
const n = (id, type, payload = {}, message = 'server message') => ({ id, type, message, payload, created_at: new Date().toISOString() });
const STORM = n('n-storm', 'storm_watch_alert', { job_id: 'job-1', city: 'Bradenton' }, 'Storm near Okafor');
const STORM_B = n('n-storm-b', 'storm_watch_alert', { job_id: 'job-2', city: 'Palmetto' }, 'Storm near Ruiz');

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
  const watching = observers.filter((o) => o.targets.has(wrapper));
  // A report no observer receives would leave the card unseen for good.
  if (watching.length === 0) throw new Error('place(): no IntersectionObserver watches this card yet; find it with findCard()');
  const rect = { top, bottom: top + height, left: 0, right: VIEWPORT.w, width: VIEWPORT.w, height };
  wrapper.getBoundingClientRect = () => rect;
  const intersects = rect.bottom > 0 && rect.top < VIEWPORT.h;
  for (const o of watching) act(() => o.cb([{ target: wrapper, isIntersecting: intersects }]));
  return wrapper;
}
// The card's observer is created in a passive effect. On a slow runner React
// can run that effect after findByText has returned, so wait for the observer
// before place() reports to it.
async function findCard(text) {
  const el = await screen.findByText(text);
  const wrapper = el.closest('[data-testid="notice-stack"] > div');
  await waitFor(() => expect(observers.some((o) => o.targets.has(wrapper))).toBe(true));
  return el;
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
  return render(<MemoryRouter><TechNoticeFeed placement="page" {...props} /></MemoryRouter>);
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

  it('an unseen storm card is not cleared or marked read after 30 minutes, and keeps its buttons', async () => {
    const calls = stubFeed([STORM]);
    mount();
    await screen.findByText(/Storm watch/);
    await advance(30 * MIN);
    expect(screen.getByText(/Storm watch/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review options' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Working through it' })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST' && /\/(read|dismiss)$/.test(c.url))).toEqual([]);
  });

  it('once seen for 1.5 s, the 5-minute clock starts and the card is then marked read and cleared', async () => {
    const calls = stubFeed([STORM]);
    mount();
    const text = await findCard(/Storm watch/);
    setView(text, 1);
    await advance(1500);
    await advance(4 * MIN + 55 * 1000);
    expect(screen.getByText(/Storm watch/)).toBeInTheDocument();
    expect(posts(calls, '/n-storm/read')).toHaveLength(0);
    await advance(10 * 1000);
    expect(screen.queryByText(/Storm watch/)).not.toBeInTheDocument();
    expect(posts(calls, '/n-storm/read')).toHaveLength(1);
  });

  it('a card that is in view for less than 1.5 s is not seen', async () => {
    const calls = stubFeed([STORM]);
    mount();
    const text = await findCard(/Storm watch/);
    setView(text, 1);
    await advance(1000);
    setView(text, 0); // scrolled away
    await advance(10 * MIN);
    expect(screen.getByText(/Storm watch/)).toBeInTheDocument();
    expect(posts(calls, '/read')).toHaveLength(0);
  });

  it('a tall card needs half the SCREEN showing: 399 px of an 800 px screen is not enough, 400 px is', async () => {
    const calls = stubFeed([STORM]);
    mount();
    const text = await findCard(/Storm watch/);
    // 3000 px card whose top 399 px shows: under both half the card and half the screen.
    place(text, { top: VIEWPORT.h - 399, height: 3000 });
    await advance(10 * MIN);
    expect(screen.getByText(/Storm watch/)).toBeInTheDocument();
    expect(posts(calls, '/read')).toHaveLength(0);
    // Scrolled so 400 px (half the screen) of it shows: counts at the next check.
    place(text, { top: VIEWPORT.h - 400, height: 3000 });
    await advance(2000); // 1.5 s dwell, sampled every 250 ms
    await advance(5 * MIN + 1000);
    expect(screen.queryByText(/Storm watch/)).not.toBeInTheDocument();
    expect(posts(calls, '/read')).toHaveLength(1);
  });

  it('a short card with less than half showing is not seen; half showing is', async () => {
    const calls = stubFeed([STORM]);
    mount();
    const text = await findCard(/Storm watch/);
    place(text, { top: VIEWPORT.h - 49, height: 100 }); // 49% shows
    await advance(10 * MIN);
    expect(posts(calls, '/read')).toHaveLength(0);
    place(text, { top: VIEWPORT.h - 50, height: 100 }); // 50% shows
    await advance(2000); // 1.5 s dwell, sampled every 250 ms
    await advance(5 * MIN + 1000);
    expect(posts(calls, '/n-storm/read')).toHaveLength(1);
  });

  it('a card under a fixed modal is not seen, though the observer reports it intersecting; it counts once the modal closes', async () => {
    const calls = stubFeed([STORM]);
    mount();
    const text = await findCard(/Storm watch/);
    covered = true;
    place(text, { top: 100, height: 100 });
    await advance(10 * MIN);
    expect(screen.getByText(/Storm watch/)).toBeInTheDocument();
    expect(posts(calls, '/read')).toHaveLength(0);
    covered = false; // modal closed: no observer event, the recheck finds the card
    await advance(2000); // 1.5 s dwell, sampled every 250 ms
    await advance(5 * MIN + 1000);
    expect(screen.queryByText(/Storm watch/)).not.toBeInTheDocument();
    expect(posts(calls, '/n-storm/read')).toHaveLength(1);
  });

  it('a card that scrolled out before the dwell ended is not seen', async () => {
    stubFeed([STORM]);
    mount();
    const text = await findCard(/Storm watch/);
    place(text, { top: 100, height: 100 });
    await advance(1000);
    place(text, { top: -500, height: 100 });
    await advance(10 * MIN);
    expect(screen.getByText(/Storm watch/)).toBeInTheDocument();
  });

  it('a card in view while the page is hidden is not seen until the page is visible again', async () => {
    stubFeed([STORM]);
    mount();
    const text = await findCard(/Storm watch/);
    setDocumentVisibility('hidden');
    setView(text, 1);
    await advance(10 * MIN);
    expect(screen.getByText(/Storm watch/)).toBeInTheDocument();
    // Back on screen: the 1.5 s dwell starts now, then the 5-minute clock.
    setDocumentVisibility('visible');
    await advance(1500 + 4 * MIN);
    expect(screen.getByText(/Storm watch/)).toBeInTheDocument();
    await advance(MIN + 1000);
    expect(screen.queryByText(/Storm watch/)).not.toBeInTheDocument();
  });

  it('a tap on the card counts as seen', async () => {
    const calls = stubFeed([STORM]);
    mount();
    const text = await screen.findByText(/Storm watch/);
    await advance(MIN);
    fireEvent.click(text);
    await advance(5 * MIN + 1000);
    expect(screen.queryByText(/Storm watch/)).not.toBeInTheDocument();
    expect(posts(calls, '/n-storm/read')).toHaveLength(1);
  });

  it('the clock runs from first sight: a new card arriving later does not restart it', async () => {
    let feed = [STORM];
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET' });
      if (!init.method) return { ok: true, json: async () => ({ notifications: feed }) };
      return { ok: true, json: async () => ({}) };
    }));
    mount();
    const text = await findCard('Storm near Okafor');
    setView(text, 1);
    await advance(1500 + 4 * MIN);
    feed = [STORM, STORM_B]; // poll brings a second card; the first card's timers are rebuilt
    await advance(10_000);
    expect(screen.getByText('Storm near Ruiz')).toBeInTheDocument();
    await advance(MIN);
    expect(screen.queryByText('Storm near Okafor')).not.toBeInTheDocument();
    expect(posts(calls, '/n-storm/read')).toHaveLength(1);
    expect(screen.getByText('Storm near Ruiz')).toBeInTheDocument(); // unseen: still there
  });

  it('tapping Working through it still clears an unseen card at once', async () => {
    const calls = stubFeed([STORM]);
    mount();
    await screen.findByText(/Storm watch/);
    fireEvent.click(screen.getByRole('button', { name: 'Working through it' }));
    await advance(0);
    expect(screen.queryByText(/Storm watch/)).not.toBeInTheDocument();
    expect(posts(calls, '/n-storm/dismiss')).toHaveLength(1);
  });

  it('with no IntersectionObserver, a mounted card on a visible page counts as seen after the dwell', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const calls = stubFeed([STORM]);
    const spy = vi.spyOn(document, 'elementFromPoint');
    mount();
    const text = await screen.findByText(/Storm watch/);
    text.closest('[data-testid="notice-stack"] > div').getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 0, right: VIEWPORT.w, width: VIEWPORT.w, height: 100 });
    // The sampler starts in a passive effect too: wait until it has measured the card in view.
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await advance(2000); // 1.5 s dwell, sampled every 250 ms
    await advance(5 * MIN + 1000);
    expect(screen.queryByText(/Storm watch/)).not.toBeInTheDocument();
    expect(posts(calls, '/n-storm/read')).toHaveLength(1);
  });
  // The server's 6-hour storm cap stops listing the row; a mounted Today page
  // must drop the card, not keep it past the cap.
  it('a card the feed stops listing leaves the screen without a /read post (storm cap)', async () => {
    let feed = [STORM, STORM_B];
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET' });
      if (!init.method) return { ok: true, json: async () => ({ notifications: feed }) };
      return { ok: true, json: async () => ({}) };
    }));
    mount();
    await screen.findByText('Storm near Okafor');
    expect(screen.getByText('Storm near Ruiz')).toBeInTheDocument();
    feed = []; // the server's storm cap stops serving them
    await advance(10_000);
    expect(screen.queryByText('Storm near Okafor')).not.toBeInTheDocument();
    expect(screen.queryByText('Storm near Ruiz')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('the dwell is continuous: a card covered for most of 1.5 s and uncovered just before the end does not count', async () => {
    const calls = stubFeed([STORM]);
    mount();
    const text = await findCard(/Storm watch/);
    covered = true;
    place(text, { top: 100, height: 100 });
    await advance(1400);
    covered = false;
    // The old end-of-dwell check would count it at 1.5 s and clear it at 301.5 s.
    await advance(1400);
    await advance(5 * MIN - 500);
    expect(screen.getByText(/Storm watch/)).toBeInTheDocument();
    expect(posts(calls, '/read')).toHaveLength(0);
    // Uncovered for a full 1.5 s by now: seen, and its 5-minute clock runs out.
    await advance(2000);
    expect(screen.queryByText(/Storm watch/)).not.toBeInTheDocument();
    expect(posts(calls, '/n-storm/read')).toHaveLength(1);
  });

  it('a modal that flickers over the card keeps resetting the dwell', async () => {
    const calls = stubFeed([STORM]);
    mount();
    const text = await findCard(/Storm watch/);
    place(text, { top: 100, height: 100 });
    for (let i = 0; i < 8; i += 1) {
      await advance(1000);
      covered = true;
      await advance(300);
      covered = false;
    }
    // The modal then stays open. Had any gap counted as a sighting, its
    // 5-minute clock would clear the card within these 6 minutes.
    covered = true;
    await advance(6 * MIN);
    expect(screen.getByText(/Storm watch/)).toBeInTheDocument();
    expect(posts(calls, '/read')).toHaveLength(0);
  });

  it('sampling stops when the card is not near the viewport', async () => {
    stubFeed([STORM]);
    const spy = vi.spyOn(document, 'elementFromPoint');
    mount();
    const text = await findCard(/Storm watch/);
    place(text, { top: -500, height: 100 });
    spy.mockClear();
    await advance(10_000);
    expect(spy).not.toHaveBeenCalled();
  });

  // The legacy `new_appointment` row (admin-schedule "Notify technician") has no
  // card here: it must not wait to be seen, or it sits unread and eats the feed.
  it('a type with no card is not rendered and is marked read on the 5-minute clock; rendered cards still wait to be seen', async () => {
    const legacy = n('n-legacy', 'new_appointment', { customer_name: 'Okafor' }, 'New appointment');
    const calls = stubFeed([legacy, STORM]);
    mount();
    await screen.findByText(/Storm watch/);
    const stack = screen.getByTestId('notice-stack');
    expect(stack.children).toHaveLength(1); // the storm card only: no empty wrapper for the legacy row
    await advance(5 * MIN - 1000);
    expect(posts(calls, '/n-legacy/read')).toHaveLength(0);
    await advance(2000);
    expect(posts(calls, '/n-legacy/read')).toHaveLength(1);
    expect(screen.getByText(/Storm watch/)).toBeInTheDocument(); // unseen: kept
    expect(posts(calls, '/n-storm/read')).toHaveLength(0);
  });

  it('a feed with only a type that has no card renders no empty stack', async () => {
    const legacy = n('n-legacy', 'new_appointment', {}, 'New appointment');
    stubFeed([legacy]);
    mount();
    await advance(100);
    expect(screen.queryByTestId('notice-stack')).not.toBeInTheDocument();
  });
});
