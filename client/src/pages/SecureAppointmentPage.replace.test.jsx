// @vitest-environment jsdom
// /secure/:token — "Use a different payment method" after a capture already
// succeeded (customer report 2026-09-08). The deterministic mint replays the
// saved card on every reopen; the page renders the succeeded replay as a
// saved-method panel and swaps to a fresh capture through
// POST /replace-intent. Same contract as the estimate accept (#4144).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SecureAppointmentPage from './SecureAppointmentPage';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'a'.repeat(22) }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock('../lib/stripeLoader', () => ({
  loadStripeSdk: vi.fn(async () => () => ({
    elements: () => ({
      create: () => ({
        mount: vi.fn(),
        update: vi.fn(),
        on: (event, cb) => { if (event === 'ready') queueMicrotask(cb); },
      }),
    }),
    retrieveSetupIntent: async () => ({ setupIntent: { status: 'requires_payment_method' } }),
    confirmSetup: async () => ({ setupIntent: { id: 'seti_after', status: 'succeeded' } }),
  })),
}));

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

const READY_REPLAY = {
  state: 'ready',
  firstName: 'Pat',
  serviceType: 'Pest Control',
  dateDisplay: 'Tue, Sep 15',
  windowDisplay: '8–10am',
  cancelFeeNote: null,
  clientSecret: 'cs_saved',
  setupIntentId: 'seti_saved',
  paymentMethodTypes: ['card'],
  capturedMethodType: 'card',
  publishableKey: 'pk_test_synthetic',
};

function installFetch({ replace = jsonResponse({ success: true, replaced: true, clientSecret: 'cs_after', setupIntentId: 'seti_after', paymentMethodTypes: ['card'], capturedMethodType: null, publishableKey: 'pk_test_synthetic' }) } = {}) {
  const fetchMock = vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/replace-intent')) return typeof replace === 'function' ? replace(url, opts) : replace;
    if (u.endsWith('/complete')) return jsonResponse({ success: true });
    if (/\/secure-card\/[A-Za-z]+$/.test(u)) return jsonResponse(READY_REPLAY);
    throw new Error(`unexpected fetch ${u}`);
  });
  global.fetch = fetchMock;
  return fetchMock;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('SecureAppointmentPage — use a different payment method', () => {
  it('renders a succeeded replay as a saved-method panel and swaps to the fresh intent the server minted', async () => {
    const fetchMock = installFetch();
    render(<SecureAppointmentPage />);
    expect(await screen.findByText('Your card is already saved for this plan.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use a different payment method' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/replace-intent'))).toBe(true));
    const [, opts] = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/replace-intent'));
    // The retired capture is named so the server can stamp it.
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ setupIntentId: 'seti_saved' });
    // The capture remounts on the fresh intent: element path, no saved panel,
    // consent reset.
    await waitFor(() => expect(screen.queryByText('Your card is already saved for this plan.')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Use a different payment method' })).not.toBeInTheDocument();
    expect(await screen.findByRole('checkbox')).not.toBeChecked();
    // The next save completes with the NEW intent, never the retired one.
    fireEvent.click(screen.getByRole('checkbox'));
    const save = await screen.findByRole('button', { name: 'Save card & secure my visit' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/complete'))).toBe(true));
    const [, completeOpts] = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/complete'));
    expect(JSON.parse(completeOpts.body).setupIntentId).toBe('seti_after');
  });

  it('a failed swap keeps the saved method usable and shows retry copy (nothing retired)', async () => {
    installFetch({ replace: jsonResponse({ error: 'We could not switch your payment method. Please refresh this page and try again.' }, { ok: false, status: 503 }) });
    render(<SecureAppointmentPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use a different payment method' }));
    expect(await screen.findByText('We could not switch your payment method. Please refresh this page and try again.')).toBeInTheDocument();
    expect(screen.getByText('Your card is already saved for this plan.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use a different payment method' })).toBeEnabled();
  });

  it('request_closed refetches and renders the row\'s true state', async () => {
    let loads = 0;
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('/replace-intent')) return jsonResponse({ error: 'closed', code: 'request_closed' }, { ok: false, status: 409 });
      loads += 1;
      return jsonResponse(loads === 1 ? READY_REPLAY : { state: 'secured', firstName: 'Pat', serviceType: 'Pest Control', cancelFeeNote: null });
    });
    global.fetch = fetchMock;
    render(<SecureAppointmentPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use a different payment method' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use a different payment method' })).not.toBeInTheDocument());
    expect(loads).toBe(2);
  });

  it('locks the save while the replacement is in flight — a confirm must not race the retirement', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fetchMock = installFetch({
      replace: async () => { await gate; return jsonResponse({ success: true, replaced: true, clientSecret: 'cs_after', setupIntentId: 'seti_after', paymentMethodTypes: ['card'], capturedMethodType: null, publishableKey: 'pk_test_synthetic' }); },
    });
    render(<SecureAppointmentPage />);
    fireEvent.click(await screen.findByRole('checkbox'));
    const save = screen.getByRole('button', { name: 'Save card & secure my visit' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Use a different payment method' }));
    expect(await screen.findByRole('button', { name: 'Switching…' })).toBeDisabled();
    fireEvent.click(save);
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/complete'))).toBe(false);
    release();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Switching…' })).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/complete'))).toBe(false);
  });
});
