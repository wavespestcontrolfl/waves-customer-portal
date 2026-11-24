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
 *   - A refund                          takes back the credit of that stop; PR 3 does it. PR 1 only exposes the stop's
 *     refund total (refundCents): refunds on the payments of the visit's linked invoices (the same links and the same split
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
function invoiceShare(row, members) {
  const priced = visitPreTaxCents(row);
  const refunded = cents(row.refunded) || 0;
  if (priced.none) return { skipped: true };
  if (priced.unclear) return { unallocated: refunded, reason: priced.unclear };
  if (members.length <= 1) {
    return { billed: new Map([[row.visit_id, priced.cents]]), refunded: new Map([[row.visit_id, refunded]]), total: priced.cents, members: members.length ? members : [{ id: row.visit_id, weight: 0 }] };
  }
  const parts = allocateCents(priced.cents, members);
  return parts ? { billed: parts, refunded: allocateCents(refunded, members), total: priced.cents, members } : { unallocated: refunded, reason: UNALLOCATED_REASON };
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
 * shares: [{ invoiceId, totalCents, members: [{ id, weight }], shareCents }] for each invoice that priced the visit }.
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
  // the latest. One row per visit and invoice.
  const links = await conn.raw(`
    SELECT DISTINCT s.id AS visit_id, i.id AS invoice_id, i.line_items, i.subtotal, i.discount_amount, i.total, i.tax_amount,
      ${rr.depositCreditSql('i')} AS deposit_credit,
      ${refundOf} AS refunded
    FROM scheduled_services s
    LEFT JOIN (SELECT scheduled_service_id, id AS service_record_id FROM service_records WHERE scheduled_service_id = ANY(?::uuid[])) sr
      ON sr.scheduled_service_id = s.id
    JOIN invoices i ON ${rr.VISIT_INVOICE_LINK_SQL}
    WHERE s.id = ANY(?::uuid[]) AND i.archived_at IS NULL AND i.annual_prepay_term_id IS NULL
      AND i.status <> ALL(?::text[])
      AND NOT EXISTS (SELECT 1 FROM annual_prepay_terms t WHERE t.prepay_invoice_id = i.id)`,
  [visitIds, visitIds, NOT_CHARGED_INVOICE_STATUSES]);
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
  const shares = new Map(); // invoice id -> { billed: Map, refunded: Map } by visit, or { unallocated: refunded cents }
  for (const row of links.rows) {
    if (shares.has(row.invoice_id)) continue;
    const list = byInvoice.get(row.invoice_id) || [];
    shares.set(row.invoice_id, invoiceShare(row, list));
  }
  for (const row of links.rows) {
    const share = shares.get(row.invoice_id);
    if (share.skipped) continue;
    const entry = out.get(row.visit_id) || { billedCents: null, refundCents: 0, unallocated: [], shares: [] };
    if (share.unallocated !== undefined) entry.unallocated.push({ invoiceId: row.invoice_id, refundCents: share.unallocated, reason: share.reason });
    else if (share.billed.has(row.visit_id)) {
      entry.billedCents = (entry.billedCents || 0) + share.billed.get(row.visit_id);
      entry.refundCents += (share.refunded && share.refunded.get(row.visit_id)) || 0;
      // What the ledger needs of the invoice (see CREDIT LEDGER): its whole priced amount, its member visits with their weights, and the
      // share this visit was billed.
      entry.shares.push({ invoiceId: row.invoice_id, totalCents: share.total, members: share.members, shareCents: share.billed.get(row.visit_id) });
    }
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
  if (invoiced && invoiced.unallocated.length) return toReview('multi_visit_job', invoiced.unallocated[0].reason);
  // A package priced on an invoice that other visits (outside the job) share cannot be credited by the ledger: its price is one slice of a
  // split that moves with those visits. Every visit of it is $0 + needs review, and the owner sets the credit by hand.
  const inJob = new Set([job.root.id, ...job.planned]);
  if (invoiceSharesOf(invoiced).some((one) => one.members.some((member) => !inJob.has(member.id)))) {
    return toReview('multi_visit_job', 'The package is priced on an invoice shared with other visits: set its credit by hand.');
  }
  const price = invoiced && invoiced.billedCents !== null ? invoiced.billedCents : cents(job.root.estimated_price);
  const nth = job.planned.indexOf(stop.id) + 1;
  if (!(price > 0)) return toReview('multi_visit_job', "The job's first visit has no price on file.");
  if (nth < 1 || nth > sold || job.planned.length > sold) return toReview('multi_visit_job', "This visit is not among the job's sold visits.");
  // What the credit ledger needs of the job (CREDIT LEDGER): its price, sold count and this visit's slot.
  return {
    ...credited('multi_visit_job', jobPartCents(price, sold, nth), `Part ${nth} of ${sold} of the job price`),
    job: { rootId: job.root.id, price, sold, nth },
  };
}

