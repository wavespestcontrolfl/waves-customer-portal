'use strict';

/**
 * Restaurants list (admin, read only): the rows the weekly restaurant job keeps in restaurant_prospects
 * (services/prospects/dbpr-restaurants.js), as one list with a reason on each row:
 *   new_restaurant  a new food license (kind new_license)
 *   new_owner       an ownership change (kind owner_change)
 *   pest_finding    an inspection whose public report holds a 35A finding (kind inspection, pest_evidence true)
 * Food trucks (license type 2014, mobile food vehicles) are left out: there is no building to treat. An inspection
 * whose report is not read yet (pest_evidence NULL), or that cites 35B only (a door or an opening), is left out too.
 * It sends nothing and calls no AI. Public business records only.
 */

const db = require('../../models/db');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { dateOnlyString, dateOnlyAtNoonUtc } = require('../../utils/date-only');

const PERIODS = [30, 90];
const REASONS = { new_license: 'new_restaurant', owner_change: 'new_owner', inspection: 'pest_finding' };
const FOOD_TRUCK = '2014';
// A row first read this many days ago or less is marked new: the job runs each Monday, so "new" is this week's rows.
const NEW_DAYS = 7;
// About two rows a day reach the list, so 90 days is a few hundred rows; the cap only guards the page. The counts
// cover the whole period either way (listRestaurants).
const ROW_LIMIT = 1000;
// The weekly job's job_health row (services/scheduler.js runs it under this name). Its last success is the last run that
// read all three files without a failure, whether or not it kept a row; a failed run leaves the last good read.
const SYNC_JOB = 'restaurant-prospect-sync';
// A run longer than this that never finished died (a deploy, a crash): a weekly run reads three files in minutes.
const READ_RUN_MAX_MS = 2 * 60 * 60 * 1000;

// A calendar day moved by whole days, with the shared helpers: noon UTC is the same day in Eastern time.
const shiftDay = (day, days) => dateOnlyString(addETDays(dateOnlyAtNoonUtc(day), days));

// detail is jsonb: the pg driver returns an object. A finding is { code, text } (dbpr-restaurants.js saveReport).
function findingsOf(detail) {
  const findings = detail && Array.isArray(detail.findings) ? detail.findings : [];
  return findings
    .filter((finding) => finding && typeof finding.code === 'string')
    .map((finding) => ({ code: finding.code, text: typeof finding.text === 'string' ? finding.text : '' }));
}

function toRow(row, newSince) {
  return {
    id: row.id,
    reason: REASONS[row.kind],
    name: row.business_name || null,
    address: row.address || null,
    city: row.city || null,
    zip: row.zip || null,
    county: row.county || null,
    phone: row.phone || null,
    seats: row.seats == null ? null : Number(row.seats),
    eventDate: dateOnlyString(row.event_date),
    licenseNumber: row.license_number || null,
    isNew: new Date(row.first_seen_at).getTime() >= newSince.getTime(),
    findings: row.kind === 'inspection' ? findingsOf(row.detail) : [],
  };
}

// The weekly job's state from its job_health row. readAt: its last good run's end. A run started after the last finish
// is under way (readingSince) while it is younger than READ_RUN_MAX_MS; older, it died, and counts as failed. A
// finished run failed when it finished after the last success: a success writes last_finished_at and last_success_at
// with one value (utils/cron-lock.js). While a run is under way, readFailedAt still names an earlier failure.
function readState(health, now) {
  const at = (value) => (value ? new Date(value) : null);
  const success = at(health && health.last_success_at);
  const finish = at(health && health.last_finished_at);
  const start = at(health && health.last_started_at);
  const started = start && (!finish || start > finish) ? start : null;
  const reading = started && now.getTime() - started.getTime() < READ_RUN_MAX_MS ? started : null;
  let failed = null;
  if (started && !reading) failed = started;
  else if (finish && (!success || finish > success)) failed = finish;
  const iso = (date) => (date ? date.toISOString() : null);
  return { readAt: iso(success), readingSince: iso(reading), readFailedAt: iso(failed) };
}

/**
 * The list for the last `days` days by the row's own date (a license's approval day, an inspection's day), Eastern,
 * today included; newest first, at most ROW_LIMIT rows. counts cover the whole period, past the cap too. readAt,
 * readingSince and readFailedAt are the weekly job's state (readState): while a run is under way, or after one failed,
 * the rows may mix two reads, since the job commits each file on its own. The rows and the state come from one
 * snapshot (a read-only REPEATABLE READ transaction), so a file committed between the two reads cannot split them.
 * @returns {Promise<{ days: number, from: string, through: string, readAt: string|null, readingSince: string|null,
 *   readFailedAt: string|null, counts: { new_restaurant: number, new_owner: number, pest_finding: number },
 *   rows: object[] }>}
 */
async function listRestaurants({ days = PERIODS[0], now = new Date() } = {}) {
  if (!PERIODS.includes(days)) throw new Error('unknown period');
  const through = etDateString(now);
  const from = shiftDay(through, -(days - 1));
  const newSince = new Date(now.getTime() - NEW_DAYS * 24 * 60 * 60 * 1000);
  const [rows, health] = await db.transaction((trx) => Promise.all([
    trx('restaurant_prospects')
      .whereBetween('event_date', [from, through])
      .whereRaw("COALESCE(license_type_code, '') <> ?", [FOOD_TRUCK])
      .where((q) => q.whereIn('kind', ['new_license', 'owner_change']).orWhere((p) => p.where({ kind: 'inspection', pest_evidence: true })))
      .orderBy([{ column: 'event_date', order: 'desc' }, { column: 'business_name', order: 'asc' }, { column: 'id', order: 'asc' }])
      .limit(ROW_LIMIT)
      .select('id', 'kind', 'business_name', 'address', 'city', 'zip', 'county', 'phone', 'seats', 'event_date',
        'license_number', 'detail', 'first_seen_at',
        // Each reason's count over the whole period: a window total is computed before the LIMIT, so the counts stay
        // whole when the list is cut, and come from the same read as the rows.
        trx.raw("count(*) FILTER (WHERE kind = 'new_license') OVER () AS total_new_restaurant"),
        trx.raw("count(*) FILTER (WHERE kind = 'owner_change') OVER () AS total_new_owner"),
        trx.raw("count(*) FILTER (WHERE kind = 'inspection') OVER () AS total_pest_finding")),
    trx('job_health').where({ job_name: SYNC_JOB }).first('last_success_at', 'last_finished_at', 'last_started_at'),
  ]), { isolationLevel: 'repeatable read', readOnly: true });
  const list = rows.map((row) => toRow(row, newSince));
  // No row means the period holds none. count() is a bigint: the driver gives a string.
  const totals = rows[0] || {};
  const counts = {
    new_restaurant: Number(totals.total_new_restaurant || 0),
    new_owner: Number(totals.total_new_owner || 0),
    pest_finding: Number(totals.total_pest_finding || 0),
  };
  return { days, from, through, ...readState(health, now), counts, rows: list };
}

module.exports = { PERIODS, listRestaurants };
