// @vitest-environment jsdom
// The "no visit needed" sentence on the customer estimate page (owner 2026-11-22, option B: under the satellite photo in
// the Waves AI card). The server decides who gets it and sends the words (GET /api/estimates/:token/data `noVisitLine`).
// The card prints them only while the satellite photo itself is the picture on the card: a card with no photo, and a card
// whose photo a staff-made picture replaced (roof points), never show them.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'no-visit-line-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

const SAT = 'https://example.test/satellite.png';
const LEAD = 'We reviewed your home, lot, and pest-risk factors before pricing this plan.';
const LINE = 'We measure your home and yard from county records and satellite images, so most quotes need no visit.';

// `line` is what the server sends as `noVisitLine`; `omitLine` leaves the key out, as the server does for most estimates.
const payload = ({ satelliteUrl = SAT, line = LINE, omitLine = false, extra = {} } = {}) => ({
  estimate: {
    customerFirstName: 'Dana', address: '77 Preview Lane', serviceCategory: 'pest_control',
    acceptance: { mode: 'standard_slot_pick' }, membership: null, askToken: 'ask-token',
    intelligence: { title: 'Waves AI reviewed your property before pricing this estimate', body: LEAD, metrics: [], satelliteUrl },
    defaultServiceMode: 'recurring', isOneTimeOnly: false, showOneTimeOption: false, billByInvoice: false,
    licenseNumber: 'JB000000', acceptedServiceMode: null, acceptedFrequencyKey: null, status: 'sent',
  },
  pricing: { services: [], askChips: [], renderFlags: {}, defaultServiceMode: 'recurring' },
  cta: { canAccept: false, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: true, reviewReason: 'contact_review' },
  ...(omitLine ? {} : { noVisitLine: line }),
  ...extra,
});

async function renderPage(data) {
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => data })));
  render(<EstimateViewPage />);
  await screen.findByRole('heading', { level: 1 });
}

class VisibleObserver {
  constructor(cb) { this.cb = cb; }
  observe(el) { this.cb([{ target: el, isIntersecting: true }]); }
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', VisibleObserver);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const roofPoints = {
  imageUrl: 'https://example.test/aerial.jpg',
  imageYear: 2025,
  pins: [{ n: 1, x: 0.25, y: 0.4, type: 'roof_returns_and_valleys', label: 'Roof return, front left', action: 'seal' }],
};
// True when `later` comes after `earlier` in the document.
const follows = (later, earlier) => Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('estimate page: the "no visit needed" sentence on the Waves AI card', () => {
  it('prints the words the server sent, once, under the satellite photo; the lead stays as it is', async () => {
    await renderPage(payload());
    const photo = await screen.findByAltText('Satellite view of 77 Preview Lane');
    const line = screen.getByTestId('no-visit-line');
    expect(line).toHaveTextContent(LINE);
    expect(line.textContent).toBe(LINE);
    expect(follows(line, photo)).toBe(true);
    expect(screen.getByText(LEAD)).toBeInTheDocument();
    expect(document.body.textContent.split(LINE)).toHaveLength(2);
  });

  it('sits above the "Red outline" caption of a photo with the property outline', async () => {
    await renderPage(payload({ extra: { showYourWork: { overlaySatelliteUrl: 'https://example.test/outline.png', facts: [] } } }));
    const line = await screen.findByTestId('no-visit-line');
    const caption = screen.getByText('Red outline: your property boundary from county records.');
    expect(follows(caption, line)).toBe(true);
  });

  it('prints nothing when the server sends no line', async () => {
    const noLine = [{ omitLine: true }, { line: null }, { line: '' }, { line: '   ' }, { line: true }, { line: 42 }];
    for (const sent of noLine) {
      await renderPage(payload(sent));
      expect(await screen.findByAltText('Satellite view of 77 Preview Lane')).toBeInTheDocument();
      expect(screen.queryByTestId('no-visit-line')).toBeNull();
      cleanup();
    }
  });

  it('prints nothing when the card has no satellite photo', async () => {
    await renderPage(payload({ satelliteUrl: null }));
    expect(screen.getByText(LEAD)).toBeInTheDocument();
    expect(screen.queryByTestId('no-visit-line')).toBeNull();
    expect(document.body.textContent).not.toContain(LINE);
  });

  it('prints nothing when roof points from a technician take the photo\'s place', async () => {
    await renderPage(payload({ extra: { roofPoints } }));
    expect(await screen.findByTestId('roof-points-card')).toBeInTheDocument();
    expect(screen.queryByTestId('no-visit-line')).toBeNull();
    expect(document.body.textContent).not.toContain(LINE);
  });
});
