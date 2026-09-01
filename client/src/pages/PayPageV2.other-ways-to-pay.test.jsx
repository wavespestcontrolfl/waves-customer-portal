// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
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
    await screen.findByText('Secure'); // payment-panel marker (the 'Pay securely' header was removed 2026-08-31)
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
    const tab = { close: vi.fn(), location: { href: '' }, opener: {} };
    vi.stubGlobal('open', vi.fn(() => tab));
    // Controls are disabled until the expand-time fresh read lands.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Venmo' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Open Venmo' }));
    await waitFor(() => expect(tab.location.href).toBe('https://venmo.com/WavesPest?txn=pay&note=Invoice+WPC-2026-0123&amount=150.00'));
    // Plain _blank keeps the handle; opener is severed on the handle itself (codex r5 P2).
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy Venmo address' })).toBeEnabled());
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
      if (!init || !init.method || init.method === 'GET') { gets += 1; return response(200, gets <= 2 ? first : edited); }
      return response(204, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const tab = { close: vi.fn(), location: { href: '' } };
    vi.stubGlobal('open', vi.fn(() => tab));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Other ways to pay/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Venmo' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Open Venmo' }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(tab.location.href).toBe('');
    expect(await screen.findByRole('status')).toHaveTextContent(/just updated/);
    // The page re-rendered from the fresh payload.
    await waitFor(() => expect(screen.getAllByText('$175.00').length).toBeGreaterThan(0));
  });

  it('refuses to open a transfer when the fresh read flags pending credit (codex r4 P1)', async () => {
    const first = payload({ manualPayOptions: { venmo: { handle: '@WavesPest' }, amountDue: 150, version: 1 } });
    // Same version + gross: credit landed after render, /setup will reduce the invoice.
    const credited = payload({ manualPayOptions: { venmo: { handle: '@WavesPest' }, amountDue: 150, creditPending: true, version: 1 } });
    let gets = 0;
    const fetchMock = vi.fn(async (url, init) => {
      if (!init || !init.method || init.method === 'GET') { gets += 1; return response(200, gets <= 2 ? first : credited); }
      return response(204, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const tab = { close: vi.fn(), location: { href: '' } };
    vi.stubGlobal('open', vi.fn(() => tab));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Other ways to pay/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Venmo' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Open Venmo' }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(tab.location.href).toBe('');
    // Re-rendered from the fresh payload: creditPending + no /setup answer withholds the block entirely.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Other ways to pay/ })).not.toBeInTheDocument());
  });

  it('refuses to open a transfer when the recipient rotated since render (codex r4 P1)', async () => {
    const first = payload({ manualPayOptions: { paypal: { handle: 'WavesPest' }, amountDue: 150, version: 1 } });
    const rotated = payload({ manualPayOptions: { paypal: { handle: 'WavesPestControl' }, amountDue: 150, version: 1 } });
    let gets = 0;
    const fetchMock = vi.fn(async (url, init) => {
      if (!init || !init.method || init.method === 'GET') { gets += 1; return response(200, gets <= 2 ? first : rotated); }
      return response(204, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const tab = { close: vi.fn(), location: { href: '' } };
    vi.stubGlobal('open', vi.fn(() => tab));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Other ways to pay/ }));
    expect(screen.getByText('paypal.me/WavesPest')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open PayPal' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Open PayPal' }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(tab.location.href).toBe('');
    expect(await screen.findByRole('status')).toHaveTextContent(/just updated/);
    // The row now shows (and copies) the rotated recipient, never the captured one.
    await waitFor(() => expect(screen.getByText('paypal.me/WavesPestControl')).toBeInTheDocument());
    expect(screen.queryByText('paypal.me/WavesPest')).not.toBeInTheDocument();
  });

  it('revalidates on expand and on tab re-focus so Copy and Zelle never act on stale details (codex r5 P1)', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const first = payload({ manualPayOptions: { zelle: { recipient: '9415551234' }, venmo: { handle: '@WavesPest' }, amountDue: 150, version: 1 } });
    const rotated = payload({ manualPayOptions: { zelle: { recipient: '9415559999' }, venmo: { handle: '@WavesPestControl' }, amountDue: 150, version: 1 } });
    let gets = 0;
    let serve = first;
    const fetchMock = vi.fn(async (url, init) => {
      if (!init || !init.method || init.method === 'GET') { gets += 1; return response(200, serve); }
      return response(204, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    const toggle = await screen.findByRole('button', { name: /Other ways to pay/ });
    // Recipients rotate after the initial GET; the expand-time fresh read catches it.
    serve = rotated;
    fireEvent.click(toggle);
    // Every control is disabled until the fresh read lands.
    expect(screen.getByRole('button', { name: 'Copy Venmo address' })).toBeDisabled();
    expect(screen.getByRole('link', { name: '(941) 555-1234' })).toHaveAttribute('aria-disabled', 'true');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy Venmo address' })).toBeEnabled());
    expect(gets).toBe(2);
    expect(await screen.findByRole('status')).toHaveTextContent(/just updated/);
    // The panel re-rendered from the fresh payload: new Zelle number, new Venmo handle, and Copy copies the NEW handle.
    expect(screen.getByRole('link', { name: '(941) 555-9999' })).toHaveAttribute('href', 'tel:+19415559999');
    expect(screen.queryByText('@WavesPest')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Venmo address' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('@WavesPestControl'));
    // An old tab regaining visibility re-reads too.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(gets).toBe(3));
  });

  it('re-reads on a cadence while the panel stays open so a validation never lasts indefinitely', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const first = payload({ manualPayOptions: { venmo: { handle: '@WavesPest' }, amountDue: 150, version: 1 } });
      let gets = 0;
      const fetchMock = vi.fn(async (url, init) => {
        if (!init || !init.method || init.method === 'GET') { gets += 1; return response(200, first); }
        return response(204, {});
      });
      vi.stubGlobal('fetch', fetchMock);
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /Other ways to pay/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Open Venmo' })).toBeEnabled());
      expect(gets).toBe(2);
      await vi.advanceTimersByTimeAsync(45_000);
      await waitFor(() => expect(gets).toBe(3));
      await vi.advanceTimersByTimeAsync(45_000);
      await waitFor(() => expect(gets).toBe(4));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps every control disabled when the revalidation read fails (codex r6 P1)', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => undefined) } });
    const first = payload({ manualPayOptions: { zelle: { recipient: '9415551234' }, venmo: { handle: '@WavesPest' }, amountDue: 150, version: 1 } });
    let gets = 0;
    const fetchMock = vi.fn(async (url, init) => {
      if (!init || !init.method || init.method === 'GET') {
        gets += 1;
        if (gets === 1) return response(200, first);
        throw new Error('network down');
      }
      return response(204, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Other ways to pay/ }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Could not confirm/);
    expect(gets).toBe(2);
    expect(screen.getByRole('button', { name: 'Copy Venmo address' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open Venmo' })).toBeDisabled();
    expect(screen.getByRole('link', { name: '(941) 555-1234' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('link', { name: 'Open Zelle' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('once /setup has minted a PI, a changed invoice from the panel read forces a full reload (never a data swap beside the mounted form)', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, search: '', href: 'http://localhost/pay/x', reload, assign: vi.fn() });
    const stripeOn = { available: true, publishableKey: 'pk_test_1' };
    const first = payload({ stripe: stripeOn, manualPayOptions: { venmo: { handle: '@WavesPest' }, amountDue: 150, version: 1 } });
    const edited = payload({ stripe: stripeOn, manualPayOptions: { venmo: { handle: '@WavesPest' }, amountDue: 175, version: 2 } });
    edited.invoice.amountDue = 175; edited.invoice.total = 175; edited.invoice.version = 2;
    let gets = 0;
    let releaseSetup;
    const setupGate = new Promise((r) => { releaseSetup = r; });
    const fetchMock = vi.fn(async (url, init) => {
      if (!init || !init.method || init.method === 'GET') { gets += 1; return response(200, gets <= 2 ? first : edited); }
      if (String(url).endsWith('/setup')) {
        await setupGate; // /setup is still pending while the panel opens
        return response(200, { clientSecret: 'cs_1', paymentIntentId: 'pi_1', amount: 150, baseAmount: 150, publishableKey: 'pk_test_1', status: 'requires_payment_method', version: 1 });
      }
      return response(204, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    // Panel opens (and validates) BEFORE /setup answers.
    fireEvent.click(await screen.findByRole('button', { name: /Other ways to pay/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Venmo' })).toBeEnabled());
    expect(gets).toBe(2);
    // Now /setup answers and the PaymentForm mounts against pi_1.
    await act(async () => { releaseSetup(); await setupGate; });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/setup'))).toBe(true));
    // The invoice changes; the panel's next read must reload the page, not
    // swap `data` beside the old client secret.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(screen.queryByText('$175.00')).not.toBeInTheDocument();
  });

  it('an older overlapping read cannot re-enable controls after a newer one started', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => undefined) } });
    const first = payload({ manualPayOptions: { venmo: { handle: '@WavesPest' }, amountDue: 150, version: 1 } });
    let gets = 0;
    const holds = [];
    const fetchMock = vi.fn(async (url, init) => {
      if (!init || !init.method || init.method === 'GET') {
        gets += 1;
        if (gets === 1) return response(200, first);
        // Every panel read is held until the test releases it.
        await new Promise((r) => { holds.push(r); });
        return response(200, first);
      }
      return response(204, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Other ways to pay/ }));
    await waitFor(() => expect(holds).toHaveLength(1)); // expand read (gen 1) in flight
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(holds).toHaveLength(2)); // re-focus read (gen 2) in flight
    // The OLDER read finishes first — controls must stay disabled.
    await act(async () => { holds[0](); });
    expect(screen.getByRole('button', { name: 'Copy Venmo address' })).toBeDisabled();
    // Only the latest read enables them.
    await act(async () => { holds[1](); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy Venmo address' })).toBeEnabled());
  });

  it('withholds the block while account credit is pending and Stripe setup has not answered (codex r3 P1)', async () => {
    stubFetch(payload({ manualPayOptions: { venmo: { handle: '@WavesPest' }, amountDue: 150, creditPending: true, version: 1 } }));
    renderPage();
    await screen.findByText('Secure'); // payment-panel marker (the 'Pay securely' header was removed 2026-08-31)
    expect(screen.queryByRole('button', { name: /Other ways to pay/ })).not.toBeInTheDocument();
  });
});
