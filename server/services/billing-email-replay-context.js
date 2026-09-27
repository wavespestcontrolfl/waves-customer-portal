const { validDateOnly } = require('../utils/date-only');

// A direct invoice notice's explicit Email leg (#4963): the immediate send,
// and its queued replay (see replaySourceEntryPoint). The ONE definition:
// messaging/invoice-send-replay-eligibility.js imports it, so a source that
// stores an invoice-pinned context always gets the invoice re-check.
const INVOICE_SEND_SOURCES = new Set(['invoice_send_via_sms', 'invoice_send_deferred']);
const SOURCES = new Set([
  ...INVOICE_SEND_SOURCES,
  'autopay_pre_charge_reminder',
  'autopay_card_expiry_warning',
  'payment_expiry_workflow',
  'balance_reminder_workflow',
  'invoice_followup_sequence',
  'balance_reminder_late_payment_check',
  'late_payment_checker',
  'annual_prepay_payment_reminder',
]);
const CATEGORIES = new Set(['invoice', 'payment_issue', 'billing', 'payment_receipt']);
const EXPIRY_STAGES = new Set(['expired', '7_day', '30_day', '60_day']);
const STRING_FIELDS = Object.freeze({
  customer_id: 160, invoice_id: 160, source_entry_point: 80, notificationEventKey: 240,
  collections_ledger_id: 160, payment_method_id: 160, expiry_stage: 20,
  appointment_id: 160, appointment_service_type: 160, followup_sequence_id: 160, rendered_amount: 40,
  annual_prepay_term_id: 160,
});

function boundedString(value, max) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result && result.length <= max && !/[\u0000-\u001f\u007f]/.test(result) ? result : null;
}

function copyStrings(context, out) {
  for (const [field, max] of Object.entries(STRING_FIELDS)) {
    if (context[field] == null) continue;
    const value = boundedString(context[field], max);
    if (!value) return false;
    out[field] = value;
  }
  return true;
}

function copyDates(context, out) {
  for (const field of ['charge_date', 'appointment_date', 'appointment_rendered_on', 'first_visit_date']) {
    if (context[field] == null) continue;
    if (!validDateOnly(context[field])) return false;
    out[field] = context[field];
  }
  return true;
}

function copyDaysOut(context, out) {
  if (context.days_out == null) return true;
  const daysOut = Number(context.days_out);
  if (![1, 3].includes(daysOut) || String(context.days_out).trim() !== String(daysOut)) return false;
  out.days_out = daysOut;
  return true;
}

function copyExpiry(context, out) {
  if (context.expiry_month != null) {
    if (!/^([1-9]|1[0-2])$/.test(String(context.expiry_month))) return false;
    out.expiry_month = String(context.expiry_month);
  }
  if (context.expiry_year != null) {
    if (!/^(\d{2}|\d{4})$/.test(String(context.expiry_year))) return false;
    out.expiry_year = String(context.expiry_year);
  }
  return true;
}

function complete(context) {
  const has = (...fields) => fields.every((field) => context[field] != null);
  // No collections reservation backs a direct invoice notice: the invoice
  // itself is the pin its provider retry re-checks.
  if (INVOICE_SEND_SOURCES.has(context.source_entry_point)) {
    return has('invoice_id') && context.category === 'invoice';
  }
  if (context.source_entry_point === 'autopay_pre_charge_reminder') return has('charge_date');
  if (context.source_entry_point === 'autopay_card_expiry_warning') {
    return has('payment_method_id', 'expiry_month', 'expiry_year', 'expiry_stage')
      && EXPIRY_STAGES.has(context.expiry_stage);
  }
  if (context.source_entry_point === 'payment_expiry_workflow') {
    return has('payment_method_id', 'expiry_month', 'expiry_year');
  }
  if (context.source_entry_point === 'balance_reminder_workflow') {
    return has('invoice_id', 'appointment_id', 'appointment_date',
      'appointment_service_type', 'appointment_rendered_on', 'collections_ledger_id');
  }
  if (context.source_entry_point === 'annual_prepay_payment_reminder') {
    return has('invoice_id', 'rendered_amount', 'collections_ledger_id', 'annual_prepay_term_id',
      'first_visit_date', 'days_out')
      && context.notificationEventKey === `annual-prepay-payment:${context.annual_prepay_term_id}:${context.days_out}`;
  }
  if (context.source_entry_point === 'invoice_followup_sequence') {
    return has('invoice_id', 'followup_sequence_id', 'rendered_amount', 'collections_ledger_id');
  }
  return has('invoice_id', 'collections_ledger_id');
}

function sanitizeBillingReplayContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context) || context.schema_version !== 1) return null;
  const out = { schema_version: 1 };
  if (!copyStrings(context, out) || !copyDates(context, out) || !copyExpiry(context, out)
    || !copyDaysOut(context, out)) return null;
  if (!out.customer_id || !out.notificationEventKey) return null;
  if (out.rendered_amount != null && !/^\d+\.\d{2}$/.test(out.rendered_amount)) return null;
  if (!CATEGORIES.has(context.category) || !SOURCES.has(out.source_entry_point)) return null;
  out.category = context.category;
  return complete(out) ? out : null;
}

// The scheduled-SMS executor replays every queued row under the generic
// scheduled_sms_cron entry point. Only a queued direct invoice notice maps
// back to its producer; any other scheduled replay keeps the generic source,
// which carries no replay contract, so it stores no context.
function replaySourceEntryPoint(input) {
  if (input?.entryPoint === 'scheduled_sms_cron'
    && input?.metadata?.original_entry_point === 'invoice_send_deferred') return 'invoice_send_deferred';
  return input?.entryPoint;
}

function buildBillingReplayContext(input, authorityContext, notificationEventKey) {
  const meta = input?.metadata || {};
  return sanitizeBillingReplayContext({
    schema_version: 1,
    customer_id: authorityContext?.customer?.id,
    invoice_id: authorityContext?.invoice?.id,
    category: authorityContext?.category,
    source_entry_point: replaySourceEntryPoint(input),
    notificationEventKey,
    collections_ledger_id: meta.collections_ledger_id,
    charge_date: meta.charge_date,
    payment_method_id: meta.payment_method_id,
    expiry_month: meta.expiry_month,
    expiry_year: meta.expiry_year,
    expiry_stage: meta.expiry_stage,
    appointment_id: input?.appointmentId,
    appointment_date: meta.appointment_date,
    appointment_service_type: meta.appointment_service_type,
    appointment_rendered_on: meta.appointment_rendered_on,
    followup_sequence_id: meta.followup_sequence_id,
    rendered_amount: meta.rendered_amount,
    annual_prepay_term_id: meta.annual_prepay_term_id,
    first_visit_date: meta.first_visit_date,
    days_out: meta.days_out,
  });
}

module.exports = { buildBillingReplayContext, sanitizeBillingReplayContext, INVOICE_SEND_SOURCES };
