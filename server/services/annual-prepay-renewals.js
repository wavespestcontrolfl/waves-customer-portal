const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const AccountMembershipEmail = require('./account-membership-email');

const ACTIVE_STATUSES = ['active', 'renewal_pending'];
// Term statuses that represent a paid, still-current prepay period for BILLING
// suppression. Renewal decisions flip an in-window term to renewed/switch_plan
// (still covered through term_end) — those must stay billing-suppressed, so this
// set is broader than ACTIVE_STATUSES (which drives renewal alerts). It excludes
// payment_pending (unpaid) and cancelled (renewal decline / refund / termination).
const BILLING_COVERED_STATUSES = ['active', 'renewal_pending', 'renewed', 'switch_plan'];
const PAYMENT_PENDING_STATUS = 'payment_pending';
const CUSTOMER_NOTICE_DAYS = [30, 15, 7];
const DEFAULT_ALERT_DAYS = 30;
const LAST_SERVICE_GRACE_DAYS = 14;
const LAST_SERVICE_TERM_END_LOOKBACK_DAYS = 120;
const NOTICE_CLAIM_TTL_MS = 15 * 60 * 1000;
const INVOICE_CANCELLED_STATUSES = new Set(['void', 'cancelled', 'canceled', 'refunded']);

let tableExistsCache = null;
let scheduledColsCache = null;
let invoiceColsCache = null;

async function annualPrepayTableExists() {
  if (tableExistsCache != null) return tableExistsCache;
  try {
    tableExistsCache = await db.schema.hasTable('annual_prepay_terms');
  } catch (err) {
    logger.warn(`[annual-prepay] table detection failed: ${err.message}`);
    tableExistsCache = false;
  }
  return tableExistsCache;
}

async function scheduledServiceColumns() {
  if (scheduledColsCache) return scheduledColsCache;
  try {
    scheduledColsCache = await db('scheduled_services').columnInfo();
  } catch {
    scheduledColsCache = {};
  }
  return scheduledColsCache;
}

async function invoiceColumns() {
  if (invoiceColsCache) return invoiceColsCache;
  try {
    invoiceColsCache = await db('invoices').columnInfo();
  } catch {
    invoiceColsCache = {};
  }
  return invoiceColsCache;
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).split('T')[0].slice(0, 10);
}

function parseYmd(value) {
  const ymd = dateOnly(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function daysInMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0, 12, 0, 0)).getUTCDate();
}

