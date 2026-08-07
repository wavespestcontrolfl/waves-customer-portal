'use strict';

// Daily owner exception email: Stripe webhook events the app failed to apply.
//
// The `stripe_webhook_events` ledger is the idempotency spine of the payment
// pipeline: handler failures write `error` and lean on Stripe's ~72h retry
// window; rows Stripe gave up on (error set / processed=false) are a de facto
// dead-letter that NOTHING sweeps — and the 3:30am purge deletes rows older
// than 90 days, so a dead event eventually vanishes with zero operator
// signal (2026-08-07 infra audit). Winston is console-only, so Railway's
// rotating logs are the only other trace. This watcher closes the loop: any
// ledger row from the lookback window with `error` set — or unprocessed with
// an ABANDONED claim (older than the webhook route's stale-claim window; a
// fresh claim is a live worker mid-handler, not a failure) — lands in one
// morning FIX email, alongside Stripe-side delivery failures from the
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
// Subject grammar follows the ops-email convention (first word = the owner's
// action): FIX because a stuck webhook event means payment state diverged
// from Stripe and needs a repair/replay decision before the retry window
// (or the 90d purge) erases it.
//
// PII: Stripe event ids (evt_…) and event types are identifiers, not PII.
// The ledger's `payload` column is NEVER read here, and error snippets are
// masked (emails, digit runs) before they leave the process — same
// discipline as cron-lock's sanitizeJobError.
//
// Exception-based: a quiet window sends nothing. Live by default with a
// kill switch (STRIPE_WEBHOOK_HEALTH_DISABLED=1). Cron: daily 7:04am ET in
// scheduler.js, inside runExclusive; a failed check must surface as a
// job_health failure, never a silent skip (the scheduler wrapper throws on
// the blocking skip codes and on stripeCheckError).

const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const db = require('../models/db');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');
// Same constant the webhook route's claim logic uses — a processed=false /
// error=null row younger than this is an in-flight claim, not a failure.
const { STALE_CLAIM_WINDOW_MS } = require('../routes/stripe-webhook-helpers');
const { isDeployedProduction } = require('../utils/railway-deployment');
const { scrubSentryText } = require('../utils/sentry-scrub');

const watcherDisabled = () => ['1', 'true', 'on']
  .includes(String(process.env.STRIPE_WEBHOOK_HEALTH_DISABLED || '').toLowerCase());
const watcherEmail = () => process.env.STRIPE_WEBHOOK_HEALTH_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';

// Lookback must exceed the daily schedule interval PLUS every "too fresh to
// judge" grace (the probe's ~10min recent-pending split, the ledger's
// stale-claim window). At 24h an event created minutes before one 7:04am
// tick was classified pending (ignored) and by the next tick had aged OUT of
// the window — it never alerted. 48h closes that gap; the cost is that an
// unresolved item repeats in consecutive digests, which is deliberate for a
// FIX email (the send-marker dedupes double TICKS, never findings — deduping
// findings could silently drop a still-dead event).
const LOOKBACK_HOURS = 48;
const MAX_ROWS = 25;
const ERROR_SNIPPET_LENGTH = 200;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Handler error messages are app-written, but provider errors can echo
// request payloads (Twilio embeds phone numbers; Stripe messages can quote a
// receipt email) and Knex prefixes the failing SQL, where customer names
// arrive as quoted literals and amounts as short currency strings. Reuse the
// shared Sentry scrubber (emails, quoted SQL literals, $amounts, digit runs)
// so the two egress sinks can't drift, then collapse whitespace and cap for
// email display — the email itself must never carry customer
// emails/names/amounts.
function sanitizeErrorSnippet(message) {
  return scrubSentryText(message)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ERROR_SNIPPET_LENGTH);
}

// Ledger rows the app failed to apply: `error` recorded by the handler catch,
// OR unprocessed with an ABANDONED claim. An error-free processed=false row
// younger than STALE_CLAIM_WINDOW_MS is a live worker mid-handler (the route
// uses received_at as the claim lease and bumps it on re-claim) — reporting
// it would flag routine in-flight deliveries as failures. Rolling window —
// real Date objects against the timestamptz column (waves-db §2: never a
// naive ISO string).
function ledgerCutoffs(now = Date.now()) {
  return {
    cutoff: new Date(now - LOOKBACK_HOURS * 60 * 60 * 1000),
    staleCutoff: new Date(now - STALE_CLAIM_WINDOW_MS),
  };
}

