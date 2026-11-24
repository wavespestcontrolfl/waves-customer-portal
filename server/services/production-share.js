/**
 * Production share, PR 1: the weekly CREDIT, its dated settings and the numbers an admin preview shows (Technician
 * Terms v3, "Production share"; owner 2026-11-23). It pays NOTHING: no pay line, no check, no gate. PR 2 puts the share
 * on the paycheck; PR 3 takes refunds back.
 *
 * The rule, in integer cents:
 *   share = rate x max(0, credited production - bar), never below $0.
 *   bar   = bar_cents x shifts worked in the week (barType 'per_shift'), or bar_cents once (barType 'weekly').
 *   A shift is a staff work date (ET) on which the technician completed at least one route stop. Paid time off,
 *   holidays, weather and training days are not shifts because no stop is completed on them.
 * Rate, bar and the callback value are SETTINGS (production_share_settings), by the pay week they apply from; the owner
 * has not set them, so with no row on or before a week the share is $0 and the preview says so.
 *
 * Credit of a completed stop (the technician the visit is assigned to; the work date is the ET date it was completed):
 *   Review map (CLAUDE.md rule 22), where each rule this module needs lives:
 *   - What a visit was billed          the pre-tax amount of the invoice linked to the visit (billedByVisit), whether or not it
 *     is paid, by the links the rate review reads (rate-review.js VISIT_INVOICE_LINK_SQL: direct, service record,
 *     first-application, completion packet); a shared invoice is split across its visits by visit price, to the cent. A fee
 *     change later never moves a credit already earned.
 *   - What a visit is priced at         with no invoice: completionInvoiceAmount + hasAuthoritativeZeroPrice (billing-lane.js).
 *     The Terms credit the PRICE CHARGED, before sales tax, not what settled: an unpaid invoice still credits. The settled-cash
 *     helpers of rate-review.js (visitRevenueCents, duesPerVisitCents: paid invoices, settled prepay, settled dues) are
 *     NOT used on purpose. completionInvoiceAmount is called with monthlyRate 0: its fallback to the customer's whole
 *     MONTHLY dues is a billing fallback (a month's dues is not the value of one visit); a dues-covered plan visit with no
 *     price of its own is listed "needs review" at $0 instead of guessed.
 *   - A prepaid plan visit              scheduled_services.prepaid_amount of a visit stamped with an annual prepay term:
 *     the term's paid amount split across its covered visits (annual-prepay-renewals.js splitCoverageAmount stamps it).
 *     That is the plan's value for one visit, after the plan's discount.
 *   - A multi-visit one-time job        the SOURCE visit's price split across the planned visits of the job: the source and
 *     the included follow-ups (followup_included, followup_source_service_id; call-booking-catalog.js
 *     callFollowUpBillingShape: the follow-up is a $0 "included" visit). Each completed visit gets its part; the parts add
 *     up to the price to the cent. A follow-up that was cancelled, skipped or a no-show is not a planned visit; a rescheduled one is.
 *     The job price is what the first visit was billed (its invoice), else its own price.
 *   - A callback                        is_callback or a re-service type (re-service.js isReService). The code does not
 *     store which work a callback follows, so the original is the customer's latest completed visit of the same line
 *     (rate-review.js LINE_SQL) at the same property (equal property ids, else equal addresses on file) that came BEFORE it
 *     by completion time. The callback test (flag, catalog key, name, type) is the same for both, so a re-service is never an
 *     original. A same-day pair with no readable order, or work whose property cannot be verified, goes to review. Original by the SAME technician within 30
 *     days = $0. Original by ANOTHER technician = the route's average value for one stop (setting). Original not found,
 *     with no technician, or by the same technician over 30 days ago (the Terms say nothing) = $0 and "needs review":
 *     pay is never guessed up.
 *   - $0                                a free assessment (no-cost-visit-types.js isConsultationServiceType with no
 *     price of its own) and the always-free visit types (isAlwaysFreeServiceType).
 *   - A refund                          takes back the credit of that stop; PR 3 does it. PR 1 only exposes the stop's
 *     refund total (refundCents): refunds on the payments of the visit's linked invoices (the same links and the same split
 *     as the amount), plus, for a prepaid plan visit, its share of the refunds on the term's prepay invoice, spread over the
 *     term's stamped visits so the shares add up to the term refund. The term invoice is counted once, in the term share.
 */
