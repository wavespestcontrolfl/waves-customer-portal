// @vitest-environment jsdom
// Pay-page previous-balance rows: the server's previousBalance (behind
// GATE_PAY_INCLUDE_BALANCE) lists the customer's other open invoices. A row
// gets a "Past due since" caption only when the server says pastDue (its
// ET-correct verdict), and the section points to the portal and the app
// instead of linking each invoice (pay tokens are bearer credentials).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
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


afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const previousBalance = {
  invoices: [
    { invoiceNumber: 'WPC-OLD-1', serviceDate: '2026-08-01', dueDate: '2026-08-15', pastDue: true, amountDue: 117 },
    { invoiceNumber: 'WPC-OLD-2', serviceDate: '2026-10-20', dueDate: '2026-11-03', pastDue: false, amountDue: 80 },
  ],
  total: 197,
  combinedTotal: 347,
};

describe('pay page — previous balance rows (GATE_PAY_INCLUDE_BALANCE)', () => {
  it('marks only the rows the server flags past due, and points to the portal and app', async () => {
    stubFetch(payload({ previousBalance }));
    renderPage();
    await screen.findByText('Also due on your account');
    // Past-due is the server verdict: the client does no date math.
    expect(screen.getByText(/Past due since August 15, 2026/)).toBeInTheDocument();
    expect(screen.getAllByText(/Past due since/)).toHaveLength(1);
    expect(screen.getByText('Total due today')).toBeInTheDocument();
    const portal = screen.getByRole('link', { name: 'customer portal' });
    expect(portal).toHaveAttribute('href', '/login');
    expect(portal.parentElement).toHaveTextContent('See every invoice in detail in your customer portal or the Waves app.');
  });

  it('renders no previous-balance section without the server field', async () => {
    stubFetch(payload());
    renderPage();
    await screen.findByText('Review and pay');
    expect(screen.queryByText('Also due on your account')).not.toBeInTheDocument();
    expect(screen.queryByText(/Past due since/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'customer portal' })).not.toBeInTheDocument();
  });
});
