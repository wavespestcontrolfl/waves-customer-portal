// @vitest-environment jsdom
// Pay-page FAQ accordion (GATE_PAY_PAGE_FAQ). The server sends `payFaq: true`
// only while the gate is on; the client renders nothing without it. Every
// answer restates a fact already on the page — the surcharge percent is
// derived from the client mirror of the rate, the Zelle question rides only
// with manualPayOptions, and the panel hides on the settled / paid states.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PayPageV2 from './PayPageV2';
import { DEFAULT_CARD_SURCHARGE_RATE } from '../lib/cardSurcharge';

vi.mock('../glass/glass-engine', () => ({ useGlassSurface: vi.fn() }));
vi.mock('../components/brand', () => ({
  WavesShell: ({ children }) => <div>{children}</div>,
  BrandCard: ({ children }) => <section>{children}</section>,
  BrandButton: ({ children, ...props }) => <button type="button" {...props}>{children}</button>,
  SerifHeading: ({ children }) => <h1>{children}</h1>,
  HelpPhoneLink: () => <span>call Waves</span>,
}));
vi.mock('../components/BrandFooter', () => ({ default: () => null }));
vi.mock('../components/DocumentActionBar', () => ({ default: () => null }));

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function payload(extra = {}) {
  return {
    invoice: {
      id: 'inv-1',
      invoiceNumber: 'WPC-2026-0123',
      title: 'Lawn care',
      status: 'sent',
      version: 1,
      saveRequired: false,
      captureNeeded: false,
      lineItems: [],
      subtotal: 150,
      discountAmount: 0,
      discountLabel: null,
      taxRate: 0,
      taxAmount: 0,
      total: 150,
      amountDue: 150,
      creditApplied: 0,
      dueDate: '2026-09-15',
      paidAt: null,
      notes: null,
      annualPrepay: null,
      attachments: [],
    },
    service: { type: 'Lawn care', date: '2026-08-20', productsApplied: [], photos: [] },
    customer: { firstName: 'Pat', lastName: 'Doe', email: 'pat@example.com', city: 'Parrish', state: 'FL', zip: '34219' },
    payer: null,
    processor: 'stripe',
    stripe: { available: false, publishableKey: null },
    ...extra,
  };
}

function stubFetch(body) {
  const fetchMock = vi.fn(async (url, init) => {
    if (!init || !init.method || init.method === 'GET') return response(200, body);
    return response(204, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/pay/deadbeefdeadbeefdeadbeef']}>
      <Routes>
        <Route path="/pay/:token" element={<PayPageV2 />} />
        <Route path="/receipt/:token" element={<div>receipt page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const FAQ = () => screen.queryByRole('region', { name: 'Payment questions' });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pay page — FAQ under the Pay button (GATE_PAY_PAGE_FAQ)', () => {
  it('renders nothing when the server omits payFaq (gate off)', async () => {
    stubFetch(payload({ manualPayOptions: { zelle: { recipient: '9415551234' } } }));
    renderPage();
    await screen.findByText('Review and pay');
    expect(FAQ()).toBeNull();
    expect(screen.queryByText('Common questions')).not.toBeInTheDocument();
  });

  it('renders the card-fee, bank-timing and saved-card questions with the derived surcharge percent', async () => {
    stubFetch(payload({ payFaq: true }));
    renderPage();
    await screen.findByText('Review and pay');
    expect(FAQ()).not.toBeNull();
    const pct = Number((DEFAULT_CARD_SURCHARGE_RATE * 100).toFixed(2)).toString();
    expect(screen.getByText('Why is there a card fee, and how do I avoid it?')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`up to ${pct.replace('.', '\\.')}%`))).toBeInTheDocument();
    expect(screen.getByText('How long does a bank (ACH) payment take?')).toBeInTheDocument();
    expect(screen.getByText(/few business days to clear/)).toBeInTheDocument();
    expect(screen.getByText('Is my card saved?')).toBeInTheDocument();
    expect(screen.getByText(/Only if you check the box/)).toBeInTheDocument();
    // No Zelle question without manualPayOptions, and no Zelle mention in the fee answer.
    expect(screen.queryByText('Can I pay by Zelle?')).not.toBeInTheDocument();
    expect(screen.queryByText(/Zelle has no fees/)).not.toBeInTheDocument();
    // The FAQ sits inside the payment panel, above "Other ways to pay".
    expect(FAQ().closest('.waves-pay-payment-panel')).not.toBeNull();
  });

  it('adds the Zelle question only when the server offers Zelle', async () => {
    stubFetch(payload({ payFaq: true, manualPayOptions: { zelle: { recipient: '9415551234' } } }));
    renderPage();
    await screen.findByText('Review and pay');
    expect(screen.getByText('Can I pay by Zelle?')).toBeInTheDocument();
    expect(screen.getByText(/Zelle has no fees/)).toBeInTheDocument();
    const faq = FAQ();
    const other = screen.getByRole('button', { name: /Other ways to pay/ });
     
    expect(faq.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('states the method is kept when a payment method on file is required', async () => {
    const body = payload({ payFaq: true });
    body.invoice.saveRequired = true;
    stubFetch(body);
    renderPage();
    await screen.findByText('Review and pay');
    expect(screen.getByText(/required for recurring service, so this one is saved/)).toBeInTheDocument();
  });

  it('drops the saved-card question on a third-party (payer) billed invoice', async () => {
    stubFetch(payload({ payFaq: true, payer: { name: 'Acme HOA', email: 'ap@example.com' } }));
    renderPage();
    await screen.findByText('Review and pay');
    expect(FAQ()).not.toBeNull();
    expect(screen.queryByText('Is my card saved?')).not.toBeInTheDocument();
  });

  it('is gone once the invoice is paid (the page hands off to the receipt)', async () => {
    const body = payload({ payFaq: true });
    body.invoice.status = 'paid';
    body.invoice.paidAt = '2026-09-01T12:00:00Z';
    body.invoice.amountDue = 0;
    stubFetch(body);
    renderPage();
    await screen.findByText('receipt page');
    expect(FAQ()).toBeNull();
  });
});
