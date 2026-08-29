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
    expect(screen.queryByRole('button', { name: /Other ways to pay/ })).not.toBeInTheDocument();
  });

  it('shows a collapsed link that expands into Zelle + Venmo + PayPal rows with pre-filled pay links', async () => {
    stubFetch(payload({ manualPayOptions: {
      zelle: { recipient: '9415551234' },
      venmo: { handle: '@WavesPest' },
      paypal: { handle: 'WavesPest' },
      amountDue: 150,
      version: 1,
    } }));
    renderPage();
    const toggle = await screen.findByRole('button', { name: /Other ways to pay/ });
    expect(toggle).toHaveTextContent('Other ways to pay — Zelle, Venmo or PayPal');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('waves-other-ways-to-pay')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('waves-other-ways-to-pay')).not.toBeNull();
    // Zelle phone → tap-to-call link, formatted for display.
    expect(screen.getByRole('link', { name: '(941) 555-1234' })).toHaveAttribute('href', 'tel:+19415551234');
    // Zelle has no pay-link — "Open Zelle" goes to Zelle's find-your-bank page.
    expect(screen.getByRole('link', { name: 'Open Zelle' })).toHaveAttribute('href', 'https://www.zellepay.com/get-started');
    // Venmo / PayPal open the app pre-filled with the amount due (+ invoice
    // memo on Venmo) — version-fenced: the tab opens synchronously, the
    // invoice is re-fetched, and only an unchanged invoice gets the URL.
    const tab = { close: vi.fn(), location: { href: '' } };
    vi.stubGlobal('open', vi.fn(() => tab));
    fireEvent.click(screen.getByRole('button', { name: 'Open Venmo' }));
    await waitFor(() => expect(tab.location.href).toBe('https://venmo.com/WavesPest?txn=pay&note=Invoice+WPC-2026-0123&amount=150.00'));
    fireEvent.click(screen.getByRole('button', { name: 'Open PayPal' }));
    await waitFor(() => expect(tab.location.href).toBe('https://paypal.me/WavesPest/150.00USD'));
    expect(tab.close).not.toHaveBeenCalled();
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
    const toggle = await screen.findByRole('button', { name: /Other ways to pay/ });
    expect(toggle).toHaveTextContent('Other ways to pay — Venmo');
    fireEvent.click(toggle);
    expect(screen.queryByText('Zelle')).not.toBeInTheDocument();
    expect(screen.queryByText('PayPal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Venmo address' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('@WavesPest'));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('refuses to open a pre-filled transfer when the invoice changed since render (codex r3 P1)', async () => {
    const first = payload({ manualPayOptions: { venmo: { handle: '@WavesPest' }, amountDue: 150, version: 1 } });
    const edited = payload({ manualPayOptions: { venmo: { handle: '@WavesPest' }, amountDue: 175, version: 2 } });
    edited.invoice.amountDue = 175; edited.invoice.total = 175; edited.invoice.version = 2;
    let gets = 0;
    const fetchMock = vi.fn(async (url, init) => {
      if (!init || !init.method || init.method === 'GET') { gets += 1; return response(200, gets === 1 ? first : edited); }
      return response(204, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const tab = { close: vi.fn(), location: { href: '' } };
    vi.stubGlobal('open', vi.fn(() => tab));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Other ways to pay/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Venmo' }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(tab.location.href).toBe('');
    expect(await screen.findByRole('status')).toHaveTextContent(/just updated/);
    // The page re-rendered from the fresh payload.
    await waitFor(() => expect(screen.getAllByText('$175.00').length).toBeGreaterThan(0));
  });

  it('withholds the block while account credit is pending and Stripe setup has not answered (codex r3 P1)', async () => {
    stubFetch(payload({ manualPayOptions: { venmo: { handle: '@WavesPest' }, amountDue: 150, creditPending: true, version: 1 } }));
    renderPage();
    await screen.findByText('Pay securely');
    expect(screen.queryByRole('button', { name: /Other ways to pay/ })).not.toBeInTheDocument();
  });
});
