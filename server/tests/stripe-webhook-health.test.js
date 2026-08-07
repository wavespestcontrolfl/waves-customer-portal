/**
 * stripe-webhook-health — daily dead-letter check over stripe_webhook_events
 * plus the Stripe-side delivery probe. Contracts pinned here:
 *
 *  - nonzero ledger failures (error set OR processed=false, last 24h) →
 *    one FIX: email listing event types + ids + sanitized error snippets;
 *  - zero ledger failures AND Stripe-side clean → no email at all
 *    (exception-based: a quiet day is silent);
 *  - Stripe-side failures alone still email (they never reach the ledger);
 *  - a failed ledger query / failed Stripe-side probe returns the blocking
 *    skip codes the scheduler wrapper converts into a job_health failure —
 *    the check never swallows its own breakage;
 *  - error snippets never carry emails or long digit runs (payloads are
 *    never read at all — the loader selects identifiers + error only);
 *  - the ops_email_send_state marker dedupes a deploy-overlap double tick.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({})),
}));
jest.mock('../models/db', () => {
  // Marker reads/writes are try/caught in the service; loaders are injected.
  const qb = () => { throw new Error('db must not be touched when loaders are injected'); };
  qb.raw = () => { throw new Error('db.raw must not be touched when loaders are injected'); };
  return qb;
});

const sendgrid = require('../services/sendgrid-mail');
const {
  runStripeWebhookHealthCheck,
  _private: { composeWebhookHealthDigest, sanitizeErrorSnippet },
} = require('../services/stripe-webhook-health');

function ledgerRow(overrides = {}) {
  return {
    id: 'evt_dead_1',
    event_type: 'payment_intent.succeeded',
    error: 'update failed: relation locked',
    processed: false,
    received_at: new Date('2026-08-07T10:15:00Z').toISOString(),
    ...overrides,
  };
}

function baseOpts(overrides = {}) {
  return {
    sentRecently: jest.fn(async () => false),
    stampSendMarker: jest.fn(async () => {}),
    loadLedgerFailures: jest.fn(async () => ({ total: 0, rows: [] })),
    stripeConfigured: true,
    stripeOpsTools: { getStripeWebhookFailures: jest.fn(async () => ({ undelivered_events: [], total_undelivered: 0 })) },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sendgrid.isConfigured.mockReturnValue(true);
  delete process.env.STRIPE_WEBHOOK_HEALTH_DISABLED;
  delete process.env.STRIPE_WEBHOOK_HEALTH_EMAIL;
});

describe('composeWebhookHealthDigest', () => {
  test('clean ledger + clean Stripe side composes nothing (quiet day)', () => {
    expect(composeWebhookHealthDigest({
      ledger: { total: 0, rows: [] },
      stripeSide: { undelivered_events: [], total_undelivered: 0 },
      stripeCheckError: null,
    })).toBeNull();
  });

  test('FIX subject carries the ledger count; body lists id, type, and error snippet', () => {
    const composed = composeWebhookHealthDigest({
      ledger: { total: 2, rows: [ledgerRow(), ledgerRow({ id: 'evt_dead_2', event_type: 'charge.refunded', error: null })] },
      stripeSide: null,
      stripeCheckError: null,
    });
    expect(composed.subject).toBe('FIX: 2 Stripe webhook events failed/unprocessed in last 24h');
    expect(composed.text).toContain('evt_dead_1 (payment_intent.succeeded)');
    expect(composed.text).toContain('error: update failed: relation locked');
    expect(composed.text).toContain('evt_dead_2 (charge.refunded)');
    expect(composed.text).toContain('unprocessed (no error recorded');
    expect(composed.count).toBe(2);
  });

  test('Stripe-side-only failures still compose a FIX email', () => {
    const composed = composeWebhookHealthDigest({
      ledger: { total: 0, rows: [] },
      stripeSide: {
        undelivered_events: [{ id: 'evt_side_1', type: 'payout.paid', created: '2026-08-07T09:00:00.000Z', pending_webhooks: 1 }],
        total_undelivered: 1,
      },
      stripeCheckError: null,
    });
    expect(composed.subject).toBe('FIX: 1 Stripe webhook delivery failure (Stripe-side) in last 24h');
    expect(composed.text).toContain('evt_side_1 (payout.paid)');
    expect(composed.stripeFailureCount).toBe(1);
  });

  test('error snippets are sanitized: no emails, no long digit runs, capped length', () => {
    const composed = composeWebhookHealthDigest({
      ledger: {
        total: 1,
        rows: [ledgerRow({ error: `SMS to +19415551234 bounced for jane.doe@example.com — ${'x'.repeat(400)}` })],
      },
      stripeSide: null,
      stripeCheckError: null,
    });
    expect(composed.text).not.toContain('+19415551234');
    expect(composed.text).not.toContain('jane.doe@example.com');
    expect(composed.text).toContain('[redacted-number]');
    expect(composed.text).toContain('[redacted-email]');
    expect(sanitizeErrorSnippet('x'.repeat(500)).length).toBe(200);
  });
});

describe('runStripeWebhookHealthCheck', () => {
  test('emails FIX on nonzero ledger count and stamps the send marker', async () => {
    const opts = baseOpts({
      loadLedgerFailures: jest.fn(async () => ({ total: 1, rows: [ledgerRow()] })),
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.sent).toBe(true);
    expect(result.count).toBe(1);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    const mail = sendgrid.sendOne.mock.calls[0][0];
    expect(mail.to).toBe('contact@wavespestcontrol.com');
    expect(mail.subject).toMatch(/^FIX: /);
    expect(mail.text).toContain('evt_dead_1');
    expect(opts.stampSendMarker).toHaveBeenCalledTimes(1);
  });

  test('silent when ledger and Stripe side are both clean', async () => {
    const opts = baseOpts();
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result).toEqual({ skipped: 'nothing_found' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(opts.stampSendMarker).not.toHaveBeenCalled();
  });

  test('ledger query throw returns the blocking query_failed skip (job_health failure upstream)', async () => {
    const opts = baseOpts({
      loadLedgerFailures: jest.fn(async () => { throw new Error('relation vanished'); }),
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result).toEqual({ skipped: 'query_failed' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('failed Stripe-side probe with a quiet ledger is a blocking failure, not a silent pass', async () => {
    const opts = baseOpts({
      stripeOpsTools: { getStripeWebhookFailures: jest.fn(async () => { throw new Error('Stripe API timed out after 15s'); }) },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.skipped).toBe('stripe_check_failed');
    expect(result.stripeCheckError).toContain('timed out');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('failed Stripe-side probe with ledger findings still emails AND surfaces stripeCheckError', async () => {
    const opts = baseOpts({
      loadLedgerFailures: jest.fn(async () => ({ total: 1, rows: [ledgerRow()] })),
      stripeOpsTools: { getStripeWebhookFailures: jest.fn(async () => { throw new Error('Stripe API returned HTTP 500'); }) },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.sent).toBe(true);
    expect(result.stripeCheckError).toContain('HTTP 500');
    expect(sendgrid.sendOne.mock.calls[0][0].text).toContain('Stripe-side delivery check itself FAILED');
  });

  test('recent send marker dedupes the tick', async () => {
    const opts = baseOpts({ sentRecently: jest.fn(async () => true) });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result).toEqual({ skipped: 'recent_send' });
    expect(opts.loadLedgerFailures).not.toHaveBeenCalled();
  });

  test('non-internal recipient fails closed', async () => {
    process.env.STRIPE_WEBHOOK_HEALTH_EMAIL = 'stranger@example.com';
    const opts = baseOpts({
      loadLedgerFailures: jest.fn(async () => ({ total: 1, rows: [ledgerRow()] })),
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.skipped).toBe('recipient');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('kill switch skips the send but reports what it would have sent', async () => {
    process.env.STRIPE_WEBHOOK_HEALTH_DISABLED = '1';
    const opts = baseOpts({
      loadLedgerFailures: jest.fn(async () => ({ total: 1, rows: [ledgerRow()] })),
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.skipped).toBe('disabled');
    expect(result.count).toBe(1);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('unconfigured Stripe key skips the Stripe-side probe without failing the run', async () => {
    const probe = jest.fn();
    const opts = baseOpts({
      stripeConfigured: false,
      stripeOpsTools: { getStripeWebhookFailures: probe },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result).toEqual({ skipped: 'nothing_found' });
    expect(probe).not.toHaveBeenCalled();
  });
});
