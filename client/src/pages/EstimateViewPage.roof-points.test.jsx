// @vitest-environment jsdom
// Roof points on the customer estimate page (owner ruling 2026-11-20, choice 4A): /data `roofPoints` (the points the Waves
// technician confirmed, frozen at send) take the satellite photo's place in the Waves AI card; a misting layout wins when
// both are present; a photo that fails to load puts the satellite photo back; and nothing changes without the key.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'roof-points-token' }) }));
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

// A canvas context and a frame loop that never runs by itself: the misting card on this page needs both to mount.
let ctx;
let frames;
let widthPx;
function stubCanvas() {
  ctx = {
    clearRect: vi.fn(), setTransform: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    save: vi.fn(), restore: vi.fn(), createRadialGradient: undefined, fillStyle: '',
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
  frames = new Map();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (cb) => { id += 1; frames.set(id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (n) => { frames.delete(n); });
  widthPx = 640;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return widthPx; } });
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

const ROOF_IMG = 'https://example.test/aerial.jpg';
const roofPoints = (over = {}) => ({
  imageUrl: ROOF_IMG,
  imageYear: 2025,
  pins: [
    { n: 1, x: 0.25, y: 0.4, type: 'roof_returns_and_valleys', label: 'Roof return, front left', action: 'seal' },
    { n: 2, x: 0.7, y: 0.55, type: 'trees_touching_roof', label: 'Branch touching the roof', action: 'trim back' },
  ],
  ...over,
});

describe('estimate page: roof points card', () => {
  it('shows the card in place of the satellite photo, with the lead, the numbered list and the photo credit', async () => {
    await renderPage(payload({ roofPoints: roofPoints() }));
    const card = await screen.findByTestId('roof-points-card');
    expect(card).toHaveTextContent('Your Waves technician found 2 places where rodents can get into your roof.');
    expect(card).toHaveTextContent('The numbers match the list below.');
    expect(card).toHaveTextContent('Photo: county aerial, 2025.');
    expect([...screen.getByTestId('roof-points-list').querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Roof return, front left: seal',
      'Branch touching the roof: trim back',
    ]);
    expect(screen.getAllByTestId('roof-point-pin').map((p) => p.textContent)).toEqual(['1', '2']);
    expect(screen.getByAltText(/^Aerial photo of the roof at 77 Preview Lane/)).toHaveAttribute('src', ROOF_IMG);
    expect(screen.queryByAltText(/Satellite view of/)).toBeNull();
  });

  it('shows one staff note at the end of the card when the block is a staff preview, and none for the customer block', async () => {
    await renderPage(payload({ roofPoints: roofPoints({ preview: true }) }));
    const card = await screen.findByTestId('roof-points-card');
    const note = screen.getByTestId('roof-points-preview-note');
    expect(note).toHaveTextContent('Staff preview: the customer sees these points after the next send.');
    expect(screen.getAllByTestId('roof-points-preview-note')).toHaveLength(1);
    expect(card.lastElementChild).toBe(note);
    cleanup();
    await renderPage(payload({ roofPoints: roofPoints() }));
    expect(await screen.findByTestId('roof-points-card')).toBeInTheDocument();
    expect(screen.queryByTestId('roof-points-preview-note')).toBeNull();
    expect(document.body.textContent).not.toContain('Staff preview');
  });

  it('keeps the satellite photo and shows no card without roofPoints', async () => {
    await renderPage(payload());
    expect(await screen.findByAltText('Satellite view of 77 Preview Lane')).toHaveAttribute('src', SAT);
    expect(screen.queryByTestId('roof-points-card')).toBeNull();
    expect(document.body.textContent).not.toContain('rodents can get into your roof');
  });

  it('keeps the satellite photo when roofPoints has no points', async () => {
    await renderPage(payload({ roofPoints: roofPoints({ pins: [] }) }));
    expect(await screen.findByAltText('Satellite view of 77 Preview Lane')).toBeInTheDocument();
    expect(screen.queryByTestId('roof-points-card')).toBeNull();
  });

  it('puts the satellite photo back when the roof photo fails to load', async () => {
    await renderPage(payload({ roofPoints: roofPoints() }));
    const img = await screen.findByAltText(/^Aerial photo of the roof at/);
    act(() => { fireEvent.error(img); });
    expect(screen.queryByTestId('roof-points-card')).toBeNull();
    expect(screen.getByAltText('Satellite view of 77 Preview Lane')).toHaveAttribute('src', SAT);
  });

  it('shows the misting layout, not the roof points, when both are present (misting wins)', async () => {
    await renderPage(payload({ mistingLayout: layout(), roofPoints: roofPoints() }));
    expect(await screen.findByTestId('misting-layout-card')).toBeInTheDocument();
    expect(screen.queryByTestId('roof-points-card')).toBeNull();
    expect(document.body.textContent).not.toContain('rodents can get into your roof');
  });

  it('shows the roof points again when the misting picture fails to load', async () => {
    await renderPage(payload({ mistingLayout: layout(), roofPoints: roofPoints() }));
    const img = await screen.findByAltText(/Proposed misting layout for/);
    act(() => { fireEvent.error(img); });
    expect(await screen.findByTestId('roof-points-card')).toBeInTheDocument();
    expect(screen.queryByTestId('misting-layout-card')).toBeNull();
  });
});
