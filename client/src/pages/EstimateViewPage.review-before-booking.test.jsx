// @vitest-environment jsdom
// Review-before-booking (priced termite trenching) regression: the /data
// contract sends cta.canAccept:false with terminalState:null and
// reviewBeforeBooking:true — the page must render the review/call card with
// the price still visible, NOT fall through to TerminalStateCard's null-state
// default ("This estimate has expired").
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'trench-review-token' }),
}));

vi.mock('../lib/stripeLoader', () => ({
  loadStripeSdk: vi.fn(async () => null),
}));

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function trenchingReviewPayload() {
  return {
    estimate: {
      customerFirstName: 'Terry',
      address: '321 Barrier Way',
      serviceCategory: 'termite_trenching',
      acceptance: { mode: 'standard_slot_pick' },
      membership: null,
      intelligence: null,
      askToken: 'ask-token',
      defaultServiceMode: 'one_time',
      isOneTimeOnly: true,
      showOneTimeOption: false,
      billByInvoice: false,
      licenseNumber: 'JB000000',
      acceptedServiceMode: null,
      acceptedFrequencyKey: null,
    },
    pricing: {
      services: [],
      askChips: ['How long does the barrier last?', 'Do you drill the concrete or driveway?'],
      anchorOneTimePrice: 2210,
      oneTimeBreakdown: {
        total: 2210,
        items: [{ service: 'trenching', label: 'Termite Trenching', amount: 2210, kind: 'charge' }],
      },
      defaultServiceMode: 'one_time',
      renderFlags: {},
    },
    cta: {
      canAccept: false,
      terminalState: null,
      quoteRequired: false,
      quoteRequiredReason: null,
      reviewBeforeBooking: true,
      reviewReason: 'termite_trenching_review',
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EstimateViewPage review-before-booking (termite trenching)', () => {
  it('renders the review/call card with the price visible instead of the expired terminal card', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(trenchingReviewPayload())));

    render(<EstimateViewPage />);

    await waitFor(() => {
      expect(screen.getByText('Waves will confirm & schedule your trenching')).toBeInTheDocument();
    });

    // Price stays visible — this is NOT a terminal or quote-required state.
    // (Appears in both the one-time price card and the breakdown row.)
    expect(screen.getAllByText('$2,210').length).toBeGreaterThan(0);
    // The null-terminal fallback must not fire.
    expect(screen.queryByText('This estimate has expired.')).not.toBeInTheDocument();
    // Self-booking is gated: the call CTA replaces slot pick / payment CTAs.
    expect(screen.getByRole('link', { name: /Call Waves to confirm/i })).toHaveAttribute('href', 'tel:+19412975749');
  });

  it('still renders the genuine terminal card when the estimate is expired', async () => {
    const payload = trenchingReviewPayload();
    // Server never advertises the review state on a terminal estimate, but the
    // client guards independently — terminal always wins.
    payload.cta = { ...payload.cta, terminalState: 'expired', reviewBeforeBooking: false, reviewReason: null };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));

    render(<EstimateViewPage />);

    await waitFor(() => {
      expect(screen.getByText('This estimate has expired.')).toBeInTheDocument();
    });
    expect(screen.queryByText('Waves will confirm & schedule your trenching')).not.toBeInTheDocument();
  });
});
