'use strict';

// Daily owner exception alert: Stripe webhook events the app failed to apply.
//
// The `stripe_webhook_events` ledger is the idempotency spine of the payment
// pipeline: handler failures write `error` and lean on Stripe's ~72h retry
// window; rows Stripe gave up on (error set / processed=false) are a de facto
// dead-letter that NOTHING sweeps — and the 3:30am purge deletes rows older
// than 90 days, so a dead event eventually vanishes with zero operator
// signal (2026-08-07 infra audit). Winston is console-only, so Railway's
// rotating logs are the only other trace. This watcher closes the loop: any
// UNRESOLVED ledger row with `error` set — or unprocessed with an ABANDONED
// claim (older than the webhook route's stale-claim window; a fresh claim is
// a live worker mid-handler, not a failure) — lands in one
// admin bell row, alongside Stripe-side delivery failures from the
// existing get_stripe_webhook_failures probe. Stripe's delivery_success
// filter is ACCOUNT-wide, so the probe's results are reconciled against the
// local ledger: an event present in our ledger WAS delivered to this
// endpoint — its failure belongs to some other integration's endpoint and
// is excluded. Absence from the ledger is NOT proof this endpoint missed
// the event (the event type may be routed only to another endpoint — the
// events API offers no per-endpoint scoping), so everything that survives
// reconciliation is reported as a POSSIBLE failure to verify in the Stripe
// dashboard, never asserted as a confirmed failure of this endpoint.
//
// Delivery (docs/admin-notifications.md; owner 2026-11-26, "shouldn't these
// all be admin notifications now"): ONE standing Billing row, dedupeKey
// 'stripe-webhook-health', raised through raiseAdminAlertWithReopen. A
// stuck webhook event means payment state diverged from Stripe and needs a
// repair/replay decision before the retry window (or the 90d purge) erases
// it. The row rings when it first appears and again only when a new event
// (or a new broken check) joins the set; an unchanged problem refreshes
// quietly, so one standing problem never rings every day. A clean run closes
// it (count_zero); a person's Done on a still-standing problem stays done.
//
// PII: Stripe event ids (evt_…) and event types are identifiers, not PII,
// and live in the row's `detail`. The ledger's `payload` column is NEVER
// read here, and stored error TEXT never leaves the process at all — no
// scrub regex can recognize every PII form (unquoted names, street
// addresses), so the alert carries fixed generic descriptions plus
// allowlisted identifiers only; the operator reads the raw error on the
// ledger row or in Railway logs.
//
// Exception-based: a quiet day writes nothing. Live by default with a
// kill switch (STRIPE_WEBHOOK_HEALTH_DISABLED=1). Cron: daily 7:04am ET in
// scheduler.js, inside runExclusive; a failed check must surface as a
// job_health failure (the scheduler wrapper throws on the blocking skip
// codes and on stripeCheckError) AND as the bell row — job_health has no
// automatic notifier, so the row is the operator-visible rail even when
// the only finding is that the check itself broke.

const logger = require('./logger');
const db = require('../models/db');
const { composeAdminAlert } = require('./admin-alert-compose');
// Same constant the webhook route's claim logic uses — a processed=false /
// error=null row younger than this is an in-flight claim, not a failure.
const { STALE_CLAIM_WINDOW_MS } = require('../routes/stripe-webhook-helpers');
const { isDeployedProduction } = require('../utils/railway-deployment');
const { safeErrorToken } = require('../utils/sentry-scrub');

const watcherDisabled = () => ['1', 'true', 'on']
  .includes(String(process.env.STRIPE_WEBHOOK_HEALTH_DISABLED || '').toLowerCase());

// Lookback for the STRIPE-SIDE probe only — it must exceed the daily
// schedule interval PLUS the probe's ~10min recent-pending grace: at 24h an
// event created minutes before one 7:04am tick was classified pending
// (ignored) and by the next tick had aged OUT of the window — it never
// alerted. 48h closes that gap. The LEDGER query is deliberately UNWINDOWED:
// a dead letter's received_at never refreshes once Stripe stops retrying, so
// any rolling window would age a still-unprocessed row out of the alert
// while it silently waits for the 90-day purge — unresolved rows must stay
// on the alert until fixed (a successful Stripe replay re-claims the same
// row id and clears error/processed, which is what removes it).
const LOOKBACK_HOURS = 48;
const MAX_ROWS = 25;
const DEDUPE_KEY = 'stripe-webhook-health';
const DETAIL_MAX_CHARS = 2000;

