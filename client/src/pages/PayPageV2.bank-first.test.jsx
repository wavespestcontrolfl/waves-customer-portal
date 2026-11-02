// @vitest-environment jsdom
// Bank first (owner 2026-11-01, option A): the invoice pay page lists the
// Bank account tile before Card or wallet, but the initial selection stays
// card (the invoice PaymentIntent is minted card-locked). The Visa-required
// surcharge notice rides under the surcharge line only while a surcharge > 0
// is displayed.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PayPageV2 from './PayPageV2';
import { CARD_SURCHARGE_NOTICE } from '../lib/cardSurcharge';

vi.mock('../glass/glass-engine', () => ({ useGlassSurface: vi.fn() }));
// PublicStateCard and BrandCard come through for real: they are leaf
// presentational components, and these suites assert on the terminal-state
// markup they produce. Everything heavier stays stubbed.
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

vi.mock('../lib/stripeLoader', () => ({ getStripe: vi.fn() }));

const elementCalls = [];

function fakeStripe() {
  const make = (type, opts) => {
    elementCalls.push({ type, opts });
    return { on: vi.fn((evt, cb) => { if (evt === 'ready') setTimeout(cb, 0); }), mount: vi.fn(), destroy: vi.fn(), unmount: vi.fn() };
  };
  return {
    elements: vi.fn(() => ({ create: make, submit: vi.fn(async () => ({})), update: vi.fn() })),
    createPaymentMethod: vi.fn(async () => ({ paymentMethod: { id: 'pm_1' } })),
    confirmPayment: vi.fn(),
  };
}

function setupResponse() {
  return { clientSecret: 'cs_1', paymentIntentId: 'pi_1', amount: 150, baseAmount: 150, publishableKey: 'pk_test_1', status: 'requires_payment_method', version: 1, cardSurchargeRate: 0.029 };
}

function stubPayFetch(quote) {
  const body = payload({ stripe: { available: true, publishableKey: 'pk_test_1' }, payFaq: true });
  const fetchMock = vi.fn(async (url, init) => {
    if (!init || !init.method || init.method === 'GET') return response(200, body);
    if (String(url).endsWith('/setup')) return response(200, setupResponse());
    if (String(url).endsWith('/quote')) return response(200, quote);
    return response(204, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const FAQ_ANSWER_TEXT = (q) => screen.getByText(q).closest('details, div');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  elementCalls.length = 0;
});

async function mountForm(quote) {
  const { getStripe } = await import('../lib/stripeLoader');
  getStripe.mockResolvedValue(fakeStripe());
  stubPayFetch(quote);
  renderPage();
  await screen.findByRole('group', { name: 'Payment method' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue to review' })).not.toBeDisabled());
}

describe('pay page — bank first (owner 2026-11-01)', () => {
  it('lists the Bank account tile before Card or wallet and keeps card selected', async () => {
    await mountForm({ base: 150, surcharge: 4.35, total: 154.35, funding: 'credit', rateBps: 290 });
    const tiles = screen.getByRole('group', { name: 'Payment method' }).querySelectorAll('button');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toHaveTextContent('Bank account');
    expect(tiles[1]).toHaveTextContent('Card or wallet');
    expect(tiles[0]).toHaveAttribute('aria-pressed', 'false');
    expect(tiles[1]).toHaveAttribute('aria-pressed', 'true');
    // The Payment Element order is unchanged: the intent is minted card-locked.
    const payment = elementCalls.find((c) => c.type === 'payment');
    expect(payment.opts.paymentMethodOrder).toEqual(['card', 'us_bank_account']);
  });

  it('shows the notice under the surcharge line once a surcharge above zero is quoted', async () => {
    await mountForm({ base: 150, surcharge: 4.35, total: 154.35, funding: 'credit', rateBps: 290 });
    expect(screen.queryByText(CARD_SURCHARGE_NOTICE, { selector: '[data-testid="card-surcharge-notice"]' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    const notice = await screen.findByTestId('card-surcharge-notice');
    expect(notice).toHaveTextContent(CARD_SURCHARGE_NOTICE);
    expect(screen.getByText(/Credit card surcharge/).closest('div').nextElementSibling).toBe(notice);
  });

  it('shows no notice when the quoted surcharge is zero (debit card)', async () => {
    await mountForm({ base: 150, surcharge: 0, total: 150, funding: 'debit', rateBps: 290 });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    await screen.findByText(/No card surcharge/);
    expect(screen.queryByTestId('card-surcharge-notice')).toBeNull();
  });

  it('adds the notice to the card-fee FAQ answer', async () => {
    await mountForm({ base: 150, surcharge: 0, total: 150, funding: 'debit', rateBps: 290 });
    fireEvent.click(screen.getByText('Why is there a card fee, and how do I avoid it?'));
    expect(FAQ_ANSWER_TEXT('Why is there a card fee, and how do I avoid it?')).toHaveTextContent(CARD_SURCHARGE_NOTICE);
  });
});
