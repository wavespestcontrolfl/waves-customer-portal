const { validDateOnly } = require('../utils/date-only');

const SOURCES = new Set([
  'autopay_pre_charge_reminder',
  'autopay_card_expiry_warning',
  'payment_expiry_workflow',
  'balance_reminder_workflow',
  'invoice_followup_sequence',
  'balance_reminder_late_payment_check',
  'late_payment_checker',
  'previsit_balance_reminder',
]);
const CATEGORIES = new Set(['invoice', 'payment_issue', 'billing', 'payment_receipt']);
const EXPIRY_STAGES = new Set(['expired', '7_day', '30_day', '60_day']);
const STRING_FIELDS = Object.freeze({
  customer_id: 160, invoice_id: 160, source_entry_point: 80, notificationEventKey: 240,
  collections_ledger_id: 160, payment_method_id: 160, expiry_stage: 20,
  appointment_id: 160, appointment_service_type: 160, followup_sequence_id: 160, rendered_amount: 40,
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
  for (const field of ['charge_date', 'appointment_date', 'appointment_rendered_on']) {
    if (context[field] == null) continue;
    if (!validDateOnly(context[field])) return false;
    out[field] = context[field];
  }
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
  // Aggregate previsit dues reminder: pinned to its visit, no single invoice.
  if (context.source_entry_point === 'previsit_balance_reminder') {
    return has('appointment_id', 'appointment_date',
      'appointment_service_type', 'appointment_rendered_on', 'collections_ledger_id');
  }
  if (context.source_entry_point === 'invoice_followup_sequence') {
    return has('invoice_id', 'followup_sequence_id', 'rendered_amount', 'collections_ledger_id');
  }
  return has('invoice_id', 'collections_ledger_id');
}

function sanitizeBillingReplayContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context) || context.schema_version !== 1) return null;
  const out = { schema_version: 1 };
  if (!copyStrings(context, out) || !copyDates(context, out) || !copyExpiry(context, out)) return null;
  if (!out.customer_id || !out.notificationEventKey) return null;
  if (out.rendered_amount != null && !/^\d+\.\d{2}$/.test(out.rendered_amount)) return null;
  if (!CATEGORIES.has(context.category) || !SOURCES.has(out.source_entry_point)) return null;
  out.category = context.category;
  return complete(out) ? out : null;
}

function buildBillingReplayContext(input, authorityContext, notificationEventKey) {
  const meta = input?.metadata || {};
  return sanitizeBillingReplayContext({
    schema_version: 1,
    customer_id: authorityContext?.customer?.id,
    invoice_id: authorityContext?.invoice?.id,
    category: authorityContext?.category,
    source_entry_point: input?.entryPoint,
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
  });
}

module.exports = { buildBillingReplayContext, sanitizeBillingReplayContext };