// Ledger rows the app failed to apply: `error` recorded by the handler catch,
// OR unprocessed with an ABANDONED claim. An error-free processed=false row
// younger than STALE_CLAIM_WINDOW_MS is a live worker mid-handler (the route
// uses received_at as the claim lease and bumps it on re-claim) — reporting
// it would flag routine in-flight deliveries as failures. NO lower time
// bound (see the LOOKBACK_HOURS comment): a dead letter must stay in the
// alert until it is fixed or the 90-day purge takes it. Real Date objects
// against the timestamptz column (waves-db §2: never a naive ISO string).
function ledgerCutoffs(now = Date.now()) {
  return {
    staleCutoff: new Date(now - STALE_CLAIM_WINDOW_MS),
  };
}

function failedEventsQuery(staleCutoff) {
  return db('stripe_webhook_events')
    .where(function whereFailedOrAbandoned() {
      this.whereNotNull('error').orWhere(function whereAbandonedClaim() {
        this.where('processed', false)
          .whereNull('error')
          .where('received_at', '<', staleCutoff);
      });
    });
}

async function loadLedgerFailures() {
  const { staleCutoff } = ledgerCutoffs();
  const [{ count }] = await failedEventsQuery(staleCutoff).count('id as count');
  const total = Number(count) || 0;
  if (total === 0) return { total: 0, rows: [] };
  const rows = await failedEventsQuery(staleCutoff)
    // `payload` is deliberately never selected — it carries customer data.
    .select('id', 'event_type', 'error', 'processed', 'received_at')
    .orderBy('received_at', 'desc')
    .limit(MAX_ROWS);
  return { total, rows };
}

// Which of these Stripe event ids does OUR ledger already know? A ledger row
// is written on receipt, so presence means the event WAS delivered to this
// endpoint — a delivery_success=false flag on it comes from some OTHER
// webhook endpoint on the account (the /v1/events filter is account-wide and
// this Stripe API version offers no per-endpoint scoping). Local application
// failures on those events are already the ledger section's job. The
// converse does NOT hold: an id absent from the ledger may be undelivered
// to us OR routed only to another endpoint's subscription — absence is a
// "possible failure" signal, never a confirmed one.
async function loadLedgerEventIds(ids) {
  if (!ids.length) return new Set();
  const rows = await db('stripe_webhook_events').whereIn('id', ids).select('id');
  return new Set(rows.map((row) => row.id));
}

// The stored error TEXT is deliberately withheld from the alert: it is
// arbitrary prose (Knex SQL prefixes, provider echoes) that no pattern
// scrub can make PII-safe (codex on #3268). Identifiers only; the operator
// reads the raw error on the ledger row or in Railway logs.
function describeLedgerRow(row) {
  const received = new Date(row.received_at).toISOString();
  const state = row.error
    ? 'error recorded (text withheld — may contain customer data; read it on the stripe_webhook_events row or in Railway logs)'
    : 'unprocessed (no error recorded — claim abandoned past the stale window)';
  return `${row.id} (${row.event_type}) received ${received} — ${state}`;
}

function describeStripeSideEvent(evt) {
  return `${evt.id} (${evt.type}) created ${evt.created} — ${evt.pending_webhooks} pending webhook(s)`;
}

const plural = (n) => (n === 1 ? '' : 's');

