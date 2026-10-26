// @vitest-environment jsdom
// Authored commercial proposal on the public estimate page: web and PDF carry the same next-step wording,
// the residential sections (Waves AI property card, app pitch, reviews) are hidden, and every remaining
// section rides the glass card treatment. A residential estimate keeps all of those sections.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'commercial-glass-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

const intelligence = {
  title: 'Sample property review title',
  body: 'Sample property review body.',
  metrics: [{ label: 'Home', value: '2,500 sq ft' }, { label: 'Pool/Lanai', value: 'No' }],
  signals: [],
};

function basePayload() {
  return {
    estimate: {
      customerFirstName: 'Pat', address: '100 Sample Way', serviceCategory: 'pest_control',
      acceptance: { mode: 'quote_required' }, membership: null, intelligence, askToken: 'ask-token',
      defaultServiceMode: 'recurring', isOneTimeOnly: false, showOneTimeOption: false, billByInvoice: false,
      licenseNumber: 'JB000000', acceptedServiceMode: null, acceptedFrequencyKey: null, noGuaranteeClaims: true,
    },
    pricing: { services: [], askChips: [], defaultServiceMode: 'recurring', renderFlags: {} },
  };
}

function proposalPayload(commercialAgreement) {
  const base = basePayload();
  return {
    ...base,
    proposal: {
      enabled: true, title: 'Commercial Service Proposal', taxLabel: 'Sales tax', taxRate: 0.07,
      terms: 'Net 30 terms apply.',
      commercialTerms: { initialTermMonths: 12, renewal: 'Renews yearly' },
      buildings: [{ name: 'Main', lineItems: [{ description: 'Quarterly pest service', quantity: 1, unitPrice: 300, amount: 300, frequency: 'quarterly', frequencyLabel: 'Quarterly', taxable: true }] }],
      totals: { annualRecurring: 1200, monthlyEquivalent: 100, oneTime: 0, totalTax: 84, firstYearTotal: 1284, hasTax: true, isMultiBuilding: false },
    },
    cta: {
      canAccept: false, terminalState: 'quote_required', quoteRequired: true, quoteRequiredReason: 'commercial_proposal',
      reviewBeforeBooking: false, reviewReason: null, commercialProposal: true,
      ...(commercialAgreement ? { commercialAgreement } : {}),
    },
  };
}

