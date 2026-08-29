// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PayPageV2 from './PayPageV2';

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
    // Stripe unavailable keeps the page from minting a PaymentIntent, so the
    // test never needs the Stripe SDK — the panel renders regardless.
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
      <Routes><Route path="/pay/:token" element={<PayPageV2 />} /></Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pay page — other ways to pay (Zelle / Venmo)', () => {
  it('renders nothing when the server sends no manualPayOptions', async () => {
    stubFetch(payload());
    renderPage();
    await screen.findByText('Pay securely');
    expect(screen.queryByRole('button', { name: /Prefer to pay by/ })).not.toBeInTheDocument();
  });

  it('shows a collapsed link that expands into Zelle + Venmo + PayPal rows with pre-filled pay links', async () => {
    stubFetch(payload({ manualPayOptions: {
      zelle: { recipient: '9415551234' },
      venmo: { handle: '@WavesPest' },
      paypal: { handle: 'WavesPest' },
    } }));
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'Prefer to pay by Zelle, Venmo or PayPal?' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Other ways to pay')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Other ways to pay')).toBeInTheDocument();
    // Zelle phone → tap-to-call link, formatted for display.
    expect(screen.getByRole('link', { name: '(941) 555-1234' })).toHaveAttribute('href', 'tel:+19415551234');
    // Zelle has no pay-link — "Open Zelle" goes to Zelle's find-your-bank page.
    expect(screen.getByRole('link', { name: 'Open Zelle' })).toHaveAttribute('href', 'https://www.zellepay.com/get-started');
    // Venmo / PayPal open the app pre-filled with the amount due (+ invoice memo on Venmo).
    expect(screen.getByRole('link', { name: 'Open Venmo' }))
      .toHaveAttribute('href', 'https://venmo.com/WavesPest?txn=pay&note=Invoice+WPC-2026-0123&amount=150.00');
    expect(screen.getByRole('link', { name: 'Open PayPal' }))
      .toHaveAttribute('href', 'https://paypal.me/WavesPest/150.00USD');
    expect(screen.getByText('@WavesPest')).toBeInTheDocument();
    expect(screen.getByText('paypal.me/WavesPest')).toBeInTheDocument();
    // Owner ruling 2026-08-29: every off-Stripe tender carries "No fees".
    expect(screen.getAllByText('No fees')).toHaveLength(3);
    expect(screen.getByText('WPC-2026-0123', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText(/stays open here/)).toBeInTheDocument();
  });

  it('names only the configured app and copies its value', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    stubFetch(payload({ manualPayOptions: { venmo: { handle: '@WavesPest' } } }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Prefer to pay by Venmo?' }));
    expect(screen.queryByText('Zelle')).not.toBeInTheDocument();
    expect(screen.queryByText('PayPal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Venmo address' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('@WavesPest'));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});