// Pure composition: null = nothing worth an alert (the common, quiet case).
// A set stripeCheckError alone IS worth an alert: job_health has no
// automatic notifier, so if the check itself broke (missing prod key,
// thrown probe, capped scan) and the ledger was quiet, this row is the
// only rail that tells the operator Stripe-side delivery status is UNKNOWN.
// `stripeCheckError` / `ledgerCheckError` here must be ALERT-SAFE text —
// the caller passes its own fixed messages verbatim and replaces a thrown
// error's arbitrary prose with a generic line + allowlisted token (never
// raw err.message).
function composeWebhookHealthAlert({ ledger, stripeSide, stripeCheckError, ledgerCheckError }) {
  const ledgerTotal = ledger?.total || 0;
  const ledgerRows = ledger?.rows || [];
  const stripeEvents = stripeSide?.undelivered_events || [];
  const stripeTotal = stripeSide?.total_undelivered || 0;
  // Beyond-cap remainder the ledger reconciliation could not verify — a
  // POSSIBLE failure needing manual verification, never a confirmed one.
  const stripeUnreconciled = stripeSide?.unreconciled_undelivered || 0;
  if (ledgerTotal === 0 && stripeTotal === 0 && stripeUnreconciled === 0
    && !stripeCheckError && !ledgerCheckError) return null;

  const stripeCombined = stripeTotal + stripeUnreconciled;
  let action;
  let why;
  if (ledgerTotal > 0) {
    action = `check ${ledgerTotal} stuck Stripe event${plural(ledgerTotal)}`;
    why = `Stripe changes were never applied, so payments may not match Stripe${stripeCombined > 0 ? `; ${stripeCombined} more may be undelivered` : ''}.`;
  } else if (stripeCombined > 0) {
    action = `check ${stripeCombined} Stripe event${plural(stripeCombined)} we may have missed`;
    why = 'Stripe flagged them undelivered and our records do not show them; the dashboard tells which are ours.';
  } else {
    action = 'fix the daily Stripe webhook check';
    why = 'The check could not finish, so Stripe delivery status is unknown until someone verifies it.';
  }

  const detailLines = [];
  if (ledgerTotal > 0) {
    detailLines.push(
      `${ledgerTotal} unresolved event${plural(ledgerTotal)} in stripe_webhook_events with an error or an abandoned claim (no time window — an unresolved event stays on this alert until fixed). Stripe retries for ~72h; after that the row is a dead letter and the 90-day purge will erase it silently.`,
      '',
      ...ledgerRows.map((row) => `- ${describeLedgerRow(row)}`),
      ...(ledgerTotal > ledgerRows.length ? [`…and ${ledgerTotal - ledgerRows.length} more not shown`] : []),
    );
  }

  if (stripeTotal > 0 || stripeUnreconciled > 0) {
    detailLines.push(
      '',
      `Possible Stripe-side delivery failures — Stripe flagged these undelivered somewhere on the account and they are absent from this endpoint's ledger. Absence can mean this endpoint missed them OR the event type is routed only to another endpoint (the events API has no per-endpoint scoping) — verify in the Stripe dashboard: ${stripeTotal}`,
      ...stripeEvents.map((evt) => `- ${describeStripeSideEvent(evt)}`),
      ...(stripeTotal > stripeEvents.length ? [`…and ${stripeTotal - stripeEvents.length} more not shown`] : []),
      ...(stripeUnreconciled > 0 ? [`…plus ${stripeUnreconciled} more event${plural(stripeUnreconciled)} beyond the probe's scan cap that could NOT be reconciled against the local ledger — possible failures only (may belong to another endpoint on the account); verify in the Stripe dashboard.`] : []),
    );
  }

  if (stripeCheckError || ledgerCheckError) {
    // When a broken check is the ONLY finding, say so explicitly — zero
    // findings from a check that couldn't run is UNKNOWN, not healthy.
    if (ledgerTotal === 0 && stripeTotal === 0 && stripeUnreconciled === 0) {
      detailLines.push(`Zero findings do NOT mean healthy: a health check could not complete, so ${ledgerCheckError ? 'webhook health status is UNKNOWN' : 'Stripe-side delivery status is UNKNOWN'} until verified.`);
    }
    if (ledgerCheckError) {
      detailLines.push('', `NOTE: the LEDGER health query itself FAILED (${ledgerCheckError}) — query stripe_webhook_events manually (error set, or unprocessed past the stale-claim window).`);
    }
    if (stripeCheckError) {
      detailLines.push('', `NOTE: the Stripe-side delivery check itself FAILED (${stripeCheckError}) — verify manually via the Intelligence Bar (get_stripe_webhook_failures) or the Stripe dashboard.`);
    }
  }
  detailLines.push('', 'Replay/retry from the Stripe dashboard: https://dashboard.stripe.com/webhooks');

  // What the row is about, for the ring decision: a new event or a newly broken check rings; the same set does not.
  const itemKeys = [
    ...ledgerRows.map((row) => String(row.id)),
    ...stripeEvents.map((evt) => String(evt.id)),
    ...(stripeUnreconciled > 0 ? ['stripe:unreconciled'] : []),
    ...(ledgerCheckError ? ['check:ledger'] : []),
    ...(stripeCheckError ? ['check:stripe'] : []),
  ].sort();

  return {
    spec: {
      area: 'Billing',
      action,
      why,
      severity: 'needs-you',
      link: ledgerTotal > 0 || stripeCombined > 0 ? '/admin/invoices' : '/admin/settings?tab=integrations',
      subject: { type: 'check', id: DEDUPE_KEY },
      doneWhen: 'count_zero',
      who: 'either',
    },
    detail: detailLines.join('\n').slice(0, DETAIL_MAX_CHARS),
    itemKeys,
    total: ledgerTotal + stripeCombined,
    count: ledgerTotal,
    stripeFailureCount: stripeTotal,
    stripeUnreconciledCount: stripeUnreconciled,
  };
}

