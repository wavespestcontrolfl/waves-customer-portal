const db = require('../../models/db');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');
const { isPaused, getChargeableAutopayMethod, isBankMethodType } = require('../autopay-eligibility');
const { resolveBillingLane } = require('../billing-lane');

const INVOICE_GUARDS = new Set([
  'invoice_followup_sequence', 'balance_reminder_workflow',
  'balance_reminder_late_payment_check', 'late_payment_checker',
]);
const EXPIRY_ENTRY_POINTS = new Set(['autopay_card_expiry_warning', 'payment_expiry_workflow']);

function refused(reason, retryable = false) {
  return { eligible: false, reason, retryable };
}

async function prechargeRefusal(meta, database) {
  if (meta.source_entry_point !== 'autopay_pre_charge_reminder') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.charge_date || '')) return refused('charge-date-missing');
  if (meta.charge_date <= etDateString()) return refused('charge-date-passed');
  if (meta.charge_date > etDateString(addETDays(new Date(), 3))) return refused('charge-date-not-due');

  const customer = await database('customers').where({ id: meta.customer_id }).first();
  if (!customer || customer.deleted_at || customer.active !== true || customer.autopay_enabled !== true
    || !(Number(customer.monthly_rate) > 0) || resolveBillingLane(customer).mode !== 'monthly_membership'
    || Number(customer.billing_day) !== Number(meta.charge_date.slice(-2))
    || isPaused(customer, new Date(`${meta.charge_date}T12:00:00Z`))) {
    return refused('precharge-no-longer-eligible');
  }
  return null;
}

async function selectedExpiryMethod(customer, source, database) {
  const current = await getChargeableAutopayMethod(customer, database, { now: new Date(), rethrow: true });
  if (current || source !== 'autopay_card_expiry_warning') return current;
  const methods = await database('payment_methods')
    .where({ customer_id: customer.id, processor: 'stripe', autopay_enabled: true })
    .whereNotNull('stripe_payment_method_id')
    .orderBy([{ column: 'updated_at', order: 'desc' }, { column: 'id', order: 'asc' }])
    .select('id', 'method_type', 'is_default');
  const pointer = methods.find((item) => String(item.id) === String(customer.autopay_payment_method_id));
  return pointer && !isBankMethodType(pointer.method_type)
    ? pointer : methods.find((item) => item.is_default === true && !isBankMethodType(item.method_type)) || null;
}

function methodYearMonth(method) {
  return [Number(method.exp_year) < 100 ? Number(method.exp_year) + 2000 : Number(method.exp_year), Number(method.exp_month)];
}

async function expiryCustomerRefusal(meta, database) {
  if (!meta.payment_method_id || !meta.expiry_month || !meta.expiry_year) {
    return { refusal: refused('expiry-pin-missing') };
  }
  const customer = await database('customers').where({ id: meta.customer_id }).first();
  if (!customer || customer.deleted_at || customer.active !== true) {
    return { refusal: refused('customer-no-longer-active') };
  }
  if (meta.source_entry_point === 'autopay_card_expiry_warning' && customer.autopay_enabled !== true) {
    return { refusal: refused('autopay-disabled') };
  }
  return { customer };
}

async function expiryMethodRefusal(meta, customer, database) {
  const method = await database('payment_methods')
    .where({ id: meta.payment_method_id, customer_id: meta.customer_id }).first();
  if (!method || method.processor !== 'stripe' || method.autopay_enabled !== true
    || !method.stripe_payment_method_id || isBankMethodType(method.method_type)
    || Number(method.exp_month) !== Number(meta.expiry_month)
    || Number(method.exp_year) % 100 !== Number(meta.expiry_year) % 100) {
    return { refusal: refused('expiry-method-changed') };
  }
  const selected = await selectedExpiryMethod(customer, meta.source_entry_point, database);
  if (String(selected?.id) !== String(method.id)) return { refusal: refused('expiry-method-replaced') };
  return { method };
}

async function expiryWindowRefusal(meta, customer, method, database) {
  const [expiryYear, expiryMonth] = methodYearMonth(method);
  if (meta.source_entry_point === 'payment_expiry_workflow') {
    const [year, month] = etDateString().split('-').map(Number);
    const next = month === 12 ? [year + 1, 1] : [year, month + 1];
    if (!((expiryYear === year && expiryMonth === month) || (expiryYear === next[0] && expiryMonth === next[1]))) {
      return refused('expiry-window-passed');
    }
    const { FORMER_CUSTOMER_STAGES } = require('../customer-stages');
    if (FORMER_CUSTOMER_STAGES.includes(customer.pipeline_stage) || customer.pipeline_stage === 'lost') {
      return refused('former-customer');
    }
    if (!['active_customer', 'won', 'at_risk'].includes(customer.pipeline_stage)) {
      const paid = await database('payments').where({ customer_id: customer.id, status: 'paid' }).first('id');
      const upcoming = await database('scheduled_services').where({ customer_id: customer.id })
        .whereIn('status', ['pending', 'confirmed']).where('scheduled_date', '>=', etDateString()).first('id');
      if (!paid && !upcoming) return refused('payment-relationship-ended');
    }
  } else {
    const first = `${expiryYear}-${String(expiryMonth).padStart(2, '0')}-01`;
    if (first > etDateString(addETDays(new Date(), 60))) return refused('expiry-window-passed');
    const expired = `${expiryYear}-${String(expiryMonth).padStart(2, '0')}` < etDateString().slice(0, 7);
    if ((meta.expiry_stage === 'expired') !== expired) return refused('expiry-stage-changed');
  }
  return null;
}

