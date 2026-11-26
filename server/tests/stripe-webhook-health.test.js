/**
 * stripe-webhook-health — daily dead-letter check over stripe_webhook_events
 * plus the Stripe-side delivery probe. Contracts pinned here:
 *
 *  - nonzero ledger failures (error set OR abandoned claim, NO time
 *    window — dead letters stay on the alert until fixed or purged) → one
 *    Billing admin alert whose detail lists event types + ids;
 *  - zero ledger failures AND Stripe-side clean → nothing raised
 *    (exception-based: a quiet day is silent) and a standing row is closed;
 *  - Stripe-side failures alone still raise (they never reach the ledger);
 *  - a broken CHECK with a quiet ledger also raises (job_health has no
 *    automatic notifier — the row is the only operator rail that says
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
 *  - a failed ledger query or Stripe-side probe RAISES (status unknown)
 *    AND carries ledgerCheckError/stripeCheckError so the scheduler
 *    wrapper converts it into a job_health failure — the check never
 *    swallows its own breakage, and job_health alone is never the only
 *    signal (it has no automatic notifier);
 *  - stored error TEXT never appears in the alert at all — arbitrary prose
 *    (Knex SQL prefixes, provider echoes) cannot be made PII-safe by
 *    pattern scrubbing, so the alert carries fixed generic descriptions +
 *    identifiers only, and a thrown check error reaches it as a generic
 *    line + allowlisted token, never raw err.message;
 *  - every composed alert passes the admin-notification copy rules, and one
 *    standing problem rings once: a refresh rings only when a new event or
 *    a newly broken check joins the set.
 *
 * (The ledger query's in-flight-claim exclusion is pinned in
 * stripe-webhook-health-query.test.js against the compiled SQL.)
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  // Loaders and the alert writer are injected; the db is never touched.
  const qb = () => { throw new Error('db must not be touched when loaders are injected'); };
  qb.raw = () => { throw new Error('db.raw must not be touched when loaders are injected'); };
  return qb;
});

const { composeAdminAlert } = require('../services/admin-alert-compose');
const {
  runStripeWebhookHealthCheck,
  _private: { composeWebhookHealthAlert, ringOnNewItem },
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
    raiseAlert: jest.fn(async () => ({ id: 'n1', deduped: false, rang: true })),
    clearAlert: jest.fn(async () => 0),
    loadLedgerFailures: jest.fn(async () => ({ total: 0, rows: [] })),
    loadLedgerEventIds: jest.fn(async () => new Set()),
    stripeConfigured: true,
    deployedProd: false,
    stripeOpsTools: { getStripeWebhookFailures: jest.fn(async () => ({ undelivered_events: [], total_undelivered: 0 })) },
    ...overrides,
  };
}

// The spec every raise carries, read back from the injected writer.
const raised = (opts) => opts.raiseAlert.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.STRIPE_WEBHOOK_HEALTH_DISABLED;
});

describe('composeWebhookHealthAlert', () => {
  test('clean ledger + clean Stripe side composes nothing (quiet day)', () => {
    expect(composeWebhookHealthAlert({
      ledger: { total: 0, rows: [] },
      stripeSide: { undelivered_events: [], total_undelivered: 0 },
      stripeCheckError: null,
    })).toBeNull();
  });

  test('ledger failures: headline carries the count; detail lists id + type but WITHHOLDS the stored error text', () => {
    const composed = composeWebhookHealthAlert({
      ledger: { total: 2, rows: [ledgerRow(), ledgerRow({ id: 'evt_dead_2', event_type: 'charge.refunded', error: null })] },
      stripeSide: null,
      stripeCheckError: null,
    });
    expect(composeAdminAlert(composed.spec).headline).toBe('Billing — check 2 stuck Stripe events');
    expect(composed.detail).toContain('evt_dead_1 (payment_intent.succeeded)');
    expect(composed.detail).toContain('error recorded (text withheld');
    expect(composed.detail).not.toContain('relation locked');
    expect(composed.detail).toContain('evt_dead_2 (charge.refunded)');
    expect(composed.detail).toContain('unprocessed (no error recorded');
    expect(composed.count).toBe(2);
    expect(composed.itemKeys).toEqual(['evt_dead_1', 'evt_dead_2']);
  });

  test('Stripe-side-only failures still compose an alert', () => {
    const composed = composeWebhookHealthAlert({
      ledger: { total: 0, rows: [] },
      stripeSide: {
        undelivered_events: [{ id: 'evt_side_1', type: 'payout.paid', created: '2026-08-07T09:00:00.000Z', pending_webhooks: 1 }],
        total_undelivered: 1,
      },
      stripeCheckError: null,
    });
    expect(composeAdminAlert(composed.spec).headline).toBe('Billing — check 1 Stripe event we may have missed');
    expect(composed.detail).toContain('Possible Stripe-side delivery failures');
    expect(composed.detail).toContain('evt_side_1 (payout.paid)');
    expect(composed.stripeFailureCount).toBe(1);
  });

  test('stored error text never reaches the alert — not even in scrubber-proof forms', () => {
    // Synthetic fixture only. Includes PII shapes a scrub regex CANNOT
    // recognize (unquoted name, street address) alongside quoted
    // literals/emails/phones — the contract is that NONE of the stored
    // error text survives into the alert.
    const composed = composeWebhookHealthAlert({
      ledger: {
        total: 1,
        rows: [ledgerRow({ error: "insert into \"invoices\" values ('Jane Q Fixture') - duplicate key; customer Jane Q Fixture at 123 Palmetto Fixture Ln, +19415551234, jane.doe@example.com, charged $36.33" })],
      },
      stripeSide: null,
      stripeCheckError: null,
    });
    const everything = JSON.stringify(composed);
    for (const leak of ['Jane Q Fixture', 'Palmetto Fixture', '9415551234', 'jane.doe@example.com', '36.33']) {
      expect(everything).not.toContain(leak);
    }
    expect(composed.detail).toContain('error recorded (text withheld');
  });

  test('beyond-cap unreconciled remainder is reported as POSSIBLE failures, never as confirmed endpoint failures', () => {
    const composed = composeWebhookHealthAlert({
      ledger: { total: 0, rows: [] },
      stripeSide: { undelivered_events: [], total_undelivered: 0, unreconciled_undelivered: 48 },
      stripeCheckError: null,
    });
    expect(composeAdminAlert(composed.spec).headline).toBe('Billing — check 48 Stripe events we may have missed');
    expect(composed.stripeFailureCount).toBe(0);
    expect(composed.stripeUnreconciledCount).toBe(48);
    expect(composed.detail).toContain('could NOT be reconciled');
    expect(composed.detail).toContain('possible failures only');
  });

  test('a broken check with everything else quiet still composes an alert (status UNKNOWN, never silent)', () => {
    const composed = composeWebhookHealthAlert({
      ledger: { total: 0, rows: [] },
      stripeSide: null,
      stripeCheckError: 'STRIPE_SECRET_KEY is not set in deployed production — Stripe-side delivery check cannot run',
    });
    const alert = composeAdminAlert(composed.spec);
    expect(alert.headline).toBe('Billing — fix the daily Stripe webhook check');
    expect(alert.link).toBe('/admin/settings?tab=integrations');
    expect(composed.detail).toContain('Stripe-side delivery status is UNKNOWN');
    expect(composed.detail).toContain('Stripe-side delivery check itself FAILED');
    expect(composed.detail).toContain('STRIPE_SECRET_KEY');
    expect(composed.count).toBe(0);
    expect(composed.itemKeys).toEqual(['check:stripe']);
  });

  test('every composition shape passes the admin-notification copy rules', () => {
    const shapes = [
      { ledger: { total: 40, rows: [ledgerRow()] }, stripeSide: { undelivered_events: [], total_undelivered: 0, unreconciled_undelivered: 12 } },
      { ledger: { total: 1, rows: [ledgerRow()] }, ledgerCheckError: 'the ledger health query threw an unexpected error' },
      { ledger: { total: 0, rows: [] }, ledgerCheckError: 'the ledger health query threw an unexpected error' },
    ];
    for (const shape of shapes) expect(() => composeAdminAlert(composeWebhookHealthAlert(shape).spec)).not.toThrow();
  });
});

describe('ringOnNewItem', () => {
  const rings = (composed, prior) => ringOnNewItem(composed)(null, prior);

  test('the same standing set stays quiet; a new event or a bigger total rings', () => {
    const prior = { itemKeys: ['evt_a', 'evt_b'], count: 2 };
    expect(rings({ itemKeys: ['evt_a', 'evt_b'], total: 2 }, prior)).toBe(false);
    expect(rings({ itemKeys: ['evt_a'], total: 1 }, prior)).toBe(false);
    expect(rings({ itemKeys: ['evt_a', 'evt_b', 'evt_c'], total: 3 }, prior)).toBe(true);
    expect(rings({ itemKeys: ['evt_a', 'evt_b'], total: 30 }, prior)).toBe(true);
    expect(rings({ itemKeys: ['check:stripe'], total: 0 }, prior)).toBe(true);
  });
});

describe('runStripeWebhookHealthCheck', () => {
  test('raises one Billing alert on nonzero ledger count', async () => {
    const opts = baseOpts({
      loadLedgerFailures: jest.fn(async () => ({ total: 1, rows: [ledgerRow()] })),
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result).toMatchObject({ raised: true, outcome: 'raised', count: 1 });
    expect(opts.raiseAlert).toHaveBeenCalledTimes(1);
    const { spec, detail, itemKeys, total } = raised(opts);
    expect(spec).toMatchObject({ area: 'Billing', severity: 'needs-you', subject: { type: 'check', id: 'stripe-webhook-health' }, doneWhen: 'count_zero' });
    expect(detail).toContain('evt_dead_1');
    expect(itemKeys).toEqual(['evt_dead_1']);
    expect(total).toBe(1);
    expect(opts.clearAlert).not.toHaveBeenCalled();
  });

  test('a standing problem that did not ring is reported as unchanged, not as a new alert', async () => {
    const opts = baseOpts({
      raiseAlert: jest.fn(async () => ({ id: 'n1', deduped: true, rang: false })),
      loadLedgerFailures: jest.fn(async () => ({ total: 1, rows: [ledgerRow()] })),
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result).toMatchObject({ raised: true, outcome: 'unchanged', count: 1 });
  });

  test('silent when ledger and Stripe side are both clean, and closes a standing alert', async () => {
    const opts = baseOpts();
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result).toEqual({ skipped: 'nothing_found' });
    expect(opts.raiseAlert).not.toHaveBeenCalled();
    expect(opts.clearAlert).toHaveBeenCalledTimes(1);
  });

  test('a failure to close the standing alert never fails the check', async () => {
    const opts = baseOpts({ clearAlert: jest.fn(async () => { throw new Error('db down'); }) });
    expect(await runStripeWebhookHealthCheck(opts)).toEqual({ skipped: 'nothing_found' });
  });

  test('ledger query throw RAISES (status unknown) and surfaces the blocking ledgerCheckError', async () => {
    const opts = baseOpts({
      loadLedgerFailures: jest.fn(async () => { throw new Error('relation vanished near Jane Q Fixture'); }),
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.raised).toBe(true);
    expect(result.ledgerCheckError).toContain('relation vanished');
    const { spec, detail } = raised(opts);
    expect(composeAdminAlert(spec).headline).toBe('Billing — fix the daily Stripe webhook check');
    expect(detail).toContain('LEDGER health query itself FAILED');
    expect(detail).toContain('webhook health status is UNKNOWN');
    // The thrown error's arbitrary prose stays OUT of the alert.
    expect(detail).not.toContain('relation vanished');
    expect(JSON.stringify(raised(opts))).not.toContain('Jane Q Fixture');
  });

  test('failed Stripe-side probe with a quiet ledger RAISES (status unknown) and still surfaces the blocking stripeCheckError', async () => {
    // job_health has no automatic notifier — if this only failed job_health
    // the operator would never learn the check broke.
    const opts = baseOpts({
      stripeOpsTools: { getStripeWebhookFailures: jest.fn(async () => { throw new Error('Stripe API timed out after 15s'); }) },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.raised).toBe(true);
    expect(result.stripeCheckError).toContain('timed out');
    const { spec, detail } = raised(opts);
    expect(composeAdminAlert(spec).headline).toBe('Billing — fix the daily Stripe webhook check');
    expect(detail).toContain('Stripe-side delivery status is UNKNOWN');
    // The thrown error's arbitrary prose stays OUT of the alert — generic
    // line only (full text lives on the result → job_health → logs).
    expect(detail).not.toContain('timed out');
    expect(detail).toContain('threw an unexpected error');
  });

  test('failed Stripe-side probe with ledger findings still raises AND surfaces stripeCheckError', async () => {
    const opts = baseOpts({
      loadLedgerFailures: jest.fn(async () => ({ total: 1, rows: [ledgerRow()] })),
      stripeOpsTools: { getStripeWebhookFailures: jest.fn(async () => { throw new Error('Stripe API returned HTTP 500'); }) },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.raised).toBe(true);
    expect(result.stripeCheckError).toContain('HTTP 500');
    expect(raised(opts).detail).toContain('Stripe-side delivery check itself FAILED');
  });

  test('a capped (non-exhaustive) Stripe scan with nothing found RAISES and blocks — never a silent pass', async () => {
    const opts = baseOpts({
      stripeOpsTools: {
        getStripeWebhookFailures: jest.fn(async () => ({ undelivered_events: [], total_undelivered: 0, scan_exhaustive: false })),
      },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.raised).toBe(true);
    expect(result.stripeCheckError).toContain('scan cap');
    expect(raised(opts).detail).toContain('scan cap');
  });

  test('a raise that throws reports error (the scheduler wrapper fails the run) and keeps the findings', async () => {
    const opts = baseOpts({
      raiseAlert: jest.fn(async () => { throw new Error('write failed'); }),
      loadLedgerFailures: jest.fn(async () => ({ total: 1, rows: [ledgerRow()] })),
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result).toMatchObject({ raised: false, error: true, count: 1 });
  });

  test('a write the alert writer swallowed (null) reports error, not raised', async () => {
    const opts = baseOpts({
      raiseAlert: jest.fn(async () => ({ rang: true })),
      loadLedgerFailures: jest.fn(async () => ({ total: 1, rows: [ledgerRow()] })),
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result).toMatchObject({ raised: false, error: true, count: 1 });
  });

  test('a long ledger backlog never cuts the note that says a check broke', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ledgerRow({ id: `evt_dead_${i}`, event_type: `payment_intent.succeeded.${'x'.repeat(150)}` }));
    const opts = baseOpts({
      loadLedgerFailures: jest.fn(async () => ({ total: 40, rows })),
      stripeOpsTools: { getStripeWebhookFailures: jest.fn(async () => { throw new Error('Stripe API returned HTTP 500'); }) },
    });
    await runStripeWebhookHealthCheck(opts);
    const { detail } = raised(opts);
    expect(detail).toContain('Stripe-side delivery check itself FAILED');
    expect(detail).toMatch(/Summary: 40 unresolved ledger events/);
  });

  test('kill switch raises nothing but reports what it would have raised', async () => {
    process.env.STRIPE_WEBHOOK_HEALTH_DISABLED = '1';
    const opts = baseOpts({
      loadLedgerFailures: jest.fn(async () => ({ total: 1, rows: [ledgerRow()] })),
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.skipped).toBe('disabled');
    expect(result.count).toBe(1);
    expect(opts.raiseAlert).not.toHaveBeenCalled();
    expect(opts.clearAlert).not.toHaveBeenCalled();
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

  test('missing STRIPE_SECRET_KEY in deployed production RAISES and blocks — never a benign skip', async () => {
    const probe = jest.fn();
    const opts = baseOpts({
      stripeConfigured: false,
      deployedProd: true,
      stripeOpsTools: { getStripeWebhookFailures: probe },
    });
    const result = await runStripeWebhookHealthCheck(opts);
    // stripeCheckError on the result is the scheduler wrapper's blocking
    // signal → job_health failure; the alert is the operator notification
    // (job_health has none of its own).
    expect(result.raised).toBe(true);
    expect(result.stripeCheckError).toContain('STRIPE_SECRET_KEY');
    expect(probe).not.toHaveBeenCalled();
    expect(composeAdminAlert(raised(opts).spec).headline).toBe('Billing — fix the daily Stripe webhook check');
    expect(raised(opts).detail).toContain('STRIPE_SECRET_KEY');
  });

  test('missing key in deployed prod with ledger findings still raises AND surfaces the blocking stripeCheckError', async () => {
    const opts = baseOpts({
      stripeConfigured: false,
      deployedProd: true,
      loadLedgerFailures: jest.fn(async () => ({ total: 1, rows: [ledgerRow()] })),
    });
    const result = await runStripeWebhookHealthCheck(opts);
    expect(result.raised).toBe(true);
    expect(result.stripeCheckError).toContain('STRIPE_SECRET_KEY');
    expect(raised(opts).detail).toContain('Stripe-side delivery check itself FAILED');
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
    expect(result.raised).toBe(true);
    expect(result.stripeFailureCount).toBe(1);
    expect(raised(opts).detail).toContain('evt_ours_dead');
    expect(raised(opts).detail).not.toContain('evt_foreign_1');
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
    expect(opts.raiseAlert).not.toHaveBeenCalled();
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
    expect(result.raised).toBe(true);
    expect(result.stripeFailureCount).toBe(0);
    expect(result.stripeUnreconciledCount).toBe(48);
    expect(composeAdminAlert(raised(opts).spec).headline).toContain('we may have missed');
    expect(raised(opts).detail).not.toContain('evt_foreign_1');
    expect(raised(opts).detail).toContain('could NOT be reconciled');
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
    expect(result.raised).toBe(true);
    expect(result.stripeCheckError).toContain('ledger lookup timed out');
    expect(raised(opts).detail).toContain('Stripe-side delivery check itself FAILED');
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
    expect(result.raised).toBe(true);
    expect(raised(opts).detail).toContain('evt_pending_exhausted');
  });

  test('lookback invariant: window exceeds the daily interval plus the probe pending grace', () => {
    const { RECENT_PENDING_MINUTES } = jest.requireActual('../services/intelligence-bar/stripe-ops-tools');
    const { _private: { LOOKBACK_HOURS } } = require('../services/stripe-webhook-health');
    expect(LOOKBACK_HOURS * 60).toBeGreaterThan(24 * 60 + RECENT_PENDING_MINUTES);
  });
});
