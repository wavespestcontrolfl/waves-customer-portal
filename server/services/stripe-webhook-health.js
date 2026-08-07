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
// ledger row from the last 24h with `error` set or still unprocessed lands
// in one morning FIX email, alongside Stripe-side delivery failures from the
// existing get_stripe_webhook_failures probe (events Stripe could not
// deliver never reach the ledger at all — the two views are complementary).
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

const watcherDisabled = () => ['1', 'true', 'on']
  .includes(String(process.env.STRIPE_WEBHOOK_HEALTH_DISABLED || '').toLowerCase());
const watcherEmail = () => process.env.STRIPE_WEBHOOK_HEALTH_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';

const WINDOW_HOURS = 24;
const MAX_ROWS = 25;
const ERROR_SNIPPET_LENGTH = 200;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Handler error messages are app-written, but provider errors can echo
// request payloads (Twilio embeds phone numbers; Stripe messages can quote a
// receipt email). Mask before the text leaves the process — the email itself
// must never carry customer emails/names/amounts.
function sanitizeErrorSnippet(message) {
  return String(message || '')
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, '[redacted-email]')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, '[redacted-number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ERROR_SNIPPET_LENGTH);
}

// Ledger rows the app failed to apply: `error` recorded by the handler catch,
// OR still unprocessed (a claim whose worker died, or an event Stripe stopped
// retrying before it ever succeeded). Rolling 24h window — a real Date object
// against the timestamptz column (waves-db §2: never a naive ISO string).
function failedEventsQuery(cutoff) {
  return db('stripe_webhook_events')
    .where('received_at', '>', cutoff)
    .where(function whereFailedOrUnprocessed() {
      this.whereNotNull('error').orWhere('processed', false);
    });
}

async function loadLedgerFailures() {
  const cutoff = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);
  const [{ count }] = await failedEventsQuery(cutoff).count('id as count');
  const total = Number(count) || 0;
  if (total === 0) return { total: 0, rows: [] };
  const rows = await failedEventsQuery(cutoff)
    // `payload` is deliberately never selected — it carries customer data.
    .select('id', 'event_type', 'error', 'processed', 'received_at')
    .orderBy('received_at', 'desc')
    .limit(MAX_ROWS);
  return { total, rows };
}

function describeLedgerRow(row) {
  const received = new Date(row.received_at).toISOString();
  const state = row.error
    ? `error: ${sanitizeErrorSnippet(row.error) || '(empty message)'}`
    : 'unprocessed (no error recorded — claim likely abandoned)';
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
  if (ledgerTotal === 0 && stripeTotal === 0) return null;

  const plural = (n) => (n === 1 ? '' : 's');
  const subject = ledgerTotal > 0
    ? `FIX: ${ledgerTotal} Stripe webhook event${plural(ledgerTotal)} failed/unprocessed in last 24h${stripeTotal > 0 ? ` + ${stripeTotal} undelivered Stripe-side` : ''}`
    : `FIX: ${stripeTotal} Stripe webhook delivery failure${plural(stripeTotal)} (Stripe-side) in last 24h`;

  const textSections = [];
  const htmlSections = [];

  if (ledgerTotal > 0) {
    textSections.push(
      `${ledgerTotal} event${plural(ledgerTotal)} in stripe_webhook_events from the last 24h with an error or still unprocessed. Stripe retries for ~72h; after that the row is a dead letter and the 90-day purge will erase it silently.`,
      '',
      ...ledgerRows.map((row) => `- ${describeLedgerRow(row)}`),
      ...(ledgerTotal > ledgerRows.length ? [`…and ${ledgerTotal - ledgerRows.length} more not shown`] : []),
    );
    htmlSections.push(
      `<p><strong>${ledgerTotal} event${plural(ledgerTotal)}</strong> in <code>stripe_webhook_events</code> from the last 24h with an error or still unprocessed. Stripe retries for ~72h; after that the row is a dead letter and the 90-day purge will erase it silently.</p>`,
      `<ul style="margin:0 0 12px 18px;padding:0;">${ledgerRows.map((row) => `<li style="margin:0 0 6px 0;">${esc(describeLedgerRow(row))}</li>`).join('')}</ul>`,
      ...(ledgerTotal > ledgerRows.length ? [`<p>…and ${ledgerTotal - ledgerRows.length} more not shown</p>`] : []),
    );
  }

  if (stripeTotal > 0) {
    textSections.push(
      '',
      `Stripe-side delivery failures (events Stripe could not deliver to the endpoint — these never reached the ledger): ${stripeTotal}`,
      ...stripeEvents.map((evt) => `- ${describeStripeSideEvent(evt)}`),
      ...(stripeTotal > stripeEvents.length ? [`…and ${stripeTotal - stripeEvents.length} more not shown`] : []),
    );
    htmlSections.push(
      `<p><strong>Stripe-side delivery failures</strong> (events Stripe could not deliver to the endpoint — these never reached the ledger): ${stripeTotal}</p>`,
      `<ul style="margin:0 0 12px 18px;padding:0;">${stripeEvents.map((evt) => `<li style="margin:0 0 6px 0;">${esc(describeStripeSideEvent(evt))}</li>`).join('')}</ul>`,
      ...(stripeTotal > stripeEvents.length ? [`<p>…and ${stripeTotal - stripeEvents.length} more not shown</p>`] : []),
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
  };
}

// Durable daily-send guard — same rationale as turf-variance-digest.js
// (advisory lock only serializes CONCURRENT ticks; a deploy-overlap tick
// after release would double-send). Marker stamps only when an email left.
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
  if (await (opts.sentRecently || sentRecently)()) return { skipped: 'recent_send' };

  let ledger;
  try {
    ledger = await (opts.loadLedgerFailures || loadLedgerFailures)();
  } catch (err) {
    logger.error(`[stripe-webhook-health] ledger query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }

  // Stripe-side delivery check via the existing IB probe. No key = the
  // expected dark state (dev/preview), not a failure; a thrown check with a
  // key present IS a failure and must reach job_health (never swallowed —
  // stripeCheckError makes the scheduler wrapper throw after any send).
  let stripeSide = null;
  let stripeCheckError = null;
  const stripeConfigured = opts.stripeConfigured ?? Boolean(process.env.STRIPE_SECRET_KEY);
  if (stripeConfigured) {
    try {
      const { getStripeWebhookFailures } = opts.stripeOpsTools || require('./intelligence-bar/stripe-ops-tools');
      stripeSide = await getStripeWebhookFailures({ hours: WINDOW_HOURS });
    } catch (err) {
      stripeCheckError = err.message || String(err);
      logger.error(`[stripe-webhook-health] Stripe-side delivery check failed: ${stripeCheckError}`);
    }
  } else {
    logger.info('[stripe-webhook-health] STRIPE_SECRET_KEY not set — skipping Stripe-side delivery check');
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
  _private: { composeWebhookHealthDigest, sanitizeErrorSnippet },
};
