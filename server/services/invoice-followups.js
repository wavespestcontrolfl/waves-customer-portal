/**
 * Per-Invoice Follow-up Sequence Engine
 *
 * Each unpaid invoice has one row in `invoice_followup_sequences` that tracks
 * which step fires next and when. The cron calls `runPending()` Tue–Fri at
 * 10:16 AM (touches stay anchored to 10:00; the tick is staggered off :00 —
 * see the scheduler block) to send due touches. The Stripe webhook calls `stopOnPayment()` the
 * instant payment succeeds — no "thanks for paying" + "you owe us" crossing.
 *
 * See server/config/invoice-followups.js for step timing + copy.
 *
 * EVERY UPDATE IN THIS FILE MUST STAMP `updated_at`. `timestamps(true, true)`
 * only defaults the column at INSERT — Knex does not maintain it and migration
 * 20260414000032 installs no trigger, so before this was fixed an unstamped
 * UPDATE left the value frozen at creation time. Anything asking "has this
 * sequence been touched since <time>?" — audit reads, reconciliation, and the
 * ownership-change checks below — was therefore reading a timestamp that never
 * moved, even for a sequence that had already dunned several times.
 *
 * A blanket BEFORE UPDATE trigger was considered and REJECTED: it would also
 * fire on pure ownership repoints (a customer merge rewriting customer_id),
 * which must stay invisible to "was this row touched?" checks — a bump there
 * would make the repoint itself read as activity. Explicit stamps, the repo's
 * convention in ~314 other call sites, keep a real mutation and a repoint
 * distinguishable.
 */

const db = require('../models/db');
const logger = require('./logger');
const { invoiceAmountDue } = require('./invoice-helpers');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { gates } = require('../config/feature-gates');
const StripeService = require('./stripe');
const { sendMicrodepositVerificationEmail } = require('./microdeposit-verification-email');
const config = require('../config/invoice-followups');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('./short-url');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { customerOnAutopay } = require('./autopay-eligibility');
const { publicPortalUrl } = require('../utils/portal-url');
const EmailTemplateLibrary = require('./email-template-library');
const { getInvoiceEmailRecipients } = require('./customer-contact');
const { currency } = require('./email-template');
const { formatDateOnly } = require('../utils/date-only');

const FOLLOWUP_EMAIL_TEMPLATE_BY_STEP_ID = {
  d3_friendly: 'invoice.followup_3_day',
  d7_reminder: 'invoice.followup_7_day',
  d14_firmer: 'invoice.followup_14_day',
  d30_final: 'invoice.followup_30_day',
};

const TERMINAL_INVOICE_STATUSES = ['paid', 'prepaid', 'void', 'processing', 'refunded', 'canceled', 'cancelled'];
const NON_SCHEDULABLE_INVOICE_STATUSES = [...TERMINAL_INVOICE_STATUSES, 'draft'];

// A dunning touch fires on its first ELIGIBLE send day or not at all (owner
// ruling 2026-08-04, after the 07-29→08-04 cron outage left 17 sequences due).
// Touches are anchored to 10:00 AM NY and the cron ticks minutes later, so a
// healthy fire is minutes past its eligible day's anchor; anything past this
// grace missed its day (the next chance is ≥24h later) and is skipped
// forward, never sent late — a revived cron must not burst a week of stale
// payment reminders. Staleness is measured from firstEligibleFireAt(due),
// NOT the raw due date: Sat/Sun/Mon-anchored touches have always fired on
// Tuesday and must not look three days old by their first chance (Codex r1).
const STALE_TOUCH_GRACE_MS = 20 * 60 * 60 * 1000;

function clean(value) {
  return String(value || '').trim();
}

function cleanEmail(value) {
  return clean(value).toLowerCase();
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value));
}

function firstToken(value) {
  return clean(value).split(/\s+/)[0] || '';
}

function normalizedStatus(invoice) {
  return String(invoice?.status || '').trim().toLowerCase();
}

function isTerminalInvoice(invoice) {
  return TERMINAL_INVOICE_STATUSES.includes(normalizedStatus(invoice));
}

function isSchedulableInvoice(invoice) {
  return !NON_SCHEDULABLE_INVOICE_STATUSES.includes(normalizedStatus(invoice));
}

// Collections policy consult lives in the SHARED rail guard (codex
// 2026-08-14: one implementation, not three that drift) — gate-off
// byte-identical, per-channel verdicts, invoice-membership required.
const { collectionsChannelPermitted: railGuardPermitted } = require('./collections/rail-guard');

async function collectionsChannelPermitted(customerId, invoiceId, channel) {
  return railGuardPermitted({
    customerId, invoiceId, channel, purpose: 'late_payment', logTag: 'invoice-followups',
  });
}

/**
 * Load the SMS body from the editable sms_templates table. Returns null if the
 * template row is missing or disabled — caller pauses the sequence in that case.
 */
async function resolveBody(step, ctx) {
  if (!step.template_key || typeof smsTemplatesRouter.getTemplate !== 'function') return null;
  return smsTemplatesRouter.getTemplate(step.template_key, {
    first_name: ctx.name || 'there',
    invoice_title: ctx.invoiceTitle || 'your service',
    amount: ctx.amount || '0.00',
    pay_url: ctx.payUrl || '',
    receipt_url: ctx.payUrl || '',
    service_date: ctx.serviceDate || '',
    service_date_clause: ctx.serviceDate ? ` completed on ${ctx.serviceDate}` : '',
  }, {
    workflow: 'invoice_followup',
    entity_type: 'invoice',
    entity_id: ctx.invoiceId || null,
  });
}

async function logFollowupEmailAttempt({
  customerId,
  invoiceId,
  stepId,
  templateKey,
  status,
  providerMessageId = null,
  sentAt = null,
  failureReason = null,
}) {
  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'email_outbound',
      subject: `Invoice follow-up email ${status}`,
      body: failureReason
        ? `Invoice follow-up ${stepId} email ${status}: ${failureReason}`
        : `Invoice follow-up ${stepId} email ${status}.`,
      metadata: JSON.stringify({
        invoice_id: invoiceId,
        step_id: stepId,
        template_key: templateKey,
        channel: 'email',
        provider_message_id: providerMessageId,
        status,
        sent_at: sentAt,
        failure_reason: failureReason,
      }),
    });
  } catch (err) {
    logger.warn(`[invoice-followups] email audit log failed for invoice ${invoiceId}: ${err.message}`);
  }
}

