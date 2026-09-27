const { validDateOnly } = require('../utils/date-only');

// A direct invoice notice's explicit Email leg (#4963): the immediate send,
// and its queued replay (see replaySourceEntryPoint). The ONE definition:
// messaging/invoice-send-replay-eligibility.js imports it, so a source that
// stores an invoice-pinned context always gets the invoice re-check.
const INVOICE_SEND_SOURCES = new Set(['invoice_send_via_sms', 'invoice_send_deferred']);
// Billing email senders moved onto the shared billing email check (owner
// ruling 2026-09-27) store a context on their OWN email row, so a provider
// retry of that row re-runs the check too. Each binds its row by template,
// trigger and idempotency key: a context copied onto any other row is
// ignored. The trigger and key share the suffix after their prefixes, the
// invoice id opens that suffix, and the row carries the binding's category
// tag. `pins` are the fields its retry re-checks (see complete()).
const SENDER_BINDINGS = Object.freeze({
  late_payment_email: Object.freeze({
    category: 'billing',
    categoryTag: 'billing',
    pins: ['invoice_id', 'rendered_amount'],
    templates: new Set([
      'billing_late_payment_7_day', 'billing_late_payment_14_day', 'billing_late_payment_30_day',
      'billing_late_payment_60_day', 'billing_late_payment_90_day',
    ]),
    triggerPrefix: 'late_payment:',
    keyPrefix: 'late_payment_email:',
  }),
  // The invoice follow-up email: its retry also re-checks the sequence (a
  // stopped one refuses) and the amount it rendered (a changed balance
  // refuses; the next touch re-renders).
  invoice_followup_email: Object.freeze({
    category: 'invoice',
    categoryTag: 'invoice_followup',
    pins: ['invoice_id', 'followup_sequence_id', 'rendered_amount'],
    templates: new Set([
      'invoice.followup_3_day', 'invoice.followup_7_day', 'invoice.followup_14_day', 'invoice.followup_30_day',
    ]),
    triggerPrefix: 'invoice_followup:',
    keyPrefix: 'invoice_followup_email:',
  }),
});
const SOURCES = new Set([
  ...INVOICE_SEND_SOURCES,
  ...Object.keys(SENDER_BINDINGS),
  'autopay_pre_charge_reminder',
  'autopay_card_expiry_warning',
  'payment_expiry_workflow',
  'balance_reminder_workflow',
  'invoice_followup_sequence',
  'balance_reminder_late_payment_check',
  'late_payment_checker',
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
  if (context.source_entry_point === 'invoice_followup_sequence') {
    return has('invoice_id', 'followup_sequence_id', 'rendered_amount', 'collections_ledger_id');
  }
  const binding = SENDER_BINDINGS[context.source_entry_point];
  if (binding) return has(...binding.pins) && context.category === binding.category;
  return has('invoice_id', 'collections_ledger_id');
}

function senderReplayTemplate(templateKey) {
  return Object.values(SENDER_BINDINGS).some((binding) => binding.templates.has(templateKey));
}

// Whether a moved sender's context belongs on the row it is stored with (or
// read back from). Null for a context that is not a moved sender's: the
// routed notice keeps its own binding in email-template-library.js.
function senderReplayBindsRow(context, facts = {}) {
  const binding = SENDER_BINDINGS[context?.source_entry_point];
  if (!binding) return null;
  const trigger = String(facts.triggerEventId || '');
  const suffix = trigger.slice(binding.triggerPrefix.length);
  return binding.templates.has(facts.templateKey)
    && facts.recipientType === 'customer' && String(facts.recipientId) === context.customer_id
    && trigger.startsWith(binding.triggerPrefix) && trigger === context.notificationEventKey
    && suffix.startsWith(`${context.invoice_id}:`)
    && facts.idempotencyKey === `${binding.keyPrefix}${suffix}`
    && (facts.categories || []).includes(binding.categoryTag);
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
  });
}

module.exports = {
  buildBillingReplayContext, sanitizeBillingReplayContext, INVOICE_SEND_SOURCES,
  SENDER_BINDINGS, senderReplayTemplate, senderReplayBindsRow,
};