// A refresh rings only when a new event or a newly broken check joins the set or the total grows. (A comeback
// after the row closed rings through raiseAdminAlertWithReopen, which ignores this.)
function ringOnNewItem({ itemKeys, total }) {
  return (_existing, existingMeta) => {
    const prior = new Set(Array.isArray(existingMeta?.itemKeys) ? existingMeta.itemKeys.map(String) : []);
    return itemKeys.some((key) => !prior.has(key)) || total > (Number(existingMeta?.count) || 0);
  };
}

async function raiseAlert(composed) {
  const alert = composeAdminAlert(composed.spec);
  return require('./admin-alert-episodes').raiseAdminAlertWithReopen('billing', alert.headline, alert.why, {
    dedupeKey: DEDUPE_KEY,
    // Under GATE_ADMIN_BELL_POLICY the 'billing' category is denied unless the call site tags it.
    bell: true,
    refreshOnDedupe: true,
    ringOnRefresh: ringOnNewItem(composed),
    bumpOnRefresh: true,
    detail: composed.detail,
    link: alert.link,
    metadata: { ...alert.metadata, itemKeys: composed.itemKeys, count: composed.total },
  });
}

async function clearAlert(now = new Date()) {
  const { closeAdminAlertKeys } = require('./admin-alert-episodes');
  return db.transaction((trx) => closeAdminAlertKeys(trx, [DEDUPE_KEY], 'count_zero', {
    now, resolution: 'Cleared: the Stripe webhook check found nothing left to fix',
  }));
}

