/**
 * Stripe webhook-health ops tools — unit tests with a mocked Stripe API.
 * Verifies the read-only contract: benign shape when unconfigured (must not
 * trip the shared admin breaker), that event PAYLOADS (customer data) never
 * appear in results, and that every failure surfaces as { error }.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const STRIPE_ENV_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_API_BASE'];

const savedEnv = {};
let executeStripeOpsTool;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeAll(() => {
  for (const key of STRIPE_ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of STRIPE_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.resetModules();
  for (const key of STRIPE_ENV_KEYS) delete process.env[key];
  global.fetch = jest.fn();
  ({ executeStripeOpsTool } = require('../services/intelligence-bar/stripe-ops-tools'));
});

describe('intelligence bar Stripe ops tools', () => {
  test('unconfigured state is benign — no error field and no network call', async () => {
    const result = await executeStripeOpsTool('get_stripe_webhook_endpoints', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/STRIPE_SECRET_KEY/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    const result = await executeStripeOpsTool('create_refund', {});
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('get_stripe_webhook_endpoints maps status and truncates the event list', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    const manyEvents = Array.from({ length: 40 }, (_, i) => `event.type.${i}`);
    global.fetch.mockResolvedValueOnce(jsonResponse({
      data: [{
        id: 'we_1',
        url: 'https://portal.example.com/api/stripe/webhook',
        status: 'enabled',
        api_version: '2026-01-01',
        enabled_events: manyEvents,
      }],
    }));

    const result = await executeStripeOpsTool('get_stripe_webhook_endpoints', {});
    expect(result.error).toBeUndefined();
    expect(result.endpoints[0].status).toBe('enabled');
    expect(result.endpoints[0].enabled_events).toHaveLength(25);
    expect(result.endpoints[0].enabled_events_total).toBe(40);
  });

  test('get_stripe_webhook_failures separates real failures from recent pending, never payload data', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    const oldCreated = Math.floor(Date.now() / 1000) - 3600; // 1h ago — failing
    const freshCreated = Math.floor(Date.now() / 1000) - 60; // 1 min ago — still delivering
    global.fetch.mockResolvedValueOnce(jsonResponse({
      has_more: false,
      data: [
        {
          id: 'evt_old',
          type: 'invoice.payment_failed',
          created: oldCreated,
          pending_webhooks: 2,
          data: { object: { customer_email: 'private@example.com', amount_due: 12345 } },
        },
        {
          id: 'evt_fresh',
          type: 'charge.succeeded',
          created: freshCreated,
          pending_webhooks: 1,
          data: { object: { customer_email: 'private2@example.com' } },
        },
      ],
    }));

    const result = await executeStripeOpsTool('get_stripe_webhook_failures', { hours: 24 });
    expect(result.error).toBeUndefined();
    expect(result.undelivered_events).toEqual([{
      id: 'evt_old',
      type: 'invoice.payment_failed',
      created: new Date(oldCreated * 1000).toISOString(),
      pending_webhooks: 2,
    }]);
    // Young events are mid-delivery, not failures — reported separately so a
    // routine health check doesn't raise false alarms.
    expect(result.recent_pending_events.map(e => e.id)).toEqual(['evt_fresh']);
    expect(result.total_undelivered).toBe(1);
    expect(result.total_recent_pending).toBe(1);
    expect(result.scan_exhaustive).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private@example.com');
    expect(JSON.stringify(result)).not.toContain('private2@example.com');

    const calledUrl = String(global.fetch.mock.calls[0][0]);
    expect(calledUrl).toContain('delivery_success=false');
    expect(calledUrl).toContain('created%5Bgte%5D=');
  });

  test('get_stripe_webhook_failures pages past fresh pending events to find older failures', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    const freshCreated = Math.floor(Date.now() / 1000) - 60;
    const oldCreated = Math.floor(Date.now() / 1000) - 7200;
    // Page 1: 50 fresh pending events (newest first) with more behind them.
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      id: `evt_fresh_${i}`, type: 'charge.succeeded', created: freshCreated, pending_webhooks: 1,
    }));
    const page2 = [
      { id: 'evt_failed_old', type: 'invoice.payment_failed', created: oldCreated, pending_webhooks: 3 },
    ];
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ has_more: true, data: page1 }))
      .mockResolvedValueOnce(jsonResponse({ has_more: false, data: page2 }));

    const result = await executeStripeOpsTool('get_stripe_webhook_failures', { hours: 24 });
    expect(result.error).toBeUndefined();
    // The older real failure behind a page of pending noise is found.
    expect(result.undelivered_events.map(e => e.id)).toEqual(['evt_failed_old']);
    expect(result.total_recent_pending).toBe(50);
    expect(result.scan_exhaustive).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(String(global.fetch.mock.calls[1][0])).toContain('starting_after=evt_fresh_49');
  });

  test('get_stripe_payment_intents maps money state and failure codes, never receipt/charge data', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    const created = Math.floor(Date.now() / 1000) - 3600;
    global.fetch.mockResolvedValueOnce(jsonResponse({
      has_more: false,
      data: [{
        id: 'pi_draft',
        amount: 3333,
        currency: 'usd',
        status: 'requires_payment_method',
        created,
        customer: 'cus_123',
        description: 'Invoice WPC-2026-0999',
        payment_method_types: ['card'],
        receipt_email: 'private@example.com',
        shipping: { name: 'Jane Customer' },
        last_payment_error: {
          code: 'card_declined',
          decline_code: 'insufficient_funds',
          message: 'Your card has insufficient funds.',
          payment_method: { card: { last4: '4242' } },
        },
      }],
    }));

    const result = await executeStripeOpsTool('get_stripe_payment_intents', {});
    expect(result.error).toBeUndefined();
    expect(result.payment_intents).toEqual([{
      id: 'pi_draft',
      amount: 33.33,
      currency: 'usd',
      status: 'requires_payment_method',
      created: new Date(created * 1000).toISOString(),
      customer: 'cus_123',
      description: 'Invoice WPC-2026-0999',
      payment_method_types: ['card'],
      next_action_type: null,
      last_payment_error: {
        code: 'card_declined',
        decline_code: 'insufficient_funds',
        message: 'Your card has insufficient funds.',
      },
    }]);
    expect(JSON.stringify(result)).not.toContain('private@example.com');
    expect(JSON.stringify(result)).not.toContain('Jane Customer');
    expect(JSON.stringify(result)).not.toContain('4242');

    const calledUrl = String(global.fetch.mock.calls[0][0]);
    expect(calledUrl).toContain('/v1/payment_intents');
    expect(calledUrl).toContain('created%5Bgte%5D=');
  });

  test('get_stripe_payment_intents "incomplete" filter matches drafts but excludes card holds and amounts filter exactly', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    const created = Math.floor(Date.now() / 1000) - 3600;
    const pi = (id, status, amount) => ({
      id, status, amount, currency: 'usd', created, customer: null, description: null, payment_method_types: ['card'],
    });
    global.fetch.mockResolvedValueOnce(jsonResponse({
      has_more: false,
      data: [
        pi('pi_draft_match', 'requires_payment_method', 3333),
        pi('pi_draft_action', 'requires_action', 3333),
        pi('pi_draft_other_amount', 'requires_payment_method', 5000),
        // A card hold awaiting capture is NOT an abandoned draft (the
        // one-time card-hold flow parks legitimate auths here).
        pi('pi_hold', 'requires_capture', 3333),
        // An in-progress ACH micro-deposit verification is an ACTIVE payment
        // session, not an abandoned draft (prepaid-pi-guard detects the same
        // subtype).
        {
          ...pi('pi_ach_verify', 'requires_action', 3333),
          next_action: { type: 'verify_with_microdeposits', verify_with_microdeposits: { hosted_verification_url: 'https://payments.stripe.com/x' } },
        },
        pi('pi_paid', 'succeeded', 3333),
      ],
    }));

    const result = await executeStripeOpsTool('get_stripe_payment_intents', { status: 'incomplete', amount: 33.33 });
    expect(result.error).toBeUndefined();
    expect(result.payment_intents.map(p => p.id)).toEqual(['pi_draft_match', 'pi_draft_action']);
    expect(result.total_scanned).toBe(6);
    expect(result.scan_exhaustive).toBe(true);
    expect(result.status_filter).toBe('incomplete');
    expect(result.amount_filter).toBe(33.33);
  });

  test('explicit requires_action still surfaces ACH verifications, as type only — never the next_action object', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    const created = Math.floor(Date.now() / 1000) - 3600;
    global.fetch.mockResolvedValueOnce(jsonResponse({
      has_more: false,
      data: [{
        id: 'pi_ach_verify', status: 'requires_action', amount: 3333, currency: 'usd', created,
        payment_method_types: ['us_bank_account'],
        next_action: { type: 'verify_with_microdeposits', verify_with_microdeposits: { hosted_verification_url: 'https://payments.stripe.com/x' } },
      }],
    }));

    const result = await executeStripeOpsTool('get_stripe_payment_intents', { status: 'requires_action' });
    expect(result.error).toBeUndefined();
    expect(result.payment_intents.map(p => p.id)).toEqual(['pi_ach_verify']);
    expect(result.payment_intents[0].next_action_type).toBe('verify_with_microdeposits');
    expect(JSON.stringify(result)).not.toContain('hosted_verification_url');
  });

  test('get_stripe_payment_intents pages past non-matching intents via starting_after', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    const created = Math.floor(Date.now() / 1000) - 3600;
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      id: `pi_paid_${i}`, status: 'succeeded', amount: 100, currency: 'usd', created, payment_method_types: ['card'],
    }));
    const page2 = [{
      id: 'pi_draft_deep', status: 'requires_confirmation', amount: 3333, currency: 'usd', created, payment_method_types: ['card'],
    }];
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ has_more: true, data: page1 }))
      .mockResolvedValueOnce(jsonResponse({ has_more: false, data: page2 }));

    const result = await executeStripeOpsTool('get_stripe_payment_intents', { status: 'incomplete' });
    expect(result.error).toBeUndefined();
    expect(result.payment_intents.map(p => p.id)).toEqual(['pi_draft_deep']);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(String(global.fetch.mock.calls[1][0])).toContain('starting_after=pi_paid_49');
  });

  test('get_stripe_payment_intents reports canceled state and unconfigured stays benign', async () => {
    const dark = await executeStripeOpsTool('get_stripe_payment_intents', {});
    expect(dark.error).toBeUndefined();
    expect(dark.configured).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();

    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    jest.resetModules();
    ({ executeStripeOpsTool } = require('../services/intelligence-bar/stripe-ops-tools'));
    const created = Math.floor(Date.now() / 1000) - 3600;
    const canceledAt = created + 600;
    global.fetch.mockResolvedValueOnce(jsonResponse({
      has_more: false,
      data: [{
        id: 'pi_cancelled', status: 'canceled', amount: 3333, currency: 'usd', created,
        canceled_at: canceledAt, cancellation_reason: 'abandoned', payment_method_types: ['card'],
      }],
    }));
    const result = await executeStripeOpsTool('get_stripe_payment_intents', { status: 'canceled' });
    expect(result.payment_intents[0].canceled_at).toBe(new Date(canceledAt * 1000).toISOString());
    expect(result.payment_intents[0].cancellation_reason).toBe('abandoned');
  });

  test('auth rejection surfaces as { error }, never a throw', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_bad';
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 401));

    const result = await executeStripeOpsTool('get_stripe_webhook_endpoints', {});
    expect(result.error).toMatch(/rejected the key/);
  });
});
