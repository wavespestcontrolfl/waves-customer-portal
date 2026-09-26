// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'closedtoken' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function acceptedPayload(extraEstimate = {}) {
  return {
    estimate: {
      customerFirstName: 'Sam', address: '1 Termite Way', serviceCategory: 'termite',
      acceptance: { mode: 'standard_slot_pick' }, defaultServiceMode: 'recurring',
      isOneTimeOnly: false, showOneTimeOption: false, billByInvoice: false,
      membership: null, intelligence: null, acceptedServiceMode: null, acceptedFrequencyKey: null,
      ...extraEstimate,
    },
    pricing: { services: [], askChips: [], renderFlags: {} },
    cta: { canAccept: false, terminalState: 'accepted', quoteRequired: false, reviewBeforeBooking: false },
  };
}

describe('termite annual offer closed unsigned (slice 3b)', () => {
  it('a normal reload renders the closed state, never the booked page (Codex #4922 r3 P1)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => acceptedPayload({ annualPlanOfferClosed: true }) })));
    render(<EstimateViewPage />);
    expect(await screen.findByText(/Nothing was charged or booked/)).toBeInTheDocument();
    expect(screen.getAllByText('This plan offer has closed.').length).toBeGreaterThan(0);
  });
});
