// @vitest-environment jsdom
// Staff draft preview (?adminPreview=1): the /data payload's JWT-verified
// adminDraftPreview flag must render the "not sent" banner while the page
// still shows the real customer pricing, and the fetch must carry the param
// + the staff session's Bearer token so the server can serve the draft.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getAllByText('$2,210.00').length).toBeGreaterThan(0);
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
    // The mount abort signal always rides along; "untouched" means no auth
    // header and no preview param — assert those specifically.
    expect(opts?.headers).toBeUndefined();
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it('exports the banner as a standalone component', () => {
    render(<DraftPreviewBanner />);
    expect(screen.getByText('Draft preview — not sent to the customer yet')).toBeInTheDocument();
  });
  it('keeps a sent staff preview inert across booking, service details, Ask and schedule controls', async () => {
    window.history.replaceState({}, '', '/estimate/draft-preview-token?adminPreview=1');
    stubLocalStorage({ waves_admin_token: 'staff-jwt' });
    const payload = draftPreviewPayload({ adminDraftPreview: false });
    Object.assign(payload.estimate, { id: 'estimate-fixture', status: 'sent', serviceCategory: 'pest', softExit: { enabled: true } });
    payload.pricing.askChips = ['What happens during service?'];
    payload.cta = { canAccept: true, terminalState: null, quoteRequired: false, reviewBeforeBooking: false };
    const fetchMock = vi.fn(async (url, opts = {}) => {
      if (opts.method && opts.method !== 'GET') throw new Error('Preview must never write');
      return jsonResponse(payload);
    });
    vi.stubGlobal('fetch', fetchMock);
    Element.prototype.scrollIntoView = vi.fn();
    render(<EstimateViewPage />);
    await screen.findByText('Saved estimate preview');
    expect(screen.getByLabelText('Scheduling preview')).toHaveTextContent('Scheduling and date searches are disabled');
    expect(screen.getByRole('link', { name: 'Edit services' })).toHaveAttribute('href', '/admin/pipeline?tab=new&editEstimateId=estimate-fixture#estimate-services');
    // Exercise all rendered non-navigation buttons, including disabled
    // controls (fireEvent cannot bypass the preview guards in their handlers).
    for (const button of screen.queryAllByRole('button')) {
      if (/print/i.test(button.textContent || '')) continue;
      fireEvent.click(button);
    }
    for (const input of screen.queryAllByRole('textbox')) {
      fireEvent.change(input, { target: { value: 'Tomorrow morning' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    }
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock.mock.calls.every(([, opts]) => !opts?.method || opts.method === 'GET')).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => /available-slots|find-slots/.test(String(url)))).toBe(false);
    expect(screen.queryByRole('button', { name: /extend/i })).not.toBeInTheDocument();
  });

  it('never requests an extension from an expired staff preview', async () => {
    window.history.replaceState({}, '', '/estimate/draft-preview-token?adminPreview=1');
    stubLocalStorage({ waves_admin_token: 'staff-jwt' });
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ extensionEligible: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    await waitFor(() => expect(screen.queryByRole('heading', { level: 1 })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /extend|request.*link/i })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([, opts]) => !opts?.method || opts.method === 'GET')).toBe(true);
  });

});
