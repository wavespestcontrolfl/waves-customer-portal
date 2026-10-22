/**
 * Intelligence Bar — create and cancel an invoice payment plan
 * server/services/intelligence-bar/payment-plan-tools.js
 *
 * Cards that replay the Invoices page's own handlers, in process (admin-invoices.js createPaymentPlanFromBar and
 * cancelPaymentPlanFromBar), so every refusal and rule is the route's own. Dark behind GATE_IB_PAYMENT_PLAN (which needs
 * GATE_IB_PLATFORM). Always a confirm card (write-gates.js two-step), admin only, never owner-direct, platform path only.
 * No refund and no card charge.
 *
 *   create_payment_plan — the Invoices page "Payment plan" dialog (POST /admin/invoices/:id/payment-plan). What the screen
 *                         does, and so what the card says: it records ONE plan row (amount due, installment amount,
 *                         frequency, start and next payment dates), stops the invoice's automatic reminders while the plan is
 *                         active, locks the invoice against edits, and EMAILS the customer the plan confirmation. It attaches
 *                         NO saved card and nothing collects the installments (payment-plans.js: "Nothing charges installments
 *                         yet"), so the card says plainly that no card is charged and staff record each payment. The screen
 *                         sends no payment method; neither does the bar. external_action (it emails the customer).
 *   cancel_payment_plan — the "Cancel plan" button (POST .../payment-plan/cancel). The plan becomes cancelled, the invoice
 *                         reopens for editing and collection, and the reminders the plan stopped are re-armed. internal_write.
 *
 *   unconfirmed -> a PREVIEW: nothing is written or sent. Its `_version` pins what the card showed (invoice edit time and
 *                  status, amount due, the plan terms and every installment, the recipient, the reminder row).
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift, then runs the handler. The create
 *                  handler also re-checks the invoice edit time on the locked invoice row (409 PREVIEW_CHANGED).
 *
 * The bar is narrower than the screen: a draft invoice is refused (send it first), a plan needs at most 60 installments (so the
 * card can list each one), and the next payment date cannot be in the past or before the start date.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');
const { maskEmail } = require('./closeout-repair-tools');

function paymentPlanLive() {
  return require('../../config/feature-gates').ibPaymentPlanLive() === true;
}

const TARGET_PROPS = {
  invoice_id: { type: 'string', format: 'uuid', description: 'The existing invoice (from get_customer_invoices)' },
  invoice_number: { type: 'string', description: 'The invoice number, e.g. WPC-2026-0534 (use instead of invoice_id)' },
};
const FREQUENCIES = ['weekly', 'biweekly', 'monthly'];
const MAX_INSTALLMENTS = 60;
const CARD_INSTALLMENTS_SHOWN = 6;

const PAYMENT_PLAN_TOOLS = [
  {
    name: 'create_payment_plan',
    description: `Create a payment plan on ONE unpaid invoice: the Invoices page "Payment plan" dialog. The plan covers the invoice's whole amount due in equal installments (the last one is the remainder) on a weekly, biweekly or monthly schedule. The first call returns a PREVIEW and changes nothing: the amount due, EACH installment date and amount, and what the plan does. The operator approves on the confirmation card; the confirmed run re-checks all of it and refuses if anything changed.
What it does: records the plan, stops the invoice's automatic payment reminders while the plan is active, locks the invoice against edits, and EMAILS the customer a payment plan confirmation. It does NOT charge a card and attaches no saved card: nothing collects the installments automatically, so staff record each payment as it arrives. No refund and no charge from the bar.
Refused with the reason: invoice not found, a draft, paid, prepaid, void, refunded or a bank payment processing, billed to a payer, nothing due, an active plan already on it, an installment above the amount due, more than 60 installments, dates in the past or out of order. Admin only.
Takes invoice_id OR invoice_number (exactly one), payment_amount (each installment, in dollars), payment_frequency, next_payment_date (YYYY-MM-DD), and optionally plan_start_date (YYYY-MM-DD, default today) and notes.
Use for: "put WPC-2026-0534 on a payment plan of $100 a month", "split this invoice into 3 monthly payments starting Nov 1".`,
    input_schema: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        payment_amount: { type: 'number', description: 'Each installment in dollars (at most the amount due)' },
        payment_frequency: { type: 'string', enum: FREQUENCIES },
        next_payment_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Date of the first installment, YYYY-MM-DD' },
        plan_start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Plan start date, YYYY-MM-DD (default today)' },
        notes: { type: 'string', maxLength: 500, description: 'Optional note kept on the plan (staff only)' },
      },
    },
    _sideEffects: true,
  },
  {
    name: 'cancel_payment_plan',
    description: `Cancel the ACTIVE payment plan on ONE invoice: the Invoices page "Cancel plan" button. The first call returns a PREVIEW and changes nothing: the invoice, the plan and what cancelling does. The operator approves on the confirmation card; the confirmed run re-checks it and refuses if anything changed.
What it does: the plan becomes cancelled, the invoice reopens for normal collection and editing, and the invoice's automatic payment reminders that the plan stopped are re-armed (a reminder can then go out to the customer on its normal schedule). Nothing is sent now, nothing is charged or refunded. Refused with the reason: no active plan, a paid or processing invoice. Admin only.
Takes invoice_id OR invoice_number, exactly one, and an optional short reason.
Use for: "cancel the payment plan on this invoice", "take WPC-2026-0534 off its payment plan".`,
    input_schema: {
      type: 'object',
      properties: { ...TARGET_PROPS, reason: { type: 'string', maxLength: 300, description: 'Why (optional; staff-only note)' } },
    },
    _sideEffects: true,
  },
];

const money = (value) => `$${(Math.round((Number(value) || 0) * 100) / 100).toFixed(2)}`;
const cents = (value) => Math.round((Number(value) || 0) * 100);
const msOf = (value) => (value ? new Date(value).getTime() : null);
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const flat = (value) => String(value || '').replace(/\s+/g, ' ').trim();
// A pg DATE column as its calendar day (a string or a UTC-midnight Date; never shifted by a timezone).
const dateOnly = (value) => (value ? require('../../utils/datetime-et').etCalendarDayOf(value) : null);

async function customerName(customerId) {
  const c = await db('customers').where({ id: customerId }).first('first_name', 'last_name', 'company_name');
  return [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.company_name || null;
}

// The invoice the call names: exactly one of id / number.
async function resolveInvoice(input) {
  const rawId = String(input?.invoice_id || '').trim();
  const rawNumber = String(input?.invoice_number || '').trim();
  if (Boolean(rawId) === Boolean(rawNumber)) return refusal('Give exactly one of invoice_id or invoice_number', 'invalid_target');
  if (rawId && !UUID_RE.test(rawId)) return refusal('A valid invoice_id is required', 'invalid_target');
  const invoice = rawId
    ? await db('invoices').where({ id: rawId.toLowerCase() }).first()
    : await db('invoices').where({ invoice_number: rawNumber.toUpperCase() }).first();
  return invoice ? { invoice } : refusal('Invoice not found', 'invoice_not_found');
}

// ── date-only helpers (the plan stores YYYY-MM-DD, no clock) ──────────

function validYmd(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text || ''))) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}
function addDaysYmd(ymd, days) {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
// Calendar months from the ORIGINAL date (so 31 Jan, 28 Feb, 31 Mar), clamped to the month's last day.
function addMonthsYmd(ymd, months) {
  const [y, m, d] = ymd.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}
function dateOfInstallment(firstYmd, frequency, index) {
  if (frequency === 'monthly') return addMonthsYmd(firstYmd, index);
  return addDaysYmd(firstYmd, index * (frequency === 'weekly' ? 7 : 14));
}
function prettyYmd(ymd) {
  const date = new Date(`${ymd}T12:00:00Z`);
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Each installment: the whole amount due in equal payments, the last one the remainder.
function installmentsFor({ totalCents, paymentCents, frequency, firstYmd }) {
  const out = [];
  let remaining = totalCents;
  for (let i = 0; remaining > 0; i += 1) {
    const amount = Math.min(paymentCents, remaining);
    out.push({ date: dateOfInstallment(firstYmd, frequency, i), cents: amount });
    remaining -= amount;
    if (out.length > MAX_INSTALLMENTS) break;
  }
  return out;
}

const seqVersion = (seq) => (seq ? {
  id: seq.id,
  status: seq.status,
  step_index: seq.step_index,
  next_touch_at: msOf(seq.next_touch_at),
  stopped_reason: seq.stopped_reason || null,
  paused_reason: seq.paused_reason || null,
} : null);

// ── create_payment_plan ────────────────────────────────────────

async function buildCreatePlan(input) {
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  const at = invoice.id;
  const { assertInvoiceCollectible, invoiceAmountDue } = require('../invoice-helpers');
  // The route's own refusals, in its order.
  if (invoice.payer_id) return refusal('Invoice is billed to a third-party payer — payment plans are not supported for payer invoices', 'payer_owned', { invoice_id: at });
  try {
    assertInvoiceCollectible(invoice);
  } catch (err) {
    return refusal(err.message, 'invoice_not_collectible', { invoice_id: at });
  }
  if (String(invoice.status || '').toLowerCase() === 'draft') {
    return refusal(`Invoice ${invoice.invoice_number} is still a draft. Send it first; a plan emails the customer about an invoice they have not received.`, 'invoice_draft', { invoice_id: at });
  }
  if (parseFloat(invoice.total || 0) <= 0) return refusal('Invoice has no amount to collect (total is $0)', 'nothing_due', { invoice_id: at });
  const activePlan = await db('payment_plans').where({ invoice_id: invoice.id, status: 'active' }).first('id');
  if (activePlan) return refusal('Invoice already has an active payment plan', 'plan_exists', { invoice_id: at });
  if (!invoice.updated_at) return refusal('This invoice cannot be pinned for approval, so nothing was offered. Use the Invoices page for this one.', 'unverified', { invoice_id: at });

  const frequency = String(input?.payment_frequency || '').trim();
  if (!FREQUENCIES.includes(frequency)) return refusal(`payment_frequency must be one of: ${FREQUENCIES.join(', ')}`, 'invalid_plan', { invoice_id: at });
  const dueCents = cents(invoiceAmountDue(invoice));
  if (dueCents <= 0) return refusal('Invoice has no remaining balance after applied account credit — no payment plan needed', 'nothing_due', { invoice_id: at });
  const paymentRaw = Number(input?.payment_amount);
  if (!Number.isFinite(paymentRaw) || paymentRaw <= 0) return refusal('payment_amount must be a positive amount', 'invalid_plan', { invoice_id: at });
  const paymentCents = cents(paymentRaw);
  if (paymentCents <= 0) return refusal('payment_amount must be at least one cent', 'invalid_plan', { invoice_id: at });
  if (paymentCents > dueCents) return refusal(`payment_amount cannot exceed the amount due (${money(dueCents / 100)})`, 'invalid_plan', { invoice_id: at });
  const today = require('../../utils/datetime-et').etDateString();
  const startYmd = String(input?.plan_start_date || today).trim();
  const nextYmd = String(input?.next_payment_date || '').trim();
  if (!validYmd(startYmd)) return refusal('plan_start_date must be a valid YYYY-MM-DD date', 'invalid_plan', { invoice_id: at });
  if (!validYmd(nextYmd)) return refusal('next_payment_date must be a valid YYYY-MM-DD date', 'invalid_plan', { invoice_id: at });
  if (nextYmd < today) return refusal('next_payment_date cannot be in the past', 'invalid_plan', { invoice_id: at });
  if (nextYmd < startYmd) return refusal('next_payment_date cannot be before plan_start_date', 'invalid_plan', { invoice_id: at });
  const notes = flat(input?.notes).slice(0, 500) || null;

  const installments = installmentsFor({ totalCents: dueCents, paymentCents, frequency, firstYmd: nextYmd });
  if (installments.length > MAX_INSTALLMENTS) {
    return refusal(`That plan needs more than ${MAX_INSTALLMENTS} installments. Use a larger payment_amount or a shorter schedule.`, 'too_many_installments', { invoice_id: at });
  }

  const who = await require('../../routes/admin-invoices').getInvoiceDeliveryRecipients(invoice.id);
  if (!who) return refusal('Invoice not found', 'invoice_not_found');
  const email = who.emailRecipient?.email ? String(who.emailRecipient.email) : null;
  const seq = await db('invoice_followup_sequences').where({ invoice_id: invoice.id }).first();
  const name = who.customerName || await customerName(invoice.customer_id);
  const lines = installments.map((row, index) => `${index + 1}. ${prettyYmd(row.date)} — ${money(row.cents / 100)}`);
  const credit = cents(invoice.credit_applied);
  const effects = [
    { kind: 'billing', text: `Records a ${frequency} payment plan on invoice ${invoice.invoice_number}: ${installments.length} installment${installments.length === 1 ? '' : 's'} totaling ${money(dueCents / 100)} (the amount due${credit > 0 ? `: ${money(cents(invoice.total) / 100)} total less ${money(credit / 100)} account credit` : ''}).` },
    { kind: 'billing', text: 'NO card is charged. The plan attaches no saved card, and nothing collects the installments automatically: staff record each payment when it arrives.' },
    { kind: 'operational', text: seq && ['active', 'paused', 'autopay_hold', 'completed'].includes(seq.status)
      ? 'Its automatic payment reminders stop while the plan is active (cancelling the plan re-arms them).'
      : 'Reminders already off for this invoice stay off while the plan is active.' },
    { kind: 'operational', text: 'The invoice is locked against edits and account-credit changes while the plan is active.' },
    { kind: 'comms', text: email
      ? `Emails the customer (${maskEmail(email)}) the payment plan confirmation: total ${money(dueCents / 100)}, ${money(paymentCents / 100)} ${frequency}, next payment ${prettyYmd(nextYmd)}. It is sent once; no text is sent.`
      : 'No usable email is on file, so no confirmation is sent; no text is sent either.' },
  ];
  return {
    preview: true,
    tool: 'create_payment_plan',
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    customer_id: invoice.customer_id,
    customer_name: name,
    status: invoice.status,
    amount_due: money(dueCents / 100),
    total: money(cents(invoice.total) / 100),
    frequency,
    plan_start_date: startYmd,
    next_payment_date: nextYmd,
    installment_count: installments.length,
    installments: lines,
    charges_card: false,
    emails_customer: Boolean(email),
    notes,
    effects,
    sends_to_customer: Boolean(email),
    _body: {
      totalBalance: dueCents / 100,
      paymentAmount: paymentCents / 100,
      paymentFrequency: frequency,
      planStartDate: startYmd,
      nextPaymentDate: nextYmd,
      ...(notes ? { notes } : {}),
    },
    _version: {
      tool: 'create_payment_plan',
      invoice_id: invoice.id,
      status: invoice.status,
      updated_at: msOf(invoice.updated_at),
      total: cents(invoice.total),
      credit_applied: credit,
      due_cents: dueCents,
      customer_id: invoice.customer_id || null,
      payer_id: invoice.payer_id || null,
      terms: digest({ paymentCents, frequency, startYmd, nextYmd, notes }),
      installments: digest(installments),
      recipient: email ? digest(email.toLowerCase()) : null,
      reminder: seqVersion(seq),
    },
    note: 'PREVIEW ONLY — nothing was created or sent. Confirm creates exactly this plan; if anything changed it refuses.',
  };
}

// ── cancel_payment_plan ────────────────────────────────────────

// What the cancel does to the reminders the plan stopped (read-only mirror of rearmFollowupsForCancelledPlan).
function rearmOutcome(seq, planId) {
  if (!seq) return 'schedule';
  const base = `payment_plan_created:${planId}`;
  const stamp = String(seq.stopped_reason || '');
  const matches = stamp === base || stamp.startsWith(`${base}:prev=`);
  const planOwned = matches && (seq.status === 'stopped' || (seq.status === 'paused' && seq.paused_reason === 'payment_plan_created'));
  if (!planOwned) return 'untouched';
  const prev = stamp.startsWith(`${base}:prev=`) ? stamp.slice(`${base}:prev=`.length) : null;
  if (seq.paused_reason !== 'payment_plan_created' && (prev === 'paused' || seq.paused_reason)) return 'restored_pause';
  if (seq.is_autopay_held) return 'held';
  return 'resumed';
}

const REARM_TEXT = {
  schedule: { kind: 'comms', text: 'The invoice has no reminder sequence, so a new one is started; a reminder can then go out to the customer on its normal schedule.' },
  untouched: { kind: 'operational', text: 'The invoice’s reminders are not changed by the cancel (they were not stopped by this plan); the reminder sequence is re-checked.' },
  restored_pause: { kind: 'operational', text: 'The reminders go back to PAUSED, as they were before the plan.' },
  held: { kind: 'operational', text: 'The reminders go back to the Auto Pay hold, as they were before the plan.' },
  resumed: { kind: 'comms', text: 'The reminders restart, so a reminder can go out to the customer at the next reminder run.' },
};

async function buildCancelPlan(input) {
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  const at = invoice.id;
  const status = String(invoice.status || '').toLowerCase();
  const plan = await db('payment_plans').where({ invoice_id: invoice.id, status: 'active' }).first();
  if (!plan) return refusal(`Invoice ${invoice.invoice_number} has no active payment plan.`, 'no_active_plan', { invoice_id: at });
  if (status === 'processing') {
    return refusal('A payment is processing on this invoice — wait for it to settle (the plan completes) or fail (then cancel), and retry.', 'payment_processing', { invoice_id: at });
  }
  if (['paid', 'prepaid'].includes(status)) {
    return refusal(`Invoice ${invoice.invoice_number} is ${status}, so the plan completes by itself; there is nothing to cancel.`, 'invoice_settled', { invoice_id: at });
  }
  if (!invoice.updated_at) return refusal('This invoice cannot be pinned for approval, so nothing was offered. Use the Invoices page for this one.', 'unverified', { invoice_id: at });
  const reason = flat(input?.reason).slice(0, 300) || null;
  const seq = await db('invoice_followup_sequences').where({ invoice_id: invoice.id }).first();
  const rearm = rearmOutcome(seq, plan.id);
  const name = await customerName(invoice.customer_id);
  const effects = [
    { kind: 'billing', text: `Cancels the ${plan.payment_frequency} payment plan on invoice ${invoice.invoice_number}: ${money(plan.payment_amount)} installments toward ${money(plan.total_balance)}, next payment ${plan.next_payment_date ? prettyYmd(dateOnly(plan.next_payment_date)) : 'not set'}.` },
    { kind: 'billing', text: 'The invoice reopens for normal collection and editing. No card is charged and nothing is refunded.' },
    REARM_TEXT[rearm],
    { kind: 'comms', text: 'Nothing is sent to the customer right now.' },
  ];
  return {
    preview: true,
    tool: 'cancel_payment_plan',
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    customer_id: invoice.customer_id,
    customer_name: name,
    status: invoice.status,
    payment_plan_id: plan.id,
    plan_summary: `${money(plan.payment_amount)} ${plan.payment_frequency} toward ${money(plan.total_balance)}`,
    reason,
    rearm,
    effects,
    sends_to_customer: false,
    _body: { paymentPlanId: plan.id, ...(reason ? { reason } : {}) },
    _version: {
      tool: 'cancel_payment_plan',
      invoice_id: invoice.id,
      status: invoice.status,
      updated_at: msOf(invoice.updated_at),
      customer_id: invoice.customer_id || null,
      plan: {
        id: plan.id,
        status: plan.status,
        total_balance: cents(plan.total_balance),
        payment_amount: cents(plan.payment_amount),
        payment_frequency: plan.payment_frequency,
        next_payment_date: dateOnly(plan.next_payment_date),
      },
      reminder: seqVersion(seq),
      rearm,
      reason: reason || null,
    },
    note: 'PREVIEW ONLY — nothing was changed. Confirm cancels exactly this plan; if anything changed it refuses.',
  };
}

// The re-derived plan when it still matches the card's pin, or the refusal.
async function verifiedPlan(build, pinned, what) {
  if (!pinned) return { refusal: refusal(`Use the confirmation card to approve this ${what}.`, 'approval_required') };
  const plan = await build();
  if (plan.error) return { refusal: { error: `Nothing was changed: ${plan.error}`, code: plan.code, preview_changed: true } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: `The invoice or its plan changed after the card was shown, so nothing was ${what === 'plan' ? 'created' : 'cancelled'}. Ask again for a fresh confirmation card.`, code: 'preview_changed', preview_changed: true } };
  }
  return { plan };
}

async function actorOf(actionContext) {
  const technicianId = actionContext?.technicianId || null;
  if (!technicianId) return { technicianId: null };
  const tech = await db('technicians').where({ id: technicianId }).first('name', 'email');
  return { technicianId, name: tech?.name || null, email: tech?.email || null };
}

async function commitCreate(input, actionContext) {
  const { plan, refusal: refused } = await verifiedPlan(() => buildCreatePlan(input), input._verified_payment_plan_version, 'plan');
  if (refused) return refused;
  const base = { invoice_id: plan.invoice_id, invoice_number: plan.invoice_number, customer_id: plan.customer_id };
  let result;
  try {
    result = await require('../../routes/admin-invoices').createPaymentPlanFromBar({
      invoiceId: plan.invoice_id, body: plan._body, actor: await actorOf(actionContext), approvedPlan: { updatedAtMs: plan._version.updated_at },
    });
  } catch (err) {
    logger.error(`[intelligence-bar:payment-plan] create handler failed (${err.code || err.name || 'error'})`);
    const now = await db('payment_plans').where({ invoice_id: plan.invoice_id, status: 'active' }).first('id').catch(() => null);
    if (now) {
      return { ...base, success: true, payment_plan_id: now.id, warning: true,
        note: `A payment plan now exists on invoice ${plan.invoice_number}, but the Invoices page reported a problem. Check the invoice; the confirmation email may not have gone out.` };
    }
    return { ...base, outcome_unknown: true, code: 'execution_interrupted',
      error: 'Creating the plan was interrupted — it may or may not have happened. Check the invoice before trying again.' };
  }
  const { status, json } = result;
  if (status === 409 && json?.code === 'PREVIEW_CHANGED') {
    return { ...base, failed: true, code: 'preview_changed', preview_changed: true, error: `Nothing was created: ${json.error}` };
  }
  if (status !== 201 && status !== 200) {
    return { ...base, failed: true, code: status === 404 ? 'not_found' : 'plan_refused', error: `The payment plan was not created: ${json?.error || 'the Invoices page refused it'}` };
  }
  if (json?.paymentPlan?.status !== 'active') {
    return { ...base, outcome_unknown: true, code: 'plan_unverified',
      error: 'The Invoices page answered, but the plan does not read as active. Check the invoice before trying again.' };
  }
  logger.info(`[intelligence-bar:payment-plan] created plan ${json.paymentPlan.id} on ${plan.invoice_id}`);
  const emailed = json.email?.ok === true;
  return { ...base, success: true, payment_plan_id: json.paymentPlan.id, charged_card: false, sent_to_customer: emailed,
    note: `The payment plan is active on invoice ${plan.invoice_number}: ${plan.installment_count} installment${plan.installment_count === 1 ? '' : 's'}, ${plan.amount_due} in all. No card was charged. ${emailed ? 'The confirmation email was sent.' : 'The confirmation email was not sent (no usable email, or it was held or suppressed); check the invoice timeline.'}` };
}

async function commitCancel(input, actionContext) {
  const { plan, refusal: refused } = await verifiedPlan(() => buildCancelPlan(input), input._verified_payment_plan_version, 'cancel');
  if (refused) return refused;
  const base = { invoice_id: plan.invoice_id, invoice_number: plan.invoice_number, customer_id: plan.customer_id, payment_plan_id: plan.payment_plan_id };
  let result;
  try {
    result = await require('../../routes/admin-invoices').cancelPaymentPlanFromBar({
      invoiceId: plan.invoice_id, body: plan._body, actor: await actorOf(actionContext),
    });
  } catch (err) {
    logger.error(`[intelligence-bar:payment-plan] cancel handler failed (${err.code || err.name || 'error'})`);
    const now = await db('payment_plans').where({ id: plan.payment_plan_id }).first('status').catch(() => null);
    if (now?.status === 'cancelled') {
      return { ...base, success: true, warning: true, note: `The plan on invoice ${plan.invoice_number} is cancelled, but the Invoices page reported a problem. Check that its reminders are armed.` };
    }
    return { ...base, outcome_unknown: true, code: 'execution_interrupted',
      error: 'Cancelling the plan was interrupted — it may or may not have happened. Check the invoice before trying again.' };
  }
  const { status, json } = result;
  if (status === 502 && json?.paymentPlan?.status === 'cancelled') {
    return { ...base, success: true, warning: true, code: 'reminders_not_rearmed',
      note: `The plan on invoice ${plan.invoice_number} is cancelled, but re-arming its reminders failed. Its reminders stay off until someone re-arms them; tell the office.` };
  }
  if (status !== 200) {
    return { ...base, failed: true, code: status === 404 ? 'not_found' : 'cancel_refused', error: `The plan was not cancelled: ${json?.error || 'the Invoices page refused it'}` };
  }
  if (json?.completedInsteadOfCancelled) {
    return { ...base, success: true, completed_instead: true, note: 'The invoice settled while cancelling, so the plan was completed, not cancelled.' };
  }
  if (json?.paymentPlan?.status !== 'cancelled') {
    return { ...base, outcome_unknown: true, code: 'cancel_unverified',
      error: 'The Invoices page answered, but the plan does not read as cancelled. Check the invoice before trying again.' };
  }
  logger.info(`[intelligence-bar:payment-plan] cancelled plan ${plan.payment_plan_id} on ${plan.invoice_id}`);
  return { ...base, success: true, sent_to_customer: false,
    note: `The payment plan on invoice ${plan.invoice_number} is cancelled and the invoice is open for collection again. Nothing was sent now.` };
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (!preview || preview.preview !== true || preview.tool !== toolName) return [];
  const effects = (preview.effects || []).map(({ kind, text }) => ({ kind, text }));
  const who = preview.customer_name || preview.customer_id;
  if (toolName === 'create_payment_plan') {
    const rows = preview.installments || [];
    return [
      { kind: 'customer', text: `Payment plan on invoice ${preview.invoice_number} for ${who}: ${preview.amount_due} due, ${preview.frequency}, ${rows.length} installment${rows.length === 1 ? '' : 's'}` },
      { kind: 'billing', text: `Total of the plan = balance due ${preview.amount_due} (invoice total ${preview.total}); starts ${preview.plan_start_date}, first payment ${preview.next_payment_date}` },
      // The first installments on the card itself; every other one rides in full under "Show more".
      ...rows.map((text, index) => ({ kind: 'billing', text: `Installment ${text}`, ...(index >= CARD_INSTALLMENTS_SHOWN ? { more: true } : {}) })),
      ...(rows.length > CARD_INSTALLMENTS_SHOWN ? [{ kind: 'billing', text: `All ${rows.length} installments are listed; installments ${CARD_INSTALLMENTS_SHOWN + 1} on are under "Show more"` }] : []),
      { kind: 'billing', text: 'Charges a card: NO. No saved card is attached and nothing collects the installments automatically.' },
      ...(preview.notes ? [{ kind: 'operational', text: `Note kept on the plan: "${preview.notes}"` }] : []),
      ...effects,
    ];
  }
  if (toolName === 'cancel_payment_plan') {
    return [
      { kind: 'customer', text: `Cancel the payment plan on invoice ${preview.invoice_number} for ${who} (${preview.plan_summary})` },
      ...(preview.reason ? [{ kind: 'operational', text: `Reason noted: "${preview.reason}"` }] : []),
      ...effects,
    ];
  }
  return [];
}

async function executePaymentPlanTool(toolName, input = {}, actionContext = {}) {
  if (!PAYMENT_PLAN_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the requireAdmin routes it runs; the registry refuses a technician too. The confirmed run needs a
  // positive admin flag (fail closed).
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Payment plans are limited to admin accounts', 'permission_denied');
  }
  if (!paymentPlanLive()) return refusal('Payment plans from the bar are switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    if (input.confirmed === true) return toolName === 'create_payment_plan' ? await commitCreate(input, actionContext) : await commitCancel(input, actionContext);
    return toolName === 'create_payment_plan' ? await buildCreatePlan(input) : await buildCancelPlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:payment-plan] ${toolName} failed (${err.code || err.name || 'error'})`);
    // A throw after an approval may follow a sent email: never invite a retry.
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The action was interrupted — it may or may not have happened. Check the invoice before trying again.' }
      : { error: 'Could not prepare this payment plan action' };
  }
}

module.exports = {
  PAYMENT_PLAN_TOOLS,
  executePaymentPlanTool,
  paymentPlanLive,
  installmentsFor,
  cardLines,
};
