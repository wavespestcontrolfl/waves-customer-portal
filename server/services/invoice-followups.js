/**
 * Per-Invoice Follow-up Sequence Engine
 *
 * Each unpaid invoice has one row in `invoice_followup_sequences` that tracks
 * which step fires next and when. The cron calls `runPending()` Tue–Fri at
 * 10 AM to send due touches. The Stripe webhook calls `stopOnPayment()` the
 * instant payment succeeds — no "thanks for paying" + "you owe us" crossing.
 *
 * See server/config/invoice-followups.js for step timing + copy.
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
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice) return null;
  if (!isSchedulableInvoice(invoice)) return null;
  // Third-party Bill-To: the follow-up/dunning sequence emails and texts the
  // homeowner with the pay link, but a payer-billed invoice's AR rolls to the
  // payer's AP inbox — never chase the homeowner for it. Phase 1 has no payer
  // dunning sequence, so we simply don't arm follow-ups for payer invoices.
  if (invoice.payer_id) return null;

  const customer = await db('customers').where({ id: invoice.customer_id }).first();
  const onAutopay = await customerOnAutopay(customer);

  // Anchor the cadence to when the invoice went out. Falls back through
  // sent_at → sms_sent_at → created_at so edge cases (manual-only, email-only,
  // or older rows without sent_at populated) still get scheduled correctly.
  const anchorAt = invoice.sent_at || invoice.sms_sent_at || invoice.created_at;
  const nextAt = computeNextTouchAt(anchorAt, 0);

  const existing = await db('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
  if (existing) {
    // Don't clobber admin-controlled state; just make sure we're aligned.
    if (existing.status === 'stopped' || existing.status === 'completed') return existing;
    return existing;
  }

  const [row] = await db('invoice_followup_sequences').insert({
    invoice_id: invoiceId,
    customer_id: invoice.customer_id,
    status: onAutopay ? 'autopay_hold' : 'active',
    step_index: 0,
    next_touch_at: onAutopay ? null : nextAt,
    is_autopay_held: !!onAutopay,
  }).returning('*');
  return row;
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

/**
 * Send a single step for one sequence row.
 */
async function fireStep(row) {
  const step = config.steps[row.step_index];
  if (!step) {
    await db('invoice_followup_sequences').where({ id: row.id }).update({
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
      status: 'paused',
      next_touch_at: null,
    });
    logger.info(`[invoice-followups] paused sequence ${row.id} — customer ${row.customer_id} is soft-deleted`);
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
    const fresh = await db('invoices').where({ id: row.invoice_id }).first('total', 'credit_applied', 'status');
    if (fresh) {
      row.total = fresh.total;
      row.credit_applied = fresh.credit_applied;
      if (['prepaid', 'paid'].includes(String(fresh.status || '').toLowerCase())) {
        await stopOnPayment(row.invoice_id).catch(() => {});
        return;
      }
    }
  } catch (creditErr) {
    logger.warn(`[invoice-followups] account-credit apply before dun skipped for ${row.invoice_id}: ${creditErr.message}`);
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

  const emailResult = mdPending
    ? await sendMicrodepositVerificationEmail({
        invoice: { id: row.invoice_id, title: row.title, total: row.total, credit_applied: row.credit_applied },
        customer,
        touchKey: step.id, // one branded verification email per follow-up step (same cadence as the SMS)
      })
    : await sendFollowupEmail({ row, customer, step, ctx });

  let smsSent = false;
  let smsSkipReason = null;
  if (customer?.phone) {
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
      const sendResult = await sendCustomerMessage({
        to: customer.phone,
        body,
        channel: 'sms',
        audience: 'customer',
        purpose: 'payment_link',
        customerId: customer.id,
        invoiceId: row.invoice_id,
        entryPoint: 'invoice_followup_sequence',
        metadata: { original_message_type: 'invoice_followup' },
      });
      if (sendResult.blocked || sendResult.sent === false) {
        smsSkipReason = sendResult.code || 'sms_blocked';
        logger.warn(`[invoice-followups] SMS blocked for sequence ${row.id}: ${sendResult.code || 'unknown'} ${sendResult.reason || ''}`);
      } else {
        smsSent = true;
      }
    }
  } else {
    smsSkipReason = 'no_customer_phone';
    logger.warn(`[invoice-followups] no phone for customer ${row.customer_id}`);
  }

  if (!smsSent && !emailResult.ok) {
    await db('invoice_followup_sequences').where({ id: row.id }).update({
      status: 'paused',
      paused_reason: smsSkipReason || emailResult.reason || emailResult.error || 'no_channel_delivered',
      next_touch_at: null,
    });
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

  const nextIndex = row.step_index + 1;
  const anchorAt = row.invoice_sent_at || row.invoice_sms_sent_at || row.invoice_created_at || row.created_at;
  const nextAt = computeNextTouchAt(anchorAt, nextIndex);

  await db('invoice_followup_sequences').where({ id: row.id }).update({
    touches_sent: row.touches_sent + 1,
    step_index: nextIndex,
    last_touch_at: new Date(),
    next_touch_at: nextAt,
    status: nextAt ? 'active' : 'completed',
  });

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
            logger.warn(`[invoice-followups] thank-you SMS blocked for invoice ${invoiceId}: ${sendResult.code || 'unknown'} ${sendResult.reason || ''}`);
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
    status: 'active',
    is_autopay_held: false,
    next_touch_at: computeNextTouchAt(invoice.due_date || invoice.created_at, seq.step_index),
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
    status: 'active',
    paused_reason: null,
    paused_until: null,
    paused_by_admin_id: null,
    next_touch_at: computeNextTouchAt(invoice.due_date || invoice.created_at, seq.step_index),
  });
}

async function stopSequence(invoiceId, { reason, adminId } = {}) {
  await db('invoice_followup_sequences').where({ invoice_id: invoiceId }).update({
    status: 'stopped',
    stopped_reason: reason || null,
    stopped_by_admin_id: adminId || null,
    next_touch_at: null,
  });
}

/**
 * Send the next touch right now, even if it's not due yet. Virginia uses this
 * when a customer is dodging (e.g. "push them to day-14 language today").
 */
async function sendNextTouchNow(invoiceId) {
  const seq = await db('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
  if (!seq || seq.status === 'stopped' || seq.status === 'completed') return;

  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice || isTerminalInvoice(invoice)) return;

  // Temporarily set next_touch_at in the past + status active, then fire
  await db('invoice_followup_sequences').where({ id: seq.id }).update({
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

  if (row) await fireStep(row);
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
  stopOnPayment,
  releaseFromAutopayHold,
  handleAutopayFailure,
  pauseSequence,
  resumeSequence,
  stopSequence,
  sendNextTouchNow,
  hasActiveSequence,
  isDunningStopped,
};
