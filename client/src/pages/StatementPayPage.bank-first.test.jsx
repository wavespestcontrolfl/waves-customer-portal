// @vitest-environment jsdom
// Bank first (owner 2026-11-01, option A): the statement pay link lists US bank
// account first, so the open row at mount is bank. The page's tracked method
// must start on bank too — submit must take the ACH confirm path before Stripe
// fires any 'change' event. The Visa-required notice rides under the card
// surcharge row only while a surcharge above zero is quoted.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StatementPayPage from './StatementPayPage';
import { CARD_SURCHARGE_NOTICE } from '../lib/cardSurcharge';

vi.mock('../glass/glass-engine', () => ({ useGlassSurface: vi.fn() }));
vi.mock('../components/brand', async (importOriginal) => ({
  ...(await importOriginal()),
  WavesShell: ({ children }) => <div>{children}</div>,
  CustomerColumn: ({ children }) => <div>{children}</div>,
  BrandCard: ({ children }) => <section>{children}</section>,
  BrandButton: ({ children, onClick, disabled }) => <button type="button" onClick={onClick} disabled={disabled}>{children}</button>,
  SerifHeading: ({ children }) => <h1>{children}</h1>,
  HelpPhoneLink: () => <span>call Waves</span>,
}));
vi.mock('../components/DocumentActionBar', () => ({ default: () => null }));
vi.mock('../lib/stripeLoader', () => ({ getStripe: vi.fn() }));

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

let created;
let paymentHandlers;
let stripe;

function fakeStripe() {
  created = [];
  paymentHandlers = {};
  const make = (type, opts) => {
    created.push({ type, opts });
    return {
      on: vi.fn((evt, cb) => { paymentHandlers[evt] = cb; if (evt === 'ready') setTimeout(cb, 0); }),
      mount: vi.fn(),
      destroy: vi.fn(),
    };
  };
  stripe = {
    elements: vi.fn(() => ({ create: make, submit: vi.fn(async () => ({})) })),
    createPaymentMethod: vi.fn(async () => ({ paymentMethod: { id: 'pm_1' } })),
    confirmPayment: vi.fn(async () => ({ paymentIntent: { status: 'processing' } })),
  };
  return stripe;
}

function stubFetch(quote) {
  const body = {
    statement: { number: 'ST-1001', payable: true, status: 'open', subtotal: 150, total: 150, tax_amount: 0, due_date: null, terms: null },
    billTo: { company: 'Acme HOA', ap_email: 'ap@example.com' },
    lines: [],
    publishableKey: 'pk_test_1',
    surchargeRateBps: 290,
  };
  const fetchMock = vi.fn(async (url, init) => {
    if (!init || !init.method || init.method === 'GET') return response(200, body);
    if (String(url).endsWith('/setup')) return response(200, { clientSecret: 'cs_1', paymentIntentId: 'pi_1', baseAmount: 150, publishableKey: 'pk_test_1' });
    if (String(url).endsWith('/quote')) return response(200, quote);
    return response(204, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function mountPage(quote = { quoteToken: 'qt', base: 150, surcharge: 4.35, total: 154.35, rateBps: 290 }) {
  const { getStripe } = await import('../lib/stripeLoader');
  getStripe.mockResolvedValue(fakeStripe());
  const fetchMock = stubFetch(quote);
  render(
    <MemoryRouter initialEntries={['/pay/statement/tok123']}>
      <Routes><Route path="/pay/statement/:token" element={<StatementPayPage />} /></Routes>
    </MemoryRouter>,
  );
  const button = await screen.findByRole('button', { name: 'Continue to payment' });
  await waitFor(() => expect(button).not.toBeDisabled());
  return { fetchMock, button };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('statement pay page — bank first (owner 2026-11-01)', () => {
  it('creates the Payment Element with US bank account first', async () => {
    await mountPage();
    const payment = created.find((c) => c.type === 'payment');
    expect(payment.opts.paymentMethodOrder).toEqual(['us_bank_account', 'card']);
  });

  it('starts on bank: submit with no change event takes the ACH confirm path, not the card quote', async () => {
    const { fetchMock, button } = await mountPage();
    // Card-only rate hint is hidden while bank is the open row.
    expect(screen.queryByText(/Credit cards add up to/)).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(stripe.confirmPayment).toHaveBeenCalledTimes(1));
    expect(stripe.createPaymentMethod).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/quote'))).toBe(false);
  });

  it('shows the notice under the card surcharge row when the quoted surcharge is above zero', async () => {
    const { button } = await mountPage();
    await act(async () => { paymentHandlers.change({ value: { type: 'card' } }); });
    expect(screen.getByText(/Credit cards add up to 2.9%/)).toBeInTheDocument();
    fireEvent.click(button);
    const notice = await screen.findByTestId('card-surcharge-notice');
    expect(notice).toHaveTextContent(CARD_SURCHARGE_NOTICE);
    expect(screen.getByText('Card surcharge (2.9%)').parentElement.nextElementSibling).toBe(notice);
  });

  it('shows no notice when the quoted surcharge is zero', async () => {
    const { button } = await mountPage({ quoteToken: 'qt', base: 150, surcharge: 0, total: 150, rateBps: 290 });
    await act(async () => { paymentHandlers.change({ value: { type: 'card' } }); });
    fireEvent.click(button);
    await screen.findByText('Amount to charge');
    expect(screen.queryByTestId('card-surcharge-notice')).toBeNull();
  });
});