async function runStripeWebhookHealthCheck(opts = {}) {
  // A failed ledger query is handled like a failed Stripe-side check, not
  // an early return: job_health has no automatic notifier, so the bell row
  // below is the only rail that tells the operator local webhook
  // failure status is UNKNOWN. Same alert-safe twin discipline as
  // stripeCheckError (generic line + allowlisted token, never raw
  // err.message — a Knex message carries the failing SQL).
  let ledger = { total: 0, rows: [] };
  let ledgerCheckError = null;
  let ledgerCheckErrorSafe = null;
  try {
    ledger = await (opts.loadLedgerFailures || loadLedgerFailures)();
  } catch (err) {
    ledgerCheckError = err.message || String(err);
    const codeToken = safeErrorToken(err.code) || safeErrorToken(err.name);
    ledgerCheckErrorSafe = `the ledger health query threw an unexpected error${codeToken ? ` (${codeToken})` : ''} — full text in Railway logs / job_health`;
    logger.error(`[stripe-webhook-health] ledger query failed: ${ledgerCheckError}`);
  }

  // Stripe-side delivery check via the existing IB probe. A thrown check
  // with a key present IS a failure and must reach job_health (never
  // swallowed — stripeCheckError makes the scheduler wrapper throw after
  // the alert). No key in dev/test/preview = the expected dark state; no key
  // in DEPLOYED PRODUCTION is a broken payment-pipeline baseline and the
  // Stripe-side half of this check silently couldn't run — FAIL CLOSED:
  // treat it exactly like a failed probe so it lands in job_health as a FIX,
  // never a benign nothing_found.
  let stripeSide = null;
  let stripeCheckError = null;
  // Alert-safe twin of stripeCheckError: our own fixed messages pass
  // verbatim; a thrown error's arbitrary prose is replaced with a generic
  // line + allowlisted token before it may reach the alert (the
  // full message still goes to the result/logs for job_health).
  let stripeCheckErrorSafe = null;
  const stripeConfigured = opts.stripeConfigured ?? Boolean(process.env.STRIPE_SECRET_KEY);
  if (stripeConfigured) {
    try {
      const { getStripeWebhookFailures } = opts.stripeOpsTools || require('./intelligence-bar/stripe-ops-tools');
      stripeSide = await getStripeWebhookFailures({ hours: LOOKBACK_HOURS });

      // Reconcile against the local ledger before composing the alert:
      // delivery_success=false is account-wide, so another integration's
      // unhealthy endpoint would otherwise page us. Any returned event id
      // already present in OUR ledger was delivered here — not our failure.
      // Ids that SURVIVE reconciliation are still only POSSIBLE failures
      // (absence from the ledger can also mean the event type is routed
      // only to another endpoint) — the alert presents them as
      // verify-in-dashboard items, never confirmed. Only the DISPLAYED ids
      // can be reconciled (the probe caps the list), so any remainder
      // beyond the cap is carried as explicitly UNRECONCILED. A
      // reconciliation query failure is caught below as stripeCheckError
      // (blocking), same as a failed probe.
      const undelivered = stripeSide?.undelivered_events || [];
      if (undelivered.length > 0) {
        const knownIds = await (opts.loadLedgerEventIds || loadLedgerEventIds)(undelivered.map((evt) => evt.id));
        const possible = undelivered.filter((evt) => !knownIds.has(evt.id));
        const foreignCount = undelivered.length - possible.length;
        if (foreignCount > 0) {
          logger.info(`[stripe-webhook-health] excluded ${foreignCount} Stripe-side failure(s) already present in the local ledger (other endpoint's failure)`);
        }
        stripeSide = {
          ...stripeSide,
          undelivered_events: possible,
          total_undelivered: possible.length,
          unreconciled_undelivered: Math.max(0, (Number(stripeSide.total_undelivered) || 0) - undelivered.length),
        };
      }

      // A capped scan is an INCOMPLETE check: a burst of recent-pending
      // events can fill every scanned page while older failures sit
      // unexamined beyond the cap, and "nothing found" would silently
      // record a healthy job_health run. Fail closed — same blocking rail
      // as a thrown probe (the alert still carries whatever WAS found).
      if (stripeSide?.scan_exhaustive === false) {
        stripeCheckError = "Stripe-side probe hit its scan cap before covering the full lookback — events beyond the cap were not examined; verify in the Stripe dashboard";
        stripeCheckErrorSafe = stripeCheckError;
      }
    } catch (err) {
      stripeCheckError = err.message || String(err);
      const codeToken = safeErrorToken(err.code) || safeErrorToken(err.name);
      stripeCheckErrorSafe = `the check threw an unexpected error${codeToken ? ` (${codeToken})` : ''} — full text in Railway logs / job_health`;
      logger.error(`[stripe-webhook-health] Stripe-side delivery check failed: ${stripeCheckError}`);
    }
  } else if (opts.deployedProd ?? isDeployedProduction()) {
    stripeCheckError = 'STRIPE_SECRET_KEY is not set in deployed production — Stripe-side delivery check cannot run';
    stripeCheckErrorSafe = stripeCheckError;
    logger.error(`[stripe-webhook-health] ${stripeCheckError}`);
  } else {
    logger.info('[stripe-webhook-health] STRIPE_SECRET_KEY not set (dev/test/preview) — skipping Stripe-side delivery check');
  }

  const composed = composeWebhookHealthAlert({
    ledger,
    stripeSide,
    stripeCheckError: stripeCheckErrorSafe,
    ledgerCheckError: ledgerCheckErrorSafe,
  });
  if (watcherDisabled()) {
    logger.info(`[stripe-webhook-health] disabled — would raise: ${composed ? `${composed.count} ledger, ${composed.stripeFailureCount} Stripe-side` : 'nothing'}`);
    return composed ? { skipped: 'disabled', ...composed } : { skipped: 'nothing_found' };
  }
  if (!composed) {
    // Everything quiet AND both checks completed (compose returns an alert
    // whenever either check error is set — job_health has no notifier, so
    // a broken check must reach the operator on the bell, not only as a
    // failed job_health row). A standing row from an earlier run closes here.
    try {
      await (opts.clearAlert || clearAlert)();
    } catch (err) {
      logger.warn(`[stripe-webhook-health] could not close the standing alert (${err.code || err.name || 'error'})`);
    }
    return { skipped: 'nothing_found' };
  }
  // The raw check errors ride on the result only (the scheduler wrapper reads them for job_health); the alert
  // gets the alert-safe text above.
  const checkErrors = { ...(stripeCheckError ? { stripeCheckError } : {}), ...(ledgerCheckError ? { ledgerCheckError } : {}) };

  let outcome;
  try {
    const result = await (opts.raiseAlert || raiseAlert)(composed);
    outcome = result?.rang === false ? 'unchanged' : 'raised';
  } catch (err) {
    logger.error(`[stripe-webhook-health] alert failed (${err.code || err.name || 'error'})`);
    return { raised: false, error: true, ...composed, ...checkErrors };
  }
  logger.info(`[stripe-webhook-health] ${outcome}: ${composed.count} ledger failure(s), ${composed.stripeFailureCount} Stripe-side`);
  return { raised: true, outcome, ...composed, ...checkErrors };
}

module.exports = {
  runStripeWebhookHealthCheck,
  _private: {
    composeWebhookHealthAlert,
    ringOnNewItem,
    failedEventsQuery,
    ledgerCutoffs,
    LOOKBACK_HOURS,
  },
};
