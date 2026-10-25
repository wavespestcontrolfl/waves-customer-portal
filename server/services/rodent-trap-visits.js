// server/services/rodent-trap-visits.js
//
// Booking-screen notice for rodent trapping (owner ruling 2026-09-26): a
// trapping job covers 2 visits, the setup visit plus 1 trap check. Visit 3
// and later is the separately priced "Rodent Trap Check - Additional"
// catalog row, which the office books. The ruling keeps no trapping-job
// record and no count-based pricing, so this module only LISTS a customer's
// recent active trapping visits at the booking's address. The office reads
// the list and decides; nothing here picks included vs. billable, applies
// the grandfathering for jobs sold before 2026-09-27, or sets a price.

const { etDateString } = require('../utils/datetime-et');

// Every catalog row that is a visit of a trapping job: the setup visit
// (plain, packaged with exclusion and/or sanitation, or the "Rodent
// Exclusion & Trapping Service" row, which places the traps), the included
// trap check, and the paid extra check. The same set as review-request's
// RODENT_TRAPPING_SERIES_KEYS.
const TRAPPING_VISIT_KEYS = [
  'rodent_trapping',
  'rodent_trapping_exclusion',
  'rodent_trapping_sanitation',
  'rodent_trapping_exclusion_sanitation',
  'rodent_exclusion',
  'rodent_trapping_followup',
  'rodent_trap_check_additional',
];
const WINDOW_DAYS = 60;
// Not a visit the job had: cancelled, replaced by a rescheduled row,
// skipped, or missed (same reading as typed-followup-obligation.js).
const INACTIVE_STATUSES = ['cancelled', 'rescheduled', 'skipped', 'no_show'];
const VISIT_LIMIT = 200;

function shiftDay(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// What trappingPremiseMatcher reads from each candidate row.
const STAMP_COLUMNS = [
  'ss.id',
  'ss.property_id',
  'ss.service_address_line1',
  'ss.service_address_line2',
  'ss.service_address_city',
  'ss.service_address_zip',
];

// A booking sent without a property is stamped with the customer's ONLY
// active property (customer-properties soleActivePropertyId), which need not
// be the primary; two or more stay unplaced, on the primary premise. Read-only
// twin: that anchor can also create a missing primary row, a write this
// lookup never makes. With no row at all the premise is the primary address.
async function soleActivePropertyIdReadOnly(db, customerId) {
  const rows = await db('customer_properties')
    .where({ customer_id: customerId, active: true })
    .limit(2)
    .select('id');
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * Active trapping visits (on the primary line or an add-on line) for one
 * customer at one premise, scheduled in the WINDOW_DAYS up to and including
 * `date` (ET 'YYYY-MM-DD', default today). A line whose catalog row is gone
 * still counts through its service_key_snapshot. scheduled_date is a DATE
 * column, so the bounds compare as calendar days, and the dates come back
 * from SQL as text so no host timezone shifts them. Read-only.
 *
 * The premise is the booking's property when one is given, else the one the
 * booking route would anchor (the customer's only active property, or the
 * primary address), using the same rules as the trapping review series
 * (review-request trappingPremiseMatcher).
 */
async function recentTrappingVisits(db, customerId, { date = null, propertyId = null, premiseMatcher } = {}) {
  const through = date || etDateString();
  const since = shiftDay(through, -WINDOW_DAYS);
  const inPremise = premiseMatcher
    // Lazy: review-request loads the messaging stack.
    || await require('./review-request').trappingPremiseMatcher(customerId, {
      property_id: propertyId || await soleActivePropertyIdReadOnly(db, customerId),
    });
  const dayCol = db.raw("to_char(ss.scheduled_date, 'YYYY-MM-DD') as scheduled_day");
  const activeInWindow = (q) => q
    .where('ss.customer_id', customerId)
    .where((s) => s.whereNotIn('ss.status', INACTIVE_STATUSES).orWhereNull('ss.status'))
    .where('ss.scheduled_date', '>=', since)
    .where('ss.scheduled_date', '<=', through);
  // The line's catalog key, or its booking-time snapshot once the catalog
  // row is gone.
  const trappingLine = (snapshotCol) => (q) => q
    .whereIn('sv.service_key', TRAPPING_VISIT_KEYS)
    .orWhere((s) => s.whereNull('sv.id').whereIn(snapshotCol, TRAPPING_VISIT_KEYS));

  const primaries = await activeInWindow(
    db('scheduled_services as ss').leftJoin('services as sv', 'ss.service_id', 'sv.id'),
  )
    .where(trappingLine('ss.service_key_snapshot'))
    .orderBy('ss.scheduled_date', 'desc')
    .limit(VISIT_LIMIT)
    .select(...STAMP_COLUMNS, db.raw('COALESCE(sv.service_key, ss.service_key_snapshot) as service_key'), dayCol);
  const addons = await activeInWindow(
    db('scheduled_service_addons as a')
      .join('scheduled_services as ss', 'a.scheduled_service_id', 'ss.id')
      .leftJoin('services as sv', 'a.service_id', 'sv.id'),
  )
    .where(trappingLine('a.service_key_snapshot'))
    .orderBy('ss.scheduled_date', 'desc')
    .limit(VISIT_LIMIT)
    .select(...STAMP_COLUMNS, db.raw('COALESCE(sv.service_key, a.service_key_snapshot) as service_key'), dayCol);

  // One appointment is one visit, however many trapping lines it carries.
  const byVisit = new Map();
  for (const row of [...primaries, ...addons]) {
    if (!byVisit.has(row.id) && inPremise(row)) byVisit.set(row.id, row);
  }
  const visits = [...byVisit.values()]
    .map((r) => ({ id: r.id, date: r.scheduled_day, serviceKey: r.service_key }))
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return { windowDays: WINDOW_DAYS, since, through, count: visits.length, visits };
}

module.exports = { TRAPPING_VISIT_KEYS, WINDOW_DAYS, INACTIVE_STATUSES, recentTrappingVisits };
