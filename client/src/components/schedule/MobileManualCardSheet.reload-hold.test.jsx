// @vitest-environment jsdom
// Tech manual card entry: each charge step holds an out-of-date tab's reload
// until it settles, through Stripe's card check (3-D Secure), which runs with
// no portal request open, so /confirm still runs.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reloadHoldNames } from '../../lib/reloadHolds';

const stripe = vi.hoisted(() => ({ handlers: {}, checks: 0, verify: null }));

vi.mock('../../lib/stripeLoader', () => ({
  getStripe: vi.fn(async () => ({
    elements: () => ({
      create: () => ({ on: (event, handler) => { stripe.handlers[event] = handler; }, mount: () => {} }),
      submit: async () => ({}),
    }),
    createPaymentMethod: async () => ({ paymentMethod: { id: 'pm_fixture' } }),
    handleNextAction: () => {
      stripe.checks += 1;
      return stripe.verify;
    },
  })),
}));

import MobileManualCardSheet from './MobileManualCardSheet';

function installFetch() {
  const calls = [];
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('/setup')) return json({ clientSecret: 'pi_secret', publishableKey: 'pk_test' });
    if (u.endsWith('/quote')) return json({ quoteToken: 'quote-1', total: 163.61, base: 159, surcharge: 4.61 });
    if (u.endsWith('/finalize')) {
      return json({ requiresAction: true, clientSecret: 'pi_secret', paymentIntentId: 'pi_fixture', status: 'requires_action', paymentMethodId: 'pm_fixture' });
    }
    if (u.endsWith('/confirm')) return json({ ok: true });
    return json({ invoice: { saveRequired: false } });
  }));
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  stripe.handlers = {};
  stripe.checks = 0;
  stripe.verify = null;
});

describe('MobileManualCardSheet reload hold', () => {
  it('holds an out-of-date tab reload through the card check until the payment is confirmed', async () => {
    const calls = installFetch();
    let finishCheck;
    stripe.verify = new Promise((resolve) => { finishCheck = resolve; });
    const onChargeSuccess = vi.fn();
    render(<MobileManualCardSheet invoiceToken="tok1234567890abcdefghij" amount={159} onClose={() => {}} onChargeSuccess={onChargeSuccess} />);
    await waitFor(() => expect(stripe.handlers.change).toBeTypeOf('function'));
    act(() => {
      stripe.handlers.ready();
      stripe.handlers.change({ complete: true });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(reloadHoldNames()).toContain('card-payment');
    const confirm = await screen.findByRole('button', { name: /Confirm & charge \$163\.61/ });
    await waitFor(() => expect(reloadHoldNames()).not.toContain('card-payment'));

    fireEvent.click(confirm);
    expect(reloadHoldNames()).toContain('card-payment');
    // Stripe's card check is open, and no portal request is on its way.
    await waitFor(() => expect(stripe.checks).toBe(1));
    expect(reloadHoldNames()).toContain('card-payment');
    expect(calls.filter((u) => u.endsWith('/confirm'))).toHaveLength(0);

    await act(async () => finishCheck({ paymentIntent: { id: 'pi_fixture', status: 'succeeded' } }));
    await waitFor(() => expect(onChargeSuccess).toHaveBeenCalledWith({ paymentIntentId: 'pi_fixture', amount: 163.61 }));
    expect(calls.filter((u) => u.endsWith('/confirm'))).toHaveLength(1);
    await waitFor(() => expect(reloadHoldNames()).not.toContain('card-payment'));
  });
});
