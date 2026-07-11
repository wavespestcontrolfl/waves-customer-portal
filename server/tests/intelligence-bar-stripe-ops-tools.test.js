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

  test('get_stripe_webhook_failures returns delivery state but never payload data', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      has_more: false,
      data: [{
        id: 'evt_1',
        type: 'invoice.payment_failed',
        created: 1783800000,
        pending_webhooks: 2,
        data: { object: { customer_email: 'private@example.com', amount_due: 12345 } },
      }],
    }));

    const result = await executeStripeOpsTool('get_stripe_webhook_failures', { hours: 24 });
    expect(result.error).toBeUndefined();
    expect(result.undelivered_events).toEqual([{
      id: 'evt_1',
      type: 'invoice.payment_failed',
      created: new Date(1783800000 * 1000).toISOString(),
      pending_webhooks: 2,
    }]);
    expect(JSON.stringify(result)).not.toContain('private@example.com');

    const calledUrl = String(global.fetch.mock.calls[0][0]);
    expect(calledUrl).toContain('delivery_success=false');
    expect(calledUrl).toContain('created%5Bgte%5D=');
  });

  test('auth rejection surfaces as { error }, never a throw', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_bad';
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 401));

    const result = await executeStripeOpsTool('get_stripe_webhook_endpoints', {});
    expect(result.error).toMatch(/rejected the key/);
  });
});
