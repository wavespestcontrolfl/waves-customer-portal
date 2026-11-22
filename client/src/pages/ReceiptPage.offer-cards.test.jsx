// @vitest-environment jsdom
// The paid receipt shows the add-a-service card and the referral card from
// its payload (GATE_DOC_CROSS_SELL). Owner 2026-11-22: the receipt link is
// the pay link, so each card only opens the Waves app. This file pins the
// PAGE's wiring: the payload keys reach the cards, absent keys render
// nothing, the cards stay out of the printed receipt, and the page sends no
// request but its own read.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReceiptPage from './ReceiptPage';

const receiptBody = (extra = {}) => ({
  invoice: {
    id: 'inv-1', invoiceNumber: 'QA-1001', title: 'Quarterly Pest Control', status: 'paid',
    lineItems: [{ description: 'Quarterly Pest Control', quantity: 1, unit_price: 85, amount: 85 }],
    subtotal: 85, discountAmount: 0, discountLabel: null, taxRate: 0, taxAmount: 0, total: 85, creditApplied: 0,
    dueDate: '2026-11-20', paidAt: '2026-11-21T15:00:00Z', paymentMethod: 'card', cardBrand: 'visa', cardLastFour: '4242',
    notes: null, creditMemo: null,
  },
  service: { type: 'Quarterly Pest Control', date: '2026-11-20', techName: 'Adam' },
  customer: {
    firstName: 'Pat', lastName: 'Sample', tier: 'Bronze', address: '1 Test Way', city: 'Bradenton', state: 'FL', zip: '34201',
    email: 'pat@example.com', isCommercial: false,
  },
  payer: null,
  payment: null,
  ...extra,
});
const CARDS = {
  crossSell: { label: 'Lawn Care', relationship: 'add', perApplication: 62 },
  referral: { headline: 'Know someone who could use Waves?', cta: 'Send My Referral Link' },
};

let body;
beforeEach(() => {
  body = receiptBody(CARDS);
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => body }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderReceipt = () => render(
  <MemoryRouter initialEntries={['/receipt/tok-1']}>
    <Routes>
      <Route path="/receipt/:token" element={<ReceiptPage />} />
    </Routes>
  </MemoryRouter>,
);

describe('ReceiptPage — add-a-service and referral cards', () => {
  it('shows both cards as links into the Waves app, with no token in either link', async () => {
    renderReceipt();
    expect(await screen.findByRole('heading', { name: 'Add lawn care to your plan' })).toBeInTheDocument();
    expect(screen.getByText('$62 per application, priced for your home')).toBeInTheDocument();
    const offer = screen.getByRole('link', { name: 'Open the Waves app' });
    expect(offer).toHaveAttribute('href', '/?tab=billing');
    expect(screen.getByRole('link', { name: 'Send My Referral Link' })).toHaveAttribute('href', '/?tab=refer');
    // Screen only: the receipt prints as a record.
    expect(offer.closest('.waves-no-print')).not.toBeNull();
    // The page's one request is its own read: nothing is posted for a card.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1]?.method).toBeUndefined();
  });

  it('a payload with no card keys renders no card', async () => {
    body = receiptBody();
    renderReceipt();
    expect((await screen.findAllByText(/QA-1001/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Open the Waves app' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Send My Referral Link' })).not.toBeInTheDocument();
  });
});
