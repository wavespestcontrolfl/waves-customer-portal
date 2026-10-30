// @vitest-environment jsdom
// Pay page, part-paid invoice (billing audit 2026-10-30, finding 5). The
// amount due was already net of part payments, but the summary showed only
// Subtotal, any credit and Total due, so the deductions did not add up. The
// page now shows the part payment as its own "Paid so far" row. After /setup
// answers, the page derives credit from the setup amount; a part payment
// must not be read as account credit there.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('../components/DocumentActionBar', () => ({ default: () => null }));

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function payload({ amountPaid = 40, creditApplied = 0, stripe = { available: false, publishableKey: null } } = {}) {
  return {
    invoice: {
      id: 'inv-1',
      invoiceNumber: 'WPC-2026-0123',
      title: 'Pest control',
      status: 'sent',
      version: 1,
      saveRequired: false,
      captureNeeded: false,
      lineItems: [{ description: 'Quarterly Pest Control', quantity: 1, unit_price: 100, amount: 100 }],
      subtotal: 100,
      discountAmount: 0,
      discountLabel: null,
      taxRate: 0,
      taxAmount: 0,
      total: 100,
      amountDue: Math.max(0, 100 - creditApplied - amountPaid),
      creditApplied,
      amountPaid,
      dueDate: '2026-11-15',
      paidAt: null,
      notes: null,
      annualPrepay: null,
      attachments: [],
    },
    service: { type: 'Pest control', date: '2026-10-20', productsApplied: [], photos: [] },
    customer: { firstName: 'Pat', lastName: 'Doe', email: 'pat@example.com', city: 'Parrish', state: 'FL', zip: '34219' },
    payer: null,
    processor: 'stripe',
    stripe,
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

const rowValue = (label) => screen.getByText(label).parentElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pay page — part-paid invoice summary', () => {
  it('shows the $40 part payment and the $60 still due', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, payload())));
    renderPage();
    await screen.findByText('Review and pay');
    expect(rowValue('Subtotal')).toHaveTextContent('$100.00');
    expect(rowValue('Paid so far')).toHaveTextContent('− $40.00');
    expect(rowValue('Total due')).toHaveTextContent('$60.00');
    expect(screen.queryByText('Account credit applied')).not.toBeInTheDocument();
  });

  it('shows credit and the part payment as separate rows that add up to the total due', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, payload({ creditApplied: 10 }))));
    renderPage();
    await screen.findByText('Review and pay');
    expect(rowValue('Account credit applied')).toHaveTextContent('− $10.00');
    expect(rowValue('Paid so far')).toHaveTextContent('− $40.00');
    expect(rowValue('Total due')).toHaveTextContent('$50.00');
  });

  it('shows no Paid so far row when nothing was paid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, payload({ amountPaid: 0 }))));
    renderPage();
    await screen.findByText('Review and pay');
    expect(screen.queryByText('Paid so far')).not.toBeInTheDocument();
  });

  it.each([
    // [setup amount, credit row expected]: setup charging the GET amount
    // applies no credit; a lower setup amount means setup applied credit.
    [60, null],
    [50, '− $10.00'],
  ])('after /setup answers $%s, the part payment is never shown as account credit', async (setupAmount, creditRow) => {
    const stripe = { available: true, publishableKey: 'pk_test_1' };
    let releaseSetup;
    const setupGate = new Promise((resolve) => { releaseSetup = resolve; });
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).endsWith('/setup')) {
        await setupGate;
        return response(200, {
          clientSecret: 'cs_1', paymentIntentId: 'pi_1', amount: setupAmount, baseAmount: setupAmount,
          publishableKey: 'pk_test_1', status: 'requires_payment_method', version: 1,
        });
      }
      if (!init || !init.method || init.method === 'GET') return response(200, payload({ stripe }));
      return response(204, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    await screen.findByText('Review and pay');
    await act(async () => { releaseSetup(); await setupGate; });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/setup'))).toBe(true));
    await waitFor(() => expect(rowValue('Total due')).toHaveTextContent(`$${setupAmount}.00`));
    expect(rowValue('Paid so far')).toHaveTextContent('− $40.00');
    if (creditRow) expect(rowValue('Account credit applied')).toHaveTextContent(creditRow);
    else expect(screen.queryByText('Account credit applied')).not.toBeInTheDocument();
  });
});
