// @vitest-environment jsdom
// Bank help (owner 2026-11-24, "build it"): a customer whose bank sign-in
// fails closes Stripe's bank window before Pay, so (1) the manual-entry help
// line shows as soon as Bank account is picked, and (2) the FAQ answers "my
// bank won't let me sign in".
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PayPageV2 from './PayPageV2';

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
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  elementCalls.length = 0;
});

async function mount() {
  const { getStripe } = await import('../lib/stripeLoader');
  getStripe.mockResolvedValue(fakeStripe());
  stubPayFetch({ base: 150, surcharge: 0, total: 150, funding: 'debit', rateBps: 290 });
  renderPage();
  await screen.findByRole('group', { name: 'Payment method' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue to review' })).not.toBeDisabled());
}

const pickBank = () => fireEvent.click(screen.getByRole('button', { name: /Bank account/ }));

describe('pay page — bank help (owner 2026-11-24)', () => {
  it('shows the manual-entry help line only while Bank account is picked', async () => {
    await mount();
    expect(screen.queryByTestId('bank-manual-entry-help')).toBeNull();
    pickBank();
    const help = await screen.findByTestId('bank-manual-entry-help');
    expect(help).toHaveTextContent('Can’t sign in to your bank?');
    expect(help).toHaveTextContent('Enter bank details manually');
    expect(help).toHaveTextContent(/routing and account\s+number/);
    expect(help).toHaveTextContent('a small deposit (or two)');
    fireEvent.click(screen.getByRole('button', { name: /Card or wallet/ }));
    await waitFor(() => expect(screen.queryByTestId('bank-manual-entry-help')).toBeNull());
  });

  it('answers the bank sign-in question in the FAQ', async () => {
    await mount();
    const q = 'My bank won’t let me sign in. How do I pay by bank?';
    fireEvent.click(screen.getByText(q));
    expect(screen.getByText(q).closest('details')).toHaveTextContent('Enter bank details manually');
    // Type-neutral deposit wording: Stripe may send one SM-code deposit or two amounts.
    expect(screen.getByText(q).closest('details')).toHaveTextContent('a small deposit (or two)');
  });
});