async function callbackCredit(conn, stop, technicianId, inForce) {
  if (stop.line === 'other') return toReview('callback_review', 'A callback whose service line is unknown, so its original work cannot be found.');
  const found = await originalWork(conn, stop);
  if (found.review) return toReview('callback_review', found.review);
  const original = found.original;
  if (!original) return toReview('callback_review', 'No earlier completed work of the same line at this property.');
  if (!original.technician_id) return toReview('callback_review', 'The original work has no technician on file.');
  if (canonicalId(original.technician_id) === canonicalId(technicianId)) {
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
      conn.raw(`to_char(${WORK_DATE_SQL}, 'YYYY-MM-DD') AS work_date`), conn.raw(`${LINE_SQL} AS line`))
    .orderByRaw(`${WORK_DATE_SQL}, s.completed_at NULLS LAST, s.id`);
}

/*
 * CREDIT LEDGER (one invariant). A BASIS is what a credit is priced from as a whole: a shared invoice (its id) or a multi-visit job
 * (its root visit id). Each credited stop row records what it drew from each basis: stops[].bases = [{ basisType, basisId, cents }].
 *   PAID(basis)  = the cents on such rows of FINALIZED, non-void checks that paid a share above $0, in OTHER weeks
 *   REMAINING    = the basis's live total - PAID(basis), never more than it
 * A basis nobody was paid from yet is credited exactly as it prices live. Once something was paid, this week's stops of the basis
 * share REMAINING by their live weights among the basis's visits NOT yet paid (invoice: its live member visits; job: the sold count
 * less the visits already paid), and REMAINING at or under $0 makes them $0 + needs review ("already credited in full"). So the
 * credits of a basis never add up to more than its live total, whatever was repriced, relinked or replaced in between, and a visit
 * that joins an invoice, or replaces a package visit, after it was credited in full earns nothing from it. A job that fails its own
 * checks stays a review row: nothing here changes a row that is already $0 + needs review. A visit already credited on such a check
 * is already_paid. Voiding the paying run takes its checks out of PAID, so the ledger releases it.
 */

// The invoice shares behind a billedByVisit entry that priced a visit: [{ invoiceId, totalCents, members, shareCents }].
const invoiceSharesOf = (entry) => (entry && entry.billedCents !== null && entry.billedCents !== undefined ? entry.shares || [] : []);

// What the credit ledger needs to recompute a credit once something was paid (applyLedger); null for a credit that no invoice or job
// priced (own price, prepaid slice, callback value, free visit type, a review row). `invoices`: the shared invoices that priced the visit,
// whatever the visit's live share came to (a share that rounds to $0 still takes what is left of the invoice). `job`: the job part's
// price, sold count and slot.
function ledgerOf(credit, invoiced) {
  if (credit.needsReview) return null;
  if (credit.job) return { job: credit.job };
  if (!credit.invoiceBased) return null;
  const invoices = invoiceSharesOf(invoiced);
  return invoices.length ? { invoices } : null;
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
  const billed = await billedByVisit(conn, [...new Set([...stops.map((stop) => stop.id),
    ...[...jobs.values()].filter((job) => job && job.root).map((job) => job.root.id)])]);
  return { jobs, billed, prepaidRefunds: await termRefunds(conn, stops) };
}

/**
 * The credit rows of ONE technician's stops (weekStops rows): { visitId, workDate, kind, creditCents, reason, needsReview,
 * refundCents, serviceType, bases } in the stops' order. `inForce` = the settings in force for the week (the callback value comes
 * from them). `facts` = loadCreditFacts of a wider set of stops (the pay run reads them once for everyone); read here when not given.
 */
