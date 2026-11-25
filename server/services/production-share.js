/**
 * Production share, PR 1: the weekly CREDIT, its dated settings and the numbers an admin preview shows (Technician
 * Terms v3, "Production share"; owner 2026-11-23). It pays NOTHING: no pay line, no check, no gate. PR 2 puts the share
 * on the paycheck; PR 3a asks the owner about refunds (production-share-refunds.js: the code never measures a refund, it detects one
 * and the owner sets the take-back).
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
 *     is paid, by the links the rate review reads (rate-review.js VISIT_INVOICE_LINK_SQL: direct, any service record of the
 *     visit, first-application, completion packet); a shared invoice is split across its visits by visit price, to the cent. A
 *     fee change later never moves a credit already earned. Left out of the amount: a monthly dues line (billing-lane.js
 *     MEMBERSHIP_DUES_LINE_KEY) and a one-time setup FEE line (the classifier the setup-fee code uses,
 *     estimate-first-application-invoice.js sumPositiveSetupFeeCents), never a line judged by its words alone. An invoice
 *     with only such lines names no visit price.
 *   - What a visit is priced at         with no invoice naming it: the price recorded on the visit (completionInvoiceAmount +
 *     hasAuthoritativeZeroPrice, billing-lane.js). The account's CURRENT per-application fee is never used for past work, and
 *     the Terms credit the PRICE CHARGED, before sales tax, not what settled. The settled-cash
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
 *   - A refund                          the code does NOT work out what a refund takes back (owner 2026-11-25). A stop with ANY refund
 *     signal (production-share-refunds.js refundSignalsOf: payments, parked refunds, returned credit, a refunded invoice, a statement
 *     refund) is $0 and needs review, kind refund_flagged, until the owner sets its credit; a refund that appears on a stop a final check
 *     already paid is listed (takeBackToSet) and the owner sets the total to take back. refundCents is only the stop's recorded refund
 *     total, shown for information: refunds on the payments of the visit's linked invoices (the same links and the same split
 *     as the amount), plus, for a prepaid plan visit, its share of the refunds on the term's prepay invoice, spread over the
 *     term's stamped visits so the shares add up to the term refund. The term invoice is counted once, in the term share.
 */
const Joi = require('joi');
const db = require('../models/db');
const { roundDiv } = require('./payroll-calc');
const { PayrollError } = require('./payroll-w4');
const { completionInvoiceAmount, hasAuthoritativeZeroPrice, ANNUAL_PREPAY_PREPAID_METHOD, MEMBERSHIP_DUES_LINE_KEY } = require('./billing-lane');
const { NON_CHARGEABLE_CLOSEOUT_OUTCOMES } = require('./visit-outcomes');
const { TWO_TREATMENT_PACKAGE_KEYS } = require('./typed-followup-obligation');
const { isReService } = require('./re-service');
const refunds = require('./production-share-refunds');
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

// The id as Postgres spells it (lowercase): every comparison of technician ids in this module is between canonical ids, so an id
// typed in capitals never reads as another technician's.
const canonicalId = (id) => (id == null ? id : String(id).toLowerCase());

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
async function settingsFor(conn, technicianIdIn, weekStart) {
  const technicianId = canonicalId(technicianIdIn);
  const rows = await conn('production_share_settings')
    .where('from_week', '<=', weekStart)
    .where((q) => q.where('technician_id', technicianId).orWhereNull('technician_id'))
    .select(...SETTINGS_COLUMNS, conn.raw("to_char(from_week, 'YYYY-MM-DD') AS from_week"))
    .orderBy([{ column: 'from_week', order: 'desc' }, { column: 'id', order: 'desc' }]);
  const row = rows.find((r) => r.technician_id === technicianId) || rows.find((r) => r.technician_id == null);
  return row ? settingsRow(row) : null;
}

