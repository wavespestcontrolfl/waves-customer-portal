'use strict';

/**
 * Away Watch + Welcome Home (GATE_AWAY_WATCH, owner approved 2026-10-31).
 *
 * A WaveGuard member sets two ET calendar days on property_preferences:
 * away_watch_from (the day they leave) and away_watch_until (the day they are
 * back). A visit whose own scheduled day falls in [from, until) is an away
 * visit: the tech job card says to photograph the outside of the home and note
 * standing water, and a performed closeout needs AWAY_WATCH_MIN_PHOTOS uploaded
 * photos. The last scheduled visit before the back day also carries the
 * Welcome Home line (lanai cobweb sweep, no product).
 *
 * Service continues while the member is away (owner 2026-09-29: pause is not a
 * product). The photos reach the member in the normal completion text and
 * service report, so nothing here sends a message. The cancel-flow Away Mode
 * (property_preferences.away_mode_until, services/cancellation-resolution) is a
 * different feature and is not read or written here.
 *
 * Gate off = every function here answers "no window", so every caller behaves
 * as it did before. The gate is read at call time through the guarded reader
 * below, so a suite that mocks feature-gates as a bare object reads it as off.
 */

const gates = require('../config/feature-gates');
const { etCalendarDayOf, etDateString } = require('../utils/datetime-et');
const { isMembershipCustomerRow } = require('./waveguard-existing-services');
const { VISIT_HOME_COLUMNS, visitAtCustomerHome } = require('./stamped-address');

const AWAY_WATCH_MIN_PHOTOS = 3;
// The longest stretch one window may cover (about eight months: a full
// summer away plus travel days).
const AWAY_WATCH_MAX_DAYS = 240;
const AWAY_WATCH_FIELDS = ['awayWatchFrom', 'awayWatchUntil'];
const AWAY_WATCH_COLUMNS = ['away_watch_from', 'away_watch_until'];

// Not-performed outcomes: no work was done, so no photo is owed.
const NOT_PERFORMED_OUTCOMES = ['inspection_only', 'customer_declined', 'incomplete'];
// A visit that no longer counts as "scheduled" when looking for the next one.
const INACTIVE_STATUSES = ['cancelled', 'canceled', 'completed', 'rescheduled', 'skipped', 'no_show'];

// Tech-facing strings (job card).
const TECH_AWAY_LINE = (until) => `Away Watch: member away until ${until}. Take 3 photos of the outside of the home from the ground and note standing water.`;
const TECH_WELCOME_HOME_LINE = 'Welcome Home: last visit before the member is back. Do a lanai cobweb sweep (no product).';

// Writer messages (customer app and Customer 360 show them as-is).
const MESSAGES = {
  together: 'Away dates must be set or cleared together.',
  order: 'The day you leave must be on or before the day you are back.',
  tooLong: `Away Watch can cover at most ${AWAY_WATCH_MAX_DAYS} days.`,
  past: 'The day you are back cannot be in the past.',
  badDay: 'Use a real calendar day, like 2026-06-01.',
};

// Tech-facing. A sheet with no photo field of its own closes with photos added to the visit (Tech Home), so the
// message names the visit, not the form.
const CLOSEOUT_PHOTO_MESSAGE = `Away Watch visit: add at least ${AWAY_WATCH_MIN_PHOTOS} photos of the outside of the home to this visit before closeout.`;

function awayWatchLive() {
  return typeof gates.awayWatchLive === 'function' && gates.awayWatchLive();
}

// Away Watch is a WaveGuard member perk: the app offers the dates, and every consumer honors them, only for a
// member (isMembershipCustomerRow, the portal's one membership rule). `customer` is a customers row.
function awayWatchOpenFor(customer) {
  return awayWatchLive() && !!customer && isMembershipCustomerRow(customer);
}

// The member's window from a property_preferences row: { from, until } as ET
// day strings, or null (gate off, either date missing, or no row).
function awayWatchWindow(prefs) {
  if (!awayWatchLive() || !prefs?.away_watch_from || !prefs?.away_watch_until) return null;
  return { from: etCalendarDayOf(prefs.away_watch_from), until: etCalendarDayOf(prefs.away_watch_until) };
}

function dayInWindow(window, day) {
  return Boolean(window && day && window.from <= day && day < window.until);
}

// One visit's Away Watch, in one read: the visit's own ET day, its stamped address beside the member's home address
// (visitAtCustomerHome: unit-aware, so a visit stamped at another address or another unit is not at home), the
// membership facts and the member's window. Answers { customerId, day, window } only for a WaveGuard member's visit at
// home inside the window; null otherwise (gate off, no row, non-member, elsewhere, no window, outside it). Dates on a
// non-member's row or another home's visit never add a job card line, a photo minimum or a Visit Brief line.
async function awayWatchVisit(dbh, scheduledServiceId) {
  if (!awayWatchLive() || !scheduledServiceId) return null;
  const row = await dbh('scheduled_services as ss')
    .join('customers as c', 'c.id', 'ss.customer_id')
    .leftJoin('property_preferences as pp', 'pp.customer_id', 'ss.customer_id')
    .where('ss.id', scheduledServiceId)
    .first(
      'ss.customer_id', 'ss.scheduled_date', 'pp.away_watch_from', 'pp.away_watch_until', 'c.waveguard_tier', 'c.monthly_rate',
      ...VISIT_HOME_COLUMNS,
    );
  if (!row || !isMembershipCustomerRow(row) || !visitAtCustomerHome(row)) return null;
  const window = awayWatchWindow(row);
  const day = etCalendarDayOf(row.scheduled_date);
  return dayInWindow(window, day) ? { customerId: row.customer_id, day, window } : null;
}