function failedEventsQuery(cutoff, staleCutoff) {
  return db('stripe_webhook_events')
    .where('received_at', '>', cutoff)
    .where(function whereFailedOrAbandoned() {
      this.whereNotNull('error').orWhere(function whereAbandonedClaim() {
        this.where('processed', false)
          .whereNull('error')
          .where('received_at', '<', staleCutoff);
      });
    });
}

async function loadLedgerFailures() {
  const { cutoff, staleCutoff } = ledgerCutoffs();
  const [{ count }] = await failedEventsQuery(cutoff, staleCutoff).count('id as count');
  const total = Number(count) || 0;
  if (total === 0) return { total: 0, rows: [] };
  const rows = await failedEventsQuery(cutoff, staleCutoff)
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

function describeLedgerRow(row) {
  const received = new Date(row.received_at).toISOString();
  const state = row.error
    ? `error: ${sanitizeErrorSnippet(row.error) || '(empty message)'}`
    : 'unprocessed (no error recorded — claim abandoned past the stale window)';
  return `${row.id} (${row.event_type}) received ${received} — ${state}`;
}

function describeStripeSideEvent(evt) {
  return `${evt.id} (${evt.type}) created ${evt.created} — ${evt.pending_webhooks} pending webhook(s)`;
}

// Pure composition: null = nothing worth an email (the common, quiet case).
function composeWebhookHealthDigest({ ledger, stripeSide, stripeCheckError }) {
  const ledgerTotal = ledger?.total || 0;
  const ledgerRows = ledger?.rows || [];
  const stripeEvents = stripeSide?.undelivered_events || [];
  const stripeTotal = stripeSide?.total_undelivered || 0;
  // Beyond-cap remainder the ledger reconciliation could not verify — a
  // POSSIBLE failure needing manual verification, never a confirmed one.
  const stripeUnreconciled = stripeSide?.unreconciled_undelivered || 0;
  if (ledgerTotal === 0 && stripeTotal === 0 && stripeUnreconciled === 0) return null;

  const plural = (n) => (n === 1 ? '' : 's');
  const stripeCombined = stripeTotal + stripeUnreconciled;
  const subject = ledgerTotal > 0
    ? `FIX: ${ledgerTotal} Stripe webhook event${plural(ledgerTotal)} failed/unprocessed in last ${LOOKBACK_HOURS}h${stripeCombined > 0 ? ` + ${stripeCombined} possible undelivered Stripe-side` : ''}`
    : stripeTotal > 0
      ? `FIX: ${stripeTotal} possible Stripe webhook delivery failure${plural(stripeTotal)} (Stripe-side) in last ${LOOKBACK_HOURS}h${stripeUnreconciled > 0 ? ` (+${stripeUnreconciled} unreconciled)` : ''}`
      : `FIX: ${stripeUnreconciled} possible Stripe webhook delivery failure${plural(stripeUnreconciled)} (Stripe-side, unreconciled) in last ${LOOKBACK_HOURS}h`;

  const textSections = [];
  const htmlSections = [];

  if (ledgerTotal > 0) {
    textSections.push(
      `${ledgerTotal} event${plural(ledgerTotal)} in stripe_webhook_events from the last ${LOOKBACK_HOURS}h with an error or an abandoned claim. Stripe retries for ~72h; after that the row is a dead letter and the 90-day purge will erase it silently. (Unresolved events repeat in consecutive digests until fixed.)`,
      '',
      ...ledgerRows.map((row) => `- ${describeLedgerRow(row)}`),
      ...(ledgerTotal > ledgerRows.length ? [`…and ${ledgerTotal - ledgerRows.length} more not shown`] : []),
    );
    htmlSections.push(
      `<p><strong>${ledgerTotal} event${plural(ledgerTotal)}</strong> in <code>stripe_webhook_events</code> from the last ${LOOKBACK_HOURS}h with an error or an abandoned claim. Stripe retries for ~72h; after that the row is a dead letter and the 90-day purge will erase it silently. (Unresolved events repeat in consecutive digests until fixed.)</p>`,
      `<ul style="margin:0 0 12px 18px;padding:0;">${ledgerRows.map((row) => `<li style="margin:0 0 6px 0;">${esc(describeLedgerRow(row))}</li>`).join('')}</ul>`,
      ...(ledgerTotal > ledgerRows.length ? [`<p>…and ${ledgerTotal - ledgerRows.length} more not shown</p>`] : []),
    );
  }

  if (stripeTotal > 0 || stripeUnreconciled > 0) {
    const stripeSideIntro = `Possible Stripe-side delivery failures — Stripe flagged these undelivered somewhere on the account and they are absent from this endpoint's ledger. Absence can mean this endpoint missed them OR the event type is routed only to another endpoint (the events API has no per-endpoint scoping) — verify in the Stripe dashboard: ${stripeTotal}`;
    const unreconciledLine = `…plus ${stripeUnreconciled} more event${plural(stripeUnreconciled)} beyond the probe's scan cap that could NOT be reconciled against the local ledger — possible failures only (may belong to another endpoint on the account); verify in the Stripe dashboard.`;
    textSections.push(
      '',
      stripeSideIntro,
      ...stripeEvents.map((evt) => `- ${describeStripeSideEvent(evt)}`),
      ...(stripeTotal > stripeEvents.length ? [`…and ${stripeTotal - stripeEvents.length} more not shown`] : []),
      ...(stripeUnreconciled > 0 ? [unreconciledLine] : []),
    );
    htmlSections.push(
      `<p><strong>Possible Stripe-side delivery failures</strong> — Stripe flagged these undelivered somewhere on the account and they are absent from this endpoint's ledger. Absence can mean this endpoint missed them OR the event type is routed only to another endpoint (the events API has no per-endpoint scoping) — verify in the Stripe dashboard: ${stripeTotal}</p>`,
      `<ul style="margin:0 0 12px 18px;padding:0;">${stripeEvents.map((evt) => `<li style="margin:0 0 6px 0;">${esc(describeStripeSideEvent(evt))}</li>`).join('')}</ul>`,
      ...(stripeTotal > stripeEvents.length ? [`<p>…and ${stripeTotal - stripeEvents.length} more not shown</p>`] : []),
      ...(stripeUnreconciled > 0 ? [`<p>${esc(unreconciledLine)}</p>`] : []),
    );
  }

  if (stripeCheckError) {
    textSections.push('', `NOTE: the Stripe-side delivery check itself FAILED (${sanitizeErrorSnippet(stripeCheckError)}) — verify manually via the Intelligence Bar (get_stripe_webhook_failures) or the Stripe dashboard.`);
    htmlSections.push(`<p><strong>NOTE:</strong> the Stripe-side delivery check itself FAILED (${esc(sanitizeErrorSnippet(stripeCheckError))}) — verify manually via the Intelligence Bar (get_stripe_webhook_failures) or the Stripe dashboard.</p>`);
  }

  textSections.push('', 'Replay/retry from the Stripe dashboard: https://dashboard.stripe.com/webhooks');
  htmlSections.push('<p><a href="https://dashboard.stripe.com/webhooks">Open Stripe webhook dashboard</a></p>');

  return {
    subject,
    text: textSections.join('\n'),
    html: htmlSections.join('\n'),
    count: ledgerTotal,
    stripeFailureCount: stripeTotal,
    stripeUnreconciledCount: stripeUnreconciled,
  };
}

// Durable daily-send guard — same rationale as turf-variance-digest.js
// (advisory lock only serializes CONCURRENT ticks; a deploy-overlap tick
// after release would double-send). Marker stamps only when an email left,
// and it gates ONLY the send decision — the health checks always run first,
// so a deduped tick still surfaces stripeCheckError to job_health instead
// of overwriting a failed state with a healthy "recent_send" skip.
const SEND_MARKER_KEY = 'stripe-webhook-health';
const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;

async function sentRecently() {
  try {
    const row = await db('ops_email_send_state').where({ email_key: SEND_MARKER_KEY }).first('last_sent_at');
    return Boolean(row?.last_sent_at && (Date.now() - new Date(row.last_sent_at).getTime()) < TWENTY_HOURS_MS);
  } catch (err) {
    logger.warn(`[stripe-webhook-health] send-marker read failed (${err.message}) — proceeding without the guard`);
    return false;
  }
}

async function stampSendMarker() {
  try {
    const now = new Date();
    await db('ops_email_send_state')
      .insert({ email_key: SEND_MARKER_KEY, last_sent_at: now, updated_at: now })
      .onConflict('email_key')
      .merge({ last_sent_at: now, updated_at: now });
  } catch (err) {
    logger.warn(`[stripe-webhook-health] send-marker write failed (${err.message}) — next tick may re-send`);
  }
}

async function runStripeWebhookHealthCheck(opts = {}) {
  let ledger;
  try {
    ledger = await (opts.loadLedgerFailures || loadLedgerFailures)();
  } catch (err) {
    logger.error(`[stripe-webhook-health] ledger query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }

  // Stripe-side delivery check via the existing IB probe. A thrown check
  // with a key present IS a failure and must reach job_health (never
  // swallowed — stripeCheckError makes the scheduler wrapper throw after
  // any send). No key in dev/test/preview = the expected dark state; no key
  // in DEPLOYED PRODUCTION is a broken payment-pipeline baseline and the
  // Stripe-side half of this check silently couldn't run — FAIL CLOSED:
  // treat it exactly like a failed probe so it lands in job_health as a FIX,
  // never a benign nothing_found.
  let stripeSide = null;
  let stripeCheckError = null;
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
      // only to another endpoint) — the digest presents them as
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
      // as a thrown probe (email still carries whatever WAS found).
      if (stripeSide?.scan_exhaustive === false) {
        stripeCheckError = "Stripe-side probe hit its scan cap before covering the full lookback — events beyond the cap were not examined; verify in the Stripe dashboard";
      }
    } catch (err) {
      stripeCheckError = err.message || String(err);
      logger.error(`[stripe-webhook-health] Stripe-side delivery check failed: ${stripeCheckError}`);
    }
  } else if (opts.deployedProd ?? isDeployedProduction()) {
    stripeCheckError = 'STRIPE_SECRET_KEY is not set in deployed production — Stripe-side delivery check cannot run';
    logger.error(`[stripe-webhook-health] ${stripeCheckError}`);
  } else {
    logger.info('[stripe-webhook-health] STRIPE_SECRET_KEY not set (dev/test/preview) — skipping Stripe-side delivery check');
  }

  const composed = composeWebhookHealthDigest({ ledger, stripeSide, stripeCheckError });
  if (!composed) {
    // Quiet ledger + broken Stripe-side check: no email (nothing concrete to
    // report), but the run did NOT complete — surface it as a failure.
    if (stripeCheckError) return { skipped: 'stripe_check_failed', stripeCheckError };
    return { skipped: 'nothing_found' };
  }
  if (stripeCheckError) composed.stripeCheckError = stripeCheckError;

  if (watcherDisabled()) {
    logger.info(`[stripe-webhook-health] disabled — would send: ${composed.count} ledger, ${composed.stripeFailureCount} Stripe-side`);
    return { skipped: 'disabled', ...composed };
  }

  // Send-dedupe AFTER the checks: findings (and any stripeCheckError) are
  // already on the result, so the scheduler wrapper still fails job_health
  // on a broken check even when the email itself is deduped.
  if (await (opts.sentRecently || sentRecently)()) {
    logger.info(`[stripe-webhook-health] email sent within the last 20h — skipping re-send (${composed.count} ledger, ${composed.stripeFailureCount} Stripe-side still outstanding)`);
    return { skipped: 'recent_send', ...composed };
  }

  const mailer = opts.sendgrid || sendgrid;
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
    logger.warn('[stripe-webhook-health] mailer not configured — skipping send');
    return { skipped: 'unconfigured', ...composed };
  }

  // FAIL CLOSED: owner/internal inboxes only — a mis-set recipient env must
  // skip, never leak payment-pipeline failure state outward.
  const to = watcherEmail();
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[stripe-webhook-health] recipient is not an internal address — skipping send; set a valid STRIPE_WEBHOOK_HEALTH_EMAIL');
    return { skipped: 'recipient', ...composed };
  }

  try {
    await mailer.sendOne({
      to,
      fromEmail: fromEmail(),
      fromName: FROM_NAME,
      subject: composed.subject,
      html: composed.html,
      text: composed.text,
      categories: ['ops', 'stripe-webhook-health'],
      suppressErrorLog: true,
    });
  } catch (err) {
    logger.error(`[stripe-webhook-health] send failed (status ${Number.isInteger(err?.status) ? err.status : 'network'})`);
    return { sent: false, error: true, ...composed };
  }
  await (opts.stampSendMarker || stampSendMarker)();
  logger.info(`[stripe-webhook-health] sent: ${composed.count} ledger failure(s), ${composed.stripeFailureCount} Stripe-side`);
  return { sent: true, ...composed };
}

module.exports = {
  runStripeWebhookHealthCheck,
  _private: {
    composeWebhookHealthDigest,
    sanitizeErrorSnippet,
    failedEventsQuery,
    ledgerCutoffs,
    LOOKBACK_HOURS,
  },
};
