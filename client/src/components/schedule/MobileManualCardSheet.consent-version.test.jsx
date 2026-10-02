// @vitest-environment jsdom
// Tech manual card entry — required-save invoices render the locked card
// authorization for the customer and attest the consent text version on
// /setup (codex #5434 r1 P1); one-off invoices render and attest nothing.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARD_CONSENT_TEXT, CONSENT_VERSION } from '../../lib/paymentMethodConsentText';

vi.mock('../../lib/stripeLoader', () => ({
  getStripe: vi.fn(async () => ({
    elements: () => ({
      create: () => ({ on: () => {}, mount: () => {} }),
    }),
  })),
}));

import MobileManualCardSheet from './MobileManualCardSheet';

function installFetch({ saveRequired }) {
  const calls = [];
  const fetchMock = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null, method: opts.method || 'GET' });
    if (u.endsWith('/setup')) {
      return new Response(JSON.stringify({ clientSecret: 'pi_secret', publishableKey: 'pk_test' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ invoice: { saveRequired } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MobileManualCardSheet consent attestation', () => {
  it('a required-save invoice renders the locked card authorization and attests its version on /setup', async () => {
    const calls = installFetch({ saveRequired: true });
    render(<MobileManualCardSheet invoiceToken="tok1234567890abcdefghij" amount={159} onClose={() => {}} onChargeSuccess={() => {}} />);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/setup'))).toBe(true));
    const setup = calls.find((c) => c.url.endsWith('/setup'));
    expect(setup.body).toEqual({ cardOnly: true, consentTextVersion: CONSENT_VERSION });
    // The GET came first (it decides whether the card is kept on file).
    expect(calls[0].url).toMatch(/\/pay\/tok1234567890abcdefghij$/);
    expect(await screen.findByText(/kept on file for Auto Pay/i)).toBeInTheDocument();
    expect(screen.getByText(/kept on file/i).closest('label').textContent).toContain(CARD_CONSENT_TEXT.slice(0, 40));
  });

  it('a one-off invoice renders no authorization and attests nothing', async () => {
    const calls = installFetch({ saveRequired: false });
    render(<MobileManualCardSheet invoiceToken="tok1234567890abcdefghij" amount={159} onClose={() => {}} onChargeSuccess={() => {}} />);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/setup'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/setup')).body).toEqual({ cardOnly: true });
    expect(screen.queryByText(/kept on file for Auto Pay/i)).not.toBeInTheDocument();
  });
});
