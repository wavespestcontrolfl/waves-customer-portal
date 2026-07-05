const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const AccountMembershipEmail = require('./account-membership-email');

const ACTIVE_STATUSES = ['active', 'renewal_pending'];
const COVERED_STATUSES = [...ACTIVE_STATUSES, 'renewed', 'switch_plan'];
const PAYMENT_PENDING_STATUS = 'payment_pending';
const CUSTOMER_NOTICE_DAYS = [30, 15, 7];
// Days BEFORE term_start the unpaid-prepay payment reminder fires (daily cron
// granularity: 3 days out and the day before the first visit).
const PAYMENT_REMINDER_DAYS = [3, 1];
const DEFAULT_ALERT_DAYS = 30;
const LAST_SERVICE_GRACE_DAYS = 14;
const LAST_SERVICE_TERM_END_LOOKBACK_DAYS = 120;
const NOTICE_CLAIM_TTL_MS = 15 * 60 * 1000;
// prepaid_method written when annual-prepay coverage stamps a visit. Stamp
// cleanup filters on this so it never clears an independent cash/Zelle/etc.
// prepayment made through the regular schedule prepay route.
const ANNUAL_PREPAY_PREPAID_METHOD = 'annual_prepay_invoice';
const INVOICE_CANCELLED_STATUSES = new Set(['void', 'cancelled', 'canceled', 'refunded']);
const COVERAGE_EXCLUDED_STATUSES = new Set(['cancelled', 'canceled', 'no_show', 'skipped', 'rescheduled']);
const PREPAID_UPDATE_EXCLUDED_STATUSES = new Set([...COVERAGE_EXCLUDED_STATUSES, 'completed']);

let tableExistsCache = null;
let termColsCache = null;
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

