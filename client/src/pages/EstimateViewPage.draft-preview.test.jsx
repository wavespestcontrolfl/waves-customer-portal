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

function draftDocumentPayload() {
  const payload = draftPreviewPayload();
  return {
    ...payload,
    documentRender: true,
    publicOrigin: 'https://portal.wavespestcontrol.com',
    estimate: {
      ...payload.estimate,
      id: 'estimate-fixture',
      token: 'draft-preview-token',
      slug: 'EST-DRAFT-1',
      customerName: 'Dana Preview',
      customerPhone: '+19415550123',
      customerEmail: 'dana@example.test',
      createdAt: '2026-10-26T14:00:00.000Z',
      expiresAt: '2026-11-02T14:00:00.000Z',
      category: 'RESIDENTIAL',
      noGuaranteeClaims: true,
    },
    proposal: {
      enabled: false,
      synthesized: true,
      noGuaranteeClaims: true,
      pestRecurringOnly: false,
      title: 'Service Proposal',
      preparedFor: 'Dana Preview',
      propertyAddress: '77 Preview Lane',
      terms: null,
      buildings: [{
        name: '77 Preview Lane',
        note: null,
        lineItems: [{
          description: 'Termite Trenching', quantity: 1, unitPrice: 2210,
          amount: 2210, frequency: 'one_time', frequencyLabel: 'One-time',
          taxable: false, termsScope: 'none',
        }],
      }],
      totals: {
        annualRecurring: 0, monthlyEquivalent: 0, oneTime: 2210,
        totalTax: 0, firstYearTotal: 2210, hasTax: false, isMultiBuilding: false,
      },
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
  delete document.fonts;
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

  it('does not disable customer actions from an unverified copied preview marker', async () => {
    window.history.replaceState({}, '', '/estimate/draft-preview-token?adminPreview=1');
    stubLocalStorage({});
    const payload = draftPreviewPayload({ adminDraftPreview: false });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    render(<EstimateViewPage />);
    await screen.findByText('Waves will confirm & schedule your trenching');
    expect(screen.queryByText('Saved estimate preview')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Scheduling preview')).not.toBeInTheDocument();
  });

  it('exports the banner as a standalone component', () => {
    render(<DraftPreviewBanner />);
    expect(screen.getByText('Draft preview — not sent to the customer yet')).toBeInTheDocument();
  });

  it('keeps an immediately-returned print on the Field document until afterprint, then restores exactly once with GETs only', async () => {
    window.history.replaceState({}, '', '/estimate/draft-preview-token?adminPreview=1');
    stubLocalStorage({ waves_admin_token: 'staff-jwt' });
    let releaseFonts;
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: new Promise((resolve) => { releaseFonts = resolve; }) },
    });
    const fetchMock = vi.fn(async (url, opts = {}) => {
      if (String(url).includes('mode=pdf')) return jsonResponse(draftDocumentPayload());
      return jsonResponse(draftPreviewPayload());
    });
    const printMock = vi.fn(() => {
      expect(screen.getByTestId('estimate-document-draft-mark')).toHaveTextContent('DRAFT — INTERNAL PREVIEW · NOT SENT TO CUSTOMER');
      expect(document.querySelector('.waves-field-document.estimate-document-v1')).toBeTruthy();
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('print', printMock);

    render(<EstimateViewPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Print preview' }));

    await screen.findByTestId('estimate-document-draft-mark');
    expect(printMock).not.toHaveBeenCalled();
    const documentCall = fetchMock.mock.calls.find(([url]) => String(url).includes('mode=pdf'));
    expect(documentCall).toBeTruthy();
    expect(documentCall[0]).toContain('adminPreview=1');
    expect(documentCall[1]).toEqual(expect.objectContaining({
      headers: { Authorization: 'Bearer staff-jwt' },
    }));

    await act(async () => { releaseFonts(); await Promise.resolve(); });
    await waitFor(() => expect(printMock).toHaveBeenCalledTimes(1));
    // window.print() returned immediately, but that is not proof the browser
    // finished (Safari/resource-deferred print). Keep the canonical document
    // and make the neutral manual escape available until afterprint.
    expect(screen.getByTestId('estimate-document-draft-mark')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Return to preview' })).toBeInTheDocument();
    const dataCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/estimates/') && String(url).includes('/data'));
    expect(dataCalls()).toHaveLength(2);

    act(() => {
      window.dispatchEvent(new Event('afterprint'));
      // The ref guard protects against a browser or embed dispatching twice
      // before React has removed the one-shot listener.
      window.dispatchEvent(new Event('afterprint'));
    });
    await screen.findByText('Draft preview — not sent to the customer yet');
    expect(dataCalls()).toHaveLength(3);
    expect(fetchMock.mock.calls.every(([, opts = {}]) => !opts.method || opts.method === 'GET')).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => /available-slots|find-slots|reserve|accept/.test(String(url)))).toBe(false);
  });

  it('lets staff return from the retained document when a browser omits afterprint', async () => {
    window.history.replaceState({}, '', '/estimate/draft-preview-token?adminPreview=1');
    stubLocalStorage({ waves_admin_token: 'staff-jwt' });
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
    const fetchMock = vi.fn(async (url) => jsonResponse(
      String(url).includes('mode=pdf') ? draftDocumentPayload() : draftPreviewPayload(),
    ));
    const printMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('print', printMock);

    render(<EstimateViewPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Print preview' }));
    await waitFor(() => expect(printMock).toHaveBeenCalledTimes(1));
    const dataCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/estimates/') && String(url).includes('/data'));
    expect(dataCalls()).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Return to preview' }));
    await screen.findByText('Draft preview — not sent to the customer yet');
    expect(dataCalls()).toHaveLength(3);
    act(() => window.dispatchEvent(new Event('afterprint')));
    expect(dataCalls()).toHaveLength(3);
  });

  it('restores the staff preview when window.print throws', async () => {
    window.history.replaceState({}, '', '/estimate/draft-preview-token?adminPreview=1');
    stubLocalStorage({ waves_admin_token: 'staff-jwt' });
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
    const fetchMock = vi.fn(async (url) => jsonResponse(
      String(url).includes('mode=pdf') ? draftDocumentPayload() : draftPreviewPayload(),
    ));
    const printMock = vi.fn(() => { throw new Error('print unavailable'); });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('print', printMock);

    render(<EstimateViewPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Print preview' }));

    await waitFor(() => expect(printMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Your browser could not open the print dialog'));
    const dataCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/estimates/') && String(url).includes('/data'));
    expect(dataCalls()).toHaveLength(3);
    act(() => window.dispatchEvent(new Event('afterprint')));
    expect(dataCalls()).toHaveLength(3);
  });

  it('does not add staff return controls to an existing PDF document render', async () => {
    window.history.replaceState({}, '', '/estimate/draft-preview-token?mode=pdf');
    stubLocalStorage();
    const payload = draftDocumentPayload();
    delete payload.adminDraftPreview;
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));

    render(<EstimateViewPage />);

    await screen.findByRole('heading', { name: 'Service Estimate' });
    expect(document.querySelector('.waves-field-document.estimate-document-v1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Return to preview' })).not.toBeInTheDocument();
  });

  it('keeps a sent staff preview inert across booking, service details, Ask and schedule controls', async () => {
    window.history.replaceState({}, '', '/estimate/draft-preview-token?adminPreview=1');
    stubLocalStorage({ waves_admin_token: 'staff-jwt' });
    const payload = draftPreviewPayload({ adminDraftPreview: false });
    payload.verifiedStaffPreview = true;
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