const Joi = require('joi');
const db = require('../models/db');
const { roundDiv } = require('./payroll-calc');
const { PayrollError } = require('./payroll-w4');
const { completionInvoiceAmount, hasAuthoritativeZeroPrice, resolveBillingLane } = require('./billing-lane');
const { isReService } = require('./re-service');
const {
  isAlwaysFreeServiceType, isConsultationServiceType,
  ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX, CONSULTATION_SERVICE_TYPE_SQL_REGEX,
} = require('./no-cost-visit-types');
const { staffWorkDateSql, staffWeekStartForWorkDate, addStaffWorkDays } = require('../utils/staff-time-work-date');
const { etDateString } = require('../utils/datetime-et');

const BAR_TYPES = ['per_shift', 'weekly'];
const OWN_CALLBACK_DAYS = 30;
const MAX_CENTS = 100000000; // $1,000,000: a typo guard, not a business limit
// A follow-up in one of these states is not a planned visit of its job. A 'rescheduled' follow-up still is one: the package
// booking code (package-followup-booking.js, uq_scheduled_services_followup_source_open) counts it as live.
const UNPLANNED_STATUSES = ['cancelled', 'skipped', 'no_show'];
// An invoice in one of these states is no charge to the customer.
const NOT_CHARGED_INVOICE_STATUSES = ['draft', 'void', 'canceled', 'cancelled'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WORK_DATE_SQL = `COALESCE(${staffWorkDateSql('s.completed_at')}, s.scheduled_date)`;

// ---------------------------------------------------------------- pure calculation

const cents = (value) => (value == null || value === '' ? null : Math.round(Number(value) * 100));

function wholeCents(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a whole number of cents, 0 or more`);
  return BigInt(value);
}

/**
 * The share of one pay week, pure. All money is whole cents.
 *   credits   the week's credits: numbers, or rows with creditCents (the rows weekCredits returns)
 *   shifts    the number of shifts worked in the week
 *   settings  { rateBps, barType, barCents } or null (no setting on file: the share is $0)
 * Returns { creditedCents, barCents, aboveBarCents, shareCents, shifts, configured }.
 */
function shareForWeek({ credits = [], shifts = 0, settings = null } = {}) {
  const creditedCents = credits.reduce((sum, credit) => {
    const value = credit && typeof credit === 'object' ? credit.creditCents : credit;
    return sum + wholeCents(value, 'A credit');
  }, 0n);
  if (!Number.isSafeInteger(shifts) || shifts < 0) throw new Error('Shifts must be a whole number, 0 or more');
  if (!settings) {
    return { creditedCents: Number(creditedCents), barCents: null, aboveBarCents: 0, shareCents: 0, shifts, configured: false };
  }
  if (!BAR_TYPES.includes(settings.barType)) throw new Error('The bar type must be per_shift or weekly');
  const rateBps = wholeCents(settings.rateBps, 'The rate');
  if (rateBps > 10000n) throw new Error('The rate cannot be more than 100%');
  const bar = wholeCents(settings.barCents, 'The bar');
  const barCents = settings.barType === 'per_shift' ? bar * BigInt(shifts) : bar;
  const above = creditedCents > barCents ? creditedCents - barCents : 0n;
  // Half a cent and up rounds up, as every payroll tax line does (payroll-calc.js).
  const share = roundDiv(above * rateBps, 10000n);
  return {
    creditedCents: Number(creditedCents), barCents: Number(barCents), aboveBarCents: Number(above), shareCents: Number(share),
    shifts, configured: true,
  };
}

// The credit of the nth planned visit of a job (1-based): the price split into `planned` parts that add up to the price.
function jobPartCents(priceCents, planned, nth) {
  const price = BigInt(priceCents);
  const n = BigInt(planned);
  return Number(roundDiv(price * BigInt(nth), n) - roundDiv(price * BigInt(nth - 1), n));
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);

const shiftDays = (rows) => [...new Set(rows.map((row) => row.workDate))].sort();

// ---------------------------------------------------------------- settings

const SETTINGS_COLUMNS = [
  'id', 'technician_id', 'rate_bps', 'bar_type', 'bar_cents', 'callback_stop_value_cents', 'created_by',
];
const settingsRow = (row) => ({
  id: Number(row.id),
  technicianId: row.technician_id || null,
  fromWeek: row.from_week,
  rateBps: row.rate_bps,
  barType: row.bar_type,
  barCents: Number(row.bar_cents),
  callbackStopValueCents: Number(row.callback_stop_value_cents),
  createdBy: row.created_by || null,
});

/**
 * The settings in force in a pay week: the newest row on or before it, and a row of the technician wins over the
 * default (technician_id NULL), as the minimum paid week reads payroll_week_minimum_changes. null = none on file.
 */
async function settingsFor(conn, technicianId, weekStart) {
  const rows = await conn('production_share_settings')
    .where('from_week', '<=', weekStart)
    .where((q) => q.where('technician_id', technicianId).orWhereNull('technician_id'))
    .select(...SETTINGS_COLUMNS, conn.raw("to_char(from_week, 'YYYY-MM-DD') AS from_week"))
    .orderBy([{ column: 'from_week', order: 'desc' }, { column: 'id', order: 'desc' }]);
  const row = rows.find((r) => r.technician_id === technicianId) || rows.find((r) => r.technician_id == null);
  return row ? settingsRow(row) : null;
}

// Every row on file for the technician and the default, newest first (the preview shows it).
async function settingsHistory(conn, technicianId) {
  const rows = await conn('production_share_settings')
    .where((q) => q.where('technician_id', technicianId).orWhereNull('technician_id'))
    .select(...SETTINGS_COLUMNS, conn.raw("to_char(from_week, 'YYYY-MM-DD') AS from_week"))
    .orderBy([{ column: 'from_week', order: 'desc' }, { column: 'id', order: 'desc' }]);
  return rows.map(settingsRow);
}

const centsSchema = (label) => Joi.number().integer().min(0).max(MAX_CENTS).required()
  .messages({ 'any.required': `Enter ${label}`, 'number.base': `${label} must be a whole number of cents`, 'number.integer': `${label} must be a whole number of cents` });
const settingsSchema = Joi.object({
  technicianId: Joi.any().custom((value, helpers) => {
    if (value == null || value === '') return null;
    return UUID_RE.test(String(value)) ? String(value).toLowerCase() : helpers.message('Choose a technician, or leave it empty for the default');
  }).default(null),
  fromWeek: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'The week must be a date, YYYY-MM-DD' }),
  rateBps: Joi.number().integer().min(0).max(10000).required()
    .messages({ 'any.required': 'Enter the rate', 'number.base': 'The rate must be a number of basis points (1500 = 15%)', 'number.max': 'The rate cannot be more than 100%' }),
  barType: Joi.string().valid(...BAR_TYPES).required().messages({ 'any.only': 'The bar is per shift or weekly', 'any.required': 'Choose the bar type' }),
  barCents: centsSchema('the bar'),
  callbackStopValueCents: centsSchema('the average value of one stop'),
});

/**
 * Saves the settings from a pay week on (the owner account's alone; the route checks it). Without fromWeek, from the pay
 * week it is saved in. A week before that is refused: a week already paid keeps the numbers it had. A second save for the
 * same technician and week replaces that week's row. Audited like the minimum paid week.
 */
async function saveSettings(input, actor, conn = db) {
  const { value: v, error } = settingsSchema.validate(input || {}, { abortEarly: true, convert: true, allowUnknown: false });
  if (error) throw new PayrollError(400, error.details[0].message);
  const thisWeek = staffWeekStartForWorkDate(etDateString());
  let fromWeek;
  try {
    fromWeek = v.fromWeek ? staffWeekStartForWorkDate(v.fromWeek) : thisWeek;
  } catch {
    throw new PayrollError(400, 'The week must be a real date, YYYY-MM-DD');
  }
  if (v.fromWeek && fromWeek !== v.fromWeek) throw new PayrollError(400, 'The week must be a Monday.');
  if (fromWeek < thisWeek) throw new PayrollError(409, 'These numbers cannot start in a week that has begun. A paid week keeps the numbers it had.');
  const actorId = (actor && typeof actor === 'object' ? actor.id : actor) || null;
  const { recordAuditEvent } = require('./audit-log');
  const { lockPayrollMutations } = require('./payroll-runs');
  return conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    if (v.technicianId && !(await trx('technicians').where({ id: v.technicianId }).first('id'))) {
      throw new PayrollError(404, 'Technician not found.');
    }
    const row = {
      technician_id: v.technicianId, from_week: fromWeek, rate_bps: v.rateBps, bar_type: v.barType, bar_cents: v.barCents,
      callback_stop_value_cents: v.callbackStopValueCents, created_by: actorId, created_at: trx.fn.now(),
    };
    await trx('production_share_settings').insert(row).onConflict(trx.raw(
      v.technicianId ? '(technician_id, from_week) WHERE technician_id IS NOT NULL' : '(from_week) WHERE technician_id IS NULL',
    )).merge(['rate_bps', 'bar_type', 'bar_cents', 'callback_stop_value_cents', 'created_by', 'created_at']);
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.production_share_settings_changed', resource_type: 'production_share_settings',
      resource_id: v.technicianId, // NULL = the default for every technician
      metadata: {
        technician_id: v.technicianId, from_week: fromWeek, rate_bps: v.rateBps, bar_type: v.barType,
        bar_cents: v.barCents, callback_stop_value_cents: v.callbackStopValueCents,
      },
    });
    return { technicianId: v.technicianId, fromWeek, rateBps: v.rateBps, barType: v.barType, barCents: v.barCents, callbackStopValueCents: v.callbackStopValueCents };
  });
}

// ---------------------------------------------------------------- credits

function requireWeek(weekStart) {
  let monday;
  try { monday = staffWeekStartForWorkDate(weekStart); } catch { throw new PayrollError(400, 'The week must be a date, YYYY-MM-DD'); }
  if (monday !== weekStart) throw new PayrollError(400, 'The week must start on a Monday.');
  return weekStart;
}

// The planned visits of the multi-visit job a stop belongs to, or null when it belongs to none. A job is a chain: the
// first visit carries the price, and each included follow-up (followup_included) points at the visit before it
// (followup_source_service_id; one live follow-up per visit, uq_scheduled_services_followup_source_open). A visit is in a
// job when it is an included follow-up or has one. { root, planned: [ids in order] }, or { broken } when the chain
// cannot be followed to a first visit.
const CHAIN_LIMIT = 12;
async function jobOf(conn, stop, hasFollowUp, cache) {
  if (!stop.followup_included && !hasFollowUp.has(stop.id)) return null;
  let root = {
    id: stop.id, estimated_price: stop.estimated_price, followup_included: stop.followup_included,
    followup_source_service_id: stop.followup_source_service_id,
  };
  for (let hops = 0; root.followup_included; hops += 1) {
    const source = hops < CHAIN_LIMIT && root.followup_source_service_id
      ? await conn('scheduled_services').where({ id: root.followup_source_service_id })
        .first('id', 'estimated_price', 'followup_included', 'followup_source_service_id')
      : null;
    if (!source) return { broken: true };
    root = source;
  }
  if (cache.has(root.id)) return cache.get(root.id);
  const planned = [root.id];
  for (let hops = 0; hops < CHAIN_LIMIT; hops += 1) {
    const next = await conn('scheduled_services')
      .where({ followup_source_service_id: planned[planned.length - 1], followup_included: true })
      .whereNotIn('status', UNPLANNED_STATUSES).orderBy('created_at').first('id');
    if (!next) break;
    planned.push(next.id);
  }
  const job = { root, planned };
  cache.set(root.id, job);
  return job;
}

// The same test for a callback everywhere: the flag, or a re-service catalog key, name or type (re-service.js).
const isCallbackVisit = (visit) => visit.is_callback === true || isReService({
  serviceKey: visit.service_key || visit.service_key_snapshot || null, serviceName: visit.service_name, serviceType: visit.service_type,
});

const normalizedText = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// A visit's address as text: its own, else its property's. null = no address on file.
function addressKey(visit) {
  const line = normalizedText(visit.service_address_line1 || visit.prop_line1);
  const zip = normalizedText(visit.service_address_zip || visit.prop_zip);
  return line && zip ? `${line}|${zip}` : null;
}
// Same property: equal property ids, else equal addresses on file. 'unknown' when neither can say (a missing id with no address).
function sameProperty(a, b) {
  if (a.property_id && b.property_id) return a.property_id === b.property_id ? 'yes' : 'no';
  const keys = [addressKey(a), addressKey(b)];
  if (!keys[0] || !keys[1]) return 'unknown';
  return keys[0] === keys[1] ? 'yes' : 'no';
}

const NEW_ORIGINAL_LIMIT = 80;
// The work a callback follows: the customer's latest completed, non-callback visit of the same line at the same property that
// came BEFORE it (by completion time; a same-day pair whose order cannot be read is never guessed). Returns
// { original } or { review: reason }; { original: null } when there is none.
async function originalWork(conn, callback) {
  const candidates = await conn('scheduled_services as s')
    .leftJoin('services as sv', 'sv.id', 's.service_id')
    .leftJoin('customer_properties as cp', 'cp.id', 's.property_id')
    .where({ 's.customer_id': callback.customer_id, 's.status': 'completed' })
    .whereNot('s.id', callback.id)
    .whereRaw(`${require('./rate-review').PLAN_LINE_SQL.LINE_SQL} = ?`, [callback.line])
    .whereRaw('s.service_type !~* ? AND s.service_type !~* ?', [ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX, CONSULTATION_SERVICE_TYPE_SQL_REGEX])
    .whereRaw(`${WORK_DATE_SQL} <= ?`, [callback.work_date])
    .orderByRaw(`${WORK_DATE_SQL} DESC, s.completed_at DESC NULLS LAST, s.id`)
    .limit(NEW_ORIGINAL_LIMIT)
    .select('s.id', 's.technician_id', 's.property_id', 's.service_type', 's.service_key_snapshot', 's.is_callback', 's.completed_at',
      's.service_address_line1', 's.service_address_zip', 'sv.service_key', 'sv.name as service_name',
      'cp.address_line1 as prop_line1', 'cp.zip as prop_zip',
      conn.raw(`to_char(${WORK_DATE_SQL}, 'YYYY-MM-DD') AS work_date`));
  let original = null;
  for (const candidate of candidates) {
    if (isCallbackVisit(candidate)) continue; // a re-service is never the original work
    const where = sameProperty(callback, candidate);
    if (where === 'no') continue;
    let earlier = candidate.work_date < callback.work_date;
    if (candidate.work_date === callback.work_date) {
      // Same day: only completion times can say which came first.
      const [then, now] = [candidate.completed_at, callback.completed_at].map((at) => (at ? new Date(at).getTime() : null));
      if (then == null || now == null || then === now) {
        return { review: 'A visit of the same line the same day as this callback, and the order of the two cannot be read.' };
      }
      earlier = then < now;
    }
    if (!earlier) continue;
    if (where === 'unknown') return { review: 'Earlier work of the same line, but it cannot be tied to this property (no property or address on file).' };
    original = candidate;
    break;
  }
  return { original };
}

// How much of a total each member gets, in whole cents, split in proportion to its weight: the floors, then the remaining
// cents one each to the largest remainders (ties by id), so the parts add up to the total exactly. null when a weight is
// missing or not positive (the split cannot be known).
function allocateCents(totalCents, members) {
  if (!members.length || members.some((m) => !(m.weight > 0))) return null;
  const total = BigInt(totalCents);
  const sum = members.reduce((acc, m) => acc + BigInt(m.weight), 0n);
  const parts = members.map((m) => ({ id: m.id, floor: (total * BigInt(m.weight)) / sum, rest: (total * BigInt(m.weight)) % sum }));
  let left = total - parts.reduce((acc, part) => acc + part.floor, 0n);
  [...parts].sort((a, b) => (a.rest === b.rest ? String(a.id).localeCompare(String(b.id)) : (a.rest > b.rest ? -1 : 1)))
    .forEach((part) => { if (left > 0n) { part.floor += 1n; left -= 1n; } });
  return new Map(parts.map((part) => [part.id, Number(part.floor)]));
}

/**
 * What each visit was BILLED, before sales tax, and what was refunded on it, from the invoices linked to the visit by the
 * links the rate review reads (rate-review.js VISIT_INVOICE_LINK_SQL: direct, through the service record, the combined
 * first-application invoice, a completion packet). An unpaid invoice counts: the credit is the price charged, and a later
 * fee change never moves it. An invoice shared by several visits is split across ALL of them in proportion to their visit
 * prices, with the cents settled exactly; when a member has no price the split is unknowable and that invoice is left out
 * (the visit then falls back to its own price). Draft and void invoices are no charge. The prepay invoice of an annual term
 * is never attributed here: its refunds go to the term's visits (termRefunds).
 * Returns Map visitId -> { billedCents: number|null, refundCents }.
 */
async function billedByVisit(conn, visitIds) {
  const out = new Map();
  if (!visitIds.length) return out;
  const rr = require('./rate-review');
  const { REFUND_BASE_SQL } = rr;
  const refundOf = `(SELECT COALESCE(sum(${REFUND_BASE_SQL}), 0) FROM payments p
    WHERE COALESCE(p.refund_amount, 0) > 0
      AND ((p.stripe_payment_intent_id IS NOT NULL AND p.stripe_payment_intent_id = i.stripe_payment_intent_id)
        OR (p.stripe_charge_id IS NOT NULL AND p.stripe_charge_id = i.stripe_charge_id)
        OR p.metadata::jsonb ->> 'invoice_id' = i.id::text))`;
  const links = await conn.raw(`
    SELECT s.id AS visit_id, i.id AS invoice_id,
      CASE WHEN ${rr.COMBINED_SETUP_INVOICE_SQL} THEN ${rr.APPLICATION_LINES_SQL}
           WHEN COALESCE(i.subtotal, 0) > 0 THEN i.subtotal - COALESCE(i.discount_amount, 0)
           ELSE i.total - COALESCE(i.tax_amount, 0) + ${rr.depositCreditSql('i')} END AS pretax,
      ${refundOf} AS refunded
    FROM scheduled_services s
    LEFT JOIN LATERAL (SELECT id AS service_record_id FROM service_records WHERE scheduled_service_id = s.id ORDER BY created_at DESC LIMIT 1) sr ON true
    JOIN invoices i ON ${rr.VISIT_INVOICE_LINK_SQL}
    WHERE s.id = ANY(?::uuid[]) AND i.archived_at IS NULL AND i.annual_prepay_term_id IS NULL
      AND i.status <> ALL(?::text[])
      AND NOT EXISTS (SELECT 1 FROM annual_prepay_terms t WHERE t.prepay_invoice_id = i.id)`,
  [visitIds, NOT_CHARGED_INVOICE_STATUSES]);
  if (!links.rows.length) return out;
  const invoiceIds = [...new Set(links.rows.map((row) => row.invoice_id))];
  const members = await conn.raw(`
    SELECT i.id AS invoice_id, m.id AS visit_id, COALESCE(m.estimated_price, m.primary_line_price) AS weight
    FROM invoices i
    JOIN LATERAL (
      ${rr.INVOICE_MEMBER_IDS_SQL}
      UNION SELECT i.scheduled_service_id WHERE i.scheduled_service_id IS NOT NULL
      UNION SELECT sr2.scheduled_service_id FROM service_records sr2 WHERE sr2.id = i.service_record_id AND sr2.scheduled_service_id IS NOT NULL
    ) mem ON true
    JOIN scheduled_services m ON m.id = mem.id
    WHERE i.id = ANY(?::uuid[])`, [invoiceIds]);
  const byInvoice = new Map();
  for (const row of members.rows) {
    if (!byInvoice.has(row.invoice_id)) byInvoice.set(row.invoice_id, []);
    byInvoice.get(row.invoice_id).push({ id: row.visit_id, weight: cents(row.weight) });
  }
  const shares = new Map(); // invoice id -> { billed: Map, refunded: Map } by visit
  for (const row of links.rows) {
    if (shares.has(row.invoice_id)) continue;
    const list = byInvoice.get(row.invoice_id) || [];
    const billed = Math.max(0, cents(row.pretax) || 0);
    const refunded = cents(row.refunded) || 0;
    if (list.length <= 1) {
      shares.set(row.invoice_id, { billed: new Map([[row.visit_id, billed]]), refunded: new Map([[row.visit_id, refunded]]) });
    } else {
      const billedParts = allocateCents(billed, list);
      shares.set(row.invoice_id, billedParts ? { billed: billedParts, refunded: allocateCents(refunded, list) } : null);
    }
  }
  for (const row of links.rows) {
    const share = shares.get(row.invoice_id);
    if (!share || !share.billed.has(row.visit_id)) continue;
    const entry = out.get(row.visit_id) || { billedCents: 0, refundCents: 0 };
    entry.billedCents += share.billed.get(row.visit_id);
    entry.refundCents += (share.refunded && share.refunded.get(row.visit_id)) || 0;
    out.set(row.visit_id, entry);
  }
  return out;
}

/**
 * The refunds on an annual prepay term's prepay invoice, spread over the term's stamped visits in proportion to their
 * prepaid slices, the cents settled exactly so the shares add up to the term's refund. Counted once: the term invoice is
 * left out of billedByVisit. Returns Map visitId -> cents for the visits in `stops`.
 */
async function termRefunds(conn, stops) {
  const out = new Map();
  const termIds = [...new Set(stops.filter((stop) => stop.annual_prepay_term_id).map((stop) => stop.annual_prepay_term_id))];
  if (!termIds.length) return out;
  const { REFUND_BASE_SQL } = require('./rate-review');
  const terms = await conn.raw(`
    SELECT apt.id, COALESCE((SELECT sum(${REFUND_BASE_SQL}) FROM payments p
      WHERE COALESCE(p.refund_amount, 0) > 0
        AND ((p.stripe_payment_intent_id IS NOT NULL AND p.stripe_payment_intent_id = pi.stripe_payment_intent_id)
          OR (p.stripe_charge_id IS NOT NULL AND p.stripe_charge_id = pi.stripe_charge_id)
          OR p.metadata::jsonb ->> 'invoice_id' = pi.id::text)), 0) AS refunded
    FROM annual_prepay_terms apt JOIN invoices pi ON pi.id = apt.prepay_invoice_id
    WHERE apt.id = ANY(?::uuid[])`, [termIds]);
  for (const term of terms.rows) {
    const refunded = cents(term.refunded) || 0;
    if (!(refunded > 0)) continue;
    const stamped = await conn('scheduled_services').where({ annual_prepay_term_id: term.id }).where('prepaid_amount', '>', 0)
      .select('id', 'prepaid_amount');
    const parts = allocateCents(refunded, stamped.map((row) => ({ id: row.id, weight: cents(row.prepaid_amount) })));
    if (!parts) continue;
    for (const stop of stops) if (parts.has(stop.id)) out.set(stop.id, parts.get(stop.id));
  }
  return out;
}

// The credit of one stop: { kind, creditCents, reason, needsReview }. A stop that cannot be credited with certainty is $0
// and needsReview, never a guess.
const credited = (kind, creditCents, reason) => ({ kind, creditCents, reason, needsReview: false });
const toReview = (kind, reason) => ({ kind, creditCents: 0, reason, needsReview: true });

// The job price is what the first visit was billed (its invoice, before tax), else its own price.
function jobCredit(stop, job, billed) {
  if (job.broken) return toReview('multi_visit_job', 'An included follow-up whose first visit cannot be found. Link it to its job.');
  const invoiced = billed.get(job.root.id);
  const price = invoiced ? invoiced.billedCents : cents(job.root.estimated_price);
  const nth = job.planned.indexOf(stop.id) + 1;
  if (!(price > 0)) return toReview('multi_visit_job', "The job's first visit has no price on file.");
  if (nth < 1) return toReview('multi_visit_job', "This visit is not among the job's planned visits.");
  return credited('multi_visit_job', jobPartCents(price, job.planned.length, nth), `Part ${nth} of ${job.planned.length} of the job price`);
}

async function callbackCredit(conn, stop, technicianId, inForce) {
  if (stop.line === 'other') return toReview('callback_review', 'A callback whose service line is unknown, so its original work cannot be found.');
  const found = await originalWork(conn, stop);
  if (found.review) return toReview('callback_review', found.review);
  const original = found.original;
  if (!original) return toReview('callback_review', 'No earlier completed work of the same line at this property.');
  if (!original.technician_id) return toReview('callback_review', 'The original work has no technician on file.');
  if (original.technician_id === technicianId) {
    const age = daysBetween(original.work_date, stop.work_date);
    return age <= OWN_CALLBACK_DAYS
      ? credited('callback_own', 0, `Callback on own work, ${age} days after it`)
      : toReview('callback_review', `Callback on own work ${age} days after it. The Terms cover 30 days only.`);
  }
  if (!inForce) return toReview('callback_review', "A callback on another technician's work, and no production share setting is on file.");
  return credited('callback_other', inForce.callbackStopValueCents, "Callback on another technician's work");
}

function ownPriceCredit(stop, invoiced) {
  if (isAlwaysFreeServiceType(stop.service_type)) return credited('free_visit', 0, 'A visit type that is always free');
  if (Number(stop.prepaid_amount) > 0 && stop.annual_prepay_term_id) {
    return credited('prepaid_plan', cents(stop.prepaid_amount), "The prepaid plan's value for one visit");
  }
  // What the visit's invoice charged, before tax, whether or not it is paid; a fee change later never moves it.
  if (invoiced) {
    if (invoiced.billedCents > 0) return credited('priced', invoiced.billedCents, "Pre-tax amount of the visit's invoice");
    return isConsultationServiceType(stop.service_type)
      ? credited('free_assessment', 0, 'A free assessment')
      : credited('free_visit', 0, "The visit's invoice charges $0");
  }
  const lane = resolveBillingLane({ billing_mode: stop.billing_mode, waveguard_tier: stop.waveguard_tier, monthly_rate: stop.monthly_rate });
  const amount = cents(completionInvoiceAmount({
    estimatedPrice: stop.estimated_price,
    isCallback: false,
    perApplicationBilling: lane.mode === 'per_application',
    perApplicationFee: stop.per_application_fee,
    monthlyRate: 0, // see the review map: a month of dues is not one visit's price
    billingMode: stop.billing_mode,
    primaryLinePrice: stop.primary_line_price,
    serviceType: stop.service_type,
  }));
  if (amount > 0) return credited('priced', amount, 'Price of the visit, before sales tax');
  if (isConsultationServiceType(stop.service_type)) return credited('free_assessment', 0, 'A free assessment');
  if (hasAuthoritativeZeroPrice(stop.estimated_price, stop.primary_line_price)) return credited('free_visit', 0, 'The visit is priced at $0');
  return toReview('unpriced', 'The visit has no price of its own on file (a plan visit covered by dues, or never priced).');
}

/**
 * The credit of every route stop the technician completed in a pay week (Monday `weekStart` to Sunday), one row per
 * stop in work-date order: { visitId, workDate, kind, creditCents, reason, needsReview, refundCents, serviceType }.
 * Stops that earn $0 are rows too, because they still make their day a shift. `settings` (optional) are the settings in
 * force for the week; read here when not passed (the callback value comes from them).
 */
async function weekCredits(conn, technicianId, weekStart, { settings } = {}) {
  requireWeek(weekStart);
  const weekEnd = addStaffWorkDays(weekStart, 6);
  const inForce = settings === undefined ? await settingsFor(conn, technicianId, weekStart) : settings;
  const { LINE_SQL } = require('./rate-review').PLAN_LINE_SQL;
  const stops = await conn('scheduled_services as s')
    .leftJoin('services as sv', 'sv.id', 's.service_id')
    .leftJoin('customers as c', 'c.id', 's.customer_id')
    .leftJoin('customer_properties as cp', 'cp.id', 's.property_id')
    .where({ 's.technician_id': technicianId, 's.status': 'completed' })
    .whereRaw(`${WORK_DATE_SQL} BETWEEN ? AND ?`, [weekStart, weekEnd])
    .select('s.id', 's.customer_id', 's.property_id', 's.service_type', 's.estimated_price', 's.primary_line_price',
      's.is_callback', 's.followup_included', 's.followup_source_service_id', 's.annual_prepay_term_id', 's.prepaid_amount',
      's.service_key_snapshot', 's.completed_at', 's.service_address_line1', 's.service_address_zip',
      'sv.service_key', 'sv.name as service_name', 'cp.address_line1 as prop_line1', 'cp.zip as prop_zip',
      'c.billing_mode', 'c.waveguard_tier', 'c.monthly_rate', 'c.per_application_fee',
      conn.raw(`to_char(${WORK_DATE_SQL}, 'YYYY-MM-DD') AS work_date`), conn.raw(`${LINE_SQL} AS line`))
    .orderByRaw(`${WORK_DATE_SQL}, s.completed_at NULLS LAST, s.id`);
  const withFollowUp = stops.length
    ? await conn('scheduled_services').whereIn('followup_source_service_id', stops.map((stop) => stop.id))
      .where({ followup_included: true }).whereNotIn('status', UNPLANNED_STATUSES).pluck('followup_source_service_id')
    : [];
  const hasFollowUp = new Set(withFollowUp);
  const jobCache = new Map();
  const jobs = new Map();
  for (const stop of stops) jobs.set(stop.id, await jobOf(conn, stop, hasFollowUp, jobCache));
  const billed = await billedByVisit(conn, [...new Set([...stops.map((stop) => stop.id),
    ...[...jobs.values()].filter((job) => job && job.root).map((job) => job.root.id)])]);
  const prepaidRefunds = await termRefunds(conn, stops);

  const rows = [];
  for (const stop of stops) {
    const callback = isCallbackVisit(stop);
    const job = jobs.get(stop.id);
    let credit;
    // An included follow-up (even of a re-service type) and the first visit of a job are parts of the job; any other callback is
    // judged by the work it follows.
    if (job && (stop.followup_included || !callback)) credit = jobCredit(stop, job, billed);
    else if (callback) credit = await callbackCredit(conn, stop, technicianId, inForce);
    else credit = ownPriceCredit(stop, billed.get(stop.id));
    rows.push({
      visitId: stop.id, workDate: stop.work_date, serviceType: stop.service_type, ...credit,
      refundCents: ((billed.get(stop.id) || {}).refundCents || 0) + (prepaidRefunds.get(stop.id) || 0),
    });
  }
  return rows;
}

/**
 * Everything the preview shows for one technician and week: the credit rows, the shifts, the settings in force, the
 * share it would be, the stops to review and the refund total. A preview only: nothing is stored or paid.
 */
async function previewWeek(technicianId, weekStart, conn = db) {
  if (!UUID_RE.test(String(technicianId || ''))) throw new PayrollError(404, 'Technician not found.');
  requireWeek(weekStart);
  const technician = await conn('technicians').where({ id: technicianId }).first('id', 'name');
  if (!technician) throw new PayrollError(404, 'Technician not found.');
  const settings = await settingsFor(conn, technicianId, weekStart);
  const stops = await weekCredits(conn, technicianId, weekStart, { settings });
  const days = shiftDays(stops);
  const result = shareForWeek({ credits: stops, shifts: days.length, settings });
  return {
    technician: { id: technician.id, name: technician.name },
    weekStart,
    weekEnd: addStaffWorkDays(weekStart, 6),
    settings,
    history: await settingsHistory(conn, technicianId),
    shiftDays: days,
    ...result,
    stops,
    needsReview: stops.filter((stop) => stop.needsReview),
    refundCents: stops.reduce((sum, stop) => sum + stop.refundCents, 0),
  };
}

module.exports = {
  allocateCents, BAR_TYPES, OWN_CALLBACK_DAYS, shareForWeek, jobPartCents, shiftDays, settingsFor, settingsHistory, saveSettings, weekCredits,
  previewWeek,
};
