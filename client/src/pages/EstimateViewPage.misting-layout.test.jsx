// @vitest-environment jsdom
// "Proposed misting layout" on the customer estimate page (GATE_MISTING_LAYOUT_DESIGNER): /data `mistingLayout`
// takes the satellite photo's place in the Waves AI card, mist animates over the picture from the geometry, and
// nothing changes without the key.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'misting-layout-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

const SAT = 'https://example.test/satellite.png';
const LAYOUT_IMG = 'https://example.test/layout.png';

const GEOMETRY = {
  center: { lat: 27.5, lng: -82.5 },
  zoom: 20,
  mapWidth: 1280,
  mapHeight: 960,
  lines: [{ kind: 'eave', points: [{ x: 400, y: 400 }, { x: 800, y: 400 }, { x: 800, y: 600 }, { x: 400, y: 600 }, { x: 400, y: 400 }] }],
  nozzles: [{ x: 500, y: 400, kind: 'eave', lineIndex: 0 }, { x: 700, y: 400, kind: 'eave', lineIndex: 0, aim: 90 }],
  risers: [{ x: 450, y: 700, source: 'manual' }],
  pump: { x: 300, y: 300 },
  zones: [],
};
const layout = (over = {}) => ({
  imageUrl: LAYOUT_IMG,
  revision: 'aaaaaaaaaaaaaaaa',
  address: '77 Preview Lane',
  counts: { nozzles: 14, eave: 10, fence: 4, risers: 2, linearFt: 131.5, zones: 1, pump: true },
  geometry: GEOMETRY,
  ...over,
});

const payload = (extra = {}) => ({
  estimate: {
    customerFirstName: 'Dana', address: '77 Preview Lane', serviceCategory: 'mosquito',
    acceptance: { mode: 'standard_slot_pick' }, membership: null, askToken: 'ask-token',
    intelligence: { title: 'Waves AI reviewed your property', body: 'We reviewed your property.', metrics: [], satelliteUrl: SAT },
    defaultServiceMode: 'recurring', isOneTimeOnly: false, showOneTimeOption: false, billByInvoice: false,
    licenseNumber: 'JB000000', acceptedServiceMode: null, acceptedFrequencyKey: null, status: 'sent',
  },
  pricing: { services: [], askChips: [], renderFlags: {}, defaultServiceMode: 'recurring' },
  cta: { canAccept: false, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: true, reviewReason: 'termite_trenching_review' },
  ...extra,
});

const stubStorage = () => {
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
};
const stubFetch = (data) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => data })));

// A canvas context that records what is drawn, and a frame loop the test steps by hand.
let ctx;
let frames;
let rafCalls;
let widthPx;
function stubCanvas() {
  ctx = {
    clearRect: vi.fn(), setTransform: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    save: vi.fn(), restore: vi.fn(), createRadialGradient: undefined, fillStyle: '',
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
  frames = new Map();
  rafCalls = 0;
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (cb) => { rafCalls += 1; id += 1; frames.set(id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (n) => { frames.delete(n); });
  widthPx = 640;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return widthPx; } });
}
// Run the queued frames at a fake clock, `count` times.
function stepFrames(count, startAt = 1000) {
  for (let i = 0; i < count; i += 1) {
    const queued = [...frames.entries()];
    frames.clear();
    queued.forEach(([, cb]) => cb(startAt + i * 50));
  }
}
const stubMotion = (reduce) => vi.stubGlobal('matchMedia', (q) => ({
  matches: reduce && q.includes('prefers-reduced-motion'),
  addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
}));

async function renderPage(data) {
  stubStorage();
  stubFetch(data);
  render(<EstimateViewPage />);
  await screen.findByRole('heading', { level: 1 });
}
const loadPicture = () => act(() => { fireEvent.load(screen.getByAltText(/Proposed misting layout for/)); });

// The default observer reports the card on screen as soon as it is watched.
class VisibleObserver {
  constructor(cb) { this.cb = cb; }
  observe(el) { this.cb([{ target: el, isIntersecting: true }]); }
  disconnect() {}
}
beforeEach(() => { stubCanvas(); stubMotion(false); vi.stubGlobal('IntersectionObserver', VisibleObserver); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete HTMLElement.prototype.clientWidth;
});

