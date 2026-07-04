// @vitest-environment jsdom
// Staff draft preview (?adminPreview=1): the /data payload's JWT-verified
// adminDraftPreview flag must render the "not sent" banner while the page
// still shows the real customer pricing, and the fetch must carry the param
// + the staff session's Bearer token so the server can serve the draft.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage, { DraftPreviewBanner } from './EstimateViewPage';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'draft-preview-token' }),
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

// One-time trenching shape (proven render path in the review-before-booking
// test) with the review gate active — a draft can be in any CTA state, and
// the review branch keeps the price visible, which is exactly what the
// preview must demonstrate.
function draftPreviewPayload({ adminDraftPreview = true } = {}) {
  return {
    ...(adminDraftPreview ? { adminDraftPreview: true } : {}),
    estimate: {
      customerFirstName: 'Dana',
      address: '77 Preview Lane',
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
      status: 'draft',
    },
    pricing: {
      services: [],
      askChips: [],
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

// jsdom in this runner ships without a usable localStorage (same workaround
// as ReportViewPage.render.test.jsx) — stub a functional one per test.
function stubLocalStorage(store = {}) {
  vi.stubGlobal('localStorage', {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/estimate/draft-preview-token');
  vi.unstubAllGlobals();
});

describe('EstimateViewPage staff draft preview', () => {
  it('renders the draft banner with the price still visible when the payload is flagged', async () => {
    stubLocalStorage();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(draftPreviewPayload())));

    render(<EstimateViewPage />);

    await waitFor(() => {
      expect(screen.getByText('Draft preview — not sent to the customer yet')).toBeInTheDocument();
    });
    // Fidelity: the preview is the real customer page, price included.
    expect(screen.getAllByText('$2,210').length).toBeGreaterThan(0);
    // Universal hero headline — service specifics live in the eyebrow line.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hello Dana, your estimate is ready!');
  });

  it('sends the adminPreview param + staff Bearer token when opened with ?adminPreview=1', async () => {
    window.history.replaceState({}, '', '/estimate/draft-preview-token?adminPreview=1');
    stubLocalStorage({ waves_admin_token: 'staff-jwt' });
    const fetchMock = vi.fn(async () => jsonResponse(draftPreviewPayload()));
    vi.stubGlobal('fetch', fetchMock);

    render(<EstimateViewPage />);

    await waitFor(() => {
      expect(screen.getByText('Draft preview — not sent to the customer yet')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('adminPreview=1'),
      expect.objectContaining({ headers: { Authorization: 'Bearer staff-jwt' } }),
    );
  });

  it('keeps the customer fetch untouched (no param, no auth header, no banner) without the preview flag', async () => {
    stubLocalStorage({ waves_admin_token: 'staff-jwt' });
    const fetchMock = vi.fn(async () => jsonResponse(draftPreviewPayload({ adminDraftPreview: false })));
    vi.stubGlobal('fetch', fetchMock);

    render(<EstimateViewPage />);

    await waitFor(() => {
      expect(screen.getByText('Waves will confirm & schedule your trenching')).toBeInTheDocument();
    });
    expect(screen.queryByText('Draft preview — not sent to the customer yet')).not.toBeInTheDocument();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).not.toContain('adminPreview');
    expect(opts).toBeUndefined();
  });

  it('exports the banner as a standalone component', () => {
    render(<DraftPreviewBanner />);
    expect(screen.getByText('Draft preview — not sent to the customer yet')).toBeInTheDocument();
  });
});