async function expiryExemptionRefusal(meta, customer, method) {
  const { getCardExpiryExemptions } = require('../annual-prepay-renewals');
  const { isCardExpiryExemptMethod } = require('../card-expiry-exemptions');
  const [year, month] = etDateString().split('-').map(Number);
  const horizon = meta.source_entry_point === 'payment_expiry_workflow'
    ? new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10)
    : etDateString(addETDays(new Date(), 60));
  const exemptions = await getCardExpiryExemptions(horizon);
  return isCardExpiryExemptMethod(exemptions, customer.id, method.id) ? refused('prepay-covered') : null;
}

async function expiryRefusal(meta, database) {
  if (!EXPIRY_ENTRY_POINTS.has(meta.source_entry_point)) return null;
  const customerCheck = await expiryCustomerRefusal(meta, database);
  if (customerCheck.refusal) return customerCheck.refusal;
  const methodCheck = await expiryMethodRefusal(meta, customerCheck.customer, database);
  if (methodCheck.refusal) return methodCheck.refusal;
  const windowRefusal = await expiryWindowRefusal(meta, customerCheck.customer, methodCheck.method, database);
  if (windowRefusal) return windowRefusal;
  return expiryExemptionRefusal(meta, customerCheck.customer, methodCheck.method);
}

async function balanceReminderVisitRefusal(meta, database) {
  if (meta.source_entry_point !== 'balance_reminder_workflow') return null;
  if (!meta.appointment_id || !/^\d{4}-\d{2}-\d{2}$/.test(meta.appointment_date || '')
    || !String(meta.appointment_service_type || '').trim()
    || !/^\d{4}-\d{2}-\d{2}$/.test(meta.appointment_rendered_on || '')) {
    return refused('balance-reminder-visit-pin-missing');
  }
  if (meta.appointment_rendered_on !== etDateString()) return refused('balance-reminder-copy-stale');
  const visit = await database('scheduled_services')
    .where({ id: meta.appointment_id, customer_id: meta.customer_id })
    .first('status', 'scheduled_date', 'service_type');
  if (!visit || !['pending', 'confirmed'].includes(visit.status)
    || dateOnlyString(visit.scheduled_date) !== meta.appointment_date
    || String(visit.service_type || 'service') !== meta.appointment_service_type) {
    return refused('balance-reminder-visit-changed');
  }
  return null;
}

async function invoiceRefusal(meta, database) {
  if (!meta.invoice_id) return null;
  if (INVOICE_GUARDS.has(meta.source_entry_point)) {
    const verdict = await require('./deferred-replay-registry').invoiceStillCollectible(meta);
    if (verdict.eligible !== true) return refused(verdict.reason, verdict.retryable === true);
  }
  const ownership = await require('../invoice-helpers').selfPayAtDispatch(meta.invoice_id, database)();
  if (ownership.ok === true) return null;
  return refused(ownership.code || 'invoice-not-self-pay', ownership.code === 'INVOICE_UNREADABLE');
}

async function persistedLedgerExclusions(meta, database) {
  if (!meta.collections_ledger_id || !meta.customer_id || !meta.notificationEventKey) return [];
  const own = await database('collections_contact_ledger')
    .where({ id: meta.collections_ledger_id, customer_id: meta.customer_id })
    .whereRaw("metadata->>'notificationEventKey' = ?", [meta.notificationEventKey]).first('id', 'source');
  if (!own) return [];
  const rows = await database('collections_contact_ledger').where({ customer_id: meta.customer_id, source: own.source })
    .whereRaw("metadata->>'notificationEventKey' = ?", [meta.notificationEventKey]).select('id');
  return [...new Set(rows.map((row) => row.id).filter(Boolean))];
}

async function collectionsPolicyRefusal(meta, database) {
  if (!INVOICE_GUARDS.has(meta.source_entry_point) || process.env.GATE_COLLECTIONS_POLICY !== 'true') return null;
  const permitted = await require('../collections/rail-guard').collectionsChannelPermitted({
    customerId: meta.customer_id,
    invoiceId: meta.invoice_id || null,
    channel: 'email',
    purpose: meta.source_entry_point === 'balance_reminder_workflow' ? 'balance_reminder' : 'late_payment',
    logTag: 'billing-email-obligation-replay',
    excludeLedgerIds: await persistedLedgerExclusions(meta, database),
  });
  return permitted ? null : refused('collections-policy-denied');
}

async function billingEmailReplayEligible(meta, database = db) {
  try {
    const checks = [prechargeRefusal, expiryRefusal, balanceReminderVisitRefusal, invoiceRefusal, collectionsPolicyRefusal];
    for (const check of checks) {
      const refusal = await check(meta || {}, database);
      if (refusal) return refusal;
    }
    return { eligible: true };
  } catch {
    return refused('billing-email-eligibility-unavailable', true);
  }
}

// Producer-state eligibility only. Recipient resolution and provider-boundary
// send authorization remain the caller's responsibility when this is wired.
module.exports = { billingEmailReplayEligible };