async function creditsOfStops(conn, technicianId, stops, inForce, facts = null) {
  const { jobs, billed, prepaidRefunds } = facts || await loadCreditFacts(conn, stops);

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
    const shown = { ...credit };
    delete shown.job;
    delete shown.invoiceBased;
    rows.push({
      visitId: stop.id, workDate: stop.work_date, serviceType: stop.service_type, ...shown,
      refundCents: (invoiced.refundCents || 0) + (prepaidRefunds.get(stop.id) || 0),
      // Refunds on a shared invoice that cannot be split across its visits: the invoice's whole refund, kept visible.
      unallocatedRefunds: invoiced.unallocated || [],
      ledger: ledgerOf(credit, invoiced),
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
const DREW_FROM_SQL = `EXISTS (SELECT 1 FROM jsonb_array_elements(${STOP_BASES_SQL}) b
        WHERE (b.value->>'basisType') || ':' || (b.value->>'basisId') = ANY(?::text[]))`;
const paidRowsSql = (match) => `SELECT c.id AS check_id, stop.value->>'visitId' AS visit_id, to_char(c.week_start, 'YYYY-MM-DD') AS week_start,
    ${STOP_BASES_SQL} AS bases ${PAID_FROM_SQL} AND (${match})`;

const baseKey = (basis) => `${basis.basisType}:${basis.basisId}`;

/**
 * What finalized pay runs already paid, for the ledger (CREDIT LEDGER above). `visitIds`: this week's visits and the roots of their
 * jobs; `keys`: the 'type:id' of every basis this week's credits draw from. Returns
 *   visits:   Map visit id -> week, for each of `visitIds` a finalized check already credited (already_paid);
 *   byBasis:  Map 'type:id' -> { cents, visits: Set }, what the paid rows drew from that basis and which visits drew it.
 * The rows are those that name a visit of `visitIds` OR draw from one of `keys`; every basis such a visit's row drew from is read in
 * full too (a basis whose link was removed from the visit since, a package root that was paid from an invoice), so a link that is gone
 * does not hide what was paid from it. Whoever the technician was. Voiding the paying run takes its checks out of these queries.
 * Two queries at most.
 */
async function paidLedger(conn, visitIds, keys, weekStart) {
  const ledger = { visits: new Map(), byBasis: new Map() };
  if (!visitIds.length && !keys.length) return ledger;
  const wanted = new Set(visitIds);
  const seen = new Set();
  const take = (rows) => {
    for (const row of rows) {
      const once = `${row.check_id}:${row.visit_id}`;
      if (seen.has(once)) continue;
      seen.add(once);
      if (wanted.has(row.visit_id) && (!ledger.visits.has(row.visit_id) || row.week_start < ledger.visits.get(row.visit_id))) ledger.visits.set(row.visit_id, row.week_start);
      for (const basis of row.bases) {
        const key = baseKey(basis);
        const entry = ledger.byBasis.get(key) || { cents: 0, visits: new Set() };
        entry.cents += Number(basis.cents) || 0;
        entry.visits.add(row.visit_id);
        ledger.byBasis.set(key, entry);
      }
    }
  };
  const first = (await conn.raw(paidRowsSql(`stop.value->>'visitId' = ANY(?::text[]) OR ${DREW_FROM_SQL}`), [weekStart, visitIds, keys])).rows;
  take(first);
  const known = new Set(keys);
  const more = [...new Set(first.filter((row) => wanted.has(row.visit_id)).flatMap((row) => row.bases.map(baseKey)))].filter((key) => !known.has(key));
  if (more.length) take((await conn.raw(paidRowsSql(DREW_FROM_SQL), [weekStart, more])).rows);
  return ledger;
}

const alreadyPaid = (row, week) => ({ ...row, bases: [], ledger: null, ...toReview('already_paid', `Already paid in the week of ${week}: a pay run already credited this visit.`) });
const exhausted = (row, what) => ({ ...row, bases: [], ledger: null, ...toReview('basis_exhausted', `This ${what} was already credited in full by earlier pay weeks, so this visit earns nothing more from it.`) });

// The new share of each invoice this week's rows draw from, by 'visitId|invoiceId' -> { cents, exhausted }. An invoice nothing was paid
// from keeps its live shares. Otherwise REMAINING (live total less what was paid) is shared by the live weights of the invoice's
// member visits that are not paid yet, to the cent, and this week's rows take their part.
function invoiceLedger(rows, paid) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.ledger) continue;
    for (const inv of row.ledger.invoices || []) {
      if (!groups.has(inv.invoiceId)) groups.set(inv.invoiceId, { inv, rows: [] });
      groups.get(inv.invoiceId).rows.push({ row, inv });
    }
  }
  const shares = new Map();
  for (const [invoiceId, group] of groups) {
    const was = paid.byBasis.get(`invoice:${invoiceId}`);
    const paidVisits = new Set([...(was ? was.visits : [])]);
    for (const member of group.inv.members) if (paid.visits.has(member.id)) paidVisits.add(member.id);
    const touched = (was && was.cents > 0) || group.inv.members.some((member) => paidVisits.has(member.id));
    const remaining = group.inv.totalCents - (was ? was.cents : 0);
    const open = group.inv.members.filter((member) => !paidVisits.has(member.id));
    // The last open member takes what is left, whatever its weight; several share it by their live weights, to the cent.
    const parts = !(touched && remaining > 0 && open.length) ? null
      : open.length === 1 ? new Map([[open[0].id, remaining]])
        : allocateCents(remaining, open) || allocateCents(remaining, open.map((member) => ({ id: member.id, weight: 1 })));
    for (const { row, inv } of group.rows) {
      const key = `${row.visitId}|${invoiceId}`;
      if (!touched) shares.set(key, { cents: Number(inv.shareCents) || 0, exhausted: false });
      else if (parts) shares.set(key, { cents: parts.get(row.visitId) || 0, exhausted: false });
      else shares.set(key, { cents: 0, exhausted: true });
    }
  }
  return shares;
}

