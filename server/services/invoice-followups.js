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
const TwilioService = require('./twilio');
const config = require('../config/invoice-followups');

const DOMAIN = process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com';

/**
 * Merge template variables into the body.
 */
function renderBody(template, ctx) {
  return template
    .replace(/\{\{name\}\}/g, ctx.name || 'there')
    .replace(/\{\{invoiceTitle\}\}/g, ctx.invoiceTitle || 'your service')
    .replace(/\{\{amount\}\}/g, ctx.amount || '0.00')
    .replace(/\{\{payUrl\}\}/g, ctx.payUrl || '')
    .replace(/\{\{serviceDate\}\}/g, ctx.serviceDate || '')
    .replace(/\{\{serviceDateClause\}\}/g, ctx.serviceDate ? ` completed on ${ctx.serviceDate}` : '');
}

/**
 * Compute the timestamp at which step `index` should fire for a given invoice.
 * Returns null if `index` is beyond the configured steps.
 */
function computeNextTouchAt(dueDate, stepIndex) {
  const step = config.steps[stepIndex];
  if (!step) return null;
  const d = new Date(dueDate);
  d.setDate(d.getDate() + step.daysAfterDue);
  // Anchor to 10 AM ET on the target day
  d.setHours(config.sendWindow.hour, 0, 0, 0);
  return d;
}

/**
 * Determine whether a customer is on autopay for this invoice.
 * Must have autopay_enabled AND a saved payment method that can actually be
 * charged. If ACH is suspended/needs_verification we still treat them as
 * autopay-held only if there's a card fallback — otherwise they need manual
 * reminders.
 */
async function customerOnAutopay(customer) {
  if (!customer) return false;
  if (customer.autopay_enabled === false) return false;
  if (customer.autopay_paused_until && new Date(customer.autopay_paused_until) > new Date()) {
    return false;
  }
  // Need an actual payment method on file
  const hasPM =
    !!customer.autopay_payment_method_id ||
    !!customer.stripe_default_payment_method_id;
  if (!hasPM) {
    // Fallback: check payment_methods table directly
    try {
      const pm = await db('payment_methods')
        .where({ customer_id: customer.id })
        .andWhere(function () { this.where('is_default', true).orWhere('autopay_enabled', true); })
        .first();
      if (!pm) return false;
    } catch { return false; }
  }
  // ACH suspended/needs_verification → not autopay-eligible unless they also have a card
  if (customer.ach_status && customer.ach_status !== 'active') {
    try {
      const card = await db('payment_methods')
        .where({ customer_id: customer.id, method_type: 'card' })
        .first();
      if (!card) return false;
    } catch { return false; }
  }
  return true;
}

/**
 * Create (or re-hydrate) a sequence row for a newly-issued invoice.
 * Call this from the invoice-send flow.
 */
async function scheduleForInvoice(invoiceId) {
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice) return null;
  if (['paid', 'void', 'draft'].includes(invoice.status)) return null;

  const customer = await db('customers').where({ id: invoice.customer_id }).first();
  const onAutopay = await customerOnAutopay(customer);

  const dueDate = invoice.due_date || invoice.created_at;
  const nextAt = computeNextTouchAt(dueDate, 0);

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

  const rows = await db('invoice_followup_sequences as s')
    .join('invoices as i', 's.invoice_id', 'i.id')
    .where('s.status', 'active')
    .where('s.next_touch_at', '<=', now)
    .whereNotIn('i.status', ['paid', 'void'])
    .select(
      's.*',
      'i.id as invoice_id', 'i.token', 'i.title', 'i.total', 'i.status as invoice_status',
      'i.service_date', 'i.due_date', 'i.invoice_number',
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

  const customer = await db('customers').where({ id: row.customer_id }).first();
  if (!customer?.phone) {
    logger.warn(`[invoice-followups] no phone for customer ${row.customer_id}; pausing`);
    await db('invoice_followup_sequences').where({ id: row.id }).update({
      status: 'paused',
      paused_reason: 'no_customer_phone',
      next_touch_at: null,
    });
    return;
  }

  const amount = parseFloat(row.total || 0).toFixed(2);
  const serviceDate = row.service_date
    ? new Date(row.service_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  const body = renderBody(step.body, {
    name: customer.first_name || 'there',
    invoiceTitle: row.title || 'your service',
    amount,
    serviceDate,
    payUrl: `${DOMAIN}/pay/${row.token}`,
  });

  await TwilioService.sendSMS(customer.phone, body, {
    customerId: customer.id,
    messageType: 'invoice_followup',
  });

  const nextIndex = row.step_index + 1;
  const nextAt = computeNextTouchAt(row.due_date || row.created_at, nextIndex);

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
      if (customer?.phone) {
        const body = renderBody(config.thankYou.body, { name: customer.first_name });
        await TwilioService.sendSMS(customer.phone, body, {
          customerId: customer.id,
          messageType: 'invoice_thank_you',
        });
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
  if (!invoice || ['paid', 'void'].includes(invoice.status)) return;

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
  if (!invoice) return;

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
      'i.id as invoice_id', 'i.token', 'i.title', 'i.total',
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
};