function residentialQuotePayload() {
  return {
    ...basePayload(),
    cta: {
      canAccept: false, terminalState: 'quote_required', quoteRequired: true, quoteRequiredReason: 'severe_infestation',
      reviewBeforeBooking: false, reviewReason: null,
    },
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function renderProposal(commercialAgreement) {
  vi.stubGlobal('fetch', vi.fn(async () => json(proposalPayload(commercialAgreement))));
  render(<EstimateViewPage />);
  await screen.findByText('Commercial Service Proposal');
}

describe('authored commercial proposal page', () => {
  it('What happens next uses the PDF wording with online signing offered', async () => {
    await renderProposal({ canSign: true, state: 'none' });
    const card = screen.getByTestId('proposal-next-steps');
    expect(within(card).getByText('What happens next')).toBeInTheDocument();
    expect(card).toHaveTextContent(/To go ahead, tap Accept & sign agreement below to review and sign your service agreement online, or call \(941\) 297-5749\./);
    expect(card).toHaveTextContent(/Signing does not start service or bill you; Adam, your Waves account manager, follows up to schedule\./);
    expect(card).not.toHaveTextContent(/no online checkout/i);
    expect(card).not.toHaveTextContent(/will share the PDF/i);
    // The sign card stays as built.
    expect(screen.getByRole('button', { name: 'Accept & sign agreement' })).toBeInTheDocument();
  });

  it('What happens next uses the follow-up wording when signing is not offered', async () => {
    await renderProposal(null);
    const card = screen.getByTestId('proposal-next-steps');
    expect(card).toHaveTextContent(/Adam, your Waves account manager, will follow up to answer questions and finalize this proposal — or call \(941\) 297-5749 any time\./);
    expect(card).not.toHaveTextContent(/Accept & sign/);
    expect(card).not.toHaveTextContent(/no online checkout/i);
  });

  it('hides the residential Waves AI property card, app pitch and reviews, and keeps Ask Waves', async () => {
    await renderProposal({ canSign: true, state: 'none' });
    expect(screen.queryByText('Sample property review title')).not.toBeInTheDocument();
    expect(screen.queryByText(/2,500 sq ft/)).not.toBeInTheDocument();
    expect(screen.queryByText('The Waves app')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Download on the App Store')).not.toBeInTheDocument();
    expect(screen.queryByText('Reviews')).not.toBeInTheDocument();
    expect(screen.queryByText(/neighbors switched/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Ask Waves about this estimate')).toBeInTheDocument();
  });

  it('every remaining section carries the glass card treatment', async () => {
    await renderProposal({ canSign: true, state: 'none' });
    const glassCard = (el) => el.closest('[data-glass="card"]');
    expect(screen.getByTestId('proposal-next-steps')).toHaveAttribute('data-glass', 'card');
    expect(screen.getByTestId('proposal-detail-card')).toHaveAttribute('data-glass', 'card');
    expect(screen.getByTestId('commercial-agreement-sign')).toHaveAttribute('data-glass', 'card');
    expect(glassCard(screen.getByLabelText('Ask Waves about this estimate'))).not.toBeNull();
    // The itemization (incl. tax) and Service terms sit inside the glass proposal card.
    const detail = screen.getByTestId('proposal-detail-card');
    expect(within(detail).getByText(/Sales tax/)).toBeInTheDocument();
    expect(within(detail).getByText('Service terms')).toBeInTheDocument();
    // No section on the page is left as a flat legacy card.
    document.querySelectorAll('section').forEach((section) => {
      expect(section.closest('[data-glass="card"]')).not.toBeNull();
    });
  });

  it('keeps the on-page proposal glass: the Field layout is the PDF only (owner 2026-10-26)', async () => {
    await renderProposal({ canSign: true, state: 'none' });
    expect(document.querySelector('.waves-field-document, .waves-field-document-body, .field-document-masthead')).toBeNull();
    expect(screen.getByTestId('proposal-detail-card')).toHaveAttribute('data-glass', 'card');
  });

  it('puts What happens next below the proposal and above the Accept & sign card (owner 2026-10-26)', async () => {
    await renderProposal({ canSign: true, state: 'none' });
    const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const detail = screen.getByTestId('proposal-detail-card');
    const nextSteps = screen.getByTestId('proposal-next-steps');
    expect(follows(detail, nextSteps)).toBe(true);
    expect(follows(nextSteps, screen.getByTestId('commercial-agreement-sign'))).toBe(true);
  });

  it('the What happens next card is glass UI: a real heading and the gold call button', async () => {
    await renderProposal({ canSign: true, state: 'none' });
    const nextSteps = screen.getByTestId('proposal-next-steps');
    expect(within(nextSteps).getByRole('heading', { level: 2, name: 'What happens next' })).toBeInTheDocument();
    expect(within(nextSteps).getByRole('link', { name: 'Call (941) 297-5749' })).toHaveAttribute('data-glass-accent');
    expect(within(nextSteps).getByRole('link', { name: 'Call (941) 297-5749' })).toHaveStyle({ marginLeft: 'auto', marginRight: 'auto' });
  });

  it('the signed and call-us agreement cards are glass too', async () => {
    await renderProposal({ canSign: false, state: 'signed' });
    expect(screen.getByTestId('commercial-agreement-signed')).toHaveAttribute('data-glass', 'card');
    cleanup();
    await renderProposal({ canSign: false, state: 'none' });
    expect(screen.getByTestId('commercial-agreement-call')).toHaveAttribute('data-glass', 'card');
  });
});

// GATE_COMMERCIAL_FIRST_VISIT: /data's cta.commercialFirstVisit. Signed, the agreement card becomes the first-visit
// picker and What happens next points at it; once booked (the proposal is then accepted), the accepted card shows the
// visit date.
describe('commercial first visit on the proposal page', () => {
  it('signed + pick: the picker replaces the signed card and What happens next points below', async () => {
    const payload = proposalPayload({ canSign: false, state: 'signed' });
    payload.cta.commercialFirstVisit = { state: 'pick', durationMinutes: 30 };
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).includes('/first-visit/availability')
      ? json({ ok: true, days: [], slots: [] })
      : json(payload))));
    render(<EstimateViewPage />);
    await screen.findByText('Commercial Service Proposal');
    const picker = await screen.findByTestId('commercial-first-visit-picker');
    expect(picker).toHaveAttribute('data-glass', 'card');
    expect(within(picker).getByRole('heading', { level: 2, name: 'Pick your first visit' })).toBeInTheDocument();
    expect(screen.queryByTestId('commercial-agreement-signed')).not.toBeInTheDocument();
    expect(screen.getByTestId('proposal-next-steps')).toHaveTextContent('Pick the day and time of your first visit below');
  });

  it('accepted with a booked first visit: the accepted card shows the visit date', async () => {
    const payload = proposalPayload();
    payload.cta = { ...payload.cta, terminalState: 'accepted', commercialFirstVisit: { state: 'booked', visit: { date: '2026-11-03', windowStart: '09:00', windowEnd: '10:00' } } };
    vi.stubGlobal('fetch', vi.fn(async () => json(payload)));
    render(<EstimateViewPage />);
    expect(await screen.findByText('Tuesday, November 3 at 9 AM')).toBeInTheDocument();
    expect(screen.getByText('Your visit')).toBeInTheDocument();
  });
});

describe('residential estimate page is unchanged', () => {
  it('still renders the Waves AI card, the app pitch, the reviews and the old next-steps card', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(residentialQuotePayload())));
    render(<EstimateViewPage />);
    await screen.findByText('Sample property review title');
    expect(screen.getByText('The Waves app')).toBeInTheDocument();
    expect(await screen.findByText('Reviews')).toBeInTheDocument();
    expect(screen.getByLabelText('Ask Waves about this estimate')).toBeInTheDocument();
    expect(screen.queryByTestId('proposal-next-steps')).not.toBeInTheDocument();
  });
});
