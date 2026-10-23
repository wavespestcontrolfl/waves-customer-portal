// @vitest-environment jsdom
// "What we can and can't fix" (GATE_ESTIMATE_LAWN_LIMITS): the page and the PDF document print
// the server's `lawnLimits` block exactly as given, and nothing when it is absent (gate off or
// no recurring lawn on the estimate). The copy itself lives on the server.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage, { LawnLimitsCard } from './EstimateViewPage';
import EstimateProposalDocument from './EstimateProposalDocument';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'lawn-limits-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const BLOCK = {
  heading: "What we can and can't fix",
  paragraphs: [
    { key: 'always', text: 'Fixed paragraph from the server.' },
    { key: 'carpetgrass', text: 'Carpetgrass line from the server.' },
    { key: 'virus_streaks', text: 'Virus line from the server.' },
  ],
};

describe('LawnLimitsCard (estimate page)', () => {
  it('prints the heading and every paragraph in order, as given', () => {
    render(<LawnLimitsCard lawnLimits={BLOCK} />);
    expect(screen.getByRole('heading', { name: "What we can and can't fix" })).toBeInTheDocument();
    const lines = [...document.querySelectorAll('[data-lawn-limit]')];
    expect(lines.map((el) => el.getAttribute('data-lawn-limit'))).toEqual(['always', 'carpetgrass', 'virus_streaks']);
    expect(lines.map((el) => el.textContent)).toEqual(BLOCK.paragraphs.map((p) => p.text));
  });

  it('renders nothing without a block, a heading or any paragraph', () => {
    expect(render(<LawnLimitsCard lawnLimits={null} />).container).toBeEmptyDOMElement();
    cleanup();
    expect(render(<LawnLimitsCard lawnLimits={{ heading: 'x', paragraphs: [] }} />).container).toBeEmptyDOMElement();
    cleanup();
    expect(render(<LawnLimitsCard lawnLimits={{ paragraphs: BLOCK.paragraphs }} />).container).toBeEmptyDOMElement();
  });
});

const DOC_DATA = (extra = {}) => ({
  publicOrigin: 'https://portal.wavespestcontrol.com',
  estimate: { token: 'tok-1', slug: 'EST-2099-0002', customerName: 'Pat Example', address: '1 Example Way, Sarasota, FL 34200', createdAt: '2026-10-22T14:00:00.000Z', category: 'RESIDENTIAL', isOneTimeOnly: false },
  proposal: { enabled: false, synthesized: true, title: 'Service Proposal', buildings: [{ name: 'Lawn', lineItems: [{ description: 'Lawn care', quantity: 1, unitPrice: 50, amount: 50, frequency: 'monthly' }] }], totals: {} },
  cta: {},
  ...extra,
});

describe('EstimateProposalDocument (estimate PDF)', () => {
  it('prints the block before the terms when the payload carries it', () => {
    render(<EstimateProposalDocument data={DOC_DATA({ lawnLimits: BLOCK })} token="tok-1" />);
    const section = screen.getByTestId('doc-lawn-limits');
    expect(section).toHaveTextContent("What we can and can't fix");
    expect(section).toHaveTextContent('Fixed paragraph from the server.');
    expect(section).toHaveTextContent('Carpetgrass line from the server.');
    expect(section).toHaveTextContent('Virus line from the server.');
    const terms = screen.getByText(/^(Terms|Service terms)$/);
    expect(section.compareDocumentPosition(terms) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('prints nothing without the block', () => {
    render(<EstimateProposalDocument data={DOC_DATA()} token="tok-1" />);
    expect(screen.queryByTestId('doc-lawn-limits')).toBeNull();
    expect(document.body.textContent).not.toContain("What we can and can't fix");
  });
});

// The real page: the card is wired to the /data payload's `lawnLimits` key and nothing else.
const pagePayload = (extra = {}) => ({
  estimate: {
    customerFirstName: 'Dana', address: '77 Preview Lane', serviceCategory: 'lawn_care',
    acceptance: { mode: 'standard_slot_pick' }, membership: null, intelligence: null, askToken: 'ask-token',
    defaultServiceMode: 'recurring', isOneTimeOnly: false, showOneTimeOption: false, billByInvoice: false,
    licenseNumber: 'JB000000', acceptedServiceMode: null, acceptedFrequencyKey: null, status: 'sent',
  },
  pricing: {
    services: [], askChips: [], renderFlags: {}, defaultServiceMode: 'recurring',
  },
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

describe('EstimateViewPage wiring', () => {
  it('prints the card when /data carries lawnLimits', async () => {
    stubStorage();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => pagePayload({ lawnLimits: BLOCK }) })));
    render(<EstimateViewPage />);
    expect(await screen.findByTestId('lawn-limits')).toHaveTextContent('Fixed paragraph from the server.');
  });

  it('prints nothing when /data has no lawnLimits key', async () => {
    stubStorage();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => pagePayload() })));
    render(<EstimateViewPage />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('lawn-limits')).toBeNull();
  });
});