// Every row on file for the technician and the default, newest first (the preview shows it).
async function settingsHistory(conn, technicianIdIn) {
  const technicianId = canonicalId(technicianIdIn);
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
// job when it is an included follow-up or has one, or is the first visit of a two-treatment package. { root, planned: [ids in order] }, or { broken } when the chain
// cannot be followed to a first visit.
const CHAIN_LIMIT = 12;
async function jobOf(conn, stop, hasFollowUp, cache) {
  // A two-treatment package's first visit is a job even before its follow-up is booked: the package was sold with two visits.
  const packageFirstVisit = TWO_TREATMENT_PACKAGE_KEYS.has(stop.service_key || stop.service_key_snapshot) && !isCallbackVisit(stop);
  if (!stop.followup_included && !hasFollowUp.has(stop.id) && !packageFirstVisit) return null;
  let root = {
    id: stop.id, estimated_price: stop.estimated_price, followup_included: stop.followup_included,
    followup_source_service_id: stop.followup_source_service_id, service_key: stop.service_key || stop.service_key_snapshot || null,
  };
  for (let hops = 0; root.followup_included; hops += 1) {
    const source = hops < CHAIN_LIMIT && root.followup_source_service_id
      ? await conn('scheduled_services as s').leftJoin('services as sv', 'sv.id', 's.service_id').where({ 's.id': root.followup_source_service_id })
        .first('s.id', 's.estimated_price', 's.followup_included', 's.followup_source_service_id',
          conn.raw('COALESCE(sv.service_key, s.service_key_snapshot) AS service_key'))
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
// A visit's address as text: its own, else its property's. null = no street and zip on file. The unit (line 2) is part of
// it: two units of one building are two homes.
// The line the owner sees to find the visit behind a review row: its street and zip, else its property's.
function addressLine(visit) {
  const own = normalizedText(visit.service_address_line1);
  const zip = visit.service_address_zip || visit.prop_zip;
  return [own ? visit.service_address_line1 : visit.prop_line1, zip].filter(Boolean).join(' ') || null;
}

function addressParts(visit) {
  const own = normalizedText(visit.service_address_line1);
  const line = own ? visit.service_address_line1 : visit.prop_line1;
  const unit = own ? visit.service_address_line2 : visit.prop_line2;
  const street = normalizedText(line);
  const zip = normalizedText(visit.service_address_zip || visit.prop_zip);
  return street && zip ? { street: `${street}|${zip}`, unit: normalizedText(unit) } : null;
}
// Same property: equal property ids, else equal addresses on file. 'unknown' when neither can say: a missing id with no
// address, or one side names a unit and the other does not.
function sameProperty(a, b) {
  if (a.property_id && b.property_id) return a.property_id === b.property_id ? 'yes' : 'no';
  const [x, y] = [addressParts(a), addressParts(b)];
  if (!x || !y) return 'unknown';
  if (x.street !== y.street) return 'no';
  if (x.unit === y.unit) return 'yes';
  return x.unit && y.unit ? 'no' : 'unknown';
}

// Whether the visit's work was performed, by its latest completion record (service_records): 'yes' (completed, an outcome
// that did work), 'no' (incomplete, declined, inspection only: no application), 'unknown' (no record, or a record that is
// not a completion). The outcome lists are the ones the completion route and the card charge use (visit-outcomes.js).
const RECORD_JOIN_SQL = `LEFT JOIN LATERAL (SELECT r.status AS record_status, r.structured_notes AS record_notes
    FROM service_records r WHERE r.scheduled_service_id = s.id ORDER BY r.created_at DESC LIMIT 1) rec ON true`;
function performedState(visit) {
  if (!visit.record_status) return 'unknown';
  let notes = visit.record_notes;
  if (typeof notes === 'string') { try { notes = JSON.parse(notes); } catch { notes = null; } }
  const outcome = String((notes && notes.visitOutcome) || '');
  if (visit.record_status === 'incomplete' || NON_CHARGEABLE_CLOSEOUT_OUTCOMES.includes(outcome)) return 'no';
  return visit.record_status === 'completed' ? 'yes' : 'unknown';
}

const NEW_ORIGINAL_LIMIT = 80;
// The work a callback follows: the customer's latest PERFORMED, non-callback visit of the same line at the same property
// that came BEFORE it (by completion time). Returns { original } (null = none) or { review: reason } whenever the answer is
// not certain: the latest candidates cannot be ordered (a same-day pair, a missing completion time) and they are not all one
// technician's, the property cannot be verified, or a candidate's completion record is missing.
async function originalWork(conn, callback) {
  const candidates = await conn('scheduled_services as s')
    .leftJoin('services as sv', 'sv.id', 's.service_id')
    .leftJoin('customer_properties as cp', 'cp.id', 's.property_id')
    .joinRaw(RECORD_JOIN_SQL)
    .where({ 's.customer_id': callback.customer_id, 's.status': 'completed' })
    .whereNot('s.id', callback.id)
    .whereRaw(`${require('./rate-review').PLAN_LINE_SQL.LINE_SQL} = ?`, [callback.line])
    .whereRaw('s.service_type !~* ? AND s.service_type !~* ?', [ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX, CONSULTATION_SERVICE_TYPE_SQL_REGEX])
    .whereRaw(`${WORK_DATE_SQL} <= ?`, [callback.work_date])
    .orderByRaw(`${WORK_DATE_SQL} DESC, s.completed_at DESC NULLS LAST, s.id`)
    .limit(NEW_ORIGINAL_LIMIT)
    .select('s.id', 's.technician_id', 's.property_id', 's.service_type', 's.service_key_snapshot', 's.is_callback', 's.completed_at',
      's.service_address_line1', 's.service_address_line2', 's.service_address_zip', 'sv.service_key', 'sv.name as service_name',
      'cp.address_line1 as prop_line1', 'cp.address_line2 as prop_line2', 'cp.zip as prop_zip', 'rec.record_status', 'rec.record_notes',
      conn.raw(`to_char(${WORK_DATE_SQL}, 'YYYY-MM-DD') AS work_date`));
  const kept = [];
  for (const candidate of candidates) {
    if (isCallbackVisit(candidate)) continue; // a re-service is never the original work
    const where = sameProperty(callback, candidate);
    if (where === 'no') continue;
    const performed = performedState(candidate);
    if (performed === 'no') continue; // nothing was applied: not the work a callback follows
    let order = 'earlier';
    if (candidate.work_date === callback.work_date) {
      // Same day: only completion times can say which came first.
      const [then, now] = [candidate.completed_at, callback.completed_at].map((at) => (at ? new Date(at).getTime() : null));
      if (then == null || now == null || then === now) order = 'ambiguous';
      else if (then > now) order = 'later';
    }
    if (order !== 'later') kept.push({ candidate, where, performed, order });
  }
  if (!kept.length) return { original: null };
  const latestDay = kept.reduce((max, k) => (k.candidate.work_date > max ? k.candidate.work_date : max), '');
  const plausible = kept.filter((k) => k.candidate.work_date === latestDay);
  // The latest of that day: the newest completion time, and any visit with no completion time (it could be later).
  const stamped = plausible.filter((k) => k.candidate.completed_at);
  const newest = stamped.length ? Math.max(...stamped.map((k) => new Date(k.candidate.completed_at).getTime())) : null;
  const latest = plausible.filter((k) => !k.candidate.completed_at || new Date(k.candidate.completed_at).getTime() === newest);
  if (kept.some((k) => k.order === 'ambiguous')) {
    return { review: 'A visit of the same line the same day as this callback, and the order of the two cannot be read.' };
  }
  if (latest.some((k) => k.performed === 'unknown')) {
    return { review: 'Earlier work of the same line has no completion record, so it cannot be known whether it was performed.' };
  }
  if (latest.some((k) => k.where === 'unknown')) {
    return { review: 'Earlier work of the same line, but it cannot be tied to this property (no property, address or unit match on file).' };
  }
  if (new Set(latest.map((k) => canonicalId(k.candidate.technician_id))).size > 1) {
    return { review: 'Two visits of the same line on the same day, and which came last cannot be read, by different technicians.' };
  }
  return { original: latest[0].candidate };
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

// One line's amount in cents (the shape every invoice-line reader here uses: amount, else unit price x quantity).
const lineCents = (line) => {
  const qty = line && line.quantity != null ? Number(line.quantity) : 1;
  const amount = line && line.amount != null ? Number(line.amount) : Number(line && line.unit_price) * qty;
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
};

const UNCLEAR_DISCOUNT_REASON = 'The invoice has a discount that is not tied to any one line, beside a setup fee or dues line, so what it took off the visit\'s work cannot be established.';

/**
 * The visit-priced part of an invoice, before tax, from its lines. Left out: a monthly dues line (stamped
 * `membership_dues_month`, billing-lane.js MEMBERSHIP_DUES_LINE_KEY) and a one-time setup FEE line, by the classifier the
 * setup-fee code already uses (estimate-first-application-invoice.js sumPositiveSetupFeeCents: a line that says "setup fee", not
 * waived). A line is never judged by words such as "initial": a $150 "Initial Pest Cleanout" is treatment work and counts.
 * Discounts follow their line: a negative line whose `discount_for` names a line's client_id comes off that line only (a
 * setup-fee line waived by its own discount costs the treatment nothing). A discount tied to no line (or to a line that is gone)
 * reaches the whole invoice: with nothing left out it comes off the work; with a fee or dues line beside the work, how much of it
 * was meant for the work cannot be established, so the visit is listed for review, never prorated by guess.
 * Returns { cents }, { none: true } (only left-out lines: the invoice names no visit price, so the caller falls back to a price
 * recorded on the visit) or { unclear: reason }.
 */
function visitPreTaxCents(row) {
  let lines = row.line_items;
  if (typeof lines === 'string') { try { lines = JSON.parse(lines); } catch { lines = null; } }
  if (!Array.isArray(lines) || !lines.length) {
    const base = Number(row.subtotal) > 0
      ? cents(row.subtotal) - (cents(row.discount_amount) || 0)
      : cents(row.total) - (cents(row.tax_amount) || 0) + (cents(row.deposit_credit) || 0);
    return { cents: Math.max(0, base) };
  }
  const { charges, discounts } = splitInvoiceLines(lines);
  if (!charges.some((charge) => !charge.left)) return { none: true };
  const byId = new Map(charges.filter((charge) => charge.id !== null).map((charge) => [charge.id, charge]));
  let untied = 0;
  for (const discount of discounts) {
    const target = discount.target && byId.get(discount.target);
    if (target) target.discount += discount.amount;
    else untied += discount.amount;
  }
  // A discount on the invoice row that no negative line accounts for is an invoice-wide discount too.
  untied += Math.max(0, (cents(row.discount_amount) || 0) - discounts.reduce((sum, d) => sum + d.amount, 0));
  const work = charges.filter((charge) => !charge.left).reduce((sum, charge) => sum + Math.max(0, charge.amount - charge.discount), 0);
  if (charges.some((charge) => charge.left)) return untied > 0 ? { unclear: UNCLEAR_DISCOUNT_REASON } : { cents: work };
  return { cents: Math.max(0, work - untied) };
}

// The positive lines (marked `left` when dues or a setup fee) and the discount lines of an invoice, in cents.
function splitInvoiceLines(lines) {
  const { sumPositiveSetupFeeCents } = require('./estimate-first-application-invoice');
  const charges = [];
  const discounts = [];
  for (const line of lines) {
    const amount = lineCents(line);
    if (!line || line.category === 'deposit_credit') continue;
    if (amount > 0) {
      charges.push({
        id: line.client_id == null ? null : String(line.client_id), amount, discount: 0,
        left: Boolean(line[MEMBERSHIP_DUES_LINE_KEY]) || sumPositiveSetupFeeCents({ line_items: [line] }) > 0,
      });
    } else if (amount < 0) discounts.push({ target: line.discount_for == null ? null : String(line.discount_for), amount: -amount });
  }
  return { charges, discounts };
}

// How one invoice (a links row) is shared: { billed, refunded } Maps by visit, { skipped } (it names no visit price),
// or { unallocated: its whole refund, reason } (its split across the visits, or what a discount took off, cannot be established).
// What an invoice's price rests on, as plain sorted data: its amounts, the lines that count and the ones left out (dues, a setup fee), the
// discounts and what each one is tied to, and the visits on it with their weights. A change to any of them changes a stop's revision.
function invoiceLineFacts(row, list) {
  let lines = row.line_items;
  if (typeof lines === 'string') { try { lines = JSON.parse(lines); } catch { lines = null; } }
  const { charges, discounts } = Array.isArray(lines) ? splitInvoiceLines(lines) : { charges: [], discounts: [] };
  const sort = (rows) => rows.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return [
    cents(row.subtotal), cents(row.discount_amount), cents(row.total), cents(row.tax_amount), cents(row.deposit_credit), row.not_charged ? 1 : 0,
    sort(charges.map((charge) => [charge.id, charge.amount, charge.left ? 1 : 0])), sort(discounts.map((discount) => [discount.target, discount.amount])),
    sort((list || []).map((member) => [String(member.id), member.weight == null ? null : Number(member.weight)])),
  ];
}

function invoiceShare(row, members) {
  const priced = visitPreTaxCents(row);
  const refunded = cents(row.refunded) || 0;
  if (priced.none) return { skipped: true };
  if (priced.unclear) return { unallocated: refunded, reason: priced.unclear };
  if (members.length <= 1) {
    return { billed: new Map([[row.visit_id, priced.cents]]), refunded: new Map([[row.visit_id, refunded]]), total: priced.cents, members: members.length ? members : [{ id: row.visit_id, weight: 0 }] };
  }
  const parts = allocateCents(priced.cents, members);
  return parts ? { billed: parts, refunded: allocateCents(refunded, members), total: priced.cents, members }
    : { unallocated: refunded, reason: UNALLOCATED_REASON, total: priced.cents, members };
}

/**
 * What each visit was BILLED, before sales tax, and what was refunded on it, from the invoices linked to the visit by the
 * links the rate review reads (rate-review.js VISIT_INVOICE_LINK_SQL: direct, through the service record, the combined
 * first-application invoice, a completion packet). An unpaid invoice counts: the credit is the price charged, and a later
 * fee change never moves it. An invoice shared by several visits is split across ALL of them in proportion to their visit
 * prices, with the cents settled exactly; when a member has no price the split is unknowable: the visit is flagged with that
 * invoice (`unallocated`, with the invoice's whole refund kept visible) and never priced from the visit instead. Draft and void invoices are no charge. The prepay invoice of an annual term
 * is never attributed here: its refunds go to the term's visits (termRefunds).
 * Returns Map visitId -> { billedCents (null = no invoice named the visit's price), refundCents, unallocated: [{ invoiceId, refundCents }],
 * shares: [{ invoiceId, totalCents, members: [{ id, weight }], shareCents }] for each invoice that priced the visit,
 * invoiceIds: every invoice linked to the visit }.
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
  // Every service record of the visit counts for ownership (an invoice can hang on an earlier one); only the closeout outcome reads
  // the latest. One row per visit and invoice. The links, the invoice amounts and the member visits with their weights are read in ONE
  // statement (one snapshot, even on a READ COMMITTED connection): an invoice edited or relinked while the run reads can never give
  // amounts from one moment and members from another.
  const read = await conn.raw(`
    WITH links AS (
      SELECT DISTINCT s.id AS visit_id, i.id AS invoice_id, i.line_items, i.subtotal, i.discount_amount, i.total, i.tax_amount,
        (COALESCE(i.status = ANY(?::text[]), true) OR i.archived_at IS NOT NULL) AS not_charged,
        ${rr.depositCreditSql('i')} AS deposit_credit,
        ${refundOf} AS refunded
      FROM scheduled_services s
      LEFT JOIN (SELECT scheduled_service_id, id AS service_record_id FROM service_records WHERE scheduled_service_id = ANY(?::uuid[])) sr
        ON sr.scheduled_service_id = s.id
      JOIN invoices i ON ${rr.VISIT_INVOICE_LINK_SQL}
      WHERE s.id = ANY(?::uuid[]) AND i.annual_prepay_term_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM annual_prepay_terms t WHERE t.prepay_invoice_id = i.id)
    ), members AS (
      SELECT i.id AS invoice_id, m.id AS visit_id, COALESCE(m.estimated_price, m.primary_line_price) AS weight
      FROM invoices i
      JOIN LATERAL (
        ${rr.INVOICE_MEMBER_IDS_SQL}
        UNION SELECT i.scheduled_service_id WHERE i.scheduled_service_id IS NOT NULL
        UNION SELECT sr2.scheduled_service_id FROM service_records sr2 WHERE sr2.id = i.service_record_id AND sr2.scheduled_service_id IS NOT NULL
      ) mem ON true
      JOIN scheduled_services m ON m.id = mem.id
      WHERE i.id IN (SELECT invoice_id FROM links)
    )
    SELECT COALESCE((SELECT json_agg(row_to_json(l)) FROM links l), '[]'::json) AS links,
      COALESCE((SELECT json_agg(row_to_json(m)) FROM members m), '[]'::json) AS members`,
  [NOT_CHARGED_INVOICE_STATUSES, visitIds, visitIds]);
  const links = { rows: read.rows[0].links };
  const members = { rows: read.rows[0].members };
  if (!links.rows.length) return out;
  const byInvoice = new Map();
  for (const row of members.rows) {
    if (!byInvoice.has(row.invoice_id)) byInvoice.set(row.invoice_id, []);
    byInvoice.get(row.invoice_id).push({ id: row.visit_id, weight: cents(row.weight) });
  }
  const shares = new Map(); // invoice id -> { billed: Map, refunded: Map } by visit, or { unallocated: refunded cents }
  for (const row of links.rows) {
    if (row.not_charged || shares.has(row.invoice_id)) continue;
    const list = byInvoice.get(row.invoice_id) || [];
    shares.set(row.invoice_id, invoiceShare(row, list));
  }
  for (const row of links.rows) {
    const entry = out.get(row.visit_id) || { billedCents: null, refundCents: 0, unallocated: [], shares: [], invoiceIds: [], invoiceMembers: new Map(), invoiceFacts: [] };
    // Every invoice linked to the visit, whatever it names (a pay run records them with a paid stop: see the INVOICE and PACKAGE rules).
    if (!entry.invoiceIds.includes(row.invoice_id)) entry.invoiceIds.push(row.invoice_id);
    // The visits of that invoice, charged or not (the stop's related ids: see relatedIdsOf).
    entry.invoiceMembers.set(row.invoice_id, (byInvoice.get(row.invoice_id) || []).map((member) => member.id));
    // The lines, discounts, amounts and member weights of every linked invoice, split or not, charged or not (the stop's revision).
    entry.invoiceFacts.push([row.invoice_id, invoiceLineFacts(row, byInvoice.get(row.invoice_id))]);
    out.set(row.visit_id, entry);
    if (row.not_charged) continue;
    const share = shares.get(row.invoice_id);
    if (share.skipped) continue;
    if (share.unallocated !== undefined) entry.unallocated.push({ invoiceId: row.invoice_id, refundCents: share.unallocated, reason: share.reason, totalCents: share.total, members: share.members });
    else if (share.billed.has(row.visit_id)) {
      entry.billedCents = (entry.billedCents || 0) + share.billed.get(row.visit_id);
      entry.refundCents += (share.refunded && share.refunded.get(row.visit_id)) || 0;
      // What the rules need of the invoice (see CREDIT RULES): its whole priced amount, its member visits, and the share billed here.
      entry.shares.push({ invoiceId: row.invoice_id, totalCents: share.total, members: share.members, shareCents: share.billed.get(row.visit_id) });
    }
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
  const termIds = [...new Set(stops.filter(isAnnualPrepayStamp).filter((stop) => stop.annual_prepay_term_id).map((stop) => stop.annual_prepay_term_id))];
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
    const stamped = await conn('scheduled_services').where({ annual_prepay_term_id: term.id, prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD })
      .where('prepaid_amount', '>', 0).select('id', 'prepaid_amount');
    const parts = allocateCents(refunded, stamped.map((row) => ({ id: row.id, weight: cents(row.prepaid_amount) })));
    if (!parts) continue;
    for (const stop of stops) if (parts.has(stop.id)) out.set(stop.id, parts.get(stop.id));
  }
  return out;
}

// The annual prepay payment stamp of a visit (the stamp annual-prepay-renewals.js writes: prepaid_method + the slice). It, not the
// term link, says a visit was paid by an annual prepay: a visit detached from its term keeps the stamp, and a term-linked visit
// can carry a separate cash/Zelle prepayment (a different prepaid_method), which is not annual prepay.
const isAnnualPrepayStamp = (visit) => visit.prepaid_method === ANNUAL_PREPAY_PREPAID_METHOD && Number(visit.prepaid_amount) > 0;

// The credit of one stop: { kind, creditCents, reason, needsReview }. A stop that cannot be credited with certainty is $0
// and needsReview, never a guess.
const credited = (kind, creditCents, reason) => ({ kind, creditCents, reason, needsReview: false });
const toReview = (kind, reason) => ({ kind, creditCents: 0, reason, needsReview: true });

const UNALLOCATED_REASON = 'A shared invoice covers this visit and cannot be split across its visits (a visit on it has no price).';

// The job price is what the first visit was billed (its invoice, before tax), else its own price, split across the visits the
// job was SOLD with: two for a two-treatment package (typed-followup-obligation.js), never the visits booked so far, so a
// missing or replaced follow-up never moves a credit. A job whose sold count cannot be established is listed for review.
function jobCredit(stop, job, billed) {
  if (job.broken) return toReview('multi_visit_job', 'An included follow-up whose first visit cannot be found. Link it to its job.');
  const sold = TWO_TREATMENT_PACKAGE_KEYS.has(job.root.service_key) ? 2 : null;
  if (!sold) return toReview('multi_visit_job', 'The number of visits this job was sold with cannot be established (only the two-treatment packages are known).');
  const invoiced = billed.get(job.root.id);
  // An invoice that cannot be split across its visits for a reason that is not "a member has no price" (a discount tied to no line) stays
  // a review row. One that only has a member without a price is no obstacle here: a package takes the invoice's whole amount.
  const unclear = invoiced && invoiced.unallocated.find((one) => !one.members);
  if (unclear) return toReview('multi_visit_job', unclear.reason);
  // A package priced on an invoice that other visits (outside the job) share cannot be credited by rule: its price is one slice of a
  // split that moves with those visits. Every visit of it is $0 + needs review, and the owner sets the credit in the preview.
  const inJob = new Set([job.root.id, ...job.planned]);
  const onInvoices = [...invoiceSharesOf(invoiced), ...((invoiced && invoiced.unallocated) || [])];
  if (onInvoices.some((one) => one.members.some((member) => !inJob.has(member.id)))) {
    return toReview('multi_visit_job', 'The package is priced on an invoice shared with other visits: set its credit in the production share preview.');
  }
  // An invoice linked only to visits of the package IS the package price, once: its whole amount, not the root's share of it.
  const price = onInvoices.length ? onInvoices.reduce((sum, one) => sum + one.totalCents, 0)
    : invoiced && invoiced.billedCents !== null ? invoiced.billedCents : cents(job.root.estimated_price);
  const nth = job.planned.indexOf(stop.id) + 1;
  if (nth < 1 || nth > sold || job.planned.length > sold) return toReview('multi_visit_job', "This visit is not among the job's sold visits.");
  // What the package rule needs of the job (CREDIT RULES): its price, sold count, this visit's slot and the package's visits. A live
  // price that is missing is NOT decided here: once a pay run fixed the package's total, a follow-up credits from that total whatever the
  // root is priced at now (applyLedger); with nothing fixed yet, no price is a review row there.
  return {
    ...credited('multi_visit_job', price > 0 ? jobPartCents(price, sold, nth) : 0, `Part ${nth} of ${sold} of the job price`),
    job: { rootId: job.root.id, price, sold, nth, visits: [job.root.id, ...job.planned] },
  };
}

async function callbackCredit(conn, stop, technicianId, inForce) {
  if (stop.line === 'other') return toReview('callback_review', 'A callback whose service line is unknown, so its original work cannot be found.');
  const found = await originalWork(conn, stop);
  if (found.review) return toReview('callback_review', found.review);
  const original = found.original;
  if (!original) return toReview('callback_review', 'No earlier completed work of the same line at this property.');
  // The original work's id rides with every answer past this point: it is one of the pricing facts a credit set by the owner is checked against.
  const withOriginal = (credit) => ({ ...credit, originalId: original.id });
  if (!original.technician_id) return withOriginal(toReview('callback_review', 'The original work has no technician on file.'));
  if (canonicalId(original.technician_id) === canonicalId(technicianId)) {
    const age = daysBetween(original.work_date, stop.work_date);
    return withOriginal(age <= OWN_CALLBACK_DAYS
      ? credited('callback_own', 0, `Callback on own work, ${age} days after it`)
      : toReview('callback_review', `Callback on own work ${age} days after it. The Terms cover 30 days only.`));
  }
  if (!inForce) return withOriginal(toReview('callback_review', "A callback on another technician's work, and no production share setting is on file."));
  return withOriginal(credited('callback_other', inForce.callbackStopValueCents, "Callback on another technician's work"));
}

function ownPriceCredit(stop, invoiced) {
  if (isAlwaysFreeServiceType(stop.service_type)) return credited('free_visit', 0, 'A visit type that is always free');
  if (isAnnualPrepayStamp(stop)) {
    // The stamp is the credit; a stamp with no term left cannot be traced to its prepay invoice, so its refunds could not be found.
    if (!stop.annual_prepay_term_id) return toReview('prepaid_plan', 'The visit carries an annual prepay stamp but no term, so its prepay invoice and refunds cannot be traced.');
    return credited('prepaid_plan', cents(stop.prepaid_amount), "The prepaid plan's value for one visit");
  }
  if (invoiced && invoiced.unallocated.length) return toReview('unpriced', invoiced.unallocated[0].reason);
  // What the visit's invoice charged, before tax, whether or not it is paid; a fee change later never moves it.
  if (invoiced && invoiced.billedCents !== null) {
    // `invoiceBased`: an invoice priced this credit (also at $0 after the split), so the credit ledger follows it (see ledgerOf).
    if (invoiced.billedCents > 0) return { ...credited('priced', invoiced.billedCents, "Pre-tax amount of the visit's invoice"), invoiceBased: true };
    return isConsultationServiceType(stop.service_type)
      ? { ...credited('free_assessment', 0, 'A free assessment'), invoiceBased: true }
      : { ...credited('free_visit', 0, "The visit's invoice charges $0"), invoiceBased: true };
  }
  // No invoice names the price: the price recorded on the visit itself. Never today's fee for the customer (the per-application
  // fee and the monthly dues are CURRENT settings: raising a fee must not move a past week's credit), so those are left out.
  const amount = cents(completionInvoiceAmount({
    estimatedPrice: stop.estimated_price,
    isCallback: false,
    perApplicationBilling: false, // the account's current per-application fee is not a price recorded for this visit
    perApplicationFee: 0,
    monthlyRate: 0, // see the review map: a month of dues is not one visit's price
    billingMode: stop.billing_mode,
    primaryLinePrice: stop.primary_line_price,
    serviceType: stop.service_type,
  }));
  if (amount > 0) return credited('priced', amount, 'Price of the visit, before sales tax');
  if (isConsultationServiceType(stop.service_type)) return credited('free_assessment', 0, 'A free assessment');
  if (hasAuthoritativeZeroPrice(stop.estimated_price, stop.primary_line_price)) return credited('free_visit', 0, 'The visit is priced at $0');
  return toReview('unpriced', 'No price was recorded for this visit (no invoice, no stamp, no visit price), and today\'s fee is never used for past work.');
}

/**
 * The completed route stops of the technicians in `technicianIds` in a pay week (Monday `weekStart` to Sunday), in ONE statement,
 * so a single snapshot decides who holds each stop (a stop reassigned between two statements can never be missed by both
 * technicians or counted by both). Rows carry technician_id; work-date order.
 */
async function weekStops(conn, technicianIds, weekStart) {
  requireWeek(weekStart);
  const weekEnd = addStaffWorkDays(weekStart, 6);
  const { LINE_SQL } = require('./rate-review').PLAN_LINE_SQL;
  if (!technicianIds.length) return [];
  return conn('scheduled_services as s')
    .leftJoin('services as sv', 'sv.id', 's.service_id')
    .leftJoin('customers as c', 'c.id', 's.customer_id')
    .leftJoin('customer_properties as cp', 'cp.id', 's.property_id')
    .joinRaw(RECORD_JOIN_SQL)
    .whereIn('s.technician_id', technicianIds).where({ 's.status': 'completed' })
    .whereRaw(`${WORK_DATE_SQL} BETWEEN ? AND ?`, [weekStart, weekEnd])
    .select('s.id', 's.technician_id', 's.customer_id', 's.property_id', 's.service_type', 's.estimated_price', 's.primary_line_price',
      's.is_callback', 's.followup_included', 's.followup_source_service_id', 's.annual_prepay_term_id', 's.prepaid_amount',
      's.prepaid_method', 's.service_key_snapshot', 's.completed_at', 's.service_address_line1', 's.service_address_line2',
      's.service_address_zip', 'sv.service_key', 'sv.name as service_name', 'cp.address_line1 as prop_line1',
      'cp.address_line2 as prop_line2', 'cp.zip as prop_zip', 'rec.record_status', 'rec.record_notes',
      'c.billing_mode',
      conn.raw(`to_char(${WORK_DATE_SQL}, 'YYYY-MM-DD') AS work_date`), conn.raw("to_char(s.scheduled_date, 'YYYY-MM-DD') AS scheduled_day"), conn.raw(`${LINE_SQL} AS line`))
    .orderByRaw(`${WORK_DATE_SQL}, s.completed_at NULLS LAST, s.id`);
}

/*
 * CREDIT RULES. What finalized pay runs already paid decides what a later week may credit. A stop row of a check that paid a share above
 * $0 records the invoice ids linked to its visit at the time, whatever priced its credit (stops[].invoices), and, for a package visit,
 * { basisType: 'job', basisId: root, totalCents, sold, slot } (stops[].bases). In every other week:
 *   ALREADY PAID  a visit already credited on such a check is already_paid ($0 + review).
 *   INVOICE       a stop priced from an invoice that is now linked to ANY visit already credited on such a check of another week (a
 *                 visit that is one of its members, or a paid row that recorded the invoice, so a late invoice or a relink is caught)
 *                 is $0 + review: "set its credit in the production share preview". An invoice shared only by visits of THIS week splits live, as always.
 *   PACKAGE       a package's total is FIXED at its first paid row (root visit, total, sold count, slot). A later visit credits
 *                 jobPartCents(fixed total, sold, its slot); a slot already paid or past the sold count is $0 + review. A package
 *                 priced on an invoice that visits OUTSIDE it also share is review for every visit (jobCredit); an invoice linked only
 *                 to the package's own visits is the package price once (its whole amount).
 * A review row stays a review row. Voiding the paying run takes its checks out of the queries, so everything is released.
 */

// The invoice shares behind a billedByVisit entry that priced a visit: [{ invoiceId, totalCents, members, shareCents }].
const invoiceSharesOf = (entry) => (entry && entry.billedCents !== null && entry.billedCents !== undefined ? entry.shares || [] : []);

// What the rules need of a credit (applyLedger); null for a credit that no invoice or package priced (own price, prepaid slice, callback
// value, free visit type, a review row). `invoices`: the invoices that priced the visit, with their member visits (the INVOICE rule,
// also when the live share rounded to $0). `job`: the job part's price, sold count and slot (the PACKAGE rule).
function ledgerOf(credit, invoiced) {
  if (credit.needsReview) return null;
  if (credit.job) return { job: credit.job };
  if (!credit.invoiceBased) return null;
  const invoices = invoiceSharesOf(invoiced).map((one) => ({ invoiceId: one.invoiceId, members: one.members }));
  return invoices.length ? { invoices } : null;
}

// Every invoice linked to the visit, and, for a package visit, to its root (the package's price came from there): recorded with a paid
// stop row, whatever priced its credit, so a late invoice or a relink to another visit is caught later (the INVOICE rule).
function linkedInvoicesOf(invoiced, job, billed) {
  const ids = new Set((invoiced && invoiced.invoiceIds) || []);
  if (job && job.root) for (const id of (billed.get(job.root.id) || {}).invoiceIds || []) ids.add(id);
  return [...ids].sort();
}

/**
 * Everything the credit rows of a set of stops need that is shared by their visits: follow-ups, jobs, what the invoices billed and
 * the prepaid refunds. Read ONCE for any number of technicians' stops (every read is keyed by visit id), so two technicians whose
 * visits share an invoice or a job always see the same invoice amounts and the same split.
 */
async function loadCreditFacts(conn, stops) {
  const withFollowUp = stops.length
    ? await conn('scheduled_services').whereIn('followup_source_service_id', stops.map((stop) => stop.id))
      .where({ followup_included: true }).whereNotIn('status', UNPLANNED_STATUSES).pluck('followup_source_service_id')
    : [];
  const hasFollowUp = new Set(withFollowUp);
  const jobCache = new Map();
  const jobs = new Map();
  for (const stop of stops) jobs.set(stop.id, await jobOf(conn, stop, hasFollowUp, jobCache));
  // The stops, and every visit of their packages (root and siblings): the related ids of a stop reach the invoices of all of them.
  const billed = await billedByVisit(conn, [...new Set([...stops.map((stop) => stop.id),
    ...[...jobs.values()].filter((job) => job && job.root).flatMap((job) => [job.root.id, ...job.planned])])]);
  return { jobs, billed, prepaidRefunds: await termRefunds(conn, stops), signals: await refunds.refundSourcesOf(conn, stops.map((stop) => stop.id)) };
}

// What a visit was billed, as plain sorted data: the amounts and the visits and weights of each invoice, so a price edited, a visit added to
// an invoice or a weight changed after the owner opened the stop shows in its revision.
function billedFactsOf(entry) {
  if (!entry) return null;
  const members = (list) => (list || []).map((member) => [String(member.id), member.weight == null ? null : Number(member.weight)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return [
    entry.billedCents, entry.refundCents,
    (entry.shares || []).map((one) => [one.invoiceId, one.totalCents, one.shareCents, members(one.members)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    (entry.unallocated || []).map((one) => [one.invoiceId, one.totalCents == null ? null : one.totalCents, one.refundCents, members(one.members)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    [...(entry.invoiceFacts || [])].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  ];
}

// Every input the credit of a stop is worked out from beyond its kind: its own prices and billing, and for a package visit the root's
// price and billing, the visits it was sold with and the planned visits.
function pricingFactsOf(stop, job, billed) {
  return [
    String(stop.estimated_price ?? ''), String(stop.primary_line_price ?? ''), String(stop.prepaid_amount ?? ''),
    billedFactsOf(billed.get(stop.id)),
    job && job.root ? [job.root.id, String(job.root.estimated_price ?? ''), TWO_TREATMENT_PACKAGE_KEYS.has(job.root.service_key) ? 2 : null, [...(job.planned || [])], billedFactsOf(billed.get(job.root.id))] : null,
  ];
}

// Everything a paid row elsewhere could touch this stop through: the stop, its package root and every sibling visit, every invoice linked to
// any of those (charged or not), and every visit on those invoices. Kept on EVERY row, review rows included.
function relatedIdsOf(stop, job, billed) {
  const visits = new Set([stop.id]);
  if (job && job.root) { visits.add(job.root.id); for (const id of job.planned || []) visits.add(id); }
  const ids = new Set(visits);
  for (const id of visits) {
    const entry = billed.get(id);
    for (const invoiceId of (entry && entry.invoiceIds) || []) {
      ids.add(invoiceId);
      for (const member of entry.invoiceMembers.get(invoiceId) || []) ids.add(member);
    }
  }
  return [...ids].sort();
}

// The package slot of a package visit, review rows too: an owner-set credit keeps it as a job basis (applyLedger, slotBasis). null for a
// visit that is not in a package, or that is no longer one of its planned visits.
function packageSlotOf(stop, job, callback, credit) {
  if (!(job && job.root && job.planned && job.planned.includes(stop.id) && (stop.followup_included || !callback))) return null;
  return {
    rootId: job.root.id, slot: job.planned.indexOf(stop.id) + 1, visits: [...job.planned],
    sold: TWO_TREATMENT_PACKAGE_KEYS.has(job.root.service_key) ? 2 : null, price: credit.job ? credit.job.price : null,
  };
}

/**
 * The credit rows of ONE technician's stops (weekStops rows): { visitId, workDate, kind, creditCents, reason, needsReview,
 * refundCents, serviceType, bases } in the stops' order. `inForce` = the settings in force for the week (the callback value comes
 * from them). `facts` = loadCreditFacts of a wider set of stops (the pay run reads them once for everyone); read here when not given.
 */
async function creditsOfStops(conn, technicianId, stops, inForce, facts = null) {
  const { jobs, billed, prepaidRefunds, signals } = facts || await loadCreditFacts(conn, stops);

  const rows = [];
  for (const stop of stops) {
    const callback = isCallbackVisit(stop);
    const job = jobs.get(stop.id);
    let credit;
    const performed = performedState(stop);
    // Whether any work was done comes first: a stop closed out incomplete, declined or inspection only earns nothing, and a
    // stop with no completion record cannot be credited with certainty.
    if (performed === 'no') credit = credited('not_performed', 0, 'The visit was closed out with no work performed (incomplete, declined or inspection only).');
    else if (performed === 'unknown') credit = toReview('unverified', 'The visit has no completed closeout record, so it cannot be known that the work was done.');
    // An included follow-up (even of a re-service type) and the first visit of a job are parts of the job; any other callback is
    // judged by the work it follows.
    else if (job && (stop.followup_included || !callback)) credit = jobCredit(stop, job, billed);
    else if (callback) credit = await callbackCredit(conn, stop, technicianId, inForce);
    else credit = ownPriceCredit(stop, billed.get(stop.id));
    const invoiced = billed.get(stop.id) || {};
    const refundSource = (signals && signals.get(canonicalId(stop.id))) || { signals: [], invoiceIds: [] };
    // The package slot of a package visit, review rows too: an owner-set credit keeps it as a job basis (applyLedger, withOverride).
    const packageSlot = packageSlotOf(stop, job, callback, credit);
    const shown = { ...credit };
    delete shown.originalId;
    delete shown.job;
    delete shown.invoiceBased;
    rows.push({
      visitId: stop.id, workDate: stop.work_date, serviceType: stop.service_type, technicianId: canonicalId(technicianId),
      // So the owner can find the visit behind a review row (the preview only; never stored with a check).
      scheduledDate: stop.scheduled_day || null, address: addressLine(stop), completedAt: stop.completed_at ? new Date(stop.completed_at).toISOString() : null, ...shown,
      refundCents: (invoiced.refundCents || 0) + (prepaidRefunds.get(stop.id) || 0),
      // Every sign of a refund on the visit's invoices (production-share-refunds.js), sorted: a stop with any is flagged in applyLedger.
      refundSignals: refundSource.signals,
      // The invoice ids behind them (live links, a package's, an annual term's prepay invoice): frozen with a paid stop, so a deleted visit or a
      // relinked invoice still asks about a later refund (snapshot stops[].refundInvoices).
      refundInvoices: refundSource.invoiceIds,
      // Refunds on a shared invoice that cannot be split across its visits: the invoice's whole refund, kept visible.
      unallocatedRefunds: invoiced.unallocated || [],
      ledger: ledgerOf(credit, invoiced),
      packageSlot,
      // The pricing facts the owner's credit is checked against under the lock (applyLedger, stopRevision).
      pricing: { serviceType: stop.service_type || null, originalId: credit.originalId || null, facts: pricingFactsOf(stop, job, billed) },
      related: relatedIdsOf(stop, job, billed),
      linkedInvoices: linkedInvoicesOf(invoiced, job, billed),
    });
  }
  return rows;
}

// The stop rows of finalized checks of finalized runs that PAID a share above $0, in a week other than the one being worked out, with
// a credit above $0: the record every later week reads (calc_snapshot.productionShare.stops). The week is bound first.
const PAID_FROM_SQL = `FROM payroll_checks c
    JOIN payroll_runs r ON r.id = c.run_id
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.calc_snapshot->'productionShare'->'stops') = 'array'
      THEN c.calc_snapshot->'productionShare'->'stops' ELSE '[]'::jsonb END) AS stop(value)
    WHERE c.status = 'finalized' AND r.status = 'finalized' AND c.week_start <> ?::date
      AND COALESCE(c.production_share_cents, 0) > 0
      AND COALESCE((stop.value->>'creditCents')::bigint, 0) > 0`;
const STOP_BASES_SQL = `CASE WHEN jsonb_typeof(stop.value->'bases') = 'array' THEN stop.value->'bases' ELSE '[]'::jsonb END`;
const STOP_INVOICES_SQL = `CASE WHEN jsonb_typeof(stop.value->'invoices') = 'array' THEN stop.value->'invoices' ELSE '[]'::jsonb END`;

/**
 * What finalized pay runs already paid, for the rules (CREDIT RULES above). `visitIds`: this week's visits, the roots of their
 * packages and the member visits of the invoices they were priced from; `invoiceIds`: those invoices; `rootIds`: those roots.
 * Reads the paid stop rows that name one of the visits, record one of the invoices, or carry a package of one of the roots, whoever
 * the technician was. Returns
 *   visits:    Map visit id -> { weekStart, root } of the first paid row of that visit (root: its package, null when paid on its own);
 *   invoices:  Map invoice id -> [{ weekStart, visitId, root }] for every paid row that recorded it, earliest first;
 *   jobs:      Map root id -> { totalCents, sold, weekStart, slots: Map slot -> visit id }: the total and the sold count are the FIRST
 *              paid row's (they are fixed there), the slots are those of every paid row.
 * Voiding the paying run takes its checks out of the query. One query.
 */
async function paidLedger(conn, visitIds, invoiceIds, rootIds, weekStart) {
  const ledger = { visits: new Map(), invoices: new Map(), jobs: new Map(), rows: [] };
  if (!visitIds.length && !invoiceIds.length && !rootIds.length) return ledger;
  const wanted = new Set(visitIds);
  const rows = (await conn.raw(`SELECT c.id AS check_id, r.id AS run_id, stop.value->>'visitId' AS visit_id, to_char(c.week_start, 'YYYY-MM-DD') AS week_start,
      ${STOP_INVOICES_SQL} AS invoices, ${STOP_BASES_SQL} AS bases
    ${PAID_FROM_SQL}
      AND (stop.value->>'visitId' = ANY(?::text[])
        OR jsonb_exists_any(${STOP_INVOICES_SQL}, ?::text[])
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(${STOP_BASES_SQL}) b
          WHERE b.value->>'basisType' = 'job' AND b.value->>'basisId' = ANY(?::text[])))
    ORDER BY c.week_start, c.id`, [weekStart, visitIds, invoiceIds, rootIds])).rows;
  const roots = new Set(rootIds);
  for (const row of rows) {
    // Every paid stop row that touches what was asked for, whole (the conflict state of a stop hashes them all).
    ledger.rows.push({ runId: row.run_id, weekStart: row.week_start, visitId: row.visit_id, invoices: row.invoices, bases: row.bases });
    // The package a paid row belonged to (null: it was paid on its own, with no package basis).
    const root = (row.bases.find((basis) => basis.basisType === 'job') || {}).basisId || null;
    if (wanted.has(row.visit_id) && !ledger.visits.has(row.visit_id)) ledger.visits.set(row.visit_id, { weekStart: row.week_start, root, runId: row.run_id });
    for (const id of row.invoices) {
      if (!ledger.invoices.has(id)) ledger.invoices.set(id, []);
      ledger.invoices.get(id).push({ weekStart: row.week_start, visitId: row.visit_id, root, runId: row.run_id });
    }
    for (const basis of row.bases) {
      if (basis.basisType !== 'job' || !roots.has(basis.basisId)) continue;
      const job = ledger.jobs.get(basis.basisId) || { totalCents: null, sold: null, weekStart: row.week_start, slots: new Map(), slotRuns: new Map(), totalRunId: null };
      // The total and sold count are fixed by the first row that knows them (an owner-set credit may record a slot with neither).
      if (job.totalCents == null && basis.totalCents != null) { job.totalCents = Number(basis.totalCents); job.sold = basis.sold == null ? job.sold : Number(basis.sold); job.totalRunId = row.run_id; }
      if (job.sold == null && basis.sold != null) job.sold = Number(basis.sold);
      job.slots.set(Number(basis.slot), row.visit_id);
      job.slotRuns.set(Number(basis.slot), row.run_id);
      ledger.jobs.set(basis.basisId, job);
    }
  }
  return ledger;
}

const REFUND_FLAGGED_REASON = 'A refund is recorded on this visit. Set its credit in the production share preview.';

// A stop that would credit above $0 and has a refund signal is $0 and needs review until the owner sets its credit (production-share-refunds.js).
// A stop that is already review, $0 or already paid keeps its own answer; its signals still ride in the conflict tuples.
function flagRefund(row, result) {
  const flagged = (row.refundSignals || []).length > 0 && !result.needsReview && result.creditCents > 0 && result.kind !== 'already_paid';
  if (!flagged) return result;
  // $0 uses no package slot (a review row records none until the owner sets its credit).
  return { ...result, bases: [], ...toReview('refund_flagged', REFUND_FLAGGED_REASON) };
}

// A stop whose work was not done or not confirmed, or that a pay run paid: never credited by the owner's hand (saving a credit refuses
// it, and an earlier credit is ignored when the stop turns into one).
const MANUAL_CREDIT_INELIGIBLE = new Set(['not_performed', 'unverified', 'already_paid']);

const alreadyPaid = (row, week) => ({ ...row, ...toReview('already_paid', `Already paid in the week of ${week}: a pay run already credited this visit.`) });
const review = (row, kind, reason) => ({ ...row, ...toReview(kind, reason) });
// A review row that also names the runs whose paid rows decided it (dependsOnRuns).
const reviewFrom = (row, kind, reason, runs) => ({ ...review(row, kind, reason), dependsOnRuns: [...new Set(runs.filter(Boolean))].sort() });

/**
 * The credit rows of a pay week through the rules (CREDIT RULES above). `paid` = paidLedger. Pure. Every row comes back with `invoices`
 * (the invoice ids linked to its visit, when it credits above $0) and `bases` (a package visit's { basisType: 'job', basisId,
 * totalCents, sold, slot }), and without the working fields.
 */
function applyLedger(rows, paid, overrides = new Map()) {
  return rows.map((row) => {
    const tuples = conflictTuplesOf(row);
    const base = flagRefund(row, settle(row));
    // The owner's credit for this stop and week (stop override) replaces whatever the rules computed, review rows included (a visit a pay
    // run already paid stays already paid). The invoices linked to the visit are still recorded with a paid row, so a later week of
    // another visit of them is caught.
    const done = overrides.has(row.visitId) && base.kind !== 'already_paid' ? withOverride(row, overrides.get(row.visitId), tuples) : base;
    const clean = {
      ...done,
      // What the page is shown of a stop, for the owner's credit to be checked against under the lock: the conflict tuples, and a revision
      // of the stop as the RULES see it (their kind, never the owner's credit).
      conflictTuples: tuples, stopRevision: stopRevisionOf(row, base.kind, tuples), dependsOnRuns: done.dependsOnRuns || [],
      invoices: done.creditCents > 0 ? done.linkedInvoices || [] : [], bases: done.bases || [],
    };
    delete clean.ledger;
    delete clean.linkedInvoices;
    delete clean.technicianId;
    delete clean.packageSlot;
    delete clean.related;
    delete clean.pricing;
    return clean;
  });

  // The stop as the rules see it (no override): already paid, a package or invoice conflict, or the credit the rules computed.
  function settle(row) {
    if (paid.visits.has(row.visitId)) {
      const was = paid.visits.get(row.visitId);
      return { ...alreadyPaid(row, was.weekStart), dependsOnRuns: [was.runId].filter(Boolean) };
    }
    const { ledger } = row;
    // A visit that was the first visit of a package a pay run fixed is that package's: credited on its own it would be paid twice.
    if (paid.jobs.has(row.visitId) && !(ledger && ledger.job && ledger.job.rootId === row.visitId) && !row.needsReview && row.creditCents > 0) {
      return reviewFrom(row, 'package_paid_elsewhere', 'This visit was the first visit of a package a pay run already credited: set its credit in the production share preview.', [...paid.jobs.get(row.visitId).slotRuns.values()]);
    }
    if (!ledger) return row;
    if (ledger.invoices) return settleInvoice(row, ledger);
    return settlePackage(row, ledger.job);
  }

  // An override belongs to the technician who held the stop when the owner set it, and to a stop whose work is still confirmed.
  function withOverride(row, set, tuples) {
    if (set.technicianId !== row.technicianId) {
      return { ...review(row, 'owner_override_reassigned', 'This stop was reassigned since the owner set its credit: clear that credit, then set it again in the production share preview.'), overrideRevision: set.revision };
    }
    if (MANUAL_CREDIT_INELIGIBLE.has(row.kind)) {
      return { ...review(row, 'owner_override_closeout_changed', 'The closeout of this stop changed since the owner set its credit (its work is no longer confirmed): clear that credit in the production share preview.'), overrideRevision: set.revision };
    }
    // A NEW conflict (an invoice or package of the stop paid elsewhere since the owner set the credit) is checked before the credit is used.
    // The refund signals are compared by EQUALITY (a new one, or one the owner saw that is gone, puts his credit aside); every other
    // conflict tuple (a paid row elsewhere) only by what is new.
    const isRefund = (tuple) => tuple.startsWith('refund:');
    const [storedRefunds, nowRefunds] = [(set.conflictTuples || []).filter(isRefund), tuples.filter(isRefund)];
    const newRefund = nowRefunds.some((tuple) => !storedRefunds.includes(tuple));
    if (newRefund || storedRefunds.some((tuple) => !nowRefunds.includes(tuple))) {
      const reason = newRefund
        ? 'A new refund is recorded on this visit since the owner set its credit: clear that credit, then set it again in the production share preview.'
        : 'A refund the owner saw on this visit is gone since he set its credit: clear that credit, then set it again in the production share preview.';
      return { ...review(row, 'owner_override_refund_changed', reason), overrideRevision: set.revision, dependsOnRuns: dependsOnRunsOf(row) };
    }
    const added = tuples.filter((tuple) => !(set.conflictTuples || []).includes(tuple));
    if (added.length) {
      return { ...review(row, 'owner_override_conflict_changed', 'This stop, its invoice or its package was paid elsewhere since the owner set its credit: clear that credit and look at the stop again in the production share preview.'), overrideRevision: set.revision, dependsOnRuns: dependsOnRunsOf(row) };
    }
    return { ...row, kind: 'owner_set', creditCents: set.creditCents, reason: `Set by the owner: ${set.reason}`, needsReview: false, ledger: null, bases: slotBasis(row), overrideRevision: set.revision, dependsOnRuns: dependsOnRunsOf(row) };
  }

  // The conflict state of a stop, ONE rule: EVERY paid stop row (finalized, non-void, a share above $0, another week) that touches what
  // the stop is related to (row.related: itself, its package root and siblings, every invoice linked to any of those, every visit on
  // those invoices), whole: run, week, visit, the invoice ids it recorded and its package basis, as a sorted list of strings. The credit
  // the owner sets stores the list; a run ignores the credit when a tuple that is NOT in the stored list shows later.
  // The paid stop rows of other weeks that touch the stop (what it depends on).
  function touchingRows(row) {
    const related = new Set(row.related || []);
    if (!related.size) return [];
    return (paid.rows || []).filter((one) => related.has(one.visitId) || one.invoices.some((id) => related.has(id)) || one.bases.some((basis) => related.has(basis.basisId)));
  }

  // The runs those rows belong to: voiding one of them would change this stop's credit (productionShare snapshot dependsOnRuns).
  function dependsOnRunsOf(row) {
    return [...new Set(touchingRows(row).map((one) => one.runId))].sort();
  }

  // The refund signals of the stop are conflict state too: an override set before a new signal appeared is no longer used (the subset
  // rule of withOverride reports owner_override_refund_changed), and the stop's revision moves with them.
  function conflictTuplesOf(row) {
    return [...new Set([...touchingRows(row)
      .map((one) => JSON.stringify([one.runId, one.weekStart, one.visitId, [...one.invoices].sort(),
        one.bases.map((basis) => [basis.basisType, basis.basisId, basis.slot]).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))])),
    ...(row.refundSignals || []).map((id) => `refund:${id}`)])].sort();
  }

  // A short revision of the stop as the rules see it: their kind, the visit, its pricing facts (service type, the original work of a
  // callback, the invoices linked to it, its package root and slot) and the conflict tuples. The page sends it with the owner's credit.
  function stopRevisionOf(row, baseKind, tuples) {
    const at = row.packageSlot;
    return require('node:crypto').createHash('sha1').update(JSON.stringify([
      baseKind, row.visitId, (row.pricing || {}).serviceType || null, (row.pricing || {}).originalId || null, (row.pricing || {}).facts || null,
      [...(row.linkedInvoices || [])].sort(), at ? [at.rootId, at.slot] : null, tuples,
    ])).digest('hex').slice(0, 16);
  }

  // A package visit credited by the owner still consumes its slot of the package: a job basis with the package root and the slot, and the
  // total only when a pay run or the live price fixed one (null = unknown), so a replacement follow-up cannot take the slot again.
  function slotBasis(row) {
    const at = row.packageSlot;
    if (!at || !(at.slot >= 1)) return [];
    const was = paid.jobs.get(at.rootId);
    const total = was && was.totalCents != null ? was.totalCents : (at.price > 0 ? at.price : null);
    return [{ basisType: 'job', basisId: at.rootId, totalCents: total, sold: was && was.sold != null ? was.sold : at.sold, slot: at.slot }];
  }

  function settleInvoice(row, ledger) {
    // The paid rows the verdict rests on: a row that recorded one of the invoices, or a member visit of them already paid.
    const entries = ledger.invoices.flatMap((inv) => [
      ...(paid.invoices.get(inv.invoiceId) || []),
      ...inv.members.map((member) => paid.visits.get(member.id)),
    ]).filter(Boolean);
    const weeks = entries.map((one) => one.weekStart).sort();
    if (weeks.length) return reviewFrom(row, 'invoice_paid_elsewhere', `This invoice also covers a visit paid in the week of ${weeks[0]}: set its credit in the production share preview.`, entries.map((one) => one.runId));
    // A visit of the invoice that was the first visit of a package a pay run fixed: the invoice is that package's, shared with this stop.
    const packages = ledger.invoices.flatMap((inv) => inv.members.map((member) => paid.jobs.get(member.id))).filter(Boolean);
    if (packages.length) {
      const packageWeek = packages.map((one) => one.weekStart).sort()[0];
      return reviewFrom(row, 'package_paid_elsewhere', `This invoice also covers the first visit of a package credited in the week of ${packageWeek}: set its credit in the production share preview.`, packages.flatMap((one) => [...one.slotRuns.values()]));
    }
    return row;
  }

  function settlePackage(row, job) {
    // A package that was, or whose invoice was, credited OUTSIDE it is not credited again: a visit of it paid on its own (no package
    // basis, or another package's), or an invoice linked to it that a paid row of another package or of no package recorded. Reusing the
    // invoice is only for a remaining slot of THIS package (the same root basis).
    const outsides = [
      ...job.visits.map((id) => paid.visits.get(id)),
      ...(row.linkedInvoices || []).flatMap((id) => paid.invoices.get(id) || []),
    ].filter((one) => one && one.root !== job.rootId);
    const outside = [...outsides].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1))[0];
    if (outside) return reviewFrom(row, 'package_paid_elsewhere', `This package, or its invoice, was already credited outside the package in the week of ${outside.weekStart}: set its credit in the production share preview.`, outsides.map((one) => one.runId));
    const was = paid.jobs.get(job.rootId);
    if (!was) {
      if (!(job.price > 0)) return review(row, 'multi_visit_job', "The job's first visit has no price on file.");
      return { ...row, creditCents: jobPartCents(job.price, job.sold, job.nth), bases: [{ basisType: 'job', basisId: job.rootId, totalCents: job.price, sold: job.sold, slot: job.nth }] };
    }
    if (was.totalCents == null) {
      // Only slots were recorded so far (an owner-set credit): no total is fixed yet, so this visit credits from the live price and the
      // sold count, and the slots already taken still cannot be taken again.
      if (was.slots.has(job.nth) || job.nth > job.sold) return reviewFrom(row, 'basis_exhausted', 'This package slot was already credited, or is past the visits the package was sold with: set its credit in the production share preview.', [was.slotRuns.get(job.nth)]);
      if (!(job.price > 0)) return review(row, 'multi_visit_job', "The job's first visit has no price on file.");
      return { ...row, creditCents: jobPartCents(job.price, job.sold, job.nth), bases: [{ basisType: 'job', basisId: job.rootId, totalCents: job.price, sold: job.sold, slot: job.nth }] };
    }
    if (job.nth > was.sold || was.slots.has(job.nth)) {
      return reviewFrom(row, 'basis_exhausted', 'This package slot was already credited, or is past the visits the package was sold with: set its credit in the production share preview.', [was.slotRuns.get(job.nth), was.totalRunId]);
    }
    // Credited from the total a pay run FIXED for the package: that run's row determined this credit.
    return { ...row, creditCents: jobPartCents(was.totalCents, was.sold, job.nth), bases: [{ basisType: 'job', basisId: job.rootId, totalCents: was.totalCents, sold: was.sold, slot: job.nth }], dependsOnRuns: [was.totalRunId].filter(Boolean) };
  }
}

const invoiceIdsOf = (rows) => [...new Set(rows.flatMap((row) => [...(row.related || []), ...(row.ledger && row.ledger.invoices ? row.ledger.invoices.map((inv) => inv.invoiceId) : []), ...(row.linkedInvoices || [])]))];
// Every visit of the week is looked up as a package root too: a visit that is the root of a package a pay run fixed (it may no longer be
// a package) can never take a standalone credit.
const rootIdsOf = (rows) => [...new Set(rows.flatMap((row) => [
  row.visitId,
  ...(row.related || []),
  ...(row.ledger && row.ledger.job ? [row.ledger.job.rootId] : []),
  // The package of a review row too (an owner-set credit on it takes the fixed total, applyLedger slotBasis).
  ...(row.packageSlot ? [row.packageSlot.rootId] : []),
  ...(row.ledger && row.ledger.invoices ? row.ledger.invoices.flatMap((inv) => inv.members.map((member) => member.id)) : []),
]))];
// The visits whose paid state the rules need: this week's, the roots of their packages, and every member visit of the invoices they
// were priced from (so a member paid some other way is known whichever technicians' stops are read together).
const visitIdsOf = (rows) => [...new Set(rows.flatMap((row) => [
  row.visitId,
  ...(row.related || []),
  ...(row.ledger && row.ledger.job ? [row.ledger.job.rootId, ...row.ledger.job.visits] : []),
  // every visit of the package of a review row too (an owner-set credit on it is checked against what was paid outside the package)
  ...(row.packageSlot ? [row.packageSlot.rootId, ...(row.packageSlot.visits || [])] : []),
  ...(row.ledger && row.ledger.invoices ? row.ledger.invoices.flatMap((inv) => inv.members.map((member) => member.id)) : []),
]))];
const paidOf = (conn, rows, weekStart) => paidLedger(conn, visitIdsOf(rows), invoiceIdsOf(rows), rootIdsOf(rows), weekStart);

/**
 * The credit of every route stop the technician completed in a pay week (Monday `weekStart` to Sunday), one row per
 * stop in work-date order: { visitId, workDate, kind, creditCents, reason, needsReview, refundCents, serviceType, bases }.
 * Stops that earn $0 are rows too, because they still make their day a shift. The credit ledger of earlier finalized weeks is
 * applied (applyLedger). `settings` (optional) are the settings in force for the week; read here when not passed (the callback
 * value comes from them).
 */
async function weekCredits(conn, technicianIdIn, weekStart, { settings } = {}) {
  const technicianId = canonicalId(technicianIdIn);
  requireWeek(weekStart);
  const inForce = settings === undefined ? await settingsFor(conn, technicianId, weekStart) : settings;
  const stops = await weekStops(conn, [technicianId], weekStart);
  const rows = await creditsOfStops(conn, technicianId, stops, inForce);
  return applyLedger(rows, await paidOf(conn, rows, weekStart), await overridesOf(conn, weekStart));
}

/**
 * The credit rows of SEVERAL technicians for one pay week: Map of technician id -> { rows } (an id with no stop has an empty
 * list) or { error } for one whose reads failed. `settingsById`: Map of technician id -> the settings in force. The week's stops
 * of all of them are listed in ONE statement (weekStops), so one snapshot decides who holds each stop even on a READ COMMITTED
 * connection, and the invoices, jobs and prepaid refunds behind ALL of them are read ONCE (loadCreditFacts, keyed by visit id): two
 * technicians who share an invoice or a job see the same amounts and the same split, however it is edited meanwhile. Each
 * technician's own reads (a callback's original work) run in a savepoint (a failed read ends there, not the caller's transaction).
 * The ledger is applied to all of them together: one paid-ledger read, and the REMAINING of an invoice or a job shared by two
 * technicians is split once.
 */
async function weekCreditsFor(conn, settingsById, weekStart, { skipOverrides = false, retryPerTechnician = true, refundLedger = true } = {}) {
  requireWeek(weekStart);
  const ids = [...settingsById.keys()].map(canonicalId);
  const stops = await weekStops(conn, ids, weekStart);
  const byTech = new Map(ids.map((id) => [id, []]));
  for (const stop of stops) byTech.get(canonicalId(stop.technician_id)).push(stop);
  const credits = new Map();
  const message = (err) => (err && err.message) || 'unknown problem';
  // The facts behind everyone's stops are read once, together. When that read fails, each technician with stops retries on his own, in
  // a savepoint of the same transaction: only the ones whose own facts cannot be read are errors, and an employee with no stops (or
  // none in the run) never blocks another.
  // The retry is for a draft or a preview. The read under the payroll lock (finalize) passes retryPerTechnician: false: a failed shared
  // read is then an error for every technician, and nothing is frozen from facts read apart. A technician credited from the retry
  // is marked `degraded`, so a draft built from it is never the one a finalize accepts.
  let shared = null;
  let sharedError = null;
  try {
    shared = await conn.transaction((sp) => loadCreditFacts(sp, stops));
  } catch (err) { sharedError = err; }
  for (const id of ids) {
    const own = byTech.get(id);
    try {
      if (!shared && !retryPerTechnician) throw sharedError;
      const facts = shared || await conn.transaction((sp) => loadCreditFacts(sp, own));
      const rows = await conn.transaction((sp) => creditsOfStops(sp, id, own, settingsById.get(id), facts));
      credits.set(id, shared ? { rows } : { rows, degraded: true });
    } catch (err) {
      credits.set(id, { error: message(err) });
    }
  }
  const all = [...credits.values()].flatMap((one) => one.rows || []);
  const done = applyLedger(all, await paidOf(conn, all, weekStart), skipOverrides ? new Map() : await overridesOf(conn, weekStart));
  const byVisit = new Map(done.map((row) => [row.visitId, row]));
  for (const [id, one] of credits) if (one.rows) credits.set(id, { ...one, rows: one.rows.map((row) => byVisit.get(row.visitId)) });
  if (refundLedger) await attachRefundLedger(conn, credits, ids, weekStart, retryPerTechnician, message);
  return credits;
}

/**
 * What the paid weeks ask of this week and what the owner answered (production-share-refunds.js refundLedgerOf), per technician, read in
 * a savepoint so a failed read ends there. Sets takeBackOwed / takeBackToSet / takeBackAnswers on each entry of `credits` that has rows.
 * When the shared read fails, a draft or preview (retryPerTechnician) reads each technician on his own and marks him `degraded` (a draft
 * built from it is never the one a finalize accepts); under the lock (no retry) every technician is an error.
 */
async function attachRefundLedger(conn, credits, ids, weekStart, retryPerTechnician, message) {
  let ledger = null;
  let ledgerError = null;
  try { ledger = await conn.transaction((sp) => refunds.refundLedgerOf(sp, ids, weekStart)); } catch (err) { ledgerError = err; }
  for (const [id, one] of credits) {
    if (!one.rows) continue;
    let mine = ledger && ledger.get(id);
    let degraded = Boolean(one.degraded);
    if (!mine && retryPerTechnician) {
      try { mine = (await conn.transaction((sp) => refunds.refundLedgerOf(sp, [id], weekStart))).get(id); degraded = true; } catch (err) { ledgerError = err; }
    }
    if (!mine) { credits.set(id, { error: message(ledgerError) }); continue; }
    credits.set(id, { ...one, ...(degraded ? { degraded: true } : {}), takeBackOwed: mine.owed, takeBackToSet: mine.toSet, takeBackAnswers: mine.answers });
  }
}

/**
 * The credit rows and refund ledger of one technician for a pay week, from the same grouped read the pay run uses (weekCreditsFor over every W-2
 * technician with settings in force, plus this one): the credits of a basis shared with another technician's stops are split once, so
 * the preview shows what a pay run draws. Throws the read's own error for this technician.
 */
async function weekOfTechnician(conn, technicianId, weekStart, settings, opts = {}) {
  const settingsById = new Map();
  for (const id of await conn('technicians').where({ employment_type: 'w2' }).pluck('id')) {
    // Another employee's settings that cannot be read leave that employee out of the preview, not the selected one.
    try {
      const found = await conn.transaction((sp) => settingsFor(sp, canonicalId(id), weekStart));
      if (found) settingsById.set(canonicalId(id), found);
    } catch { /* not the selected employee: the run reports it */ }
  }
  settingsById.set(technicianId, settings);
  const one = (await weekCreditsFor(conn, settingsById, weekStart, opts)).get(technicianId);
  if (one.error) throw new PayrollError(500, `The production share could not be worked out: ${one.error}`);
  return one;
}

// The credit rows alone (the owner's stop credit reads no refund ledger).
const creditsOfWeek = async (conn, technicianId, weekStart, settings, opts = {}) => (
  await weekOfTechnician(conn, technicianId, weekStart, settings, { ...opts, refundLedger: false })).rows;

// ---------------------------------------------------------------- stop credit overrides

// What identifies one stored credit: the page sends it back with a clear or a replace, and the server refuses (409) when the stored
// credit is no longer the one the owner saw (another session changed or replaced it meanwhile).
const overrideRevision = (row) => require('node:crypto').createHash('sha1')
  .update(JSON.stringify([canonicalId(row.technician_id), Number(row.credit_cents), row.reason, row.conflict_basis || '', new Date(row.created_at).toISOString()])).digest('hex').slice(0, 16);

// The conflict tuples a credit was set against, stored as a JSON array of strings in conflict_basis.
const tuplesOfStored = (text) => { try { const list = JSON.parse(text || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } };

/** The owner's credits for the stops of a pay week: Map of visit id -> { technicianId, creditCents, reason, revision }. */
async function overridesOf(conn, weekStart) {
  const rows = await conn('production_share_stop_overrides').where({ week_start: weekStart }).select('visit_id', 'technician_id', 'credit_cents', 'reason', 'conflict_basis', 'created_at');
  return new Map(rows.map((row) => [canonicalId(row.visit_id), {
    technicianId: canonicalId(row.technician_id), creditCents: Number(row.credit_cents), reason: row.reason, conflictTuples: tuplesOfStored(row.conflict_basis), revision: overrideRevision(row),
  }]));
}

const overrideSchema = Joi.object({
  technicianId: Joi.string().pattern(UUID_RE).required().error(new Error('Choose a technician')),
  visitId: Joi.string().pattern(UUID_RE).required().error(new Error('Choose a stop')),
  weekStart: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required().error(new Error('The week must be a date, YYYY-MM-DD')),
  creditCents: Joi.number().integer().min(0).max(MAX_CENTS).required().error(new Error('Enter the credit as whole cents, $0 or more')),
  reason: Joi.string().trim().min(1).max(500).required().error(new Error('Say why (up to 500 characters)')),
  // The revision of the stored credit the page was showing (its stop's `overrideRevision`): required to replace or clear one.
  revision: Joi.string().max(64).error(new Error('The revision must be text')),
  // The revision of the stop as the page showed it (its row's `stopRevision`): refused (409) when the stop changed since.
  stopRevision: Joi.string().max(64).required().error(new Error('Reload the week: the stop must be sent with its revision')),
});
const overrideKeySchema = overrideSchema.fork(['technicianId', 'creditCents', 'reason', 'stopRevision'], (field) => field.optional());

// A stored credit is replaced or cleared only by the page that saw it: no revision, or another one, is refused.
function requireSameRevision(stored, revision) {
  // A revision names a credit the page saw: with none stored any more (cleared, or never there) it is refused. A new credit is created
  // only when there is neither a stored credit nor a revision.
  if (!stored) {
    if (revision) throw new PayrollError(409, 'This credit no longer exists. Reload the week to see the stop as it is now.');
    return;
  }
  if (!revision) throw new PayrollError(409, 'This stop already has a credit. Reload the week to see it.');
  if (revision !== overrideRevision(stored)) throw new PayrollError(409, 'This credit changed since you loaded the week. Reload the week and try again.');
}

async function guardOverride(trx, input) {
  requireWeek(input.weekStart);
  const technicianId = canonicalId(input.technicianId);
  if (!(await trx('technicians').where({ id: technicianId }).first('id'))) throw new PayrollError(404, 'Technician not found.');
  // Like the settings: a week a finalized check covers keeps the credits it was paid with.
  const covered = await trx('payroll_checks as c').join('payroll_runs as r', 'r.id', 'c.run_id')
    .where({ 'c.status': 'finalized', 'r.status': 'finalized', 'c.technician_id': technicianId, 'c.week_start': input.weekStart }).first('c.id');
  if (covered) throw new PayrollError(409, 'This week is already paid. A paid week keeps the credits it was paid with: void the run to change them.');
  return technicianId;
}

/**
 * Sets the credit the owner decides for one stop in one pay week (the owner account's alone; the route checks it), replacing an earlier
 * one. The stop must be a completed stop of that technician in that week. Refused with 409 once a finalized check covers the week.
 * Under the payroll mutation lock, with a critical audit event.
 */
async function setStopOverride(input, actor, conn = db) {
  const { value: v, error } = overrideSchema.validate(input || {}, { abortEarly: true, convert: true, allowUnknown: false });
  if (error) throw new PayrollError(400, error.details ? error.details[0].message : error.message);
  const actorId = (actor && typeof actor === 'object' ? actor.id : actor) || null;
  const { recordAuditEvent } = require('./audit-log');
  const { lockPayrollMutations } = require('./payroll-runs');
  return conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    const technicianId = await guardOverride(trx, v);
    const visitId = canonicalId(v.visitId);
    const before = await trx('production_share_stop_overrides').where({ visit_id: visitId, week_start: v.weekStart }).first('technician_id', 'credit_cents', 'reason', 'conflict_basis', 'created_at');
    requireSameRevision(before, v.revision);
    // Replacing a credit set for another technician (the stop was reassigned): that technician's paid week is guarded too.
    const owned = Boolean(before) && canonicalId(before.technician_id) === technicianId;
    if (before && !owned) await guardOverride(trx, { weekStart: v.weekStart, technicianId: before.technician_id });
    // The stop as the rules see it NOW, under the lock and without any override: a new credit is accepted only for a stop that still needs
    // review (or already holds one of the owner's credits) and whose work was done.
    const rows = await creditsOfWeek(trx, technicianId, v.weekStart, await settingsFor(trx, technicianId, v.weekStart), { skipOverrides: true });
    const now = rows.find((row) => canonicalId(row.visitId) === visitId);
    if (!now) throw new PayrollError(400, 'That stop is not a completed stop of this technician in that week.');
    // The stop the owner opened is the stop under the lock: its conflict state (invoices, package, what was paid elsewhere) is the same.
    if (now.stopRevision !== v.stopRevision) throw new PayrollError(409, 'The stop changed since you opened it. Reload the week and look at it again.');
    if (MANUAL_CREDIT_INELIGIBLE.has(now.kind)) throw new PayrollError(409, 'This stop cannot be credited by hand: its work was not done or confirmed, or a pay run already paid it.');
    if (!now.needsReview && !owned) throw new PayrollError(409, 'This stop no longer needs review.');
    await trx('production_share_stop_overrides').insert({
      technician_id: technicianId, visit_id: visitId, week_start: v.weekStart, credit_cents: v.creditCents, reason: v.reason,
      // The conflict state the stop is in NOW (what the owner looked at): a new conflict later makes a run ignore the credit.
      conflict_basis: JSON.stringify(now.conflictTuples || []), created_by: actorId, created_at: trx.fn.now(),
    }).onConflict(['visit_id', 'week_start']).merge(['technician_id', 'credit_cents', 'reason', 'conflict_basis', 'created_by', 'created_at']);
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.production_share_stop_override_set', resource_type: 'production_share_stop_override', resource_id: visitId,
      metadata: {
        technician_id: technicianId, visit_id: visitId, week_start: v.weekStart, credit_cents: v.creditCents, reason: v.reason,
        ...(before ? { before_credit_cents: Number(before.credit_cents), before_reason: before.reason } : {}),
      },
    });
    return { technicianId, visitId, weekStart: v.weekStart, creditCents: v.creditCents, reason: v.reason };
  });
}

/** Removes the owner's credit for a stop and week: the stop goes back to the rules. Same guards and audit as setStopOverride. */
async function clearStopOverride(input, actor, conn = db) {
  const { value: v, error } = overrideKeySchema.validate(input || {}, { abortEarly: true, convert: true, allowUnknown: false });
  if (error) throw new PayrollError(400, error.details ? error.details[0].message : error.message);
  const actorId = (actor && typeof actor === 'object' ? actor.id : actor) || null;
  const { recordAuditEvent } = require('./audit-log');
  const { lockPayrollMutations } = require('./payroll-runs');
  return conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    requireWeek(v.weekStart);
    const visitId = canonicalId(v.visitId);
    // The stored row decides whose paid week this is: the technician who held the stop when the credit was set, whatever the caller sent.
    const before = await trx('production_share_stop_overrides').where({ visit_id: visitId, week_start: v.weekStart }).first('technician_id', 'credit_cents', 'reason', 'conflict_basis', 'created_at');
    if (!before && !v.revision) throw new PayrollError(404, 'No credit was set for that stop.');
    requireSameRevision(before, v.revision);
    const technicianId = await guardOverride(trx, { weekStart: v.weekStart, technicianId: before.technician_id });
    await trx('production_share_stop_overrides').where({ visit_id: visitId, week_start: v.weekStart }).del();
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.production_share_stop_override_cleared', resource_type: 'production_share_stop_override', resource_id: visitId,
      metadata: {
        technician_id: technicianId, visit_id: visitId, week_start: v.weekStart, before_credit_cents: Number(before.credit_cents), before_reason: before.reason,
        ...(v.technicianId && canonicalId(v.technicianId) !== technicianId ? { requested_technician_id: canonicalId(v.technicianId) } : {}),
      },
    });
    return { technicianId, visitId, weekStart: v.weekStart };
  });
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
  // From here on the id is the one the database holds (lowercase), whatever the caller typed.
  const id = canonicalId(technician.id);
  const settings = await settingsFor(conn, id, weekStart);
  // The week as the pay run works it out: every W-2 technician with numbers in force is read together (an invoice or a package shared
  // by two technicians is split once), and this technician's rows are returned.
  const week = await weekOfTechnician(conn, id, weekStart, settings);
  const stops = week.rows;
  const days = shiftDays(stops);
  // A take-back the owner set for a refund on a paid stop comes off the week's credited production, as the pay run takes it.
  const applied = refunds.applyTakeBacks(stops, week.takeBackOwed);
  const result = shareForWeek({ credits: [applied.creditedCents], shifts: days.length, settings });
  await require('./production-share-refund-alerts').raiseRefundFlagAlerts({ technicianId: id, stops, takeBackToSet: week.takeBackToSet });
  // The conflict tuples stay on the server: the page gets the stop's revision.
  const shown = stops.map((stop) => { const copy = { ...stop }; delete copy.conflictTuples; delete copy.refundInvoices; return copy; });
  return {
    technician: { id, name: technician.name },
    weekStart,
    weekEnd: addStaffWorkDays(weekStart, 6),
    settings,
    history: await settingsHistory(conn, id),
    shiftDays: days,
    ...result,
    stops: shown,
    needsReview: shown.filter((stop) => stop.needsReview),
    refundCents: stops.reduce((sum, stop) => sum + stop.refundCents, 0),
    // Refunds the owner is asked about: paid stops with a new refund (takeBackToSet), his answers (takeBackAnswers, with the total he set),
    // and what this week takes (takeBacks, signed; negative = credit given back; refundTakeBackCents is the net, owedTakeBackCents all that is owed).
    takeBackToSet: week.takeBackToSet,
    takeBackAnswers: week.takeBackAnswers,
    takeBacks: applied.takeBacks,
    refundTakeBackCents: applied.refundTakeBackCents,
    owedTakeBackCents: week.takeBackOwed.reduce((sum, one) => sum + Math.max(0, one.cents), 0),
    // Whole refunds on shared invoices that could not be split, each invoice once.
    unallocatedRefundCents: [...new Map(stops.flatMap((stop) => stop.unallocatedRefunds).map((u) => [u.invoiceId, u.refundCents])).values()]
      .reduce((sum, cents2) => sum + cents2, 0),
  };
}

module.exports = {
  allocateCents, BAR_TYPES, OWN_CALLBACK_DAYS, shareForWeek, jobPartCents, shiftDays, settingsFor, settingsHistory, saveSettings, weekCredits, weekCreditsFor, weekStops, creditsOfStops, paidLedger, applyLedger, loadCreditFacts,
  previewWeek, overridesOf, setStopOverride, clearStopOverride,
  setRefundTakeBack: refunds.setRefundTakeBack, clearRefundTakeBack: refunds.clearRefundTakeBack,
};
