// @vitest-environment jsdom
// Billing audit B-11: Postgres DATE columns (service.date, payment.paymentDate)
// arrive over JSON as "YYYY-MM-DDT00:00:00.000Z" and must render on their exact
// calendar date without shifting a day early in America/New_York, while real
// timestamps (paidAt, refundedAt) convert to ET.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReceiptPage from './ReceiptPage';

function makePayload(overrides = {}) {
  return {
    invoice: {
      id: 'inv-b11',
      invoiceNumber: 'WPC-2026-0719',
      title: 'Quarterly Pest Control',
      status: 'paid',
      lineItems: [{ description: 'Quarterly Pest Control', quantity: 1, unit_price: 95, amount: 95 }],
      subtotal: 95,
      discountAmount: 0,
      discountLabel: null,
      taxRate: 0,
      taxAmount: 0,
      total: 95,
      creditApplied: 0,
      dueDate: '2026-07-19T00:00:00.000Z',
      paidAt: '2026-07-20T02:30:00.000Z', // 10:30 PM EDT on July 19
      paymentMethod: 'card',
      cardBrand: 'visa',
      cardLastFour: '4242',
      notes: null,
      creditMemo: null,
      ...(overrides.invoice || {}),
    },
    service: {
      type: 'Quarterly Pest Control',
      date: '2026-07-19T00:00:00.000Z',
      techName: 'Tech One',
      ...(overrides.service || {}),
    },
    customer: {
      firstName: 'Pat',
      lastName: 'Sample',
      tier: 'Bronze',
      address: '1 Test Way',
      city: 'Bradenton',
      state: 'FL',
      zip: '34201',
      email: 'pat@example.com',
      isCommercial: false,
    },
    payer: null,
    payment: overrides.payment !== undefined ? overrides.payment : null,
  };
}

function renderReceipt(payload) {
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => payload }));
  return render(
    <MemoryRouter initialEntries={['/receipt/tok-b11']}>
      <Routes>
        <Route path="/receipt/:token" element={<ReceiptPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ReceiptPage date formatting (B-11)', () => {
  it('renders Postgres ISO DATE service.date ("2026-07-19T00:00:00.000Z") as July 19, 2026, never July 18', async () => {
    renderReceipt(makePayload());
    expect(await screen.findByText('Quarterly Pest Control · July 19, 2026')).toBeInTheDocument();
    expect(screen.queryByText(/July 18, 2026/)).not.toBeInTheDocument();
  });

  it('renders fallback DATE payment.paymentDate without shifting a day early when invoice.paidAt is null', async () => {
    renderReceipt(makePayload({
      invoice: { status: 'processing', paidAt: null },
      service: { date: '2026-07-15T00:00:00.000Z' },
      payment: {
        amount: 95,
        paymentDate: '2026-07-19T00:00:00.000Z',
        state: 'processing',
        refundAmount: 0,
        remainingPaid: 95,
      },
    }));
    expect(await screen.findByText('Quarterly Pest Control · July 15, 2026')).toBeInTheDocument();
    const submittedRow = screen.getByText(/Submitted:/).parentElement;
    expect(submittedRow).toHaveTextContent('Submitted: July 19, 2026');
    expect(screen.queryByText(/July 18, 2026/)).not.toBeInTheDocument();
  });

  it('keeps ET timestamp conversion for real timestamps (paidAt and refundedAt)', async () => {
    renderReceipt(makePayload({
      invoice: { paidAt: '2026-07-20T02:30:00.000Z' }, // 10:30 PM EDT on July 19
      service: { date: '2026-07-15T00:00:00.000Z' },
      payment: {
        amount: 95,
        paymentDate: '2026-07-19T00:00:00.000Z',
        state: 'fully_refunded',
        refundAmount: 95,
        refundedAt: '2026-07-21T01:15:00.000Z', // 9:15 PM EDT on July 20
        remainingPaid: 0,
      },
    }));
    const paidRow = (await screen.findByText(/^Paid:/)).parentElement;
    expect(paidRow).toHaveTextContent('Paid: July 19, 2026');
    expect(screen.getByText(/This payment has been fully refunded on July 20, 2026\./)).toBeInTheDocument();
  });
});