function addMonthsSameDay(value, months) {
  const parts = parseYmd(value);
  if (!parts) return null;
  const monthIndex = parts.month - 1 + Number(months || 0);
  const targetYear = parts.year + Math.floor(monthIndex / 12);
  const targetMonthIndex = ((monthIndex % 12) + 12) % 12;
  const targetMonth = targetMonthIndex + 1;
  const targetDay = Math.min(parts.day, daysInMonth(targetYear, targetMonth));
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

function addDaysYmd(value, days) {
  const ymd = dateOnly(value) || etDateString();
  return etDateString(addETDays(parseETDateTime(`${ymd}T12:00`), Number(days || 0)));
}

function daysUntil(fromYmd, toYmd) {
  const from = parseYmd(fromYmd);
  const to = parseYmd(toYmd);
  if (!from || !to) return null;
  const fromUtc = Date.UTC(from.year, from.month - 1, from.day, 12, 0, 0);
  const toUtc = Date.UTC(to.year, to.month - 1, to.day, 12, 0, 0);
  return Math.round((toUtc - fromUtc) / 86400000);
}

function noticeColumnForDaysOut(daysOut) {
  const n = Number(daysOut);
  if (n === 30) return 'notice_30_sent_at';
  if (n === 15) return 'notice_15_sent_at';
  if (n === 7) return 'notice_7_sent_at';
  return null;
}

function noticeClaimColumnForDaysOut(daysOut) {
  const n = Number(daysOut);
  if (n === 30) return 'notice_30_claimed_at';
  if (n === 15) return 'notice_15_claimed_at';
  if (n === 7) return 'notice_7_claimed_at';
  return null;
}

function formatDateLabel(ymd) {
  if (!ymd) return '';
  return new Date(`${dateOnly(ymd)}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/New_York',
  });
}

function statusAfterDecision(action) {
  if (action === 'renew') return 'renewed';
  if (action === 'cancel') return 'cancelled';
  if (action === 'switch_plan') return 'switch_plan';
  return 'renewal_pending';
}

function invoiceTermStatus(invoice) {
  if (!invoice) return PAYMENT_PENDING_STATUS;
  const status = String(invoice.status || '').toLowerCase();
  if (INVOICE_CANCELLED_STATUSES.has(status)) return 'cancelled';
  if (status === 'paid' || invoice.paid_at) return 'active';
  return PAYMENT_PENDING_STATUS;
}

function parsePaymentMetadata(payment) {
  try {
    return typeof payment?.metadata === 'string'
      ? JSON.parse(payment.metadata || '{}')
      : (payment?.metadata || {});
  } catch {
    return {};
  }
}

async function findInvoiceIdForRefundedPayment(payment, conn = db) {
  const metadata = parsePaymentMetadata(payment);
  let invoiceId = payment?.invoice_id
    || metadata.invoice_id
    || metadata.invoiceId
    || metadata.waves_invoice_id
    || null;
  if (invoiceId) return invoiceId;

  const lookups = [
    ['stripe_payment_intent_id', payment?.stripe_payment_intent_id],
    ['stripe_charge_id', payment?.stripe_charge_id],
  ];
  for (const [column, value] of lookups) {
    if (!value) continue;
    const invoice = await conn('invoices').where({ [column]: value }).first('id');
    if (invoice?.id) return invoice.id;
  }

  return null;
}

function isLastServiceNearTermEnd(term) {
  const termEnd = dateOnly(term.term_end);
  const lastService = dateOnly(term.last_scheduled_service_date);
  const lastServiceToTermEnd = lastService ? daysUntil(lastService, termEnd) : null;
  return lastServiceToTermEnd != null
    && lastServiceToTermEnd >= 0
    && lastServiceToTermEnd <= LAST_SERVICE_TERM_END_LOOKBACK_DAYS;
}

async function findLastScheduledServiceForTerm(customerId, termStart, termEnd, conn = db) {
  if (!customerId || !termStart || !termEnd) return null;
  return conn('scheduled_services')
    .where({ customer_id: customerId })
    .whereBetween('scheduled_date', [termStart, termEnd])
    .whereNotIn('status', ['cancelled', 'rescheduled'])
    .orderBy('scheduled_date', 'desc')
    .orderBy('created_at', 'desc')
    .first('id', 'scheduled_date', 'service_type', 'status');
}

async function attachScheduledServices(term, conn = db) {
  const cols = await scheduledServiceColumns();
  if (!cols.annual_prepay_term_id || !term?.id) return;
  try {
    await conn('scheduled_services')
      .where({ customer_id: term.customer_id })
      .whereBetween('scheduled_date', [dateOnly(term.term_start), dateOnly(term.term_end)])
      .whereNotIn('status', ['cancelled', 'rescheduled'])
      .where(function () {
        this.whereNull('annual_prepay_term_id').orWhere('annual_prepay_term_id', term.id);
      })
      .update({ annual_prepay_term_id: term.id, updated_at: new Date() });
  } catch (err) {
    logger.warn(`[annual-prepay] scheduled service attach skipped: ${err.message}`);
  }
}

async function refreshTermSnapshot(termOrId, conn = db) {
  if (!(await annualPrepayTableExists())) return null;
  const term = typeof termOrId === 'object'
    ? termOrId
    : await conn('annual_prepay_terms').where({ id: termOrId }).first();
  if (!term) return null;

  const termStart = dateOnly(term.term_start);
  const termEnd = dateOnly(term.term_end);
  const lastService = await findLastScheduledServiceForTerm(term.customer_id, termStart, termEnd, conn);
  if (ACTIVE_STATUSES.includes(term.status)) {
    await attachScheduledServices({ ...term, term_start: termStart, term_end: termEnd }, conn);
  }

  const updates = {
    last_scheduled_service_id: lastService?.id || null,
    last_scheduled_service_date: lastService ? dateOnly(lastService.scheduled_date) : null,
    updated_at: new Date(),
  };

  const [updated] = await conn('annual_prepay_terms')
    .where({ id: term.id })
    .update(updates)
    .returning('*');

  return updated || { ...term, ...updates };
}

async function refreshActiveTermsForCustomer(customerId, conn = db) {
  if (!(await annualPrepayTableExists())) return [];
  if (!customerId) return [];

  const terms = await conn('annual_prepay_terms')
    .where({ customer_id: customerId })
    .whereIn('status', ACTIVE_STATUSES)
    .select('*');

  const refreshed = [];
  for (const term of terms) {
    const snapshot = await refreshTermSnapshot(term, conn);
    if (snapshot) refreshed.push(snapshot);
  }
  return refreshed;
}

async function syncCustomerRenewalDate(customerId, termEnd, conn = db) {
  if (!customerId || !termEnd) return;
  try {
    const customerCols = await conn('customers').columnInfo();
    if (!customerCols.waveguard_renewal_date) return;
    await conn('customers')
      .where({ id: customerId })
      .update({ waveguard_renewal_date: termEnd, updated_at: new Date() });
  } catch (err) {
    logger.warn(`[annual-prepay] customer renewal date sync skipped: ${err.message}`);
  }
}

async function syncInvoiceTerm(invoiceId, termId, conn = db) {
  if (!invoiceId || !termId) return;
  const cols = await invoiceColumns();
  if (!cols.annual_prepay_term_id) return;
  try {
    await conn('invoices').where({ id: invoiceId }).update({ annual_prepay_term_id: termId });
  } catch (err) {
    logger.warn(`[annual-prepay] invoice term sync skipped: ${err.message}`);
  }
}

async function statusForPrepayInvoice(invoiceId, conn = db) {
  if (!invoiceId) return 'active';
  try {
    const invoice = await conn('invoices').where({ id: invoiceId }).first('id', 'status', 'paid_at');
    return invoiceTermStatus(invoice);
  } catch (err) {
    logger.warn(`[annual-prepay] invoice status lookup skipped: ${err.message}`);
    return PAYMENT_PENDING_STATUS;
  }
}

async function syncTermForInvoicePayment(invoiceOrId, conn = db) {
  if (!(await annualPrepayTableExists())) return [];
  const invoice = typeof invoiceOrId === 'object'
    ? invoiceOrId
    : await conn('invoices').where({ id: invoiceOrId }).first('id', 'status', 'paid_at');
  if (!invoice?.id) return [];

  const nextStatus = invoiceTermStatus(invoice);
  const terms = await conn('annual_prepay_terms')
    .where({ prepay_invoice_id: invoice.id })
    .whereIn('status', [PAYMENT_PENDING_STATUS, ...ACTIVE_STATUSES])
    .select('*');

  const results = [];
  for (const term of terms) {
    let current = term;
    if (nextStatus === 'active' && term.status === PAYMENT_PENDING_STATUS) {
      const [updated] = await conn('annual_prepay_terms')
        .where({ id: term.id, status: PAYMENT_PENDING_STATUS })
        .update({ status: 'active', updated_at: new Date() })
        .returning('*');
      current = updated || term;
    } else if (nextStatus === 'cancelled') {
      const [updated] = await conn('annual_prepay_terms')
        .where({ id: term.id })
        .whereNull('renewal_decision')
        .update({ status: 'cancelled', updated_at: new Date() })
        .returning('*');
      current = updated || term;
    }

    if (ACTIVE_STATUSES.includes(current.status)) {
      await syncCustomerRenewalDate(current.customer_id, dateOnly(current.term_end), conn);
      const refreshed = await refreshTermSnapshot(current, conn);
      results.push(refreshed || current);
    } else {
      results.push(current);
    }
  }

  return results;
}

async function syncTermForRefundedPayment(payment, conn = db) {
  if (!(await annualPrepayTableExists()) || !payment) return [];
  const invoiceId = await findInvoiceIdForRefundedPayment(payment, conn);
  if (!invoiceId) return [];

  return syncTermForInvoicePayment({
    id: invoiceId,
    status: 'refunded',
    paid_at: null,
  }, conn);
}

async function activatePaidPendingTerms(conn = db) {
  if (!(await annualPrepayTableExists())) return [];
  const rows = await conn('annual_prepay_terms as t')
    .join('invoices as i', 't.prepay_invoice_id', 'i.id')
    .where('t.status', PAYMENT_PENDING_STATUS)
    .where(function () {
      this.where('i.status', 'paid').orWhereNotNull('i.paid_at');
    })
    .select('i.id');

  const activated = [];
  for (const row of rows) {
    const synced = await syncTermForInvoicePayment(row.id, conn);
    activated.push(...synced.filter((term) => ACTIVE_STATUSES.includes(term.status)));
  }
  return activated;
}

async function createTermForAnnualPrepay({
  customerId,
  sourceEstimateId = null,
  prepayInvoiceId = null,
  planLabel = 'WaveGuard Annual Prepay',
  monthlyRate = null,
  prepayAmount = null,
  termStart = null,
  termEnd = null,
  conn = db,
} = {}) {
  if (!(await annualPrepayTableExists())) return null;
  if (!customerId) throw new Error('customerId is required');

  const normalizedStart = dateOnly(termStart) || etDateString();
  const normalizedEnd = dateOnly(termEnd) || addMonthsSameDay(normalizedStart, 12);
  if (!normalizedEnd) throw new Error('Could not determine annual prepay term end');
  const nextStatus = await statusForPrepayInvoice(prepayInvoiceId, conn);

  let existing = null;
  if (sourceEstimateId || prepayInvoiceId) {
    existing = await conn('annual_prepay_terms')
      .where(function () {
        if (sourceEstimateId) this.orWhere({ source_estimate_id: sourceEstimateId });
        if (prepayInvoiceId) this.orWhere({ prepay_invoice_id: prepayInvoiceId });
      })
      .first();
  }
  if (!existing) {
    existing = await conn('annual_prepay_terms')
      .where({
        customer_id: customerId,
        term_start: normalizedStart,
        term_end: normalizedEnd,
      })
      .whereIn('status', ACTIVE_STATUSES)
      .first();
  }

  if (existing) {
    const updates = {
      source_estimate_id: existing.source_estimate_id || sourceEstimateId || null,
      prepay_invoice_id: existing.prepay_invoice_id || prepayInvoiceId || null,
      plan_label: planLabel || existing.plan_label,
      monthly_rate: monthlyRate != null ? monthlyRate : existing.monthly_rate,
      prepay_amount: prepayAmount != null ? prepayAmount : existing.prepay_amount,
      status: existing.renewal_decision ? existing.status : nextStatus,
      updated_at: new Date(),
    };
    // Honor explicitly supplied coverage dates so an edit can correct them.
    // Only the start supplied → recompute the 12-month end from it; neither
    // supplied → leave the existing window untouched (the estimate flow re-runs
    // with null dates and must not have its term reset).
    const suppliedStart = dateOnly(termStart);
    const suppliedEnd = dateOnly(termEnd);
    if (suppliedStart) updates.term_start = suppliedStart;
    if (suppliedEnd) updates.term_end = suppliedEnd;
    else if (suppliedStart) updates.term_end = addMonthsSameDay(suppliedStart, 12);
    await conn('annual_prepay_terms').where({ id: existing.id }).update(updates);
    // When the coverage window is edited (start/end actually supplied), detach
    // any visits attachScheduledServices() stamped under the old window that now
    // fall outside it — refreshTermSnapshot only re-attaches in-window visits, it
    // never removes out-of-window ones, so a shortened/moved window would keep
    // reporting stale visits as Annual Prepay. Skipped when no dates were given
    // (the estimate re-run path), so it only fires on a real window change.
    if (updates.term_start || updates.term_end) {
      const scCols = await scheduledServiceColumns();
      if (scCols.annual_prepay_term_id) {
        const winStart = dateOnly(updates.term_start || existing.term_start);
        const winEnd = dateOnly(updates.term_end || existing.term_end);
        try {
          await conn('scheduled_services')
            .where({ annual_prepay_term_id: existing.id })
            .andWhere(function () {
              this.where('scheduled_date', '<', winStart).orWhere('scheduled_date', '>', winEnd);
            })
            .update({ annual_prepay_term_id: null, updated_at: new Date() });
        } catch (err) {
          logger.warn(`[annual-prepay] scheduled service detach skipped: ${err.message}`);
        }
      }
    }
    await syncInvoiceTerm(prepayInvoiceId, existing.id, conn);
    const refreshed = await refreshTermSnapshot(existing.id, conn);
    if (refreshed && ACTIVE_STATUSES.includes(refreshed.status)) {
      await syncCustomerRenewalDate(customerId, normalizedEnd, conn);
    }
    return refreshed;
  }

  const [term] = await conn('annual_prepay_terms').insert({
    customer_id: customerId,
    source_estimate_id: sourceEstimateId || null,
    prepay_invoice_id: prepayInvoiceId || null,
    plan_label: planLabel,
    monthly_rate: monthlyRate != null ? monthlyRate : null,
    prepay_amount: prepayAmount != null ? prepayAmount : null,
    term_start: normalizedStart,
    term_end: normalizedEnd,
    status: nextStatus,
  }).returning('*');

  await syncInvoiceTerm(prepayInvoiceId, term.id, conn);
  const refreshed = await refreshTermSnapshot(term.id, conn);
  if (refreshed && ACTIVE_STATUSES.includes(refreshed.status)) {
    await syncCustomerRenewalDate(customerId, normalizedEnd, conn);
  }
  return refreshed;
}

function shouldAlertTerm(term, today, daysAhead = DEFAULT_ALERT_DAYS) {
  const termEnd = dateOnly(term.term_end);
  const lastService = dateOnly(term.last_scheduled_service_date);
  const termEndDays = daysUntil(today, termEnd);
  const lastServiceDays = lastService ? daysUntil(today, lastService) : null;
  const termEndTrigger = termEndDays != null && termEndDays >= 0 && termEndDays <= daysAhead;
  const lastServiceTrigger = lastServiceDays != null
    && isLastServiceNearTermEnd(term)
    && lastServiceDays >= -LAST_SERVICE_GRACE_DAYS
    && lastServiceDays <= daysAhead;
  return termEndTrigger || lastServiceTrigger;
}

async function getOpenRenewalAlerts({ daysAhead = DEFAULT_ALERT_DAYS, today = etDateString() } = {}) {
  if (!(await annualPrepayTableExists())) return [];
  await activatePaidPendingTerms();
  const soon = addDaysYmd(today, daysAhead);
  const candidates = await db('annual_prepay_terms as t')
    .leftJoin('customers as c', 't.customer_id', 'c.id')
    .whereIn('t.status', ACTIVE_STATUSES)
    .whereNull('t.renewal_decision')
    // Soft-deleted customers get no renewal outreach.
    .whereNull('c.deleted_at')
    .where(function () {
      this.whereBetween('t.term_end', [today, soon])
        .orWhereBetween('t.last_scheduled_service_date', [addDaysYmd(today, -LAST_SERVICE_GRACE_DAYS), soon]);
    })
    .select(
      't.*',
      'c.first_name',
      'c.last_name',
      'c.phone',
      'c.email'
    )
    .orderBy('t.term_end', 'asc')
    .limit(100);

  const alerts = [];
  for (const candidate of candidates) {
    const refreshed = await refreshTermSnapshot(candidate.id);
    const term = { ...candidate, ...(refreshed || {}) };
    if (!shouldAlertTerm(term, today, daysAhead)) continue;
    const termEnd = dateOnly(term.term_end);
    const lastServiceDate = dateOnly(term.last_scheduled_service_date);
    alerts.push({
      id: term.id,
      source: 'annual_prepay',
      customerId: term.customer_id,
      customerName: `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim(),
      phone: candidate.phone,
      email: candidate.email,
      planLabel: term.plan_label || 'Annual Prepay',
      termStart: dateOnly(term.term_start),
      termEnd,
      lastScheduledServiceId: term.last_scheduled_service_id,
      lastScheduledServiceDate: lastServiceDate,
      daysUntilTermEnd: daysUntil(today, termEnd),
      daysUntilLastService: lastServiceDate ? daysUntil(today, lastServiceDate) : null,
      status: term.status,
      createdAt: term.created_at,
    });
  }
  return alerts;
}