/**
 * The credit rows of a pay week through the ledger (CREDIT LEDGER above). `paid` = paidLedger. Pure. Every row comes back with
 * `bases` = what it drew from each basis ([{ basisType, basisId, cents }], none for a credit no invoice or job priced) and no
 * `ledger`.
 */
function applyLedger(rows, paid) {
  const base = rows.map((row) => (paid.visits.has(row.visitId) ? alreadyPaid(row, paid.visits.get(row.visitId)) : row));
  const shares = invoiceLedger(base, paid);
  const out = new Map();
  // Job parts, per job: this week's visits in slot order take the REMAINING of the job over the slots not paid yet.
  const jobs = new Map();
  for (const row of base) if (row.ledger && row.ledger.job) {
    if (!jobs.has(row.ledger.job.rootId)) jobs.set(row.ledger.job.rootId, []);
    jobs.get(row.ledger.job.rootId).push(row);
  }
  for (const [rootId, group] of jobs) {
    group.sort((a, b) => a.ledger.job.nth - b.ledger.job.nth);
    const { sold } = group[0].ledger.job;
    // A job priced on an invoice shared with other visits never gets here (it is a review row, jobCredit); its price is live.
    const { price } = group[0].ledger.job;
    const was = paid.byBasis.get(`job:${rootId}`);
    const touched = was && (was.cents > 0 || was.visits.size > 0);
    const slotsLeft = sold - (was ? was.visits.size : 0);
    const remaining = price - (was ? was.cents : 0);
    const parts = touched && remaining > 0 && slotsLeft > 0
      ? allocateCents(remaining, Array.from({ length: slotsLeft }, (_, k) => ({ id: k, weight: 1 }))) : null;
    group.forEach((row, index) => {
      const nth = row.ledger.job.nth;
      let cents;
      if (!touched) cents = jobPartCents(price, sold, nth);
      else if (parts && index < slotsLeft) cents = parts.get(index);
      else { out.set(row.visitId, exhausted(row, 'package')); return; }
      out.set(row.visitId, { ...row, creditCents: cents, ledger: null, bases: [{ basisType: 'job', basisId: rootId, cents }] });
    });
  }
  return base.map((row) => {
    const done = settle(row);
    const clean = { ...done };
    delete clean.ledger;
    return clean;
  });

  function settle(row) {
    if (out.has(row.visitId)) return out.get(row.visitId);
    if (!row.ledger) return { ...row, bases: row.bases || [], ledger: null };
    if (row.ledger.job) return { ...row, bases: [], ledger: null };
    const mine = row.ledger.invoices.map((inv) => ({ inv, share: shares.get(`${row.visitId}|${inv.invoiceId}`) }));
    const cents = mine.reduce((sum, one) => sum + one.share.cents, 0);
    if (!(cents > 0) && mine.some((one) => one.share.exhausted)) return exhausted(row, 'invoice');
    // What is left of the invoice can reach a visit whose live share rounded to $0: it is a priced credit then.
    const classified = cents > 0 && row.kind !== 'priced'
      ? { kind: 'priced', needsReview: false, reason: "What is left of the visit's invoice, before tax" } : {};
    return {
      ...row, ...classified, creditCents: cents, ledger: null,
      bases: mine.filter((one) => one.share.cents > 0).map((one) => ({ basisType: 'invoice', basisId: one.inv.invoiceId, cents: one.share.cents })),
    };
  }
}