describe('estimate page: Proposed misting layout card', () => {
  it('shows the card in place of the satellite photo, with counts, legend and the concept note', async () => {
    await renderPage(payload({ mistingLayout: layout() }));
    const card = await screen.findByTestId('misting-layout-card');
    expect(card).toHaveTextContent('Proposed misting layout');
    expect(screen.getByAltText('Proposed misting layout for 77 Preview Lane')).toHaveAttribute('src', LAYOUT_IMG);
    expect(screen.queryByAltText(/Satellite view of/)).toBeNull();
    expect(card).toHaveTextContent('Nozzles: 14 (eave 10, fence 4)');
    expect(screen.getByTestId('misting-legend').querySelectorAll('li').length).toBeGreaterThanOrEqual(6);
    expect(card).toHaveTextContent('Concept layout — final placement at the design visit and install.');
    // 14 nozzles plus 2 risers is 16 of 60: no pump notice.
    expect(screen.queryByTestId('misting-pump-notice')).toBeNull();
  });

  it('prints the pump notice when nozzles plus risers pass 60', async () => {
    await renderPage(payload({ mistingLayout: layout({ counts: { nozzles: 58, eave: 50, fence: 8, risers: 5, linearFt: 300, zones: 0, pump: true } }) }));
    expect(await screen.findByTestId('misting-pump-notice')).toHaveTextContent('Over 60 nozzles: needs a Pynamite Zone Kit (up to 120)');
  });

  it('keeps the satellite photo and shows no card without mistingLayout', async () => {
    await renderPage(payload());
    expect(await screen.findByAltText('Satellite view of 77 Preview Lane')).toHaveAttribute('src', SAT);
    expect(screen.queryByTestId('misting-layout-card')).toBeNull();
    expect(screen.queryByTestId('misting-spray')).toBeNull();
    expect(document.body.textContent).not.toContain('Proposed misting layout');
  });

  it('puts the satellite photo back when the layout picture fails to load', async () => {
    await renderPage(payload({ mistingLayout: layout() }));
    const img = await screen.findByAltText(/Proposed misting layout for/);
    act(() => { fireEvent.error(img); });
    expect(screen.queryByTestId('misting-layout-card')).toBeNull();
    expect(screen.getByAltText('Satellite view of 77 Preview Lane')).toHaveAttribute('src', SAT);
  });

  it('shows the still picture only when the payload has no geometry', async () => {
    await renderPage(payload({ mistingLayout: layout({ geometry: undefined }) }));
    await screen.findByTestId('misting-layout-card');
    expect(screen.queryByTestId('misting-spray')).toBeNull();
  });
});

describe('estimate page: spray overlay', () => {
  it('animates mist once the picture has loaded, and scales map pixels to the rendered width', async () => {
    await renderPage(payload({ mistingLayout: layout() }));
    await screen.findByTestId('misting-layout-card');
    // Nothing sprays over a picture that has not loaded.
    expect(screen.getByTestId('misting-spray')).toHaveAttribute('data-mode', 'still');
    expect(rafCalls).toBe(0);
    loadPicture();
    expect(screen.getByTestId('misting-spray')).toHaveAttribute('data-mode', 'animated');
    // 640 px wide at a pixel ratio of 1 is half of the 1280 px map.
    expect(ctx.setTransform).toHaveBeenCalledWith(0.5, 0, 0, 0.5, 0, 0);
    expect(screen.getByTestId('misting-spray')).toHaveAttribute('width', '640');
    expect(screen.getByTestId('misting-spray')).toHaveAttribute('height', '480');
    stepFrames(8);
    // Puffs are drawn: the first spawn lands on a nozzle or riser in map pixels, inside the 1280 by 960 map.
    expect(ctx.arc).toHaveBeenCalled();
    const [x, y] = ctx.arc.mock.calls[0];
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(1280);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(960);
  });

  it('does not animate with prefers-reduced-motion', async () => {
    stubMotion(true);
    await renderPage(payload({ mistingLayout: layout() }));
    await screen.findByTestId('misting-layout-card');
    loadPicture();
    expect(screen.getByTestId('misting-spray')).toHaveAttribute('data-mode', 'still');
    expect(rafCalls).toBe(0);
    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it('pauses while the card is offscreen and resumes when it scrolls back', async () => {
    let notify;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb) { notify = cb; }
      observe() {}
      disconnect() {}
    });
    await renderPage(payload({ mistingLayout: layout() }));
    await screen.findByTestId('misting-layout-card');
    loadPicture();
    // Not yet reported on screen: no frames.
    expect(rafCalls).toBe(0);
    act(() => notify([{ isIntersecting: true }]));
    expect(rafCalls).toBeGreaterThan(0);
    stepFrames(2);
    const before = rafCalls;
    act(() => notify([{ isIntersecting: false }]));
    expect(frames.size).toBe(0);
    stepFrames(3);
    expect(rafCalls).toBe(before);
    expect(screen.getByTestId('misting-spray')).toHaveAttribute('data-mode', 'still');
  });

  it('pauses while the tab is hidden', async () => {
    await renderPage(payload({ mistingLayout: layout() }));
    await screen.findByTestId('misting-layout-card');
    loadPicture();
    expect(frames.size).toBe(1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(frames.size).toBe(0);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(frames.size).toBe(1);
  });

  it('stops the frame loop when the card goes away', async () => {
    await renderPage(payload({ mistingLayout: layout() }));
    await screen.findByTestId('misting-layout-card');
    loadPicture();
    expect(frames.size).toBe(1);
    cleanup();
    expect(frames.size).toBe(0);
  });
});