async function sendFollowupEmail({ row, customer, step, ctx }) {
  const templateKey = FOLLOWUP_EMAIL_TEMPLATE_BY_STEP_ID[step.id];
  if (!templateKey) return { ok: false, skipped: true, reason: 'no_email_template_mapping' };

  const latestInvoice = await db('invoices').where({ id: row.invoice_id }).first().catch(() => null);
  if (!latestInvoice || isTerminalInvoice(latestInvoice)) {
    return { ok: false, skipped: true, reason: 'invoice_not_eligible' };
  }

  const prefs = await db('notification_prefs')
    .where({ customer_id: customer.id })
    .first()
    .catch((err) => {
      logger.warn(`[invoice-followups] notification_prefs lookup failed for ${customer.id}: ${err.message}`);
      return null;
    });
  const [recipient] = getInvoiceEmailRecipients(customer, prefs || {})
    .filter((entry) => isEmailLike(entry.email));
  if (!recipient?.email) return { ok: false, skipped: true, reason: 'missing_email' };

  const payload = {
    first_name: firstToken(recipient.name) || firstToken(customer.first_name) || 'there',
    invoice_title: ctx.invoiceTitle || latestInvoice.title || latestInvoice.service_type || 'your service',
    invoice_number: latestInvoice.invoice_number || row.invoice_number || '',
    amount_due: currency(latestInvoice ? invoiceAmountDue(latestInvoice) : invoiceAmountDue(row)),
    due_date: formatDateOnly(latestInvoice.due_date, { fallback: '' }),
    service_date: formatDateOnly(latestInvoice.service_date, { fallback: '' }),
    service_date_clause: ctx.serviceDate ? ` completed on ${ctx.serviceDate}` : '',
    pay_url: ctx.payUrl,
    customer_portal_url: `${publicPortalUrl()}/?tab=billing`,
  };

  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey,
      to: recipient.email,
      payload,
      recipientType: 'customer',
      recipientId: customer.id,
      triggerEventId: `invoice_followup:${row.invoice_id}:${step.id}`,
      idempotencyKey: `invoice_followup_email:${row.invoice_id}:${step.id}`,
      categories: ['invoice_followup', step.id],
      suppressionGroupKey: 'transactional_required',
    });

    if (result.deduped) {
      return {
        ok: !!result.sent,
        deduped: true,
        blocked: !!result.blocked,
        messageId: result.message?.provider_message_id || null,
      };
    }

    const status = result.sent ? 'sent' : result.blocked ? 'blocked' : 'failed';
    await logFollowupEmailAttempt({
      customerId: customer.id,
      invoiceId: row.invoice_id,
      stepId: step.id,
      templateKey,
      status,
      providerMessageId: result.message?.provider_message_id || null,
      sentAt: result.message?.sent_at || null,
      failureReason: result.sent ? null : result.reason || result.message?.error_message || 'email_not_sent',
    });

    if (!result.sent) {
      return {
        ok: false,
        blocked: !!result.blocked,
        reason: result.reason || 'email_not_sent',
      };
    }
    return { ok: true, messageId: result.message?.provider_message_id || null };
  } catch (err) {
    await logFollowupEmailAttempt({
      customerId: customer.id,
      invoiceId: row.invoice_id,
      stepId: step.id,
      templateKey,
      status: 'failed',
      failureReason: err.message,
    });
    logger.error(`[invoice-followups] ${step.id} email failed for invoice ${row.invoice_id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}


/**
 * Compute the timestamp at which step `index` should fire for a given invoice.
 * Returns null if `index` is beyond the configured steps. Anchored to when the
 * invoice was sent (so "3-day friendly nudge" = 3 days after send), lands at
 * 10:00 AM America/New_York regardless of server timezone or DST.
 */
function computeNextTouchAt(anchorDate, stepIndex) {
  const step = config.steps[stepIndex];
  if (!step) return null;
  return anchorTo10amNY(new Date(anchorDate), step.daysAfterSend, config.sendWindow.hour);
}

/**
 * Return a Date that represents {hour}:00 America/New_York on the calendar
 * day that is {daysAfter} days past {anchorDate} (measured in NY local time).
 * DST-safe — probes EDT/EST on the target day and picks the right UTC offset.
 */
function anchorTo10amNY(anchorDate, daysAfter, hour) {
  const nyParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(anchorDate).map((p) => [p.type, p.value])
  );
  // Advance calendar days in UTC math (safe across DST day-length quirks).
  const base = new Date(Date.UTC(+nyParts.year, +nyParts.month - 1, +nyParts.day));
  base.setUTCDate(base.getUTCDate() + daysAfter);
  const y = base.getUTCFullYear(), m = base.getUTCMonth(), d = base.getUTCDate();
  // Probe DST at noon UTC on the target day (always mid-afternoon NY, never ambiguous).
  const probe = new Date(Date.UTC(y, m, d, 12));
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'short',
  }).format(probe).slice(-3); // "EDT" or "EST"
  const offsetHours = tzName === 'EDT' ? 4 : 5;
  return new Date(Date.UTC(y, m, d, hour + offsetHours));
}

/**
 * Create (or re-hydrate) a sequence row for a newly-issued invoice.
 * Call this from the invoice-send flow.
 */
async function scheduleForInvoice(invoiceId) {
  // Cheap unlocked pre-checks: a missing / non-schedulable / payer-billed
  // invoice never arms a sequence, and none of those verdicts can be flipped
  // by an ownership change (a merge moves customer_id, not status or payer).
  // Re-verified
  // under the lock below, so a status change racing this read is caught there.
  const preview = await db('invoices').where({ id: invoiceId }).first();
  if (!preview) return null;
  if (!isSchedulableInvoice(preview)) return null;
  // Third-party Bill-To: the follow-up/dunning sequence emails and texts the
  // homeowner with the pay link, but a payer-billed invoice's AR rolls to the
  // payer's AP inbox — never chase the homeowner for it. Phase 1 has no payer
  // dunning sequence, so we simply don't arm follow-ups for payer invoices.
  if (preview.payer_id) return null;

  // OWNERSHIP IS DERIVED UNDER THE INVOICE LOCK (r19 P1).
  //
  // customer_id used to be captured from the pre-lock read above and then
  // carried through several awaits into the INSERT. Any writer that holds the
  // invoice's lock in between — a customer merge repointing invoices.customer_id
  // is the live one — commits while we wait, after which this insert resumes and
  // arms a sequence owned by the PREVIOUS customer for an invoice that has since
  // moved. The FK is on invoice_id, so nothing rejects it, and the next cron
  // touch duns the wrong customer with the invoice's bearer /pay/:token.
  //
  // The invoice row is the serialization point the whole invoice family already
  // shares (fireStep's claim, InvoiceService.update, stripe-webhook's
  // succeeded-PI handler). Taking it here and deriving customer_id from the
  // POST-lock row is the same settlement-ownership pattern those callers
  // document: we always arm against whoever owns the invoice once the lock is
  // ours. Never a pre-lock copy.
  //
  // Everything under the lock is DB work on this connection (customerOnAutopay
  // takes the trx), so the lock is never held across external I/O.
  return db.transaction(async (trx) => {
    const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
    if (!invoice) return null;
    // Re-verify post-lock: an edit or payment that committed while we waited
    // can have made this invoice non-schedulable or payer-billed.
    if (!isSchedulableInvoice(invoice)) return null;
    if (invoice.payer_id) return null;

    // Existing-row check moved under the lock too: it and the INSERT must be
    // one atomic decision, or two concurrent arms race the unique(invoice_id).
    const existing = await trx('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
    if (existing) {
      // Don't clobber admin-controlled state; just make sure we're aligned.
      if (existing.status === 'stopped' || existing.status === 'completed') return existing;
      return existing;
    }

    const customer = await trx('customers').where({ id: invoice.customer_id }).first();
    const onAutopay = await customerOnAutopay(customer, { db: trx });

    // Anchor the cadence to when the invoice went out. Falls back through
    // sent_at → sms_sent_at → created_at so edge cases (manual-only, email-only,
    // or older rows without sent_at populated) still get scheduled correctly.
    const anchorAt = invoice.sent_at || invoice.sms_sent_at || invoice.created_at;
    const nextAt = computeNextTouchAt(anchorAt, 0);

    const [row] = await trx('invoice_followup_sequences').insert({
      invoice_id: invoiceId,
      customer_id: invoice.customer_id,
      status: onAutopay ? 'autopay_hold' : 'active',
      step_index: 0,
      next_touch_at: onAutopay ? null : nextAt,
      is_autopay_held: !!onAutopay,
    }).returning('*');
    return row;
  });
}

/**
 * Cron entry point — fires all due touches.
 */
async function runPending() {
  const now = new Date();

  // Only run during configured window (double-guard; cron also enforces this)
  const dow = now.getDay();
  if (!config.sendWindow.daysOfWeek.includes(dow)) {
    logger.info('[invoice-followups] outside send window (day); skipping');
    return { sent: 0, skipped: 0 };
  }

  // No deleted-customer filter here: fireStep() pauses those sequences
  // (status='paused', next_touch_at=null) so they're handled terminally
  // rather than staying armed and past-due until a restore fires a
  // stale collection touch.
  const rows = await db('invoice_followup_sequences as s')
    .join('invoices as i', 's.invoice_id', 'i.id')
    .where('s.status', 'active')
    .where('s.next_touch_at', '<=', now)
    .whereNotIn('i.status', TERMINAL_INVOICE_STATUSES)
    // Third-party Bill-To: never dun a payer-billed invoice through this
    // homeowner sequence — fireStep would text the payer's bearer /pay/:token to
    // row.customer_id (the service recipient). scheduleForInvoice already refuses
    // to arm these, but an active row can pre-date the payer (backfill run after
    // payer invoices issued, or an older/manual sequence); exclude them here and
    // guard fireStep too.
    .whereNull('i.payer_id')
    .select(
      's.*',
      'i.id as invoice_id', 'i.token', 'i.title', 'i.total', 'i.credit_applied', 'i.status as invoice_status',
      'i.payer_id as invoice_payer_id', 'i.stripe_payment_intent_id as invoice_stripe_pi',
      'i.service_date', 'i.due_date', 'i.invoice_number',
      'i.sent_at as invoice_sent_at', 'i.sms_sent_at as invoice_sms_sent_at',
      'i.created_at as invoice_created_at',
    );

  let sent = 0, skipped = 0;
  for (const row of rows) {
    try {
      if (row.next_touch_at && isStaleTouch(row.next_touch_at, now)) {
        const skip = await skipStaleTouches(row, now);
        skipped++;
        // The landing step can itself be due THIS run (a step went stale over
        // a weekend and the next one anchors to today) — fire it now, or the
        // next tick would find it past ITS eligible day and stale-skip it too
        // (Codex r1 P2). fireStep revalidates against the just-persisted
        // step/due under the invoice lock, so a concurrent change no-ops.
        if (skip.updated && skip.nextAt
            && skip.nextAt.getTime() <= now.getTime()
            && !isStaleTouch(skip.nextAt, now)) {
          await fireStep({ ...row, step_index: skip.nextIndex, next_touch_at: skip.nextAt });
          sent++;
        }
        continue;
      }
      await fireStep(row);
      sent++;
    } catch (err) {
      logger.error(`[invoice-followups] step fire failed for invoice ${row.invoice_id}: ${err.message}`);
      skipped++;
    }
  }
  logger.info(`[invoice-followups] runPending: ${sent} sent, ${skipped} skipped`);
  return { sent, skipped };
}

// NY weekday of a touch's anchor (touches always sit at 10:00 NY, so the
// short weekday name is unambiguous).
const NY_DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * The earliest tick that was ever allowed to send a touch due at `dueAt`:
 * touches anchor to 10:00 NY on any calendar day, but the cron only runs on
 * sendWindow.daysOfWeek — a Sat/Sun/Mon-anchored touch has always fired on
 * Tuesday. Staleness must be measured from this moment, not the raw due
 * date, or every routine weekend-anchored touch would look days old by its
 * first chance to send and be skipped as stale (Codex r1 P1).
 */
function firstEligibleFireAt(dueAt) {
  let candidate = new Date(dueAt);
  for (let i = 0; i < 7; i++) {
    const dowName = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short',
    }).format(candidate);
    if (config.sendWindow.daysOfWeek.includes(NY_DOW[dowName])) return candidate;
    candidate = anchorTo10amNY(candidate, 1, config.sendWindow.hour);
  }
  return new Date(dueAt);
}

function isStaleTouch(dueAt, now) {
  return now.getTime() - firstEligibleFireAt(dueAt).getTime() > STALE_TOUCH_GRACE_MS;
}

/**
 * Advance a sequence past touches whose eligible send day already passed,
 * without sending them. Walks the same anchored timeline fireTouch advances
 * along until it finds a step still sendable; no sendable step left = completed.
 * The update is a single guarded statement predicated on the batch snapshot
 * (status/step/due unchanged), so it no-ops — and the next tick re-decides —
 * if an admin edit or a manual sendNextTouchNow moved the sequence meanwhile.
 * Deliberately no customer_interactions row: nothing customer-facing happened.
 */
async function skipStaleTouches(row, now) {
  const anchorAt = row.anchor_at || row.invoice_sent_at || row.invoice_sms_sent_at
    || row.invoice_created_at || row.created_at;
  let nextIndex = row.step_index;
  let nextAt = new Date(row.next_touch_at);
  const skippedSteps = [];
  while (nextAt && isStaleTouch(nextAt, now)) {
    skippedSteps.push(config.steps[nextIndex]?.id || `step_${nextIndex}`);
    nextIndex += 1;
    nextAt = computeNextTouchAt(anchorAt, nextIndex);
  }
  const updated = await db('invoice_followup_sequences')
    .where({ id: row.id, status: 'active', step_index: row.step_index })
    .where('next_touch_at', row.next_touch_at)
    .update({
      updated_at: db.fn.now(),
      step_index: nextIndex,
      next_touch_at: nextAt,
      status: nextAt ? 'active' : 'completed',
    });
  if (updated) {
    logger.info(
      `[invoice-followups] skipped stale touch(es) [${skippedSteps.join(', ')}] for invoice ${row.invoice_id} — `
      + `sequence ${nextAt ? `resumes at step ${nextIndex} (${new Date(nextAt).toISOString()})` : 'completed (no future steps)'}`,
    );
  } else {
    logger.info(`[invoice-followups] stale-skip no-op for invoice ${row.invoice_id} — sequence changed since batch select`);
  }
  return { skippedSteps, nextIndex, nextAt: nextAt || null, updated: !!updated };
}

/**
 * Send a single step for one sequence row.
 *
 * Serialized against delivered-invoice edits (2026-07-17 lane): a short
 * claim is stamped on the sequence row before rendering/sending, and
 * InvoiceService.update refuses (pre-check + atomic predicate) while a
 * fresh claim exists — so a reminder can't quote amounts an admin is
 * rewriting mid-send. The claim clears in `finally`; a crashed sender
 * self-heals via the TTL window.
 */
const TOUCH_CLAIM_TTL_MS = 10 * 60 * 1000;
async function fireStep(row, { operatorInitiated = false } = {}) {
  // The cleanup is predicated on OUR stamp: if this send outlives the TTL
  // and another worker replaces the stale claim, an unconditional clear
  // here would release the successor's live claim and let an edit race its
  // in-flight reminder.
  const claimStamp = new Date();
  let claimedSeq = null;
  let claimedInvoice = null;
  try {
    // Claim inside a transaction that locks the INVOICE row first.
    // InvoiceService.update locks the same row before re-checking the claim,
    // so Postgres strictly orders an edit against this claim — without a
    // common row lock, both single-statement writes could pass on
    // pre-commit snapshots of each other. The transaction holds no external
    // work: it commits before any rendering or sending.
    await db.transaction(async (trx) => {
      const lockedInvoice = await trx('invoices')
        .where({ id: row.invoice_id })
        .forUpdate()
        .first();
      if (!lockedInvoice) return;
      // Post-claim... now post-LOCK revalidation: the caller's row is a
      // batch snapshot — a due-date edit (rescheduleForInvoiceEdit, which
      // commits atomically with its invoice edit) can postpone
      // next_touch_at, or an admin can pause/stop/advance the sequence.
      // Fire only if it is still active, on the same step, and actually
      // due; progress from the LIVE anchor so a postponed timeline is
      // never overwritten from the stale snapshot.
      const liveSeq = await trx('invoice_followup_sequences').where({ id: row.id }).first();
      if (
        !liveSeq ||
        liveSeq.status !== 'active' ||
        liveSeq.step_index !== row.step_index ||
        !liveSeq.next_touch_at ||
        new Date(liveSeq.next_touch_at).getTime() > Date.now()
      ) {
        return;
      }
      // OWNERSHIP REVALIDATION UNDER THE LOCK (r19 P1 — customer-facing leak).
      //
      // `row` is a batch snapshot from runPending's join (or sendNextTouchNow's).
      // An ownership change that committed between that SELECT and this lock
      // (a customer merge repoints BOTH the invoice and its sequence) leaves
      // `row.customer_id` naming the previous owner — nothing above re-read it.
      // fireTouch would then render this invoice's bearer /pay/:token and
      // text/email one customer's bill to a DIFFERENT customer.
      //
      // Refuse rather than re-target: an ownership flip means the state this
      // batch row was built from is gone, and re-deriving a send from half-
      // refreshed fields is how the original bug happened. Skipping leaves the
      // sequence active and due, so the next cron pass re-selects it fresh.
      // Sequence and invoice must also agree with EACH OTHER — a split between
      // them is exactly the state the undo's child probe refuses to create, so
      // seeing it here means something else diverged: fail closed.
      if (
        String(liveSeq.customer_id) !== String(row.customer_id) ||
        String(lockedInvoice.customer_id) !== String(row.customer_id)
      ) {
        logger.warn(
          `[invoice-followups] ownership changed under the lock for sequence ${row.id} (invoice ${row.invoice_id}) — skipping this touch; the next run re-selects it fresh`,
        );
        return;
      }
      const claimed = await trx('invoice_followup_sequences')
        .where({ id: row.id })
        .where(function () {
          this.whereNull('touch_claimed_at').orWhere(
            'touch_claimed_at', '<', new Date(claimStamp.getTime() - TOUCH_CLAIM_TTL_MS),
          );
        })
        // The claim stamps updated_at too: "a worker is mid-send on this
        // sequence" is precisely the activity an ownership-change check must
        // see, and
        // it is the backstop for the ownership gate above — a claim taken
        // before the undo's verification pass makes the undo refuse instead of
        // repointing a sequence out from under an in-flight touch.
        .update({ touch_claimed_at: claimStamp, updated_at: trx.fn.now() });
      if (claimed) {
        claimedSeq = liveSeq;
        claimedInvoice = lockedInvoice;
      }
    });
  } catch (err) {
    logger.error(`[invoice-followups] touch claim failed for invoice ${row.invoice_id}: ${err.message}`);
    return;
  }
  if (!claimedSeq) {
    logger.info(`[invoice-followups] sequence ${row.id} in flight or changed after batch select; skipping touch`);
    return;
  }
  // Hand fireTouch POST-LOCK state, not the batch snapshot (r19 P1). The
  // ownership gate above proved customer_id has not moved; these are the
  // remaining send-driving fields the lock proves fresher than the batch
  // select. invoice_payer_id especially: fireTouch's Bill-To guard reads it to
  // decide whether sending would leak the payer's bearer link, and a payer
  // assigned since the batch SELECT would otherwise be invisible to it.
  row.anchor_at = claimedSeq.anchor_at;
  row.customer_id = claimedSeq.customer_id;
  row.invoice_payer_id = claimedInvoice.payer_id ?? null;
  row.invoice_status = claimedInvoice.status;
  row.token = claimedInvoice.token;
  try {
    await fireTouch(row, { operatorInitiated });
  } finally {
    await db('invoice_followup_sequences')
      .where({ id: row.id, touch_claimed_at: claimStamp })
      // Stamped as well, so a send that THREW before reaching any status write
      // still leaves the row looking touched to the undo's activity gate.
      .update({ touch_claimed_at: null, updated_at: db.fn.now() })
      .catch((err) => logger.warn(
        `[invoice-followups] could not clear touch claim for ${row.invoice_id}: ${err.message}`,
      ));
  }
}

async function fireTouch(row, { operatorInitiated = false } = {}) {
  const step = config.steps[row.step_index];
  if (!step) {
    await db('invoice_followup_sequences').where({ id: row.id }).update({
      updated_at: db.fn.now(),
      status: 'completed',
      next_touch_at: null,
    });
    return;
  }

  // Third-party Bill-To: never send a dunning touch for a payer-billed invoice —
  // fireStep builds /pay/:token and texts it to row.customer_id (the homeowner),
  // leaking the payer's bearer pay link. runPending already filters these out;
  // this covers sendNextTouchNow's direct call too. Pause terminally (not a bare
  // return) so a later re-arm can't fire a stale touch. Prefer the selected
  // invoice_payer_id; fall back to a lookup when the caller didn't select it.
  let payerId = row.invoice_payer_id;
  if (payerId === undefined) {
    const inv = await db('invoices').where({ id: row.invoice_id }).first('payer_id').catch(() => null);
    payerId = inv?.payer_id ?? null;
  }
  if (payerId) {
    await db('invoice_followup_sequences').where({ id: row.id }).update({
      updated_at: db.fn.now(),
      status: 'paused',
      next_touch_at: null,
    });
    logger.info(`[invoice-followups] paused sequence ${row.id} — invoice ${row.invoice_id} is billed to a third-party payer`);
    return;
  }

  const customer = await db('customers').where({ id: row.customer_id }).first();
  // Guard every send path (cron runPending filters too, but sendNextTouchNow
  // reaches here directly) — soft-deleted customers get no follow-up touches.
  // Pause rather than bare-return: sendNextTouchNow re-arms the sequence
  // (active + past-due next_touch_at) before calling here, so leaving it
  // active would fire a stale touch if the customer is later restored.
  if (customer?.deleted_at) {
    await db('invoice_followup_sequences').where({ id: row.id }).update({
      updated_at: db.fn.now(),
      status: 'paused',
      next_touch_at: null,
    });
    logger.info(`[invoice-followups] paused sequence ${row.id} — customer ${row.customer_id} is soft-deleted`);
    return;
  }
  // Collections policy — BOTH legs' permissions resolved here, ahead of the
  // account-credit draw (a fully-denied touch must not draw down credit and
  // then need a reversal). Each channel decides independently (codex
  // 2026-08-14: the email leg must not ride the SMS verdict). Gate off ⇒
  // both true without consulting, byte-identical (pinned by test). A policy
  // denial is a TRANSIENT state (frequency window, releasable hold) — a
  // both-denied touch returns with the sequence still active and due, so
  // the next tick re-decides; it is never paused terminally for policy.
  const smsPermitted = await collectionsChannelPermitted(row.customer_id, row.invoice_id, 'sms');
  const emailPermitted = await collectionsChannelPermitted(row.customer_id, row.invoice_id, 'email');
  if (!smsPermitted && !emailPermitted) {
    logger.info(`[invoice-followups] collections policy denied both channels for sequence ${row.id} — touch deferred to a later run`);
    return;
  }
  // Apply any available account credit before dunning so the reminder bills amount
  // due, not the gross balance — credit issued AFTER the invoice was sent isn't drawn
  // down until a payment-ask seam runs, and this dunning touch is one of them. Gated +
  // best-effort + idempotent. Re-read the (possibly reduced) invoice; if credit fully
  // covered it the invoice is now prepaid/paid — stop the sequence instead of dunning.
  // Track what THIS dun drew down so the no-channel-delivered path below can reverse
  // it (don't consume credit for an undelivered reminder; matches the send/project
  // rollback).
  let dunAppliedCredit = 0;
  try {
    const { autoApplyAccountCreditIfEnabled } = require('./customer-credit');
    const dunCreditResult = await autoApplyAccountCreditIfEnabled(row.invoice_id);
    dunAppliedCredit = dunCreditResult?.applied || 0;
  } catch (creditErr) {
    logger.warn(`[invoice-followups] account-credit apply before dun skipped for ${row.invoice_id}: ${creditErr.message}`);
  }
  // The refresh runs in its OWN try: it is what keeps the reminder's
  // amounts/copy on the just-edited live row instead of the batch snapshot
  // (edits are fenced out from the claim onward, so this read is the settled
  // state) — a credit-helper failure above must not bypass it.
  try {
    const fresh = await db('invoices').where({ id: row.invoice_id })
      .first('total', 'credit_applied', 'status', 'title', 'token', 'due_date', 'invoice_number');
    if (fresh) {
      row.total = fresh.total;
      row.credit_applied = fresh.credit_applied;
      row.title = fresh.title;
      row.token = fresh.token;
      row.due_date = fresh.due_date;
      row.invoice_number = fresh.invoice_number;
      if (['prepaid', 'paid'].includes(String(fresh.status || '').toLowerCase())) {
        await stopOnPayment(row.invoice_id).catch(() => {});
        return;
      }
    }
  } catch (refreshErr) {
    logger.warn(`[invoice-followups] invoice refresh before dun failed for ${row.invoice_id}: ${refreshErr.message}`);
  }
  // Dun for amount DUE (total − applied account credit), not the pre-credit total.
  const amount = invoiceAmountDue(row).toFixed(2);
  const serviceDate = row.service_date
    ? new Date(row.service_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
    : '';

  const payUrl = await shortenOrPassthrough(`${publicPortalUrl()}/pay/${row.token}`, {
    kind: 'invoice', entityType: 'invoices', entityId: row.invoice_id, customerId: customer.id,
    codePrefix: invoiceShortCodePrefix(row),
  });
  const ctx = {
    name: customer.first_name || 'there',
    invoiceTitle: row.title || 'your service',
    amount,
    serviceDate,
    payUrl,
    invoiceId: row.invoice_id,
  };

  // Divert micro-deposit-blocked invoices to a verification re-nudge: the customer
  // isn't ignoring the bill, they haven't confirmed their two ACH micro-deposits.
  // Swap this touch's message to the verification copy (SMS-only, matching the
  // webhook's one-time nudge) but keep the cadence so the re-nudge repeats on the
  // normal schedule until the PI clears (then the terminal-status filter stops it).
  const mdPending = gates.divertMicrodepositDunning
    && await StripeService.isInvoiceAwaitingMicrodepositVerification({
      id: row.invoice_id,
      stripe_payment_intent_id: row.invoice_stripe_pi,
    });

  // Email leg — policy-permitted only, with RECORD-THEN-SEND ledger
  // discipline: the collections_contact_ledger row precedes the delivery
  // attempt; an insert failure skips the leg (no unledgered contact, ever),
  // a failed delivery stamps the standing row send_failed.
  const ContactLedger = require('./collections/contact-ledger');
  let emailResult = { ok: false, skipped: true, reason: 'collections_policy_denied' };
  if (emailPermitted) {
    let emailLedger = null;
    try {
      emailLedger = await ContactLedger.recordContact({
        customerId: customer.id,
        channel: 'email',
        purpose: mdPending ? 'payment_verification' : 'invoice_followup',
        invoiceIds: [row.invoice_id],
        source: 'invoice_followups',
        metadata: { step_id: step.id },
      });
    } catch (ledgerErr) {
      emailResult = { ok: false, skipped: true, reason: 'ledger_unavailable' };
      logger.warn(`[invoice-followups] email leg skipped for sequence ${row.id} — contact ledger unavailable: ${ledgerErr.message}`);
    }
    if (emailLedger) {
      emailResult = mdPending
        ? await sendMicrodepositVerificationEmail({
            invoice: { id: row.invoice_id, title: row.title, total: row.total, credit_applied: row.credit_applied },
            customer,
            touchKey: step.id, // one branded verification email per follow-up step (same cadence as the SMS)
          })
        : await sendFollowupEmail({ row, customer, step, ctx });
      if (emailResult?.ok !== true) {
        await ContactLedger.markSendFailed(emailLedger, {
          reason: emailResult?.reason || emailResult?.error || 'email_not_sent',
        });
      }
    }
  }

  let smsSent = false;
  let smsSkipReason = null;
  let smsDeferUntil = null;
  // The held SMS leg failed to reach the scheduled rail: nothing durable
  // owns it, so this touch must stay retryable (codex r21).
  let smsHoldUnowned = false;
  if (!smsPermitted) {
    // Collections policy denial — transient; the no-channel branch below
    // leaves the sequence armed instead of pausing it.
    smsSkipReason = 'collections_policy_denied';
  } else if (customer?.phone) {
    const body = mdPending
      ? await renderSmsTemplate('bank_verification_incomplete', {
          first_name: ctx.name,
          billing_url: `${publicPortalUrl()}/billing`,
        }, { workflow: 'microdeposit_verification_reminder', entity_type: 'invoice', entity_id: row.invoice_id })
      : await resolveBody(step, ctx);
    if (!body) {
      smsSkipReason = 'missing_template';
      logger.warn(`[invoice-followups] template ${step.template_key} missing/disabled for sequence ${row.id}`);
    } else {
      // RECORD-THEN-SEND: the ledger row precedes the SMS attempt; an
      // insert failure skips the send (no unledgered contact, ever).
      let smsLedger = null;
      try {
        smsLedger = await ContactLedger.recordContact({
          customerId: customer.id,
          channel: 'sms',
          purpose: mdPending ? 'payment_verification' : 'invoice_followup',
          invoiceIds: [row.invoice_id],
          source: 'invoice_followups',
          metadata: { step_id: step.id },
        });
      } catch (ledgerErr) {
        smsSkipReason = 'ledger_unavailable';
        logger.warn(`[invoice-followups] SMS leg skipped for sequence ${row.id} — contact ledger unavailable: ${ledgerErr.message}`);
      }
      const sendResult = smsLedger ? await sendCustomerMessage({
        to: customer.phone,
        body,
        channel: 'sms',
        audience: 'customer',
        purpose: 'payment_link',
        customerId: customer.id,
        invoiceId: row.invoice_id,
        entryPoint: 'invoice_followup_sequence',
        // Send-window operator marker: only the admin "send now" route sets
        // it (an operator clicked THIS touch at this moment); the 10:16 ET
        // cron path stays fenced.
        ...(operatorInitiated ? { operatorInitiated: true } : {}),
        metadata: { original_message_type: 'invoice_followup' },
      }) : null;
      if (sendResult && (sendResult.blocked || sendResult.sent === false)) {
        await ContactLedger.markSendFailed(smsLedger, { code: sendResult.code || 'sms_blocked' });
        smsSkipReason = sendResult.code || 'sms_blocked';
        // Send-window block (this cron runs hourly, incl. nights): not a
        // delivery failure — remember the window open so the no-channel
        // branch below defers the touch instead of pausing the sequence.
        if (sendResult.code === 'QUIET_HOURS_HOLD' && sendResult.nextAllowedAt) {
          const at = new Date(sendResult.nextAllowedAt);
          if (!Number.isNaN(at.getTime())) smsDeferUntil = at;
          // Email already carried this touch: the no-channel defer below
          // won't run and step_index advances, so the held SMS leg must be
          // persisted NOW or it is never retried. Queue the exact rendered
          // body on the scheduled-SMS rail for the window open — one
          // enqueue per touch fire. An enqueue FAILURE leaves the pay-link
          // text with no owner at all, so the step is held back for a
          // retry instead of advancing (the email's per-step idempotency
          // key dedupes its leg on the re-fire).
          if (smsDeferUntil && emailResult.ok) {
            try {
              const TWILIO_NUMBERS = require('../config/twilio-numbers');
              await db('sms_log').insert({
                customer_id: customer.id,
                direction: 'outbound',
                from_phone: TWILIO_NUMBERS.getOutboundNumber(),
                to_phone: customer.phone,
                message_body: body,
                status: 'scheduled',
                scheduled_for: smsDeferUntil,
                message_type: 'invoice_followup',
                metadata: JSON.stringify({
                  entry_point: 'invoice_followup_deferred',
                  invoice_id: row.invoice_id,
                  customer_id: customer.id,
                  // Minted ONCE at enqueue: the replay's delivery-time
                  // ledger reservation is keyed to it, so executor retries
                  // of this same queued row can never double-count.
                  ledger_reservation_key: require('crypto').randomUUID(),
                  followup_sequence_id: row.id,
                  original_block_code: sendResult.code,
                  replay_purpose: 'payment_link',
                  // The amount the frozen body NAMES (codex r27): credit
                  // applied/reversed overnight changes the balance while
                  // the invoice stays collectible — the replay suppresses
                  // on mismatch and the sequence's next touch re-renders.
                  rendered_amount: amount,
                  refresh_customer_phone: true,
                  resolve_from_by_customer: true,
                }),
              });
              logger.info(`[invoice-followups] SMS leg of sequence ${row.id} held outside the 8AM-8PM ET send window — queued for ${smsDeferUntil.toISOString()} (email leg delivered)`);
            } catch (queueErr) {
              smsHoldUnowned = true;
              logger.error(`[invoice-followups] Held SMS requeue failed for sequence ${row.id}: ${queueErr.message} — holding the step for retry at the window open (email leg already delivered, idempotency-keyed)`);
            }
          }
        }
        logger.warn(`[invoice-followups] SMS blocked for sequence ${row.id}: ${sendResult.code || 'unknown'} ${sendResult.reason || ''}`);
      } else if (sendResult) {
        smsSent = true;
      }
    }
  } else {
    smsSkipReason = 'no_customer_phone';
    logger.warn(`[invoice-followups] no phone for customer ${row.customer_id}`);
  }

  if (!smsSent && !emailResult.ok) {
    if (smsDeferUntil) {
      // Nothing failed — the touch fired outside the 8AM-8PM ET send
      // window and no email leg covered it. Keep the sequence active and
      // move ONLY this touch to the window open; the same step re-fires at
      // 8:00 AM with a fresh credit draw (tonight's is reversed below,
      // same as the pause branch — nothing was delivered).
      await db('invoice_followup_sequences').where({ id: row.id }).update({
        updated_at: db.fn.now(),
        next_touch_at: smsDeferUntil,
      });
    } else if (
      ['collections_policy_denied', 'ledger_unavailable'].includes(smsSkipReason)
      || ['collections_policy_denied', 'ledger_unavailable'].includes(emailResult.reason)
    ) {
      // Transient collections-policy denial / ledger outage — NOT a
      // delivery failure. Leave the sequence armed and due (no status
      // write) so a later tick re-decides; pausing terminally here would
      // turn a 24h frequency window into a permanently silenced sequence.
      logger.info(`[invoice-followups] touch for sequence ${row.id} held by collections policy/ledger — retrying on a later run`);
    } else {
      await db('invoice_followup_sequences').where({ id: row.id }).update({
        updated_at: db.fn.now(),
        status: 'paused',
        paused_reason: smsSkipReason || emailResult.reason || emailResult.error || 'no_channel_delivered',
        next_touch_at: null,
      });
    }
    // No reminder went out — reverse the credit THIS dun drew down so we don't consume
    // it for an undelivered touch (matches the invoice/project send rollback). Only
    // this dun's increment; any prior applied credit stays. The invoice is collectible
    // here, so reverseAppliedCredit (which refuses 'sending'/'prepaid') applies.
    if (dunAppliedCredit > 0) {
      try {
        const { reverseAppliedCredit } = require('./customer-credit');
        await reverseAppliedCredit({ invoiceId: row.invoice_id, amount: dunAppliedCredit, createdBy: 'system:dun_undelivered' });
      } catch (e) {
        logger.warn(`[invoice-followups] credit reversal after undelivered dun skipped for ${row.invoice_id}: ${e.message}`);
      }
    }
    return;
  }

  // Held SMS with no durable owner (codex r21): the email carried its own
  // leg, but advancing step_index here would retire a pay-link text that
  // was never queued and is never retried. Keep THIS step current and move
  // the touch to the window open — the re-fire re-renders the SMS and
  // re-attempts the enqueue, while the email's per-step idempotency key
  // (invoice_followup_email:<invoice>:<step>) suppresses a second email.
  // No credit reversal: unlike the nothing-delivered defer above, the email
  // leg DID deliver against this draw.
  if (smsHoldUnowned && smsDeferUntil) {
    await db('invoice_followup_sequences').where({ id: row.id }).update({
      updated_at: db.fn.now(),
      next_touch_at: smsDeferUntil,
    });
    logger.warn(`[invoice-followups] sequence ${row.id} step ${row.step_index} held at its current index — the deferred SMS leg never reached the rail; retrying at ${smsDeferUntil.toISOString()}`);
    return;
  }

  const nextIndex = row.step_index + 1;
  // anchor_at (set when an admin edit shifted the due date) overrides the
  // send-time anchor so the whole remaining cadence stays on one timeline.
  const anchorAt = row.anchor_at || row.invoice_sent_at || row.invoice_sms_sent_at || row.invoice_created_at || row.created_at;
  const nextAt = computeNextTouchAt(anchorAt, nextIndex);

  await db('invoice_followup_sequences').where({ id: row.id }).update({
    updated_at: db.fn.now(),
    touches_sent: row.touches_sent + 1,
    step_index: nextIndex,
    last_touch_at: new Date(),
    next_touch_at: nextAt,
    status: nextAt ? 'active' : 'completed',
  });

  // (Contact-ledger rows were written BEFORE each leg's delivery attempt —
  // record-then-send, codex 2026-08-14 — so there is nothing to record here.)

  // Log to customer_interactions for the 360 view
  try {
    await db('customer_interactions').insert({
      customer_id: customer.id,
      interaction_type: 'sms_outbound',
      subject: `Invoice follow-up — ${step.label} (${row.invoice_number || row.invoice_id})`,
      body: `Step ${row.step_index + 1}/${config.steps.length} fired. Amount: $${amount}.`,
      metadata: JSON.stringify({
        invoice_id: row.invoice_id,
        step_id: step.id,
        step_index: row.step_index,
        sms_sent: smsSent,
        email_sent: !!emailResult.ok,
        email_reason: emailResult.reason || emailResult.error || null,
      }),
    });
  } catch { /* non-critical */ }
}

/**
 * Called from the Stripe webhook the instant an invoice is paid.
 * Marks the sequence completed and optionally sends a thank-you.
 */
async function stopOnPayment(invoiceId) {
  const seq = await db('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
  if (!seq) return;
  if (seq.status === 'completed' || seq.status === 'stopped') return;

  const sentAReminder = seq.touches_sent > 0;

  await db('invoice_followup_sequences').where({ id: seq.id }).update({
    updated_at: db.fn.now(),
    status: 'completed',
    next_touch_at: null,
  });

  if (sentAReminder && config.thankYou.enabled) {
    try {
      const customer = await db('customers').where({ id: seq.customer_id }).first();
      const invoice = await db('invoices').where({ id: invoiceId }).first();
      if (customer?.phone) {
        const payUrl = invoice?.token
          ? await shortenOrPassthrough(`${publicPortalUrl()}/pay/${invoice.token}`, {
              kind: 'invoice',
              entityType: 'invoices',
              entityId: invoice.id,
              customerId: customer.id,
              codePrefix: invoiceShortCodePrefix(invoice),
            })
          : '';
        const body = await resolveBody(config.thankYou, {
          name: customer.first_name,
          payUrl,
        });
        if (!body) {
          logger.warn(`[invoice-followups] thank-you template ${config.thankYou.template_key} missing/disabled — skipping for invoice ${invoiceId}`);
        } else {
          const sendResult = await sendCustomerMessage({
            to: customer.phone,
            body,
            channel: 'sms',
            audience: 'customer',
            purpose: 'payment_receipt',
            customerId: customer.id,
            invoiceId,
            entryPoint: 'invoice_followup_thank_you',
            metadata: { original_message_type: 'invoice_thank_you' },
          });
          if (sendResult.blocked || sendResult.sent === false) {
            // Send-window hold: this is event-driven (the payment just
            // landed) and the sequence is already marked completed —
            // nothing retries, so queue the thank-you for 8:00 AM. A paid
            // invoice's acknowledgment can't go stale, so no recheck.
            if (sendResult.code === 'QUIET_HOURS_HOLD' && sendResult.deferred && sendResult.nextAllowedAt) {
              try {
                const TWILIO_NUMBERS = require('../config/twilio-numbers');
                await db('sms_log').insert({
                  customer_id: customer.id,
                  direction: 'outbound',
                  from_phone: TWILIO_NUMBERS.getOutboundNumber(),
                  to_phone: customer.phone,
                  message_body: body,
                  status: 'scheduled',
                  scheduled_for: new Date(sendResult.nextAllowedAt),
                  message_type: 'invoice_thank_you',
                  metadata: JSON.stringify({
                    entry_point: 'invoice_followup_thank_you_deferred',
                    invoice_id: invoiceId,
                    original_block_code: sendResult.code,
                    replay_purpose: 'payment_receipt',
                    refresh_customer_phone: true,
                    resolve_from_by_customer: true,
                  }),
                });
                logger.info(`[invoice-followups] thank-you SMS for invoice ${invoiceId} held outside the 8AM-8PM ET send window — queued for ${sendResult.nextAllowedAt}`);
              } catch (queueErr) {
                logger.error(`[invoice-followups] held thank-you requeue failed for invoice ${invoiceId}: ${queueErr.message}`);
              }
            } else {
              logger.warn(`[invoice-followups] thank-you SMS blocked for invoice ${invoiceId}: ${sendResult.code || 'unknown'} ${sendResult.reason || ''}`);
            }
          }
        }
      }
    } catch (err) {
      logger.error(`[invoice-followups] thank-you SMS failed: ${err.message}`);
    }
  }
}

/**
 * Release an autopay-held sequence into the active queue — call from the
 * ACH failure handler after failures cross the threshold.
 */
async function releaseFromAutopayHold(invoiceId) {
  const seq = await db('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
  if (!seq || seq.status !== 'autopay_hold') return;

  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice || isTerminalInvoice(invoice)) return;

  await db('invoice_followup_sequences').where({ id: seq.id }).update({
    updated_at: db.fn.now(),
    status: 'active',
    is_autopay_held: false,
    // A shifted anchor (delivered-invoice due-date edit while held) wins so
    // the re-armed step lands on the same timeline fireStep progression uses.
    next_touch_at: computeNextTouchAt(seq.anchor_at || invoice.due_date || invoice.created_at, seq.step_index),
  });
}

/**
 * Called per-customer when autopay fails — bumps the counter on every
 * active autopay-held sequence for that customer, and releases any whose
 * count has crossed the threshold.
 */
async function handleAutopayFailure(customerId) {
  const rows = await db('invoice_followup_sequences')
    .where({ customer_id: customerId, status: 'autopay_hold' })
    .select('*');

  for (const row of rows) {
    const nextCount = row.autopay_failures_observed + 1;
    if (nextCount >= config.autopayFailureThreshold) {
      await releaseFromAutopayHold(row.invoice_id);
    } else {
      await db('invoice_followup_sequences').where({ id: row.id }).update({
        updated_at: db.fn.now(),
        autopay_failures_observed: nextCount,
      });
    }
  }
}

/**
 * Admin controls — called from the invoice detail UI.
 */
async function pauseSequence(invoiceId, { reason, until, adminId } = {}) {
  await db('invoice_followup_sequences').where({ invoice_id: invoiceId }).update({
    updated_at: db.fn.now(),
    status: 'paused',
    paused_reason: reason || null,
    paused_until: until || null,
    paused_by_admin_id: adminId || null,
    next_touch_at: null,
  });
}

async function resumeSequence(invoiceId) {
  const seq = await db('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
  if (!seq) return;
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice || isTerminalInvoice(invoice)) return;
  await db('invoice_followup_sequences').where({ id: seq.id }).update({
    updated_at: db.fn.now(),
    status: 'active',
    paused_reason: null,
    paused_until: null,
    paused_by_admin_id: null,
    // A shifted anchor (delivered-invoice due-date edit while paused) wins so
    // the re-armed step lands on the same timeline fireStep progression uses.
    next_touch_at: computeNextTouchAt(seq.anchor_at || invoice.due_date || invoice.created_at, seq.step_index),
  });
}

/**
 * Shift an ACTIVE sequence's whole timeline after an admin edits a
 * delivered invoice's due date (the 2026-07-17 ruling made
 * sent/viewed/overdue invoices editable). Moving the due date +N days
 * moves the cadence anchor +N days and stamps it on the row
 * (`anchor_at`), so BOTH the current touch and every later step (fireStep
 * progression reads anchor_at first) stay on one shifted timeline —
 * re-anchoring only the current step would leave progression computing
 * later steps from sent_at in the past and burst the remaining reminders
 * on consecutive cron runs. Paused / autopay-held rows shift the anchor
 * but keep next_touch_at null until their release paths re-arm them;
 * stopped / completed rows are terminal and untouched.
 */
async function rescheduleForInvoiceEdit(invoiceId, { previousDueDate, newDueDate } = {}, dbc = db) {
  const dayMs = 24 * 60 * 60 * 1000;
  const prev = previousDueDate ? new Date(previousDueDate) : null;
  const next = newDueDate ? new Date(newDueDate) : null;
  if (!prev || !next || Number.isNaN(prev.getTime()) || Number.isNaN(next.getTime())) return;
  const deltaDays = Math.round((next.getTime() - prev.getTime()) / dayMs);
  if (!deltaDays) return;

  // Paused / autopay-held sequences shift their anchor too — their release
  // paths re-arm the CURRENT step themselves, but fireStep progression
  // computes later steps from anchor_at, and a stale anchor would land those
  // in the past and burst them on consecutive cron runs. Only an active
  // sequence carries a scheduled next touch; held/paused rows keep
  // next_touch_at null until released. Stopped/completed are terminal.
  const RESCHEDULABLE_STATUSES = ['active', 'paused', 'autopay_hold'];
  const seq = await dbc('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
  if (!seq || !RESCHEDULABLE_STATUSES.includes(seq.status)) return;
  const invoice = await dbc('invoices').where({ id: invoiceId }).first();
  if (!invoice || isTerminalInvoice(invoice)) return;

  const baseAnchor = seq.anchor_at || invoice.sent_at || invoice.sms_sent_at || invoice.created_at;
  const shiftedAnchor = shiftAnchorNYCalendarDays(new Date(baseAnchor), deltaDays);
  const patch = { anchor_at: shiftedAnchor };
  if (seq.status === 'active') {
    patch.next_touch_at = computeNextTouchAt(shiftedAnchor, seq.step_index);
  }
  await dbc('invoice_followup_sequences').where({ id: seq.id })
    .update({ ...patch, updated_at: dbc.fn.now() });
}

/**
 * Advance an anchor by N America/New_York CALENDAR days. The cadence only
 * consumes an anchor's NY calendar date (anchorTo10amNY), so the shifted
 * anchor is pinned to noon UTC of the target day — fixed 24-hour arithmetic
 * would move a near-midnight anchor across the spring DST boundary onto the
 * wrong Eastern date and delay every remaining reminder by a day.
 */
function shiftAnchorNYCalendarDays(anchorDate, days) {
  const nyParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(anchorDate).map((p) => [p.type, p.value])
  );
  const base = new Date(Date.UTC(+nyParts.year, +nyParts.month - 1, +nyParts.day, 12));
  base.setUTCDate(base.getUTCDate() + days);
  return base;
}

async function stopSequence(invoiceId, { reason, adminId } = {}) {
  // "Stop dunning" also means "don't force-collect on the pay page"
  // (payIncludeBalance): if this invoice rides another invoice's combined
  // PaymentIntent as a SIBLING, release that session — cancel the PI while
  // it is still unconfirmed and clear its stamps, so a customer mid-pay
  // reloads to a fresh total without this invoice instead of charging it
  // after the stop (codex #3427 r4 P1: the money-seam locks can't see a
  // stop that lands between the last verification and the browser's
  // confirm). Money already in flight (processing/succeeded) is never
  // touched — the stop can't retract a confirmed payment.
  //
  // FAIL CLOSED, release BEFORE the stop (codex r5 P1): the browser can
  // call Stripe confirmPayment directly with no later server verification,
  // so a swallowed cancel failure would report the stop as done while the
  // confirmable PI (post /update-amount) can still charge the stopped
  // invoice. The stop must not acknowledge until the release succeeds —
  // an unreadable PI throws too (it could be a combined session), and the
  // admin simply retries the stop.
  // The whole stop runs in ONE transaction holding the pay.combined.customer
  // advisory lock (codex r10 P1): without it, a combined /setup between this
  // PI read and the sequence commit could stamp the siblings AFTER the scan
  // saw no PI but BEFORE the stop landed — setup's stopped-dunning check
  // would pass and the customer could confirm a PI that still includes the
  // newly stopped invoice. Under the shared lock the stop and any setup are
  // strictly ordered: setup first → the release below cancels its PI; stop
  // first → setup's in-lock stopped-dunning re-check excludes the invoice.
  const invoice = await db('invoices').where({ id: invoiceId }).first('id', 'customer_id', 'stripe_payment_intent_id', 'invoice_number');
  await db.transaction(async (trx) => {
    const PayCombined = require('./pay-combined');
    // The pre-transaction customer read can be OBSOLETE (codex r22 P1): a
    // merge holding both combined locks but not yet committed still shows
    // the loser's customer_id — locking that would serialize against the
    // wrong customer while /setup locks the winner. Re-read the owner
    // AFTER each lock and re-lock under the current owner if it moved
    // (xact locks accumulate, so old+new both stay held — strictly safer).
    if (invoice?.customer_id) {
      let ownerId = String(invoice.customer_id);
      for (let attempt = 0; ; attempt++) {
        await PayCombined.lockCombinedCustomers(trx, [ownerId]);
        const freshOwner = await trx('invoices').where({ id: invoiceId }).first('customer_id');
        const freshId = freshOwner?.customer_id ? String(freshOwner.customer_id) : null;
        if (!freshId || freshId === ownerId) break;
        if (attempt >= 4) throw new Error(`Invoice ownership kept changing while stopping dunning for ${invoiceId} — try again`);
        ownerId = freshId;
      }
    }
    // Re-read under the lock — a setup that committed while we waited may
    // have stamped a PI the unlocked read missed.
    const lockedInvoice = invoice
      ? await trx('invoices').where({ id: invoiceId }).first('id', 'stripe_payment_intent_id', 'invoice_number')
      : null;
    if (lockedInvoice?.stripe_payment_intent_id) {
      const StripeService = require('./stripe');
      let pi;
      try {
        pi = await StripeService.retrievePaymentIntent(lockedInvoice.stripe_payment_intent_id);
      } catch (err) {
        throw new Error(`Could not verify invoice ${lockedInvoice.invoice_number}'s active payment before stopping dunning (${err.message}) — try again`);
      }
      // Null = Stripe unconfigured, not "no session" (codex r23 P1): the
      // attached PI may be a live combined session a browser can still
      // confirm — the stop must not acknowledge past an unverifiable one.
      if (!pi) {
        throw new Error(`Could not verify invoice ${lockedInvoice.invoice_number}'s active payment before stopping dunning (payment service unavailable) — try again`);
      }
      const isSiblingOnCombined = pi
        && PayCombined.isCombinedPiMetadata(pi.metadata)
        && String(pi.metadata?.waves_invoice_id || '') !== String(invoiceId)
        && PayCombined.paymentIntentOwnsInvoice(pi.metadata, invoiceId);
      // NO microdeposit exemption (codex r11 P1): this release only fires
      // for a SIBLING riding someone else's combined PI — the stop is an
      // explicit "don't collect this invoice", and a pending bank
      // verification is still an uncaptured session that would charge the
      // stopped sibling once verified. Cancel it like the payer-change
      // fence does; only processing/succeeded money is left alone.
      const unconfirmed = pi && ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status);
      if (isSiblingOnCombined && unconfirmed) {
        try {
          await StripeService.cancelPaymentIntent(pi.id);
        } catch (err) {
          throw new Error(`Could not release the combined payment session holding invoice ${lockedInvoice.invoice_number} (${err.message}) — dunning NOT stopped, try again`);
        }
        await PayCombined.clearPaymentIntentStamps(trx, pi.id);
        logger.info(`[invoice-followups] stop-dunning on ${lockedInvoice.invoice_number} released combined PI ${pi.id} (unconfirmed) and cleared its stamps`);
      } else if (isSiblingOnCombined) {
        logger.warn(`[invoice-followups] stop-dunning on ${lockedInvoice.invoice_number}: combined PI ${pi.id} is ${pi.status} — money may be in flight, not touched`);
      }
    }
    await trx('invoice_followup_sequences').where({ invoice_id: invoiceId }).update({
      updated_at: trx.fn.now(),
      status: 'stopped',
      stopped_reason: reason || null,
      stopped_by_admin_id: adminId || null,
      next_touch_at: null,
    });
  });
}

