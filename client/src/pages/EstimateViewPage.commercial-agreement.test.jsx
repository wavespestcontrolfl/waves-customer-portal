// @vitest-environment jsdom
// "Accept & sign agreement" on an authored commercial proposal (GATE_COMMERCIAL_PROPOSAL_SIGN): the page shows it
// only when /data carries cta.commercialAgreement (the server adds it only with the gate on), and the tap hands the
// customer to the signing URL the server returns.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'commercial-sign-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function proposalPayload(commercialAgreement) {
  return {
    estimate: {
      customerFirstName: 'Pat', address: '100 Sample Way', serviceCategory: 'pest_control',
      acceptance: { mode: 'quote_required' }, membership: null, intelligence: null, askToken: 'ask-token',
      defaultServiceMode: 'recurring', isOneTimeOnly: false, showOneTimeOption: false, billByInvoice: false,
      licenseNumber: 'JB000000', acceptedServiceMode: null, acceptedFrequencyKey: null, noGuaranteeClaims: true,
    },
    pricing: { services: [], askChips: [], defaultServiceMode: 'recurring', renderFlags: {} },
    proposal: {
      enabled: true, title: 'Commercial Service Proposal', taxLabel: 'Sales tax',
      buildings: [{ name: 'Main', lineItems: [{ description: 'Quarterly pest service', quantity: 1, unitPrice: 300, amount: 300, frequency: 'quarterly', frequencyLabel: 'Quarterly', taxable: false }] }],
      totals: { annualRecurring: 1200, monthlyEquivalent: 100, oneTime: 0, totalTax: 0, firstYearTotal: 1200, hasTax: false, isMultiBuilding: false },
    },
    cta: {
      canAccept: false, terminalState: 'quote_required', quoteRequired: true, quoteRequiredReason: 'commercial_proposal',
      reviewBeforeBooking: false, reviewReason: null, commercialProposal: true,
      ...(commercialAgreement ? { commercialAgreement } : {}),
    },
  };
}

let assign;
beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EstimateViewPage commercial proposal signing', () => {
  it('shows the button with the agreement block and posts to the route, then goes to the signing page', async () => {
    const fetchMock = vi.fn(async (url, init) => (init?.method === 'POST'
      ? json({ signingUrl: 'https://portal.example.test/contract/abc123' }, 201)
      : json(proposalPayload({ canSign: true, state: 'none' }))));
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    const button = await screen.findByRole('button', { name: 'Accept & sign agreement' });
    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://portal.example.test/contract/abc123'));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post[0]).toMatch(/\/estimates\/commercial-sign-token\/commercial-agreement$/);
  });

  it('shows no button when /data carries no agreement block (gate off, or nothing to sign)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(proposalPayload(null))));
    render(<EstimateViewPage />);
    await screen.findByText('Commercial Service Proposal');
    expect(screen.queryByRole('button', { name: 'Accept & sign agreement' })).not.toBeInTheDocument();
    expect(screen.queryByText('Ready to go ahead?')).not.toBeInTheDocument();
  });

  it('an estimate with no account says to call, with no button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(proposalPayload({ canSign: false, state: 'none' }))));
    render(<EstimateViewPage />);
    await screen.findByText('Ready to go ahead?');
    expect(screen.queryByRole('button', { name: 'Accept & sign agreement' })).not.toBeInTheDocument();
    expect(within(screen.getByTestId('commercial-agreement-call')).getByRole('link', { name: '(941) 297-5749' })).toHaveAttribute('href', 'tel:+19412975749');
  });

  it('a signed agreement shows the thank-you and no button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(proposalPayload({ canSign: false, state: 'signed' }))));
    render(<EstimateViewPage />);
    await screen.findByText('Service agreement signed');
    expect(screen.queryByRole('button', { name: 'Accept & sign agreement' })).not.toBeInTheDocument();
  });
});
