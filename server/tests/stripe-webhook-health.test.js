/**
 * stripe-webhook-health — daily dead-letter check over stripe_webhook_events
 * plus the Stripe-side delivery probe. Contracts pinned here:
 *
 *  - nonzero ledger failures (error set OR abandoned claim, lookback
 *    window) → one FIX: email listing event types + ids + sanitized error
 *    snippets;
 *  - zero ledger failures AND Stripe-side clean → no email at all
 *    (exception-based: a quiet day is silent);
 *  - Stripe-side failures alone still email (they never reach the ledger);
 *  - Stripe-side results are reconciled against the local ledger: an event
 *    id we already hold was delivered to OUR endpoint, so its account-wide
 *    delivery_success=false flag is another integration's failure — never
 *    alerted here;
 *  - the Stripe-side probe runs on a 48h lookback — longer than the daily
 *    interval + the probe's recent-pending grace — so an event that was
 *    "too fresh to judge" at one tick still alerts at the next;
 *  - missing STRIPE_SECRET_KEY in deployed production is a BLOCKING check
 *    failure (fail closed), while dev/test/preview keeps the benign skip;
 *  - a failed ledger query / failed Stripe-side probe returns the blocking
 *    skip codes the scheduler wrapper converts into a job_health failure —
 *    the check never swallows its own breakage;
 *  - error snippets never carry emails or long digit runs (payloads are
 *    never read at all — the loader selects identifiers + error only);
 *  - the ops_email_send_state marker dedupes a deploy-overlap double tick.
 *
 * (The ledger query's in-flight-claim exclusion is pinned in
 * stripe-webhook-health-query.test.js against the compiled SQL.)
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
    loadLedgerEventIds: jest.fn(async () => new Set()),
    stripeConfigured: true,
    deployedProd: false,
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
    expect(composed.subject).toBe('FIX: 2 Stripe webhook events failed/unprocessed in last 48h');
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
    expect(composed.subject).toBe('FIX: 1 Stripe webhook delivery failure (Stripe-side) in last 48h');
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

  test('unconfigured Stripe key outside deployed prod skips the Stripe-side probe without failing the run', async () => {
    const probe = jest.fn();
    const opts = baseOpts({
      stripeConfigured: false,
      deployedProd: false,
      stripeOpsTools: { getStripeWebhookFailures: probe },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result).toEqual({ skipped: 'nothing_found' });
    expect(probe).not.toHaveBeenCalled();
  });

  test('missing STRIPE_SECRET_KEY in deployed production is a BLOCKING failure, never a benign skip', async () => {
    const probe = jest.fn();
    const opts = baseOpts({
      stripeConfigured: false,
      deployedProd: true,
      stripeOpsTools: { getStripeWebhookFailures: probe },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    // stripe_check_failed is on the scheduler wrapper's blocking list →
    // job_health failure, not nothing_found.
    expect(result.skipped).toBe('stripe_check_failed');
    expect(result.stripeCheckError).toContain('STRIPE_SECRET_KEY');
    expect(probe).not.toHaveBeenCalled();
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('missing key in deployed prod with ledger findings still emails AND surfaces the blocking stripeCheckError', async () => {
    const opts = baseOpts({
      stripeConfigured: false,
      deployedProd: true,
      loadLedgerFailures: jest.fn(async () => ({ total: 1, rows: [ledgerRow()] })),
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.sent).toBe(true);
    expect(result.stripeCheckError).toContain('STRIPE_SECRET_KEY');
    expect(sendgrid.sendOne.mock.calls[0][0].text).toContain('Stripe-side delivery check itself FAILED');
  });

  test('Stripe-side failures already present in the local ledger are foreign-endpoint failures — excluded from the alert', async () => {
    const opts = baseOpts({
      loadLedgerEventIds: jest.fn(async () => new Set(['evt_foreign_1'])),
      stripeOpsTools: {
        getStripeWebhookFailures: jest.fn(async () => ({
          undelivered_events: [
            { id: 'evt_foreign_1', type: 'invoice.paid', created: '2026-08-06T09:00:00.000Z', pending_webhooks: 1 },
            { id: 'evt_ours_dead', type: 'payout.paid', created: '2026-08-06T10:00:00.000Z', pending_webhooks: 1 },
          ],
          total_undelivered: 2,
        })),
      },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(opts.loadLedgerEventIds).toHaveBeenCalledWith(['evt_foreign_1', 'evt_ours_dead']);
    expect(result.sent).toBe(true);
    expect(result.stripeFailureCount).toBe(1);
    const mail = sendgrid.sendOne.mock.calls[0][0];
    expect(mail.text).toContain('evt_ours_dead');
    expect(mail.text).not.toContain('evt_foreign_1');
  });

  test('when EVERY Stripe-side failure reconciles to the local ledger the run is silent', async () => {
    const opts = baseOpts({
      loadLedgerEventIds: jest.fn(async () => new Set(['evt_foreign_1'])),
      stripeOpsTools: {
        getStripeWebhookFailures: jest.fn(async () => ({
          undelivered_events: [{ id: 'evt_foreign_1', type: 'invoice.paid', created: '2026-08-06T09:00:00.000Z', pending_webhooks: 1 }],
          total_undelivered: 1,
        })),
      },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result).toEqual({ skipped: 'nothing_found' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('a failed ledger-reconciliation query still alerts (unreconciled) AND surfaces the blocking stripeCheckError', async () => {
    // Fail toward alerting: if we cannot prove a failure is foreign, report
    // it — and the surfaced stripeCheckError makes the scheduler wrapper
    // throw so the broken reconciliation itself lands in job_health.
    const opts = baseOpts({
      loadLedgerEventIds: jest.fn(async () => { throw new Error('ledger lookup timed out'); }),
      stripeOpsTools: {
        getStripeWebhookFailures: jest.fn(async () => ({
          undelivered_events: [{ id: 'evt_x', type: 'payout.paid', created: '2026-08-06T09:00:00.000Z', pending_webhooks: 1 }],
          total_undelivered: 1,
        })),
      },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.sent).toBe(true);
    expect(result.stripeCheckError).toContain('ledger lookup timed out');
    const mail = sendgrid.sendOne.mock.calls[0][0];
    expect(mail.text).toContain('evt_x');
    expect(mail.text).toContain('Stripe-side delivery check itself FAILED');
  });

  test('probe runs on the 48h lookback so a pending-at-one-tick event still alerts the next day', async () => {
    // Day-2 replay of the gap: created 6:56am day 1 → recent_pending
    // (ignored) at the 7:04 tick; ~24h later it is outside a 24h window but
    // squarely inside 48h — and old enough to count as failing.
    const dayOldEvent = {
      id: 'evt_pending_exhausted',
      type: 'payment_intent.succeeded',
      created: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      pending_webhooks: 1,
    };
    const probe = jest.fn(async (input) => {
      expect(input).toEqual({ hours: 48 });
      return { undelivered_events: [dayOldEvent], total_undelivered: 1 };
    });
    const opts = baseOpts({ stripeOpsTools: { getStripeWebhookFailures: probe } });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(true);
    expect(sendgrid.sendOne.mock.calls[0][0].text).toContain('evt_pending_exhausted');
  });

  test('lookback invariant: window exceeds the daily interval plus the probe pending grace', () => {
    const { RECENT_PENDING_MINUTES } = jest.requireActual('../services/intelligence-bar/stripe-ops-tools');
    const { _private: { LOOKBACK_HOURS } } = require('../services/stripe-webhook-health');
    expect(LOOKBACK_HOURS * 60).toBeGreaterThan(24 * 60 + RECENT_PENDING_MINUTES);
  });
});