// Closeout: is this visit an Away Watch visit?
async function visitInAwayWatchWindow(dbh, scheduledServiceId) {
  return Boolean(await awayWatchVisit(dbh, scheduledServiceId));
}

// Job card and Visit Brief: the lines for one visit. Welcome Home goes on the last scheduled visit at home before
// the back day: no later active visit at home before it (a visit stamped at another address or unit does not count,
// visitAtCustomerHome as in awayWatchVisit).
async function awayWatchCardLines(dbh, scheduledServiceId) {
  const visit = await awayWatchVisit(dbh, scheduledServiceId);
  if (!visit) return null;
  const later = await dbh('scheduled_services as ss')
    .join('customers as c', 'c.id', 'ss.customer_id')
    .where('ss.customer_id', visit.customerId)
    .where('ss.scheduled_date', '>', visit.day)
    .where('ss.scheduled_date', '<', visit.window.until)
    .whereNotIn('ss.status', INACTIVE_STATUSES)
    .select('ss.scheduled_date', ...VISIT_HOME_COLUMNS);
  const lines = [TECH_AWAY_LINE(visit.window.until)];
  if (!later.some((row) => visitAtCustomerHome(row))) lines.push(TECH_WELCOME_HOME_LINE);
  return { lines };
}

// Closeout: every photo this closeout puts on the visit counts once. The body's completion photos (the full form, the
// Tree & Shrub sheet), the visit photos the tech staged from Tech Home or the pest sheet (promoted to the record in the
// same transaction, before this count), and the customer-visible photos of the lawn assessment the lawn sheet linked
// (its front, back and side shots are photos of the outside from the ground). A Fast Complete sheet that sends no photo of its own is
// covered by the visit photos staged from Tech Home.
// The body's count is the upload's own unique count; a staged photo the upload deduped onto (same bytes, same
// row) is counted there, not again.
async function awayWatchClosePhotoCount(dbh, { promotedIds = [], uploadResult = {}, lawnAssessmentId = null } = {}) {
  const uploadedIds = new Set((uploadResult.photos || []).map((row) => row && row.id).filter(Boolean).map(String));
  const staged = promotedIds.map(String).filter((id) => !uploadedIds.has(id)).length;
  const body = Number(uploadResult.uniqueUploaded ?? uploadResult.uploaded ?? 0) || 0;
  if (!lawnAssessmentId) return body + staged;
  // Only photos the customer receives: the lawn report leaves out customer_visible = false rows (report-photo-set.js
  // resolveLawnReportPhotos), so those never meet an Away Watch promise.
  const lawn = await dbh('lawn_assessment_photos')
    .where({ assessment_id: lawnAssessmentId, customer_visible: true })
    .whereNotNull('s3_key')
    .whereNot('s3_key', 'like', 'pending/%')
    .count({ n: '*' })
    .first();
  return body + staged + Number(lawn?.n || 0);
}

// Writer rule for the pair, given the values that validated alone. `sent` is
// how many of the two keys the request carried. Returns a message or null.
function awayWatchPairError(from, until, sent, today = etDateString()) {
  if (sent === 1 || (from === null) !== (until === null)) return MESSAGES.together;
  if (from === null) return null;
  if (from > until) return MESSAGES.order;
  if ((Date.parse(until) - Date.parse(from)) / 86400000 > AWAY_WATCH_MAX_DAYS) return MESSAGES.tooLong;
  if (until < today) return MESSAGES.past;
  return null;
}

// The two days, gone from a copy of obj (camel and snake keys): they say when a home stands empty.
function stripAwayWatchDates(obj) {
  if (!obj) return obj;
  const copy = { ...obj };
  AWAY_WATCH_FIELDS.forEach((k) => delete copy[k]);
  AWAY_WATCH_COLUMNS.forEach((k) => delete copy[k]);
  return copy;
}

// A preferences response for this customer: the two days as plain ET days for a member while the gate is on, and
// gone for everyone else.
function awayWatchFieldsFor(customer, obj) {
  return awayWatchOpenFor(customer) ? withAwayWatchDays(obj) : stripAwayWatchDates(obj);
}

// Gate on: the two days as plain ET day strings (a pg date can arrive as a Date).
function withAwayWatchDays(obj) {
  if (!awayWatchLive() || !obj) return obj;
  const copy = { ...obj };
  AWAY_WATCH_FIELDS.forEach((k) => { if (copy[k]) copy[k] = etCalendarDayOf(copy[k]); });
  AWAY_WATCH_COLUMNS.forEach((k) => { if (copy[k]) copy[k] = etCalendarDayOf(copy[k]); });
  return copy;
}

module.exports = {
  AWAY_WATCH_MIN_PHOTOS,
  AWAY_WATCH_MAX_DAYS,
  AWAY_WATCH_FIELDS,
  AWAY_WATCH_COLUMNS,
  NOT_PERFORMED_OUTCOMES,
  CLOSEOUT_PHOTO_MESSAGE,
  awayWatchLive,
  awayWatchOpenFor,
  awayWatchFieldsFor,
  awayWatchWindow,
  dayInWindow,
  awayWatchVisit,
  visitInAwayWatchWindow,
  awayWatchCardLines,
  awayWatchClosePhotoCount,
  awayWatchPairError,
  stripAwayWatchDates,
  withAwayWatchDays,
  MESSAGES,
};