async function sendCustomerTermNotice(termOrId, daysOut, opts = {}) {
  if (!(await annualPrepayTableExists())) return { sent: false, reason: 'table_missing' };
  const noticeCol = noticeColumnForDaysOut(daysOut);
  const claimCol = noticeClaimColumnForDaysOut(daysOut);
  if (!noticeCol || !claimCol) return { sent: false, reason: 'unsupported_days_out' };

  const refreshed = await refreshTermSnapshot(termOrId);
  const term = refreshed || (typeof termOrId === 'object' ? termOrId : null);
  if (!term || term[noticeCol]) return { sent: false, reason: term ? 'already_sent' : 'term_not_found' };
  const previousStatus = term.status;
  const now = new Date();
  const staleClaimCutoff = new Date(now.getTime() - NOTICE_CLAIM_TTL_MS);

  const [claimedTerm] = await db('annual_prepay_terms')
    .where({ id: term.id })
    .whereIn('status', ACTIVE_STATUSES)
    .whereNull('renewal_decision')
    .whereNull(noticeCol)
    .where(function noticeClaimAvailable() {
      this.whereNull(claimCol).orWhere(claimCol, '<', staleClaimCutoff);
    })
    .update({
      [claimCol]: now,
      status: term.status === 'active' ? 'renewal_pending' : term.status,
      updated_at: now,
    })
    .returning('*');

  if (!claimedTerm) return { sent: false, reason: 'already_claimed' };

  const releaseClaim = async () => {
    await db('annual_prepay_terms')
      .where({ id: claimedTerm.id })
      .whereNull('renewal_decision')
      .whereNull(noticeCol)
      .update({
        [claimCol]: null,
        status: previousStatus,
        updated_at: new Date(),
      })
      .catch((err) => logger.warn(`[annual-prepay] notice claim release failed for term ${claimedTerm.id}: ${err.message}`));
  };

  let noticeRecorded = false;
  try {
    const customer = await db('customers').where({ id: claimedTerm.customer_id }).first();
    const lastServiceDate = dateOnly(claimedTerm.last_scheduled_service_date);
    if (!customer) {
      await releaseClaim();
      return { sent: false, reason: 'customer_not_found' };
    }

    const sendRenewalEmail = async () => {
      try {
        const result = await AccountMembershipEmail.sendMembershipRenewalReminder({
          customerId: customer.id,
          renewalDate: claimedTerm.term_end,
          daysOut,
          termId: claimedTerm.id,
          lastServiceDate,
        });
        if (result?.sent === false || result?.ok === false) {
          logger.warn(`[annual-prepay] renewal email not sent for term ${claimedTerm.id}: ${result.reason || 'not_sent'}`);
        }
        return result?.sent === true || result?.ok === true;
      } catch (err) {
        logger.warn(`[annual-prepay] renewal email failed for term ${claimedTerm.id}: ${err.message}`);
        return false;
      }
    };
    const markNoticeSent = async (sentAt = new Date()) => {
      await db('annual_prepay_terms')
        .where({ id: claimedTerm.id })
        .whereNull(noticeCol)
        .update({
          [noticeCol]: sentAt,
          [claimCol]: null,
          updated_at: sentAt,
        });
      noticeRecorded = true;
    };

    if (!customer?.phone) {
      const emailSent = await sendRenewalEmail();
      if (emailSent) {
        await markNoticeSent();
        return { sent: true, termId: claimedTerm.id, channel: 'email', sms: false };
      }
      await releaseClaim();
      return { sent: false, reason: 'no_phone' };
    }

    const lastServiceSentence = lastServiceDate && isLastServiceNearTermEnd(claimedTerm)
      ? ` The last service currently on your schedule for this prepaid term is ${formatDateLabel(lastServiceDate)}.`
      : '';
    const body = await renderSmsTemplate(
      'annual_prepay_renewal_reminder',
      {
        first_name: customer.first_name || 'there',
        term_end: formatDateLabel(claimedTerm.term_end),
        last_service_sentence: lastServiceSentence,
      },
      { workflow: 'annual_prepay_renewal_reminder', entity_type: 'annual_prepay_term', entity_id: claimedTerm.id },
    );
    if (!body) {
      logger.warn(`[annual-prepay] annual_prepay_renewal_reminder template missing/disabled for customer ${customer.id}`);
      const emailSent = await sendRenewalEmail();
      if (emailSent) {
        await markNoticeSent();
        return { sent: true, termId: claimedTerm.id, channel: 'email', sms: false, reason: 'missing_sms_template' };
      }
      await releaseClaim();
      return { sent: false, reason: 'missing_sms_template' };
    }

    const smsResult = await sendCustomerMessage({
      to: customer.phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: 'retention',
      customerId: customer.id,
      identityTrustLevel: 'phone_matches_customer',
      entryPoint: 'annual_prepay_renewal',
      consentBasis: {
        status: 'opted_in',
        source: 'customer_retention_preferences',
        capturedAt: customer.updated_at || customer.created_at || new Date().toISOString(),
      },
      metadata: {
        original_message_type: 'annual_prepay_renewal_reminder',
        annual_prepay_term_id: claimedTerm.id,
        days_out: daysOut,
        ...(opts.metadata || {}),
      },
    });

    if (!smsResult.sent) {
      logger.warn(`[annual-prepay] renewal SMS blocked/failed for term ${claimedTerm.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
      const emailSent = await sendRenewalEmail();
      if (emailSent) {
        await markNoticeSent();
        return { sent: true, termId: claimedTerm.id, channel: 'email', sms: false, reason: smsResult.code || smsResult.reason || 'send_failed' };
      }
      await releaseClaim();
      return { sent: false, reason: smsResult.code || smsResult.reason || 'send_failed' };
    }

    const sentAt = new Date();
    await markNoticeSent(sentAt);

    await db('customer_interactions').insert({
      customer_id: customer.id,
      interaction_type: 'sms_outbound',
      channel: 'sms',
      subject: `Annual prepay renewal - ${daysOut}-day reminder`,
      body: `Automated annual prepay renewal reminder sent (${daysOut} days out)`,
    }).catch((err) => logger.warn(`[annual-prepay] interaction insert failed: ${err.message}`));

    void sendRenewalEmail();

    return { sent: true, termId: claimedTerm.id };
  } catch (err) {
    if (!noticeRecorded) await releaseClaim();
    throw err;
  }
}

async function checkAndSend({ today = etDateString() } = {}) {
  if (!(await annualPrepayTableExists())) return { sent: 0 };
  await activatePaidPendingTerms();
  let sent = 0;

  for (const daysOut of CUSTOMER_NOTICE_DAYS) {
    const target = addDaysYmd(today, daysOut);
    const noticeCol = noticeColumnForDaysOut(daysOut);
    const terms = await db('annual_prepay_terms')
      .whereIn('status', ACTIVE_STATUSES)
      .whereNull('renewal_decision')
      .whereNull(noticeCol)
      .where(function noticeClaimAvailable() {
        const claimCol = noticeClaimColumnForDaysOut(daysOut);
        this.whereNull(claimCol).orWhere(claimCol, '<', new Date(Date.now() - NOTICE_CLAIM_TTL_MS));
      })
      .where('term_end', target)
      .select('*');

    for (const term of terms) {
      try {
        const result = await sendCustomerTermNotice(term, daysOut);
        if (result.sent) sent++;
      } catch (err) {
        logger.error(`[annual-prepay] reminder failed for term ${term.id}: ${err.message}`);
      }
    }
  }

  return { sent };
}

async function hasAnnualPrepayRenewal(customerId, termEnd) {
  if (!(await annualPrepayTableExists())) return false;
  const row = await db('annual_prepay_terms')
    .where({ customer_id: customerId, term_end: dateOnly(termEnd) })
    .first('id');
  return !!row;
}

async function recordDecision({ termId, action, adminUserId = null, notes = null } = {}) {
  if (!(await annualPrepayTableExists())) return null;
  const allowed = new Set(['contacted', 'renew', 'cancel', 'switch_plan']);
  if (!allowed.has(action)) throw new Error('invalid annual prepay action');
  const now = new Date();
  if (action === 'contacted') {
    const update = {
      status: 'renewal_pending',
      renewal_contacted_at: now,
      renewal_contacted_by: adminUserId || null,
      updated_at: now,
    };
    if (notes) update.renewal_notes = notes;
    const [term] = await db('annual_prepay_terms')
      .where({ id: termId })
      .whereIn('status', ACTIVE_STATUSES)
      .whereNull('renewal_decision')
      .update(update)
      .returning('*');
    return term || null;
  }

  const update = {
    status: statusAfterDecision(action),
    renewal_decision: action,
    renewal_decision_at: now,
    renewal_decision_by: adminUserId || null,
    updated_at: now,
  };
  if (notes) update.renewal_notes = notes;
  const [term] = await db('annual_prepay_terms')
    .where({ id: termId })
    .whereIn('status', ACTIVE_STATUSES)
    .whereNull('renewal_decision')
    .update(update)
    .returning('*');
  return term || null;
}

/**
 * Customer IDs whose prepay coverage is active on `asOf` (ET date string;
 * defaults to today). A customer in this set has paid for the current period up
 * front and MUST be excluded from monthly billing even when active +
 * monthly_rate > 0 + autopay on. The paid coverage term — not a zeroed
 * monthly_rate — is the billing-suppression source of truth, so monthly_rate
 * stays on the profile for renewal/reporting math.
 *
 * Coverage = today within [term_start, term_end] AND a BILLING_COVERED_STATUSES
 * term AND the prepay invoice is not void/refunded. Keying on the paid invoice
 * (rather than only ACTIVE_STATUSES) keeps renewal-decided terms — renewed /
 * switch_plan, still covered through term_end — suppressed, while a refund
 * (invoice flips to refunded) correctly re-enables monthly billing.
 */
async function getActivelyCoveredCustomerIds(asOf = etDateString(), conn = db) {
  if (!(await annualPrepayTableExists())) return new Set();
  const today = dateOnly(asOf) || etDateString();
  const cancelledStatuses = [...INVOICE_CANCELLED_STATUSES];
  const rows = await conn('annual_prepay_terms as t')
    .leftJoin('invoices as i', 'i.id', 't.prepay_invoice_id')
    .where('t.term_start', '<=', today)
    .where('t.term_end', '>=', today)
    // Covered = a paid-coverage status, OR a payment_pending term whose invoice
    // is in fact paid (webhook/reconcile lag). activatePaidPendingTerms() is the
    // canonical recovery (run before this in the billing cron); this OR-branch
    // is the belt-and-suspenders guard if that sync hasn't caught up.
    .where(function statusGuard() {
      this.whereIn('t.status', BILLING_COVERED_STATUSES)
        .orWhere(function paidPending() {
          this.where('t.status', PAYMENT_PENDING_STATUS)
            .andWhere(function invoicePaid() {
              this.where('i.status', 'paid').orWhereNotNull('i.paid_at');
            });
        })
        // A 'cancelled' status is overloaded: a renewal *lapse* decision
        // (renewal_decision='cancel') still leaves the already-paid term current
        // through term_end, whereas a refund sets status='cancelled' with a NULL
        // renewal_decision. Keep the lapsed-but-still-paid customer suppressed;
        // the invoice/payment refund exclusions below still drop true refunds.
        .orWhere(function lapsedRenewalStillInTerm() {
          this.where('t.status', 'cancelled').andWhere('t.renewal_decision', 'cancel');
        });
    })
    // Exclude void/refunded prepay invoices…
    .whereRaw(
      `lower(coalesce(i.status, 'paid')) not in (${cancelledStatuses.map(() => '?').join(', ')})`,
      cancelledStatuses,
    )
    // …and any term whose prepay payment was FULLY refunded. The Stripe refund
    // webhook (charge.refunded) flips a full refund to status='refunded' /
    // refund_status='full' on the payment row — it does NOT flip invoices.status
    // or set refunded_at — so detect it on the payment via the invoice's Stripe
    // identifiers. Partial refunds (status stays 'paid') keep coverage.
    .whereRaw(
      `not exists (
        select 1 from payments p
        where (p.status = 'refunded' or p.refund_status = 'full')
          and (
            (p.stripe_payment_intent_id is not null and p.stripe_payment_intent_id = i.stripe_payment_intent_id)
            or (p.stripe_charge_id is not null and p.stripe_charge_id = i.stripe_charge_id)
          )
      )`,
    )
    .distinct('t.customer_id');
  return new Set(rows.map((r) => String(r.customer_id)));
}

module.exports = {
  createTermForAnnualPrepay,
  getActivelyCoveredCustomerIds,
  refreshTermSnapshot,
  refreshActiveTermsForCustomer,
  syncTermForInvoicePayment,
  syncTermForRefundedPayment,
  activatePaidPendingTerms,
  getOpenRenewalAlerts,
  sendCustomerTermNotice,
  checkAndSend,
  hasAnnualPrepayRenewal,
  recordDecision,
  _private: {
    dateOnly,
    addMonthsSameDay,
    addDaysYmd,
    daysUntil,
    noticeColumnForDaysOut,
    noticeClaimColumnForDaysOut,
    shouldAlertTerm,
    isLastServiceNearTermEnd,
    invoiceTermStatus,
    formatDateLabel,
    parsePaymentMetadata,
    findInvoiceIdForRefundedPayment,
  },
};