const keysOf = (rows) => [...new Set(rows.flatMap((row) => (row.ledger ? [
  ...(row.ledger.invoices || []).map((inv) => `invoice:${inv.invoiceId}`),
  ...(row.ledger.job ? [`job:${row.ledger.job.rootId}`] : []),
] : [])))];
// The visits whose paid state the ledger needs: this week's, the roots of their jobs, and every member visit of the invoices they draw
// from (so a member paid some other way is known whichever technicians' stops are read together).
const visitIdsOf = (rows) => [...new Set(rows.flatMap((row) => [
  row.visitId,
  ...(row.ledger && row.ledger.job ? [row.ledger.job.rootId] : []),
  ...(row.ledger && row.ledger.invoices ? row.ledger.invoices.flatMap((inv) => inv.members.map((member) => member.id)) : []),
]))];

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
  return applyLedger(rows, await paidLedger(conn, visitIdsOf(rows), keysOf(rows), weekStart));
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
async function weekCreditsFor(conn, settingsById, weekStart) {
  requireWeek(weekStart);
  const ids = [...settingsById.keys()].map(canonicalId);
  const stops = await weekStops(conn, ids, weekStart);
  const byTech = new Map(ids.map((id) => [id, []]));
  for (const stop of stops) byTech.get(canonicalId(stop.technician_id)).push(stop);
  const credits = new Map();
  let facts = null;
  try {
    facts = await conn.transaction((sp) => loadCreditFacts(sp, stops));
  } catch (err) {
    for (const id of ids) credits.set(id, { error: (err && err.message) || 'unknown problem' });
  }
  if (facts) {
    for (const id of ids) {
      try {
        credits.set(id, { rows: await conn.transaction((sp) => creditsOfStops(sp, id, byTech.get(id), settingsById.get(id), facts)) });
      } catch (err) {
        credits.set(id, { error: (err && err.message) || 'unknown problem' });
      }
    }
  }
  const all = [...credits.values()].flatMap((one) => one.rows || []);
  const done = applyLedger(all, await paidLedger(conn, visitIdsOf(all), keysOf(all), weekStart));
  const byVisit = new Map(done.map((row) => [row.visitId, row]));
  for (const [id, one] of credits) if (one.rows) credits.set(id, { rows: one.rows.map((row) => byVisit.get(row.visitId)) });
  return credits;
}

/**
 * The credit rows of one technician for a pay week, from the same grouped read the pay run uses (weekCreditsFor over every W-2
 * technician with settings in force, plus this one): the credits of a basis shared with another technician's stops are split once, so
 * the preview shows what a pay run draws. Throws the read's own error for this technician.
 */
async function creditsOfWeek(conn, technicianId, weekStart, settings) {
  const settingsById = new Map();
  for (const id of await conn('technicians').where({ employment_type: 'w2' }).pluck('id')) {
    const found = await settingsFor(conn, canonicalId(id), weekStart);
    if (found) settingsById.set(canonicalId(id), found);
  }
  settingsById.set(technicianId, settings);
  const one = (await weekCreditsFor(conn, settingsById, weekStart)).get(technicianId);
  if (one.error) throw new PayrollError(500, `The production share could not be worked out: ${one.error}`);
  return one.rows;
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
  const stops = await creditsOfWeek(conn, id, weekStart, settings);
  const days = shiftDays(stops);
  const result = shareForWeek({ credits: stops, shifts: days.length, settings });
  return {
    technician: { id, name: technician.name },
    weekStart,
    weekEnd: addStaffWorkDays(weekStart, 6),
    settings,
    history: await settingsHistory(conn, id),
    shiftDays: days,
    ...result,
    stops,
    needsReview: stops.filter((stop) => stop.needsReview),
    refundCents: stops.reduce((sum, stop) => sum + stop.refundCents, 0),
    // Whole refunds on shared invoices that could not be split, each invoice once.
    unallocatedRefundCents: [...new Map(stops.flatMap((stop) => stop.unallocatedRefunds).map((u) => [u.invoiceId, u.refundCents])).values()]
      .reduce((sum, cents2) => sum + cents2, 0),
  };
}

module.exports = {
  allocateCents, BAR_TYPES, OWN_CALLBACK_DAYS, shareForWeek, jobPartCents, shiftDays, settingsFor, settingsHistory, saveSettings, weekCredits, weekCreditsFor, weekStops, creditsOfStops, paidLedger, applyLedger, loadCreditFacts,
  previewWeek,
};