function resetCachesForTests() {
  tableExistsCache = null;
  termColsCache = null;
  scheduledColsCache = null;
  invoiceColsCache = null;
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

async function annualPrepayColumns(conn = db) {
  if (conn === db && termColsCache) return termColsCache;
  let cols = {};
  try {
    cols = await conn('annual_prepay_terms').columnInfo();
  } catch {
    cols = {};
  }
  if (conn === db) termColsCache = cols;
  return cols;
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

function normalizeCoverageServiceType(value) {
  const cleaned = String(value || '').trim().replace(/\s+/g, ' ');
  // Cap to 100: this value is written verbatim into scheduled_services.service_type
  // (varchar(100)) when coverage rows are seeded, so a longer label would fail
  // activation with a Postgres "value too long" error.
  return cleaned ? cleaned.slice(0, 100) : null;
}

function normalizeCoverageVisitCount(value) {
  const count = Number.parseInt(value, 10);
  return Number.isInteger(count) && count > 0 ? Math.min(count, 24) : null;
}

function normalizeCoverageCadence(value) {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!cleaned) return null;

  const aliases = {
    bi_monthly: 'bimonthly',
    every_2_months: 'bimonthly',
    every_2_month: 'bimonthly',
    every_two_months: 'bimonthly',
    every_three_months: 'quarterly',
    every_3_months: 'quarterly',
    every_four_months: 'triannual',
    every_4_months: 'triannual',
    every_six_months: 'semiannual',
    every_6_months: 'semiannual',
    every_6_weeks: 'every_6_weeks',
    every_six_weeks: 'every_6_weeks',
    every_42_days: 'every_6_weeks',
    six_weeks: 'every_6_weeks',
    semi_annual: 'semiannual',
    biannual: 'semiannual',
    yearly: 'annual',
  };

  const normalized = aliases[cleaned] || cleaned;
  return ['monthly', 'bimonthly', 'quarterly', 'triannual', 'semiannual', 'annual', 'every_6_weeks'].includes(normalized)
    ? normalized
    : null;
}

function coverageCadenceMonths(value) {
  const cadence = normalizeCoverageCadence(value);
  if (cadence === 'monthly') return 1;
  if (cadence === 'bimonthly') return 2;
  if (cadence === 'quarterly') return 3;
  if (cadence === 'triannual') return 4;
  if (cadence === 'semiannual') return 6;
  if (cadence === 'annual') return 12;
  return null;
}

function coverageCadenceDays(value) {
  const cadence = normalizeCoverageCadence(value);
  if (cadence === 'every_6_weeks') return 42;
  return null;
}

function coverageCadenceSchedule(value) {
  const cadence = normalizeCoverageCadence(value);
  const months = coverageCadenceMonths(cadence);
  if (months) return { unit: 'months', value: months, cadence };
  const days = coverageCadenceDays(cadence);
  if (days) return { unit: 'days', value: days, cadence };
  return null;
}

function inferCoverageCadence(term = {}) {
  const explicit = normalizeCoverageCadence(term?.coverage_cadence);
  if (explicit) return explicit;

  const serviceType = String(term?.coverage_service_type || '').toLowerCase();
  if (/\bbi[-\s]?monthly\b|\bevery\s*2\s*months?\b/.test(serviceType)) return 'bimonthly';
  if (/\bquarterly\b|\bevery\s*3\s*months?\b/.test(serviceType)) return 'quarterly';
  if (/\btri[-\s]?annual\b|\bevery\s*4\s*months?\b/.test(serviceType)) return 'triannual';
  if (/\bsemi[-\s]?annual\b|\bevery\s*6\s*months?\b/.test(serviceType)) return 'semiannual';
  if (/\bannual\b|\byearly\b|\bevery\s*12\s*months?\b/.test(serviceType)) return 'annual';
  if (/\bevery\s*6\s*weeks?\b|\b6\s*weeks\b|\b42\s*days\b/.test(serviceType)) return 'every_6_weeks';
  if (/\bmonthly\b/.test(serviceType)) return 'monthly';

  const coverageVisitCount = normalizeCoverageVisitCount(term?.coverage_visit_count);
  if (coverageVisitCount === 12) return 'monthly';
  if (coverageVisitCount === 6) return 'bimonthly';
  if (coverageVisitCount === 4) return 'quarterly';
  if (coverageVisitCount === 3) return 'triannual';
  if (coverageVisitCount === 2) return 'semiannual';
  if (coverageVisitCount === 1) return 'annual';
  if (coverageVisitCount === 9) return 'every_6_weeks';

  return 'quarterly';
}

function coverageServiceKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(quarterly|monthly|bimonthly|bi-monthly|semiannual|semi-annual|annual|yearly|recurring|general|program|service|visit|application|applications|every|week|weeks|day|days|six|42|6)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function serviceMatchesCoverage(row, coverageServiceType) {
  const target = coverageServiceKey(coverageServiceType);
  const service = coverageServiceKey(row?.service_type);
  if (!target || !service) return false;
  return service === target || service.includes(target) || target.includes(service);
}

function splitCoverageAmount(totalDollars, visitCount) {
  const total = Number(totalDollars);
  const count = Number(visitCount);
  if (!Number.isFinite(total) || total <= 0 || !Number.isInteger(count) || count <= 0) return [];
  const totalCents = Math.round(total * 100);
  const baseCents = Math.floor(totalCents / count);
  const remainder = totalCents - baseCents * count;
  return Array.from({ length: count }, (_, index) => (
    (baseCents + (index === count - 1 ? remainder : 0)) / 100
  ));
}

function coverageScheduleDates(termStart, visitCount, cadence, termEnd = null) {
  const normalizedStart = dateOnly(termStart);
  const count = normalizeCoverageVisitCount(visitCount);
  if (!normalizedStart || !count) return [];
  const schedule = coverageCadenceSchedule(cadence) || coverageCadenceSchedule(inferCoverageCadence({ coverage_visit_count: count }));
  if (!schedule) return [];
  const normalizedEnd = termEnd ? dateOnly(termEnd) : null;
  const dates = [];
  for (let index = 0; index < count; index++) {
    const date = schedule.unit === 'days'
      ? addDaysYmd(normalizedStart, index * schedule.value)
      : addMonthsSameDay(normalizedStart, index * schedule.value);
    if (!date) return [];
    if (normalizedEnd && date > normalizedEnd) break;
    dates.push(date);
  }
  return dates;
}

async function coverageRowsForTerm(term, conn = db, { includeTerminalStatuses = false } = {}) {
  const coverageServiceType = normalizeCoverageServiceType(term?.coverage_service_type);
  const coverageVisitCount = normalizeCoverageVisitCount(term?.coverage_visit_count);
  const termStart = dateOnly(term?.term_start);
  const termEnd = dateOnly(term?.term_end);
  if (!term?.customer_id || !coverageServiceType || !coverageVisitCount || !termStart || !termEnd) {
    return [];
  }

  const rows = await conn('scheduled_services')
    .where({ customer_id: term.customer_id })
    .whereBetween('scheduled_date', [termStart, termEnd])
    .orderBy(['scheduled_date', 'window_start', 'id'])
    .select('*');

  const filtered = includeTerminalStatuses
    ? rows
    : rows.filter((row) => !COVERAGE_EXCLUDED_STATUSES.has(String(row.status || '').toLowerCase()));

  const matching = filtered.filter((row) => serviceMatchesCoverage(row, coverageServiceType));
  if (matching.length <= coverageVisitCount) return matching;

  // More matching candidates than sold visits: keep the visits already committed
  // to THIS term (linked or annual-prepay-stamped) inside the slice. Plain
  // date-order slicing would let a newly-added earlier matching visit displace an
  // already-stamped later one, which then keeps its orphaned prepaid stamp —
  // leaving more than coverageVisitCount visits prepaid and skipping completion
  // billing on the extra work. Fill any remaining slots with the earliest
  // uncommitted matches, then return the selection in date order.
  const isCommittedToTerm = (row) =>
    (term.id != null && String(row.annual_prepay_term_id) === String(term.id))
    || (Number(row.prepaid_amount) > 0 && row.prepaid_method === ANNUAL_PREPAY_PREPAID_METHOD);
  const selectedIds = new Set(
    [...matching.filter(isCommittedToTerm), ...matching.filter((row) => !isCommittedToTerm(row))]
      .slice(0, coverageVisitCount)
      .map((row) => row.id),
  );
  return matching.filter((row) => selectedIds.has(row.id));
}

async function ensureCoverageRowsForTerm(term, conn = db) {
  const coverageServiceType = normalizeCoverageServiceType(term?.coverage_service_type);
  const coverageVisitCount = normalizeCoverageVisitCount(term?.coverage_visit_count);
  const coverageCadence = inferCoverageCadence(term);
  const termStart = dateOnly(term?.term_start);
  const termEnd = dateOnly(term?.term_end);
  const targetDates = coverageScheduleDates(termStart, coverageVisitCount, coverageCadence, termEnd);
  if (!term?.customer_id || !coverageServiceType || !coverageVisitCount || !termStart || !termEnd || !targetDates.length) {
    return { createdCount: 0, targetDates: [], reason: 'coverage_not_configured' };
  }

  const cols = await scheduledServiceColumns();
  if (!cols.scheduled_date || !cols.service_type) {
    return { createdCount: 0, targetDates, reason: 'scheduled_columns_missing' };
  }

  // Only count visits that can actually be stamped prepaid downstream:
  // attachScheduledServices() / applyPrepaidCoverageForTerm() use the
  // non-terminal coverage set, so a cancelled / skipped / no-show / rescheduled
  // visit must NOT consume one of the sold coverageVisitCount slots or suppress
  // its generated replacement — otherwise the paid term ends up with fewer
  // covered visits than the admin sold.
  const existingRows = await coverageRowsForTerm({ ...term, term_start: termStart, term_end: termEnd }, conn);

  // Existing in-window matching visits (e.g. the customer's pre-existing route)
  // already satisfy coverage even when they don't land on the exact generated
  // cadence dates. Treat a generated date within half a cadence interval of an
  // existing visit as already covered, so a July-1 target doesn't lay a second
  // series on top of an existing July-15 route. Each existing visit is consumed
  // by at most ONE slot (removed from the pool once matched) — otherwise a single
  // visit sitting midway between two cadence dates would suppress both and leave
  // the paid coverage short. The remaining-count cap stops over-seeding when the
  // customer already has at least the sold number of in-window matching visits.
  const availableExistingDates = existingRows.map((row) => dateOnly(row.scheduled_date)).filter(Boolean);
  const cadenceMonths = coverageCadenceMonths(coverageCadence);
  const cadenceIntervalDays = cadenceMonths ? cadenceMonths * 30 : (coverageCadenceDays(coverageCadence) || 30);
  const slotToleranceDays = Math.max(7, Math.floor(cadenceIntervalDays / 2));
  const remainingToSeed = Math.max(0, coverageVisitCount - existingRows.length);
  const datesToSeed = [];
  for (const scheduledDate of targetDates) {
    if (datesToSeed.length >= remainingToSeed) break;
    const matchIndex = availableExistingDates.findIndex((existingDate) => {
      const diff = daysUntil(existingDate, scheduledDate);
      return diff != null && Math.abs(diff) <= slotToleranceDays;
    });
    if (matchIndex !== -1) {
      availableExistingDates.splice(matchIndex, 1);
      continue;
    }
    datesToSeed.push(scheduledDate);
  }

  const createdRows = [];
  // Owner directive (2026-07-03): every service call defaults to 60 minutes.
  const baseDuration = 60;
  const recurringParentId = existingRows[0]?.recurring_parent_id || existingRows[0]?.id || null;
  let createdParentId = recurringParentId;

  // Give seeded visits a billable pre-tax per-visit price (from the prepay
  // invoice subtotal) and flag create_invoice_on_complete, so that if the prepay
  // is later voided/refunded and the prepaid stamp is cleared, completion billing
  // has a price to invoice — prepay customers often have monthly_rate 0, which
  // would otherwise leave these generated visits completing unbilled. While
  // coverage is intact the prepaid stamp (>= this pre-tax price) still suppresses
  // the invoice, so this never double-bills a covered visit.
  let seededVisitPrice = null;
  if (cols.estimated_price && term?.prepay_invoice_id) {
    try {
      const inv = await conn('invoices').where({ id: term.prepay_invoice_id }).first('subtotal', 'total');
      const base = Number(inv?.subtotal) > 0 ? Number(inv.subtotal) : Number(inv?.total) || 0;
      if (base > 0) seededVisitPrice = Math.round((base / coverageVisitCount) * 100) / 100;
    } catch (err) {
      logger.warn(`[annual-prepay] seeded visit price lookup skipped: ${err.message}`);
    }
  }

  for (const scheduledDate of datesToSeed) {
    const insertData = {
      customer_id: term.customer_id,
      scheduled_date: scheduledDate,
      service_type: coverageServiceType,
      status: 'pending',
      notes: `Annual prepaid ${coverageServiceType} coverage`,
      estimated_duration_minutes: baseDuration,
    };
    if (cols.annual_prepay_term_id) insertData.annual_prepay_term_id = term.id;
    if (cols.is_recurring) insertData.is_recurring = true;
    if (cols.recurring_pattern) insertData.recurring_pattern = coverageCadence === 'every_6_weeks' ? 'custom' : coverageCadence;
    if (cols.recurring_interval_days) insertData.recurring_interval_days = coverageCadence === 'every_6_weeks' ? 42 : null;
    if (cols.recurring_ongoing) insertData.recurring_ongoing = false;
    if (cols.recurring_parent_id) {
      if (createdParentId) {
        insertData.recurring_parent_id = createdParentId;
      }
    }
    if (cols.time_window) insertData.time_window = null;
    if (cols.window_start) insertData.window_start = null;
    if (cols.window_end) insertData.window_end = null;
    if (cols.technician_id) insertData.technician_id = null;
    if (cols.customer_notes) insertData.customer_notes = null;
    if (cols.estimated_price && seededVisitPrice != null) insertData.estimated_price = seededVisitPrice;
    if (cols.create_invoice_on_complete) insertData.create_invoice_on_complete = true;

    const [created] = await conn('scheduled_services').insert(insertData).returning('*');
    if (!created) continue;
    createdRows.push(created);
    if (!createdParentId) {
      createdParentId = created.id;
    }
  }

  // Register a durable 72h/24h reminder row for each newly-seeded visit in the
  // SAME transaction (a SAVEPOINT, so a reminder hiccup can never roll back the
  // prepay/payment this rides with). Every upcoming visit should get reminders,
  // and these are created here rather than via the normal schedule flow — so
  // register them at birth instead of relying on a backfill. Date-only
  // placeholders default to 08:00 (matching how the scheduler reminds windowless
  // spawns); the time self-corrects if the visit is later given a real window.
  if (createdRows.length) {
    const AppointmentReminders = require('./appointment-reminders');
    for (const created of createdRows) {
      const startHHMM = created.window_start ? String(created.window_start).slice(0, 5) : '08:00';
      try {
        await conn.transaction((sp) =>
          AppointmentReminders.registerVisitReminderInTx(sp, {
            scheduledServiceId: created.id,
            customerId: term.customer_id,
            appointmentTime: `${dateOnly(created.scheduled_date)}T${startHHMM}`,
            serviceType: coverageServiceType,
            source: 'annual_prepay_seed',
          }),
        );
      } catch (err) {
        logger.warn(`[annual-prepay] seeded-visit reminder registration skipped for ${created.id}: ${err.message}`);
      }
    }
  }

  return {
    createdCount: createdRows.length,
    targetDates,
    existingCount: existingRows.length,
    createdRows,
  };
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
    const coverageServiceType = normalizeCoverageServiceType(term.coverage_service_type);
    const coverageVisitCount = normalizeCoverageVisitCount(term.coverage_visit_count);
    if (coverageServiceType && coverageVisitCount) {
      const rows = await coverageRowsForTerm(term, conn);
      const ids = rows.map((row) => row.id).filter(Boolean);
      if (!ids.length) return;
      await conn('scheduled_services')
        .whereIn('id', ids)
        .where(function () {
          this.whereNull('annual_prepay_term_id').orWhere('annual_prepay_term_id', term.id);
        })
        .update({ annual_prepay_term_id: term.id, updated_at: new Date() });
      return;
    }

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

async function applyPrepaidCoverageForTerm(term, conn = db) {
  const coverageServiceType = normalizeCoverageServiceType(term?.coverage_service_type);
  const coverageVisitCount = normalizeCoverageVisitCount(term?.coverage_visit_count);
  const totalAmount = Number(term?.prepay_amount);
  if (!term?.id || !coverageServiceType || !coverageVisitCount || !(totalAmount > 0)) {
    return { stampedCount: 0, matchedCount: 0, reason: 'coverage_not_configured' };
  }

  const cols = await scheduledServiceColumns();
  if (!cols.prepaid_amount || !cols.prepaid_method || !cols.prepaid_at) {
    return { stampedCount: 0, matchedCount: 0, reason: 'prepaid_columns_missing' };
  }

  const rows = await coverageRowsForTerm(term, conn);
  const slices = splitCoverageAmount(totalAmount, coverageVisitCount);
  const now = new Date();
  let stampedCount = 0;

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const status = String(row.status || '').toLowerCase();
    if (PREPAID_UPDATE_EXCLUDED_STATUSES.has(status)) continue;
    if (
      row.prepaid_amount != null
      && Number(row.prepaid_amount) > 0
      && (
        // Already covered by a DIFFERENT annual-prepay term.
        (row.annual_prepay_term_id && String(row.annual_prepay_term_id) !== String(term.id))
        // OR independently prepaid (cash/Zelle/etc.) through the regular schedule
        // route — attachScheduledServices may have linked it to this term, but its
        // stamp is a real out-of-band payment. Don't overwrite the method, or the
        // void/unflag cleanup (method-scoped) would later clear an already-collected
        // visit and completion billing would re-invoice it.
        || (row.prepaid_method && row.prepaid_method !== ANNUAL_PREPAY_PREPAID_METHOD)
      )
    ) {
      continue;
    }

    const visitAmount = slices[index] ?? slices[0] ?? 0;
    const updates = {
      prepaid_amount: visitAmount,
      prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD,
      prepaid_note: `Annual prepaid ${coverageServiceType} (${index + 1} of ${coverageVisitCount})`,
      prepaid_at: row.prepaid_at || now,
    };
    if (cols.annual_prepay_term_id) updates.annual_prepay_term_id = term.id;
    if (cols.updated_at) updates.updated_at = now;

    const updated = await conn('scheduled_services')
      .where({ id: row.id })
      .update(updates)
      .returning(['id']);
    if (Array.isArray(updated) ? updated.length > 0 : updated) stampedCount++;
  }

  return {
    stampedCount,
    matchedCount: rows.length,
    expectedVisitCount: coverageVisitCount,
    perVisitAmount: slices[0] || 0,
  };
}

// When a paid prepay invoice is voided/refunded the term flips to 'cancelled',
// but its not-yet-completed covered visits keep the per-visit prepaid_amount
// stamp that suppresses completion billing — so they'd be serviced free even
// though coverage was cancelled. Clear the stamps on those future visits so they
// bill normally again. Completed/terminal visits (PREPAID_UPDATE_EXCLUDED_STATUSES)
// are left untouched — already serviced and not billable here. The term link is
// kept for audit; billing-skip keys on prepaid_amount, which is now null.
// `throwOnError` (default false) preserves the best-effort behavior used by the
// webhook/void paths. Callers that need the clear to be atomic with a larger
// transaction (e.g. prepaid reversal) pass `{ throwOnError: true }` so a
// transient DB failure rolls the whole unit of work back instead of silently
// leaving future visits stamped prepaid.
async function clearPrepaidStampsForTerm(termId, conn = db, { throwOnError = false } = {}) {
  if (!termId) return 0;
  const cols = await scheduledServiceColumns();
  if (!cols.annual_prepay_term_id || !cols.prepaid_amount) return 0;
  const updates = { prepaid_amount: null };
  if (cols.prepaid_method) updates.prepaid_method = null;
  if (cols.prepaid_at) updates.prepaid_at = null;
  if (cols.prepaid_note) updates.prepaid_note = null;
  if (cols.updated_at) updates.updated_at = new Date();
  try {
    const q = conn('scheduled_services')
      .where({ annual_prepay_term_id: termId })
      .whereNotIn('status', Array.from(PREPAID_UPDATE_EXCLUDED_STATUSES));
    // Only clear stamps that annual prepay set — a visit manually marked prepaid
    // (cash/Zelle) through the regular schedule route keeps its independent stamp.
    if (cols.prepaid_method) q.where('prepaid_method', ANNUAL_PREPAY_PREPAID_METHOD);
    const cleared = await q.update(updates);
    return Array.isArray(cleared) ? cleared.length : cleared;
  } catch (err) {
    if (throwOnError) throw err;
    logger.warn(`[annual-prepay] clear prepaid stamps skipped for term ${termId}: ${err.message}`);
    return 0;
  }
}

// Canonical "is this term's paid coverage live on `coverageDate`" query — the
// single source of truth shared by getActivelyCoveredCustomerIds and the
// completion gate (annualPrepayCoversVisit), so the two can't drift. A term
// counts as covered when: coverageDate is within [term_start, term_end]; the term
// is in a paid-coverage status (or a payment_pending term whose invoice is in fact
// paid, or a renewal *lapse* still inside its already-paid term); the prepay
// invoice is not void/cancelled/refunded; and the prepay payment was not FULLY
// refunded (the Stripe refund webhook flips the PAYMENT row, not invoices.status,
// so we detect it on payments via the invoice's Stripe identifiers). Partial
// refunds (invoice stays 'paid') keep coverage.
// `coverageDate` restricts to terms whose window contains that date (the covered-
// as-of-a-day question). Pass null to skip the window and return EVERY term with
// still-valid paid coverage regardless of window (the audit's "which paid terms
// exist" question) — the invoice/payment refund exclusions still apply.
function coveredTermsAsOf(conn, coverageDate = null) {
  const cancelledStatuses = [...INVOICE_CANCELLED_STATUSES];
  const query = conn('annual_prepay_terms as t')
    .leftJoin('invoices as i', 'i.id', 't.prepay_invoice_id');
  if (coverageDate) {
    query.where('t.term_start', '<=', coverageDate).where('t.term_end', '>=', coverageDate);
  }
  return query
    .where(function statusGuard() {
      this.whereIn('t.status', COVERED_STATUSES)
        .orWhere(function paidPending() {
          this.where('t.status', PAYMENT_PENDING_STATUS)
            .andWhere(function invoicePaid() {
              this.where('i.status', 'paid').orWhereNotNull('i.paid_at');
            });
        })
        .orWhere(function lapsedRenewalStillInTerm() {
          this.where('t.status', 'cancelled').andWhere('t.renewal_decision', 'cancel');
        });
    })
    .whereRaw(
      `lower(coalesce(i.status, 'paid')) not in (${cancelledStatuses.map(() => '?').join(', ')})`,
      cancelledStatuses,
    )
    .whereRaw(
      `not exists (
        select 1 from payments p
        where (p.status = 'refunded' or p.refund_status = 'full')
          and (
            (p.stripe_payment_intent_id is not null and p.stripe_payment_intent_id = i.stripe_payment_intent_id)
            or (p.stripe_charge_id is not null and p.stripe_charge_id = i.stripe_charge_id)
          )
      )`,
    );
}

// Fail-closed coverage test for completion billing. An annual-prepay-stamped
// visit is COVERED when its explicit stamp (prepaid_method === annual_prepay_invoice)
// is backed by a term whose paid coverage is STILL LIVE on the visit date
// (coveredTermsAsOf) — INDEPENDENT of the per-visit prepaid_amount. The stamp is a
// DISCOUNTED allocation slice (splitCoverageAmount divides the discounted invoice
// total across visits), so on a discounted plan the slice is < the visit's
// undiscounted estimated_price; the legacy `prepaid_amount >= amount` gate would
// then wrongly re-bill a prepaid visit (the double-bill this fixes). It is
// fail-closed twice over: (1) requires an explicit stamp AND a live term, so a
// stale stamp left by a best-effort void/refund clear (clearPrepaidStampsForTerm
// swallows errors on the webhook path) can't suppress; (2) revalidates the prepay
// invoice/payment isn't void/refunded and the visit date is inside the term, so a
// term whose status drifts from its paid state can't suppress either.
// Absence/ambiguity => false; the caller then falls back to the numeric
// prepaid_amount >= amount comparison for other (cash/Zelle) methods.
async function annualPrepayCoversVisit(scheduledService, conn = db) {
  if (!scheduledService) return false;
  if (scheduledService.prepaid_method !== ANNUAL_PREPAY_PREPAID_METHOD) return false;
  if (!(Number(scheduledService.prepaid_amount) > 0)) return false;
  const termId = scheduledService.annual_prepay_term_id;
  if (!termId) return false;
  if (!(await annualPrepayTableExists())) return false;
  try {
    const coverageDate = dateOnly(scheduledService.scheduled_date) || etDateString();
    const term = await coveredTermsAsOf(conn, coverageDate)
      .where('t.id', termId)
      // The stamp must belong to THIS visit's customer — a stale stamp pointing at
      // another customer's live term can't suppress.
      .modify((q) => {
        if (scheduledService.customer_id != null) q.where('t.customer_id', scheduledService.customer_id);
      })
      .first('t.id', 't.coverage_service_type');
    if (!term) return false;
    // Defense-in-depth: when the term declares a coverage service, the stamped
    // visit must still be that service (coverage-selection cleanup is best-effort,
    // so a stale stamp left on a dropped/re-typed service must not suppress). The
    // same matcher that APPLIED the stamp gates it here. Legacy no-config terms
    // (no coverage_service_type) never had a service to match, so skip the check.
    if (term.coverage_service_type
      && scheduledService.service_type
      && !serviceMatchesCoverage(scheduledService, normalizeCoverageServiceType(term.coverage_service_type))) {
      return false;
    }
    return true;
  } catch (err) {
    // Fail-closed: if the term/invoice can't be validated, DON'T suppress billing.
    logger.warn(`[annual-prepay] coverage validation failed for scheduled service ${scheduledService.id}: ${err.message}`);
    return false;
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
  const coverageServiceType = normalizeCoverageServiceType(term.coverage_service_type);
  const coverageVisitCount = normalizeCoverageVisitCount(term.coverage_visit_count);
  const coverageCadence = inferCoverageCadence(term);
  if (ACTIVE_STATUSES.includes(term.status)) {
    await ensureCoverageRowsForTerm({ ...term, term_start: termStart, term_end: termEnd, coverage_cadence: coverageCadence }, conn);
    await attachScheduledServices({ ...term, term_start: termStart, term_end: termEnd }, conn);
    await applyPrepaidCoverageForTerm({ ...term, term_start: termStart, term_end: termEnd }, conn);
  }
  const coveredRows = coverageServiceType && coverageVisitCount
    ? await coverageRowsForTerm({ ...term, term_start: termStart, term_end: termEnd }, conn)
    : [];
  const lastService = coveredRows.length
    ? coveredRows[coveredRows.length - 1]
    : await findLastScheduledServiceForTerm(term.customer_id, termStart, termEnd, conn);

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
      // A true void/refund (no renewal decision) cancels coverage — drop the
      // per-visit prepaid stamps so future covered visits bill normally. A
      // renewal-lapse (renewal_decision set) keeps its paid window, so the
      // whereNull guard leaves `updated` undefined and we don't clear.
      if (updated && updated.status === 'cancelled') {
        await clearPrepaidStampsForTerm(term.id, conn);
        // Also reopen any per-visit invoices this term settled as NON-CASH coverage
        // (status='prepaid' by this term, or a partial with a coverage line) — the
        // prepay was refunded, so the covered work is owed again. Mirrors the stamp
        // clear; best-effort (never blocks the refund sync), and never reopens a
        // cash-paid invoice.
        try {
          await require('./invoice').reopenAnnualPrepayCoveredInvoicesForTerm(term.id, conn);
        } catch (err) {
          logger.warn(`[annual-prepay] invoice coverage reopen skipped for term ${term.id}: ${err.message}`);
        }
      }
    }

    if (ACTIVE_STATUSES.includes(current.status)) {
      await syncCustomerRenewalDate(current.customer_id, dateOnly(current.term_end), conn);
      const refreshed = await refreshTermSnapshot(current, conn);
      results.push(refreshed || current);
    } else {
      results.push(current);
    }
  }

  if (nextStatus === 'cancelled') {
    // A refund/void voids the prepaid coverage even for terms whose renewal was
    // already decided (renewed / switch_plan / lapse) — these stay covered through
    // term_end for the renewal flow and the loop above doesn't select them, so
    // their future visits would keep annual-prepay stamps and skip billing after
    // the refund. Clear those stamps too (method-scoped, so manual cash/Zelle
    // stamps survive); the term's renewal-flow status is intentionally left as-is.
    const decidedCoveredTerms = await conn('annual_prepay_terms')
      .where({ prepay_invoice_id: invoice.id })
      .where(function decidedCovered() {
        this.whereIn('status', ['renewed', 'switch_plan'])
          .orWhere(function lapsed() {
            this.where('status', 'cancelled').whereNotNull('renewal_decision');
          });
      })
      .select('id');
    for (const decided of decidedCoveredTerms) {
      await clearPrepaidStampsForTerm(decided.id, conn);
      // Same as the active loop: reopen any visit invoices this term settled as
      // non-cash coverage — the refund voids their coverage too.
      try {
        await require('./invoice').reopenAnnualPrepayCoveredInvoicesForTerm(decided.id, conn);
      } catch (err) {
        logger.warn(`[annual-prepay] invoice coverage reopen skipped for decided term ${decided.id}: ${err.message}`);
      }
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

/**
 * Customer IDs whose prepay coverage is active on `asOf` (ET date string;
 * defaults to today). A customer in this set has paid for the current period up
 * front and MUST be excluded from monthly billing even when active +
 * monthly_rate > 0 + autopay on. The paid coverage term — not a zeroed
 * monthly_rate — is the billing-suppression source of truth.
 *
 * Coverage = today within [term_start, term_end] AND a COVERED_STATUSES term
 * (or a payment_pending term whose invoice is in fact paid, or a renewal-lapsed
 * term still inside its paid window) AND the prepay invoice is not void/refunded
 * AND the prepay payment was not fully refunded. A refund (invoice flips to
 * refunded / payment refund_status='full') correctly re-enables monthly billing.
 */
async function getActivelyCoveredCustomerIds(asOf = etDateString(), conn = db) {
  if (!(await annualPrepayTableExists())) return new Set();
  const coverageDate = dateOnly(asOf) || etDateString();
  // Covered = a paid-coverage status, OR a payment_pending term whose invoice is
  // in fact paid (webhook/reconcile lag — activatePaidPendingTerms() is the
  // canonical recovery, run before this in the billing cron), OR a renewal *lapse*
  // still current through term_end; void/refunded prepay invoices and fully
  // refunded payments are excluded. See coveredTermsAsOf (shared with the
  // completion coverage gate so the two definitions can't drift).
  const rows = await coveredTermsAsOf(conn, coverageDate).distinct('t.customer_id');
  return new Set(rows.filter((row) => row.customer_id != null).map((row) => String(row.customer_id)));
}

/**
 * Customer IDs with an annual-prepay commitment whose invoice is still open.
 * These customers have not paid for coverage yet, so they are not "actively
 * covered"; the monthly billing cron still must not charge them while the
 * annual-prepay invoice is pending review/payment. Bounded to terms whose
 * window has not ended and whose linked invoice is still open (not paid, void,
 * cancelled, or refunded) so a stale/void pending row cannot suppress billing
 * indefinitely.
 */
async function getPaymentPendingCustomerIds(asOf = etDateString(), conn = db) {
  if (!(await annualPrepayTableExists())) return new Set();
  const coverageDate = dateOnly(asOf) || etDateString();
  const cancelledStatuses = [...INVOICE_CANCELLED_STATUSES];
  const rows = await conn('annual_prepay_terms as t')
    .join('invoices as i', 'i.id', 't.prepay_invoice_id')
    .where('t.status', PAYMENT_PENDING_STATUS)
    .whereNotNull('t.prepay_invoice_id')
    .where('t.term_end', '>=', coverageDate)
    .whereRaw(
      `lower(coalesce(i.status, 'draft')) not in (${cancelledStatuses.map(() => '?').join(', ')})`,
      cancelledStatuses,
    )
    .whereRaw("lower(coalesce(i.status, 'draft')) <> 'paid'")
    .whereNull('i.paid_at')
    .distinct('t.customer_id');
  return new Set(rows.filter((row) => row.customer_id != null).map((row) => String(row.customer_id)));
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
  coverageServiceType = undefined,
  coverageVisitCount = undefined,
  coverageCadence = undefined,
  conn = db,
} = {}) {
  if (!(await annualPrepayTableExists())) return null;
  if (!customerId) throw new Error('customerId is required');

  const hasExplicitTermStart = termStart !== null && termStart !== undefined && termStart !== '';
  const hasExplicitTermEnd = termEnd !== null && termEnd !== undefined && termEnd !== '';
  const normalizedStart = dateOnly(termStart) || etDateString();
  const normalizedEnd = dateOnly(termEnd) || addMonthsSameDay(normalizedStart, 12);
  if (!normalizedEnd) throw new Error('Could not determine annual prepay term end');
  const nextStatus = await statusForPrepayInvoice(prepayInvoiceId, conn);
  const termCols = await annualPrepayColumns(conn);
  const normalizedCoverageServiceType = coverageServiceType === undefined
    ? undefined
    : normalizeCoverageServiceType(coverageServiceType);
  const normalizedCoverageVisitCount = coverageVisitCount === undefined
    ? undefined
    : normalizeCoverageVisitCount(coverageVisitCount);
  const normalizedCoverageCadence = coverageCadence === undefined
    ? undefined
    : normalizeCoverageCadence(coverageCadence);

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
    // Only the start supplied → recompute the 12-month end from it (normalizedEnd
    // already carries start+12mo when termEnd was blank); neither supplied →
    // leave the existing window untouched (the estimate flow re-runs with null
    // dates and must not have its term reset).
    if (hasExplicitTermStart) updates.term_start = normalizedStart;
    if (hasExplicitTermEnd) updates.term_end = normalizedEnd;
    else if (hasExplicitTermStart) updates.term_end = normalizedEnd;
    if (termCols.coverage_service_type && normalizedCoverageServiceType !== undefined) {
      updates.coverage_service_type = normalizedCoverageServiceType;
    }
    if (termCols.coverage_visit_count && normalizedCoverageVisitCount !== undefined) {
      updates.coverage_visit_count = normalizedCoverageVisitCount;
    }
    if (termCols.coverage_cadence && normalizedCoverageCadence !== undefined) {
      updates.coverage_cadence = normalizedCoverageCadence;
    }
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
        function detachOutOfWindow() {
          this.where('scheduled_date', '<', winStart).orWhere('scheduled_date', '>', winEnd);
        }
        try {
          // Completion billing keys on prepaid_amount independently of the term
          // link, so a now-out-of-window FUTURE visit would still be treated as
          // prepaid and skip invoicing unless its stamp is cleared too. Clear the
          // stamps on the non-completed out-of-window visits first (while they're
          // still findable by term id); completed/terminal visits keep their
          // historical stamp.
          if (scCols.prepaid_amount) {
            const stampClear = { prepaid_amount: null, updated_at: new Date() };
            if (scCols.prepaid_method) stampClear.prepaid_method = null;
            if (scCols.prepaid_at) stampClear.prepaid_at = null;
            if (scCols.prepaid_note) stampClear.prepaid_note = null;
            const stampQuery = conn('scheduled_services')
              .where({ annual_prepay_term_id: existing.id })
              .andWhere(detachOutOfWindow)
              .whereNotIn('status', Array.from(PREPAID_UPDATE_EXCLUDED_STATUSES));
            // Only clear annual-prepay stamps; preserve an independent cash/Zelle
            // prepayment made on the visit through the regular schedule route.
            if (scCols.prepaid_method) stampQuery.where('prepaid_method', ANNUAL_PREPAY_PREPAID_METHOD);
            await stampQuery.update(stampClear);
          }
          await conn('scheduled_services')
            .where({ annual_prepay_term_id: existing.id })
            .andWhere(detachOutOfWindow)
            .update({ annual_prepay_term_id: null, updated_at: new Date() });
        } catch (err) {
          logger.warn(`[annual-prepay] scheduled service detach skipped: ${err.message}`);
        }
      }
    }
    // When the coverage SELECTION changes on an edit (service type / visit count
    // / cadence) — not just the date window handled above — the visits that
    // matched the OLD selection keep their annual-prepay prepaid stamps, since
    // attachScheduledServices/applyPrepaidCoverageForTerm only add+stamp the new
    // matches and never clear the old ones. Completion billing keys on
    // prepaid_amount, so those stale visits would keep skipping billing on top
    // of the newly covered ones. Clear the term's stamps here so the
    // refreshTermSnapshot below re-stamps ONLY the new selection; visits dropped
    // from coverage fall back to normal billing. Method-scoped + non-completed
    // (clearPrepaidStampsForTerm), so manual cash/Zelle stamps and already
    // serviced visits are untouched. Best-effort, mirroring the window block.
    const coverageSelectionChanged = (
      (normalizedCoverageServiceType !== undefined
        && (normalizeCoverageServiceType(existing.coverage_service_type) || null)
          !== (normalizedCoverageServiceType || null))
      || (normalizedCoverageVisitCount !== undefined
        && (normalizeCoverageVisitCount(existing.coverage_visit_count) || null)
          !== (normalizedCoverageVisitCount || null))
      || (normalizedCoverageCadence !== undefined
        && (normalizeCoverageCadence(existing.coverage_cadence) || null)
          !== (normalizedCoverageCadence || null))
    );
    if (coverageSelectionChanged) {
      // Clearing stamps isn't enough: the dropped visits keep their
      // annual_prepay_term_id link, which the repo treats as Annual Prepay for
      // reporting/forecasting (pricing-reality-check) and copies onto recurring
      // children (recurring-appointment-seeder). Detach the term link from the
      // non-completed linked visits too, then let refreshTermSnapshot below
      // re-attach + re-stamp ONLY the new selection — visits dropped from
      // coverage fall fully back to normal billing. Completed/terminal visits
      // keep their historical link + stamp (PREPAID_UPDATE_EXCLUDED_STATUSES).
      //
      // The stamp clear and the link detach must be atomic: if the detach
      // landed but the stamp clear silently failed, those visits would keep a
      // prepaid_amount with no term link — completion billing would still skip
      // them and no term-keyed cleanup could ever find them again. Run both in
      // one (sub)transaction with the stamp clear set to throw, so a failed
      // clear rolls back the detach instead of orphaning the stamps.
      const scCols = await scheduledServiceColumns();
      try {
        await conn.transaction(async (trx) => {
          await clearPrepaidStampsForTerm(existing.id, trx, { throwOnError: true });
          if (scCols.annual_prepay_term_id) {
            await trx('scheduled_services')
              .where({ annual_prepay_term_id: existing.id })
              .whereNotIn('status', Array.from(PREPAID_UPDATE_EXCLUDED_STATUSES))
              .update({ annual_prepay_term_id: null, updated_at: new Date() });
          }
        });
      } catch (err) {
        logger.warn(`[annual-prepay] coverage-change stamp/link cleanup skipped: ${err.message}`);
      }
    }
    await syncInvoiceTerm(prepayInvoiceId, existing.id, conn);
    const refreshed = await refreshTermSnapshot(existing.id, conn);
    if (refreshed && ACTIVE_STATUSES.includes(refreshed.status)) {
      await syncCustomerRenewalDate(customerId, dateOnly(refreshed.term_end), conn);
    }
    return refreshed;
  }

  const insert = {
    customer_id: customerId,
    source_estimate_id: sourceEstimateId || null,
    prepay_invoice_id: prepayInvoiceId || null,
    plan_label: planLabel,
    monthly_rate: monthlyRate != null ? monthlyRate : null,
    prepay_amount: prepayAmount != null ? prepayAmount : null,
    term_start: normalizedStart,
    term_end: normalizedEnd,
    status: nextStatus,
  };
  if (termCols.coverage_service_type && normalizedCoverageServiceType !== undefined) {
    insert.coverage_service_type = normalizedCoverageServiceType;
  }
  if (termCols.coverage_visit_count && normalizedCoverageVisitCount !== undefined) {
    insert.coverage_visit_count = normalizedCoverageVisitCount;
  }
  if (termCols.coverage_cadence && normalizedCoverageCadence !== undefined) {
    insert.coverage_cadence = normalizedCoverageCadence;
  }

  const [term] = await conn('annual_prepay_terms').insert(insert).returning('*');

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
      // Anchor the reminder on the effective coverage end: term_end, OR the last
      // covered visit when that is the effective end. Finite cadences (e.g. a
      // quarterly term seeds visits at +0/+3/+6/+9mo while term_end is +12mo) end
      // service before term_end, so a term_end-only match would fire the reminder
      // months after coverage actually lapsed (or skip it). Mirrors the
      // getOpenRenewalAlerts last_scheduled_service_date trigger so the automated
      // sender and the admin alert list agree.
      .where(function renewalAnchorMatches() {
        this.where('term_end', target).orWhere('last_scheduled_service_date', target);
      })
      .select('*');

    for (const term of terms) {
      // Only treat the last-visit date as the anchor when it is genuinely near
      // term end (the effective end); a term matched solely by an early
      // last-service date still reminds on term_end instead.
      const onTermEnd = dateOnly(term.term_end) === target;
      if (!onTermEnd && !isLastServiceNearTermEnd(term)) continue;
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

// ── Pre-visit payment reminders for UNPAID accept-time prepay terms ─────────
//
// A prepay-annual accept mints the full-year invoice and a payment_pending
// term, but nothing visit-anchored nudged the customer before the first visit:
// the estimate follow-up cadence stops at accept, and the invoice follow-up
// sequence (d3/d7/d14/d30) is SEND-anchored, so a short accept-to-visit gap
// can ride into service week untouched. These reminders anchor on term_start
// (3 days / 1 day before, matching the daily 10 AM renewal cron's day
// granularity) and set the expectation that an unpaid prepay simply bills the
// visit per-application. Same durable sent/claim column pattern as the
// renewal notices above.

function paymentReminderColumnForDaysOut(daysOut) {
  const n = Number(daysOut);
  if (n === 3) return 'payment_reminder_3d_sent_at';
  if (n === 1) return 'payment_reminder_1d_sent_at';
  return null;
}

function paymentReminderClaimColumnForDaysOut(daysOut) {
  const n = Number(daysOut);
  if (n === 3) return 'payment_reminder_3d_claimed_at';
  if (n === 1) return 'payment_reminder_1d_claimed_at';
  return null;
}

// The invoice follow-up engine (send-anchored dunning) and this visit-anchored
// reminder both text the same pay link, and both crons fire at 10 AM ET — so
// suppress a pre-visit reminder when that invoice's sequence either touched
// the customer in the last ~20h or is DUE to touch them today (deterministic
// regardless of which cron runs first in the shared hour). The 20h window
// (not 24h) keeps yesterday's 10 AM dunning from suppressing today's 10 AM
// reminder on the boundary.
const PAYMENT_REMINDER_DUNNING_SUPPRESS_MS = 20 * 60 * 60 * 1000;
async function invoiceDunningActiveToday(invoiceId, { now = new Date(), todayYmd = null } = {}) {
  try {
    const row = await db('invoice_followup_sequences')
      .where({ invoice_id: invoiceId })
      .first('status', 'last_touch_at', 'next_touch_at');
    if (!row || row.status !== 'active') return false;
    if (row.last_touch_at && (now - new Date(row.last_touch_at)) < PAYMENT_REMINDER_DUNNING_SUPPRESS_MS) return true;
    if (row.next_touch_at) {
      // A due touch only suppresses on a day the follow-up cron can actually
      // fire (Tue–Fri per config.sendWindow). A touch that came due over the
      // weekend would otherwise suppress the Sat 3d AND Mon 1d reminders while
      // no dunning ran either day — the customer would reach the visit with no
      // pre-visit contact at all.
      const followupConfig = require('../config/invoice-followups');
      const sendDays = new Set(followupConfig?.sendWindow?.daysOfWeek || []);
      const today = todayYmd || etDateString();
      const todayEtDow = new Date(`${today}T12:00:00Z`).getUTCDay();
      if (sendDays.has(todayEtDow)) {
        const endOfTodayEt = parseETDateTime(`${today} 23:59:59`);
        if (new Date(row.next_touch_at) <= endOfTodayEt) return true;
      }
    }
    return false;
  } catch (err) {
    // Fail open (send the reminder): a read miss must not silence the only
    // visit-anchored nudge; worst case the customer gets dunning + reminder.
    logger.warn(`[annual-prepay] dunning suppression check failed for invoice ${invoiceId}: ${err.message}`);
    return false;
  }
}

async function sendPaymentPendingReminder(termOrId, daysOut, opts = {}) {
  if (!(await annualPrepayTableExists())) return { sent: false, reason: 'table_missing' };
  const sentCol = paymentReminderColumnForDaysOut(daysOut);
  const claimCol = paymentReminderClaimColumnForDaysOut(daysOut);
  if (!sentCol || !claimCol) return { sent: false, reason: 'unsupported_days_out' };
  const cols = await annualPrepayColumns();
  if (!cols[sentCol] || !cols[claimCol]) return { sent: false, reason: 'columns_missing' };

  // The status/sent checks on this row are advisory (the caller's candidate
  // read may be moments old) — the conditional claim UPDATE below re-checks
  // both atomically, and the fresh invoice read below catches a payment the
  // webhook hasn't flipped onto the term yet.
  const term = typeof termOrId === 'object' && termOrId?.id
    ? termOrId
    : await db('annual_prepay_terms').where({ id: termOrId }).first();
  if (!term) return { sent: false, reason: 'term_not_found' };
  if (term.status !== PAYMENT_PENDING_STATUS) return { sent: false, reason: 'not_payment_pending' };
  if (term[sentCol]) return { sent: false, reason: 'already_sent' };
  if (!term.prepay_invoice_id) return { sent: false, reason: 'no_invoice' };

  let invoice = await db('invoices').where({ id: term.prepay_invoice_id }).first();
  if (!invoice) return { sent: false, reason: 'invoice_missing' };
  // Canonical collectibility (invoice-helpers): paid/prepaid/PROCESSING/void/
  // refunded/cancelled all skip — an in-flight ACH must not be asked to pay
  // again, and the pay page would refuse these states anyway.
  const { isInvoiceCollectibleStatus, invoiceAmountDue } = require('./invoice-helpers');
  if (!isInvoiceCollectibleStatus(invoice.status)) {
    return { sent: false, reason: 'invoice_not_collectible' };
  }
  // Never text the homeowner a pay link for a payer-billed invoice — the
  // pay link + AR route to the payer (mirrors InvoiceService.sendViaSMS).
  if (invoice.payer_id) return { sent: false, reason: 'payer_billed' };

  if (await invoiceDunningActiveToday(invoice.id)) {
    return { sent: false, reason: 'dunning_active_today' };
  }

  // Run the same account-credit seam the regular invoice send paths run
  // before asking for money (feature-gated + fail-soft inside), then re-read:
  // available credit may shrink or fully cover the balance, and the reminder
  // must quote the amount Stripe will actually collect, not the gross total.
  try {
    const { autoApplyAccountCreditIfEnabled } = require('./customer-credit');
    await autoApplyAccountCreditIfEnabled(invoice.id, { createdBy: 'system:annual_prepay_payment_reminder' });
    const freshInvoice = await db('invoices').where({ id: invoice.id }).first();
    if (freshInvoice) invoice = freshInvoice;
  } catch (err) {
    logger.warn(`[annual-prepay] credit seam skipped for invoice ${invoice.id}: ${err.message}`);
  }
  if (!isInvoiceCollectibleStatus(invoice.status)) {
    return { sent: false, reason: 'invoice_not_collectible' };
  }
  const amountDue = invoiceAmountDue(invoice);
  if (!(amountDue > 0)) return { sent: false, reason: 'fully_credited' };

  const now = new Date();
  const staleClaimCutoff = new Date(now.getTime() - NOTICE_CLAIM_TTL_MS);
  const [claimedTerm] = await db('annual_prepay_terms')
    .where({ id: term.id, status: PAYMENT_PENDING_STATUS })
    .whereNull(sentCol)
    .where(function paymentClaimAvailable() {
      this.whereNull(claimCol).orWhere(claimCol, '<', staleClaimCutoff);
    })
    .update({ [claimCol]: now, updated_at: now })
    .returning('*');
  if (!claimedTerm) return { sent: false, reason: 'already_claimed' };

  const releaseClaim = async () => {
    await db('annual_prepay_terms')
      .where({ id: claimedTerm.id })
      .whereNull(sentCol)
      .update({ [claimCol]: null, updated_at: new Date() })
      .catch((err) => logger.warn(`[annual-prepay] payment reminder claim release failed for term ${claimedTerm.id}: ${err.message}`));
  };

  try {
    // whereNull(deleted_at): a soft-deleted account must not get a pay-link
    // text (mirrors the renewal scan's deleted-customer exclusion).
    const customer = await db('customers')
      .where({ id: claimedTerm.customer_id })
      .whereNull('deleted_at')
      .first();
    if (!customer) {
      await releaseClaim();
      return { sent: false, reason: 'customer_missing_or_deleted' };
    }
    if (!customer.phone) {
      // The invoice email already carries the pay link (sent at accept, plus
      // the follow-up sequence's email legs) — with no phone there is no SMS
      // nudge to add. Mark sent so the daily cron doesn't re-claim forever.
      await db('annual_prepay_terms')
        .where({ id: claimedTerm.id })
        .whereNull(sentCol)
        .update({ [sentCol]: new Date(), [claimCol]: null, updated_at: new Date() });
      return { sent: false, reason: 'no_phone' };
    }

    const { publicPortalUrl } = require('../utils/portal-url');
    const { shortenOrPassthrough, invoiceShortCodePrefix } = require('./short-url');
    const payUrl = await shortenOrPassthrough(`${publicPortalUrl()}/pay/${invoice.token}`, {
      kind: 'invoice',
      entityType: 'invoices',
      entityId: invoice.id,
      customerId: customer.id,
      codePrefix: invoiceShortCodePrefix(invoice),
    });
    const amountText = Number.isFinite(amountDue) && amountDue > 0
      ? ` for $${amountDue.toFixed(2)}`
      : '';

    const body = await renderSmsTemplate(
      'annual_prepay_payment_reminder',
      {
        first_name: customer.first_name || 'there',
        amount_text: amountText,
        first_visit_date: formatDateLabel(claimedTerm.term_start),
        pay_link: payUrl,
      },
      { workflow: 'annual_prepay_payment_reminder', entity_type: 'annual_prepay_term', entity_id: claimedTerm.id },
    );
    if (!body) {
      logger.warn(`[annual-prepay] annual_prepay_payment_reminder template missing/disabled for customer ${customer.id}`);
      await releaseClaim();
      return { sent: false, reason: 'missing_sms_template' };
    }

    const smsResult = await sendCustomerMessage({
      to: customer.phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: 'payment_link',
      customerId: customer.id,
      invoiceId: invoice.id,
      identityTrustLevel: 'phone_matches_customer',
      entryPoint: 'annual_prepay_payment_reminder',
      metadata: {
        original_message_type: 'annual_prepay_payment_reminder',
        annual_prepay_term_id: claimedTerm.id,
        days_out: daysOut,
        ...(opts.metadata || {}),
      },
    });
    if (!smsResult.sent) {
      logger.warn(`[annual-prepay] payment reminder SMS blocked/failed for term ${claimedTerm.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
      await releaseClaim();
      return { sent: false, reason: smsResult.code || smsResult.reason || 'send_failed' };
    }

    const sentAt = new Date();
    await db('annual_prepay_terms')
      .where({ id: claimedTerm.id })
      .whereNull(sentCol)
      .update({ [sentCol]: sentAt, [claimCol]: null, updated_at: sentAt });

    await db('customer_interactions').insert({
      customer_id: customer.id,
      interaction_type: 'sms_outbound',
      channel: 'sms',
      subject: `Annual prepay payment - ${daysOut}-day pre-visit reminder`,
      body: `Automated unpaid-prepay payment reminder sent (${daysOut} day(s) before term start)`,
    }).catch((err) => logger.warn(`[annual-prepay] interaction insert failed: ${err.message}`));

    return { sent: true, termId: claimedTerm.id };
  } catch (err) {
    await releaseClaim();
    throw err;
  }
}

async function checkAndSendPaymentReminders({ today = etDateString() } = {}) {
  if (!(await annualPrepayTableExists())) return { sent: 0 };
  // Flip any paid-but-pending terms first so they never remind.
  await activatePaidPendingTerms();
  let sent = 0;

  for (const daysOut of PAYMENT_REMINDER_DAYS) {
    const sentCol = paymentReminderColumnForDaysOut(daysOut);
    const claimCol = paymentReminderClaimColumnForDaysOut(daysOut);
    const cols = await annualPrepayColumns();
    if (!cols[sentCol] || !cols[claimCol]) continue; // migration not run yet
    const target = addDaysYmd(today, daysOut);
    const terms = await db('annual_prepay_terms')
      .where({ status: PAYMENT_PENDING_STATUS })
      .whereNotNull('prepay_invoice_id')
      .whereNull(sentCol)
      .where(function paymentClaimAvailable() {
        this.whereNull(claimCol).orWhere(claimCol, '<', new Date(Date.now() - NOTICE_CLAIM_TTL_MS));
      })
      .where('term_start', target)
      .select('*');

    for (const term of terms) {
      try {
        const result = await sendPaymentPendingReminder(term, daysOut);
        if (result.sent) sent++;
      } catch (err) {
        logger.error(`[annual-prepay] payment reminder failed for term ${term.id}: ${err.message}`);
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

module.exports = {
  createTermForAnnualPrepay,
  refreshTermSnapshot,
  refreshActiveTermsForCustomer,
  syncTermForInvoicePayment,
  syncTermForRefundedPayment,
  activatePaidPendingTerms,
  getActivelyCoveredCustomerIds,
  getPaymentPendingCustomerIds,
  getOpenRenewalAlerts,
  sendCustomerTermNotice,
  checkAndSend,
  sendPaymentPendingReminder,
  checkAndSendPaymentReminders,
  hasAnnualPrepayRenewal,
  applyPrepaidCoverageForTerm,
  clearPrepaidStampsForTerm,
  annualPrepayCoversVisit,
  coveredTermsAsOf,
  ANNUAL_PREPAY_PREPAID_METHOD,
  recordDecision,
  _private: {
    dateOnly,
    addMonthsSameDay,
    addDaysYmd,
    daysUntil,
    noticeColumnForDaysOut,
    noticeClaimColumnForDaysOut,
    paymentReminderColumnForDaysOut,
    paymentReminderClaimColumnForDaysOut,
    invoiceDunningActiveToday,
    shouldAlertTerm,
    isLastServiceNearTermEnd,
    invoiceTermStatus,
    formatDateLabel,
    parsePaymentMetadata,
    findInvoiceIdForRefundedPayment,
    coverageServiceKey,
    serviceMatchesCoverage,
    splitCoverageAmount,
    coverageScheduleDates,
    normalizeCoverageCadence,
    coverageCadenceMonths,
    coverageCadenceDays,
    inferCoverageCadence,
    normalizeCoverageServiceType,
    normalizeCoverageVisitCount,
    ensureCoverageRowsForTerm,
    coverageRowsForTerm,
    resetCachesForTests,
  },
};