/**
 * Send the next touch right now, even if it's not due yet. Virginia uses this
 * when a customer is dodging (e.g. "push them to day-14 language today").
 */
async function sendNextTouchNow(invoiceId, { operatorInitiated = false } = {}) {
  const seq = await db('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
  if (!seq || seq.status === 'stopped' || seq.status === 'completed') return;

  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice || isTerminalInvoice(invoice)) return;

  // Temporarily set next_touch_at in the past + status active, then fire
  await db('invoice_followup_sequences').where({ id: seq.id }).update({
    updated_at: db.fn.now(),
    status: 'active',
    next_touch_at: new Date(Date.now() - 1000),
  });

  const row = await db('invoice_followup_sequences as s')
    .join('invoices as i', 's.invoice_id', 'i.id')
    .where('s.id', seq.id)
    .select(
      's.*',
      'i.id as invoice_id', 'i.token', 'i.title', 'i.total', 'i.credit_applied',
      'i.stripe_payment_intent_id as invoice_stripe_pi',
      'i.service_date', 'i.due_date', 'i.invoice_number',
    )
    .first();

  if (row) await fireStep(row, { operatorInitiated });
}

/**
 * Called by late-payment-checker.js to decide whether an invoice is already
 * handled by the per-invoice sequence (so we skip the account-level reminder).
 */
