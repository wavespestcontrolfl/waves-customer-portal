// @vitest-environment jsdom
// Pay page layout (owner 2026-11-06): the card form (method choice and card
// form) renders above the invoice details so it is near the top on a phone.
// The DocumentActionBar stays first; the FAQ and "Other ways to pay" stay
// below the invoice details. States that never show a card
// form (here: a missing invoice) are early returns and render as before.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PayPageV2 from './PayPageV2';

vi.mock('../glass/glass-engine', () => ({ useGlassSurface: vi.fn() }));
vi.mock('../components/brand', async (importOriginal) => ({
  ...(await importOriginal()),
  WavesShell: ({ children }) => <div>{children}</div>,
  CustomerColumn: ({ children, ...props }) => <div {...props}>{children}</div>,
  BrandCard: ({ children }) => <section>{children}</section>,
  BrandButton: ({ children, ...props }) => <button type="button" {...props}>{children}</button>,
  SerifHeading: ({ children }) => <h1>{children}</h1>,
  HelpPhoneLink: () => <span>call Waves</span>,
}));
vi.mock('../components/BrandFooter', () => ({ default: () => null }));
vi.mock('../components/DocumentActionBar', () => ({ default: () => <div data-testid="document-action-bar" /> }));
vi.mock('../lib/stripeLoader', () => ({ getStripe: vi.fn() }));

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const BODY = {
  invoice: {
    id: 'inv-1',
    invoiceNumber: 'WPC-2026-0123',
    title: 'Lawn care',
    status: 'sent',
    version: 1,
    saveRequired: false,
    captureNeeded: false,
    lineItems: [{ description: 'Synthetic lawn visit', quantity: 1, unit_price: 150, amount: 150 }],
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
    notes: 'Synthetic invoice note',
    annualPrepay: null,
    attachments: [],
  },
  service: { type: 'Lawn care', date: '2026-08-20', productsApplied: [], photos: [] },
  customer: { firstName: 'Pat', lastName: 'Doe', email: 'pat@example.com', city: 'Parrish', state: 'FL', zip: '34219' },
  payer: null,
  processor: 'stripe',
  stripe: { available: true, publishableKey: 'pk_test_1' },
  payFaq: true,
  manualPayOptions: { zelle: { recipient: 'pay@example.com' } },
};

function fakeStripe() {
  const make = () => ({ on: vi.fn((evt, cb) => { if (evt === 'ready') setTimeout(cb, 0); }), mount: vi.fn(), destroy: vi.fn(), unmount: vi.fn() });
  return {
    elements: vi.fn(() => ({ create: make, submit: vi.fn(async () => ({})), update: vi.fn() })),
    createPaymentMethod: vi.fn(async () => ({ paymentMethod: { id: 'pm_1' } })),
    confirmPayment: vi.fn(),
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/pay/deadbeefdeadbeefdeadbeef']}>
      <Routes><Route path="/pay/:token" element={<PayPageV2 />} /></Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('pay page — payment block above the invoice details (owner 2026-11-06)', () => {
  it('renders the action bar, the card form, the invoice details, then the FAQ and other ways to pay', async () => {
    const { getStripe } = await import('../lib/stripeLoader');
    getStripe.mockResolvedValue(fakeStripe());
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (!init || !init.method || init.method === 'GET') return response(200, BODY);
      if (String(url).endsWith('/setup')) {
        return response(200, { clientSecret: 'cs_1', paymentIntentId: 'pi_1', amount: 150, baseAmount: 150, publishableKey: 'pk_test_1', status: 'requires_payment_method', version: 1, cardSurchargeRate: 0.029 });
      }
      return response(204, {});
    }));
    renderPage();

    const methods = await screen.findByRole('group', { name: 'Payment method' });
    const actionBar = screen.getByTestId('document-action-bar');
    const itemsHeading = screen.getByText('Invoice items');
    const totalDue = screen.getByText('Total due');
    const notes = screen.getByText('Synthetic invoice note');
    const faq = screen.getByText('Why is there a card fee, and how do I avoid it?');
    const otherWays = screen.getByRole('button', { name: /Other ways to pay/ });

    expect(before(actionBar, methods)).toBe(true);
    for (const detail of [itemsHeading, totalDue, notes]) expect(before(methods, detail)).toBe(true);
    for (const below of [faq, otherWays]) {
      for (const detail of [itemsHeading, totalDue, notes]) expect(before(detail, below)).toBe(true);
    }
    // Both payment panels stay off the printout, as before.
    expect(methods.closest('.waves-pay-payment-panel')).toHaveClass('waves-no-print');
    expect(faq.closest('.waves-pay-payment-panel')).toHaveClass('waves-no-print');
    expect(otherWays.closest('.waves-pay-payment-panel')).toBe(faq.closest('.waves-pay-payment-panel'));
  });

  it('a state with no card form (invoice not found) renders as before, with no payment block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(404, {})));
    renderPage();
    expect(await screen.findByText("We couldn't find that invoice")).toBeInTheDocument();
    expect(screen.queryByTestId('document-action-bar')).toBeNull();
    expect(document.querySelector('.waves-pay-payment-panel')).toBeNull();
  });
});
