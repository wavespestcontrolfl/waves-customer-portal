/**
 * stripe-webhook-health — daily dead-letter check over stripe_webhook_events
 * plus the Stripe-side delivery probe. Contracts pinned here:
 *
 *  - nonzero ledger failures (error set OR abandoned claim, NO time
 *    window — dead letters repeat until fixed or purged) → one FIX: email
 *    listing event types + ids;
 *  - zero ledger failures AND Stripe-side clean → no email at all
 *    (exception-based: a quiet day is silent);
 *  - Stripe-side failures alone still email (they never reach the ledger);
 *  - a broken CHECK with a quiet ledger also emails (job_health has no
 *    automatic notifier — the digest is the only operator rail that says
 *    Stripe-side delivery status is UNKNOWN) and still surfaces the
 *    blocking stripeCheckError;
 *  - Stripe-side results are reconciled against the local ledger: an event
 *    id we already hold was delivered to OUR endpoint, so its account-wide
 *    delivery_success=false flag is another integration's failure — never
 *    alerted here; ids that survive reconciliation are reported as
 *    POSSIBLE failures (ledger absence can also mean the event type is
 *    routed only to another endpoint), never confirmed ones;
 *  - a probe scan that hit its page cap (scan_exhaustive=false) is an
 *    INCOMPLETE check → blocking, never a silent healthy pass;
 *  - the Stripe-side probe runs on a 48h lookback — longer than the daily
 *    interval + the probe's recent-pending grace — so an event that was
 *    "too fresh to judge" at one tick still alerts at the next;
 *  - missing STRIPE_SECRET_KEY in deployed production is a BLOCKING check
 *    failure (fail closed), while dev/test/preview keeps the benign skip;
 *  - a failed ledger query returns the blocking query_failed skip; a failed
 *    Stripe-side probe emails AND carries stripeCheckError so the scheduler
 *    wrapper converts it into a job_health failure — the check never
 *    swallows its own breakage;
 *  - stored error TEXT never appears in the email at all — arbitrary prose
 *    (Knex SQL prefixes, provider echoes) cannot be made PII-safe by
 *    pattern scrubbing, so the digest carries fixed generic descriptions +
 *    identifiers only, and a thrown check error reaches the email as a
 *    generic line + allowlisted token, never raw err.message;
 *  - the ops_email_send_state marker dedupes a deploy-overlap double tick's
 *    SEND only — the checks still run first, so a deduped tick surfaces
 *    stripeCheckError to job_health instead of masking a broken check.
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
  _private: { composeWebhookHealthDigest },
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

  test('FIX subject carries the ledger count; body lists id + type but WITHHOLDS the stored error text', () => {
    const composed = composeWebhookHealthDigest({
      ledger: { total: 2, rows: [ledgerRow(), ledgerRow({ id: 'evt_dead_2', event_type: 'charge.refunded', error: null })] },
      stripeSide: null,
      stripeCheckError: null,
    });
    expect(composed.subject).toBe('FIX: 2 unresolved Stripe webhook events failed/unprocessed');
    expect(composed.text).toContain('evt_dead_1 (payment_intent.succeeded)');
    expect(composed.text).toContain('error recorded (text withheld');
    expect(composed.text).not.toContain('relation locked');
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
    expect(composed.subject).toBe('FIX: 1 possible Stripe webhook delivery failure (Stripe-side) in last 48h');
    expect(composed.text).toContain('Possible Stripe-side delivery failures');
    expect(composed.text).toContain('evt_side_1 (payout.paid)');
    expect(composed.stripeFailureCount).toBe(1);
  });

  test('stored error text never reaches the email — not even in scrubber-proof forms', () => {
    // Synthetic fixture only. Includes PII shapes a scrub regex CANNOT
    // recognize (unquoted name, street address) alongside quoted
    // literals/emails/phones — the contract is that NONE of the stored
    // error text survives into the digest.
    const composed = composeWebhookHealthDigest({
      ledger: {
        total: 1,
        rows: [ledgerRow({ error: "insert into \"invoices\" values ('Jane Q Fixture') - duplicate key; customer Jane Q Fixture at 123 Palmetto Fixture Ln, +19415551234, jane.doe@example.com, charged $36.33" })],
      },
      stripeSide: null,
      stripeCheckError: null,
    });
    expect(composed.text).not.toContain('Jane Q Fixture');
    expect(composed.text).not.toContain('Palmetto Fixture');
    expect(composed.text).not.toContain('9415551234');
    expect(composed.text).not.toContain('jane.doe@example.com');
    expect(composed.text).not.toContain('36.33');
    expect(composed.text).toContain('error recorded (text withheld');
    expect(composed.html).not.toContain('Jane Q Fixture');
  });

  test('beyond-cap unreconciled remainder is reported as POSSIBLE failures, never as confirmed endpoint failures', () => {
    const composed = composeWebhookHealthDigest({
      ledger: { total: 0, rows: [] },
      stripeSide: { undelivered_events: [], total_undelivered: 0, unreconciled_undelivered: 48 },
      stripeCheckError: null,
    });
    expect(composed.subject).toBe('FIX: 48 possible Stripe webhook delivery failures (Stripe-side, unreconciled) in last 48h');
    expect(composed.stripeFailureCount).toBe(0);
    expect(composed.stripeUnreconciledCount).toBe(48);
    expect(composed.text).toContain('could NOT be reconciled');
    expect(composed.text).toContain('possible failures only');
  });

  test('a broken check with everything else quiet still composes a FIX email (status UNKNOWN, never silent)', () => {
    const composed = composeWebhookHealthDigest({
      ledger: { total: 0, rows: [] },
      stripeSide: null,
      stripeCheckError: 'STRIPE_SECRET_KEY is not set in deployed production — Stripe-side delivery check cannot run',
    });
    expect(composed.subject).toBe('FIX: Stripe webhook delivery check FAILED — Stripe-side status unknown');
    expect(composed.text).toContain('Stripe-side delivery status is UNKNOWN');
    expect(composed.text).toContain('Stripe-side delivery check itself FAILED');
    expect(composed.text).toContain('STRIPE_SECRET_KEY');
    expect(composed.count).toBe(0);
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

  test('failed Stripe-side probe with a quiet ledger EMAILS (status unknown) and still surfaces the blocking stripeCheckError', async () => {
    // job_health has no automatic notifier — if this only failed job_health
    // the operator would never learn the check broke.
    const opts = baseOpts({
      stripeOpsTools: { getStripeWebhookFailures: jest.fn(async () => { throw new Error('Stripe API timed out after 15s'); }) },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.sent).toBe(true);
    expect(result.stripeCheckError).toContain('timed out');
    const mail = sendgrid.sendOne.mock.calls[0][0];
    expect(mail.subject).toBe('FIX: Stripe webhook delivery check FAILED — Stripe-side status unknown');
    expect(mail.text).toContain('Stripe-side delivery status is UNKNOWN');
    // The thrown error's arbitrary prose stays OUT of the email — generic
    // line only (full text lives on the result → job_health → logs).
    expect(mail.text).not.toContain('timed out');
    expect(mail.text).toContain('threw an unexpected error');
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

  test('recent send marker dedupes the SEND but the checks still run and findings surface', async () => {
    const opts = baseOpts({
      sentRecently: jest.fn(async () => true),
      loadLedgerFailures: jest.fn(async () => ({ total: 1, rows: [ledgerRow()] })),
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.skipped).toBe('recent_send');
    expect(result.count).toBe(1);
    expect(opts.loadLedgerFailures).toHaveBeenCalledTimes(1);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(opts.stampSendMarker).not.toHaveBeenCalled();
  });

  test('a deduped rerun after a partial run still surfaces stripeCheckError — recent_send never masks a broken check', async () => {
    // The partial run emailed the ledger alert but the Stripe-side probe
    // failed; a deploy-overlap rerun within 20h must NOT report a healthy
    // recent_send that overwrites the failed job_health state.
    const opts = baseOpts({
      sentRecently: jest.fn(async () => true),
      loadLedgerFailures: jest.fn(async () => ({ total: 1, rows: [ledgerRow()] })),
      stripeOpsTools: { getStripeWebhookFailures: jest.fn(async () => { throw new Error('Stripe API returned HTTP 500'); }) },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.skipped).toBe('recent_send');
    expect(result.stripeCheckError).toContain('HTTP 500');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('a capped (non-exhaustive) Stripe scan with nothing found EMAILS and blocks — never a silent pass', async () => {
    const opts = baseOpts({
      stripeOpsTools: {
        getStripeWebhookFailures: jest.fn(async () => ({ undelivered_events: [], total_undelivered: 0, scan_exhaustive: false })),
      },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.sent).toBe(true);
    expect(result.stripeCheckError).toContain('scan cap');
    expect(sendgrid.sendOne.mock.calls[0][0].text).toContain('scan cap');
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

  test('missing STRIPE_SECRET_KEY in deployed production EMAILS and blocks — never a benign skip', async () => {
    const probe = jest.fn();
    const opts = baseOpts({
      stripeConfigured: false,
      deployedProd: true,
      stripeOpsTools: { getStripeWebhookFailures: probe },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    // stripeCheckError on the result is the scheduler wrapper's blocking
    // signal → job_health failure; the email is the operator notification
    // (job_health has none of its own).
    expect(result.sent).toBe(true);
    expect(result.stripeCheckError).toContain('STRIPE_SECRET_KEY');
    expect(probe).not.toHaveBeenCalled();
    const mail = sendgrid.sendOne.mock.calls[0][0];
    expect(mail.subject).toBe('FIX: Stripe webhook delivery check FAILED — Stripe-side status unknown');
    expect(mail.text).toContain('STRIPE_SECRET_KEY');
  });

  test('a deduped tick with ONLY a broken check still surfaces stripeCheckError (recent_send never masks it)', async () => {
    const opts = baseOpts({
      sentRecently: jest.fn(async () => true),
      stripeOpsTools: { getStripeWebhookFailures: jest.fn(async () => { throw new Error('Stripe API timed out after 15s'); }) },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.skipped).toBe('recent_send');
    expect(result.stripeCheckError).toContain('timed out');
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

  test('beyond-cap remainder survives reconciliation as unreconciled instead of masquerading as confirmed failures', async () => {
    // Probe saw 50 failures but capped the list at 2; both displayed ids
    // reconcile to the local ledger (another endpoint's outage). The other
    // 48 could not be checked — they must alert as UNRECONCILED possible
    // failures, with zero confirmed ones and no foreign ids listed.
    const opts = baseOpts({
      loadLedgerEventIds: jest.fn(async () => new Set(['evt_foreign_1', 'evt_foreign_2'])),
      stripeOpsTools: {
        getStripeWebhookFailures: jest.fn(async () => ({
          undelivered_events: [
            { id: 'evt_foreign_1', type: 'invoice.paid', created: '2026-08-06T09:00:00.000Z', pending_webhooks: 1 },
            { id: 'evt_foreign_2', type: 'invoice.paid', created: '2026-08-06T09:01:00.000Z', pending_webhooks: 1 },
          ],
          total_undelivered: 50,
        })),
      },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.sent).toBe(true);
    expect(result.stripeFailureCount).toBe(0);
    expect(result.stripeUnreconciledCount).toBe(48);
    const mail = sendgrid.sendOne.mock.calls[0][0];
    expect(mail.subject).toContain('possible');
    expect(mail.subject).toContain('unreconciled');
    expect(mail.text).not.toContain('evt_foreign_1');
    expect(mail.text).toContain('could NOT be reconciled');
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