async function hasActiveSequence(invoiceId) {
  const seq = await db('invoice_followup_sequences')
    .where({ invoice_id: invoiceId })
    .whereIn('status', ['active', 'paused', 'autopay_hold'])
    .first();
  return !!seq;
}

/**
 * True when an admin has explicitly STOPPED this invoice's follow-up sequence.
 * A stop is a deliberate "stop all automated dunning for this invoice" instruction
 * (e.g. customer is paying by mailed check). The account-level late-payment-checker
 * must honor it too — otherwise stopping follow-ups in the invoice UI silently hands
 * the customer off to the legacy reminder path and they keep getting "X days overdue"
 * texts. `hasActiveSequence` deliberately excludes 'stopped' (a stopped sequence is no
 * longer "active"/handling the invoice), so this is a separate, explicit check.
 */
async function isDunningStopped(invoiceId) {
  const seq = await db('invoice_followup_sequences')
    .where({ invoice_id: invoiceId, status: 'stopped' })
    .first();
  return !!seq;
}

module.exports = {
  scheduleForInvoice,
  runPending,
  // Used by the scheduled-SMS executor to suppress stale deferred
  // invoice/dunning replays (paid/void overnight).
  isTerminalInvoice,
  stopOnPayment,
  releaseFromAutopayHold,
  handleAutopayFailure,
  pauseSequence,
  resumeSequence,
  rescheduleForInvoiceEdit,
  stopSequence,
  sendNextTouchNow,
  hasActiveSequence,
  isDunningStopped,
  skipStaleTouches,
  firstEligibleFireAt,
  STALE_TOUCH_GRACE_MS,
};
