/**
 * Unfinished bookings reach a person (GATE_PORTAL_BOOKING_ITEMS, owner 2026-11-02, unworked-leads audit).
 *
 * Two kinds of visitor started to book with Waves and left, and nobody was told:
 *   (A) the public booking page: the visitor picked a time and went away. That is a booking_intents row with
 *       converted_at null. Only the automatic recovery text and email (booking-abandon-recovery.js) followed.
 *   (B) the card step of an estimate: the visitor opened the save-a-card step (an estimate_checkout_events row,
 *       kind recurring_card or card_hold) on an estimate that was never accepted. Nothing followed at all.
 * This raises ONE admin bell per drop-off, so a person calls. It is an admin row, never a service request: a
 * request is shown to the customer in the app and a status change sends them a notice.
 *
 * - Drop-off time: the intent's last_activity_at; the newest checkout event's updated_at of the estimate.
 *   A drop-off counts after QUIET_MINUTES with no new touch, and only if it is not older than WINDOW_DAYS, so
 *   turning the gate on cannot burst old rows.
 * - Skipped: an intent that converted or is suppressed; an estimate accepted, declined or archived; a customer
 *   with a live visit booked (any way) after the drop-off; a drop-off a PERSON already followed up (the shared
 *   witnesses in admin-alert-contact-witnesses.js: a person's text, a call a person placed or answered, a
 *   person's Gmail send, after the drop-off); a drop-off that already has a bell with its key, open or done.
 * - Customer-less: a booking-page visitor with no customer on file, and an estimate with no customer_id (the
 *   staff estimator keeps only customer_name and customer_phone), still get a bell. The contact check then
 *   matches by their PHONE; the "booked a visit" skip needs a customer id, so only a converted intent or an
 *   accepted estimate closes those. Without a customer id or a phone nothing can be matched at all, and the
 *   close rules are the converted / accepted ones.
 * - One bell per key: dedupeKey `portal-unfinished-booking:<intent id>` or `portal-unfinished-checkout:<estimate
 *   id>`, notifyAdmin's default dedupe (finds a done row too). The sweep also leaves out a key whose row exists,
 *   so a bell a person marked done never rings again.
 * - The bell is closed by admin-alert-relevance.js (class portal_unfinished_booking) and listed on the
 *   Communications Portal tab by portal-inbox.js.
 * - Sends nothing to a customer: no text, email, call or app notice. Admin bell rows only.
 *
 * Runs inside the alert-relevance sweep (every 10 minutes), only while the gate is on. Read-only apart from the
 * bell writes. Never throws into the sweep.
 */

const db = require('../models/db');
const logger = require('./logger');

const WINDOW_DAYS = 14;
const QUIET_MINUTES = 60;
// Candidates read per page, newest first, keyset-paged on (drop-off time, id). A drop-off a person already followed
// up never gets a bell, so it never drops out of the query: paging is what lets an older unanswered drop-off behind
// many contacted ones still ring. At most MAX_PAGES pages per source per run; a run that stops there says so, and
// the next sweep starts again from the newest.
const PAGE_SIZE = 200;
const MAX_PAGES = 10;
const KEY_PREFIX = 'portal-unfinished-';
const BOOKING_KEY_PREFIX = 'portal-unfinished-booking:';
const CHECKOUT_KEY_PREFIX = 'portal-unfinished-checkout:';
const SOURCE_BOOKING_PAGE = 'booking_page';
const SOURCE_ESTIMATE_CARD = 'estimate_card';
const MAX_WHY_CHARS = 110;

const safeError = (err) => require('./notification-service').safeErrorSummary(err);
const relevance = () => require('./admin-alert-relevance');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

// ---- Detection -------------------------------------------------------------------------------------------

// A bell with this key exists, open or done: the dedupe the bell itself applies, as SQL, so a drop-off that
// already rang drops out of the query and cannot crowd out a newer one.
const KEY_TAKEN_SQL = (prefix, idColumn) => `EXISTS (
  SELECT 1 FROM notifications n
  WHERE n.recipient_type = 'admin' AND n.metadata->>'dedupeKey' = '${prefix}' || ${idColumn}::text
)`;

// A live visit (a booking someone made that is to run or ran, never one the system generated) created for the
// customer after the drop-off: the customer booked another way.
function visitBookedAfter(query, customerColumn, boundarySql) {
  return query.whereNotExists(function bookedAfter() {
    relevance().whereLiveBooking(this.select(db.raw('1')).from('scheduled_services as ss')
      .whereRaw(`ss.customer_id = ${customerColumn}`)
      .whereRaw(`ss.created_at > ${boundarySql}`));
  });
}

// The page after `cursor` ({ at, id }: the last row's drop-off time as the database's own text, so no microsecond is
// lost, and its id), newest first. `timeColumn` and `idColumn` are this module's own column names.
function afterCursor(query, timeColumn, idColumn, cursor) {
  return cursor ? query.whereRaw(`(${timeColumn}, ${idColumn}) < (?::timestamptz, ?::uuid)`, [cursor.at, cursor.id]) : query;
}

// (A) booking-page drop-offs: not converted, not suppressed, quiet for QUIET_MINUTES, in the window.
function bookingPageQuery(conn, now, { cursor = null, pageSize = PAGE_SIZE } = {}) {
  const quietBefore = new Date(now.getTime() - QUIET_MINUTES * MIN_MS);
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const query = conn('booking_intents as bi')
    .leftJoin('customers as c', 'c.id', 'bi.customer_id')
    .whereNull('bi.converted_at')
    .whereRaw('COALESCE(bi.suppressed, false) = false')
    .where('bi.last_activity_at', '<=', quietBefore)
    .where('bi.last_activity_at', '>', since)
    .whereRaw(`NOT ${KEY_TAKEN_SQL(BOOKING_KEY_PREFIX, 'bi.id')}`);
  return afterCursor(visitBookedAfter(query, 'bi.customer_id', 'bi.captured_at'), 'bi.last_activity_at', 'bi.id', cursor)
    .orderBy([{ column: 'bi.last_activity_at', order: 'desc' }, { column: 'bi.id', order: 'desc' }])
    .limit(pageSize)
    .select('bi.id', 'bi.customer_id', 'bi.phone', 'bi.service_type', 'bi.slot_date', 'bi.slot_start', 'bi.slot_end',
      'bi.last_activity_at as drop_off_at', 'bi.pricing_estimate_id', conn.raw('bi.last_activity_at::text AS cursor_at'),
      conn.raw("COALESCE(NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), ''), NULLIF(trim(concat_ws(' ', bi.first_name, bi.last_name)), '')) AS name"));
}

// (B) estimate card-step drop-offs: one row per estimate (its newest event), the estimate still open.
function estimateCardQuery(conn, now, { cursor = null, pageSize = PAGE_SIZE } = {}) {
  const quietBefore = new Date(now.getTime() - QUIET_MINUTES * MIN_MS);
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const latest = conn('estimate_checkout_events')
    .groupBy('estimate_id')
    .havingRaw('max(updated_at) <= ?', [quietBefore])
    .havingRaw('max(updated_at) > ?', [since])
    .select('estimate_id', conn.raw('max(updated_at) AS last_at'))
    .as('ce');
  const query = conn.from(latest)
    .join('estimates as e', 'e.id', 'ce.estimate_id')
    .whereNull('e.accepted_at')
    .whereNull('e.archived_at')
    .whereRaw("COALESCE(e.status, '') NOT IN ('accepted', 'declined')")
    .whereRaw(`NOT ${KEY_TAKEN_SQL(CHECKOUT_KEY_PREFIX, 'e.id')}`);
  return afterCursor(visitBookedAfter(query, 'e.customer_id', 'ce.last_at'), 'ce.last_at', 'e.id', cursor)
    .orderBy([{ column: 'ce.last_at', order: 'desc' }, { column: 'e.id', order: 'desc' }])
    .limit(pageSize)
    .select('e.id', 'e.customer_id', 'e.customer_name', 'e.customer_phone', 'e.estimate_data', 'e.service_interest',
      'ce.last_at as drop_off_at', conn.raw('ce.last_at::text AS cursor_at'));
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');

function bookingItem(row) {
  return {
    key: `${BOOKING_KEY_PREFIX}${row.id}`,
    source: SOURCE_BOOKING_PAGE,
    sourceId: String(row.id),
    dropOffAt: new Date(row.drop_off_at),
    customerId: row.customer_id ? String(row.customer_id) : null,
    name: text(row.name),
    phone: text(row.phone),
    service: text(row.service_type),
    slot: row.slot_date ? { date: String(row.slot_date).slice(0, 10), start: text(row.slot_start), end: text(row.slot_end) } : null,
    estimateId: row.pricing_estimate_id ? String(row.pricing_estimate_id) : null,
  };
}

// The services an estimate is for, in the words the estimate screens use ("Pest Control + Lawn Care"), or ''.
function estimateService(row) {
  try {
    return text(require('./estimate-service-lines').inferEstimateServiceInterest({
      estimate_data: row.estimate_data, service_interest: row.service_interest,
    }));
  } catch (err) {
    logger.warn(`[portal-unfinished-bookings] estimate service not read: ${safeError(err)}`);
    return '';
  }
}

function estimateItem(row) {
  return {
    key: `${CHECKOUT_KEY_PREFIX}${row.id}`,
    source: SOURCE_ESTIMATE_CARD,
    sourceId: String(row.id),
    dropOffAt: new Date(row.drop_off_at),
    customerId: row.customer_id ? String(row.customer_id) : null,
    name: text(row.customer_name),
    phone: text(row.customer_phone),
    service: estimateService(row),
    slot: null,
    estimateId: String(row.id),
  };
}

const SOURCES = [
  { name: SOURCE_BOOKING_PAGE, query: bookingPageQuery, item: bookingItem },
  { name: SOURCE_ESTIMATE_CARD, query: estimateCardQuery, item: estimateItem },
];

// One page of one source's drop-offs that could ring now, before the person-contact check, and the cursor of the
// next page (null when this was the last one).
async function findDropOffPage(source, now, { conn = db, cursor = null, pageSize = PAGE_SIZE } = {}) {
  const rows = await source.query(conn, now, { cursor, pageSize });
  const items = rows.map(source.item).filter((item) => !Number.isNaN(item.dropOffAt.getTime()));
  const last = rows[rows.length - 1];
  return { items, next: rows.length < pageSize || !last ? null : { at: last.cursor_at, id: String(last.id) } };
}

// A person reached the customer after the drop-off: the witnesses' text, call back, answered call or Gmail send.
const reached = (bundle) => [bundle.textAt, bundle.backAt, bundle.inAt, bundle.replyAt]
  .some((at) => at && new Date(at).getTime() > bundle.anchor.getTime());

// The drop-offs no person has followed up. A customer-less drop-off is matched by its phone. A witness read that
// fails is no verdict and throws: nothing rings this run. A drop-off the witnesses cannot identify (no customer
// id and no usable phone) has no bundle and stays: only the converted / accepted closes can judge it.
async function withoutPersonContact(items, conn = db) {
  if (!items.length) return [];
  const { loadContactBundles } = require('./admin-alert-contact-witnesses');
  const bundles = await loadContactBundles(
    items.map((item) => ({
      id: item.key,
      kind: 'customer',
      bellAt: item.dropOffAt,
      refs: { customerId: item.customerId, ...(item.customerId ? {} : { phone: item.phone }) },
    })),
    // A visit booked is its own skip (the query's), judged on the live-booking predicate.
    { conn, bookedVisits: async () => new Map() },
  );
  return items.filter((item) => {
    const bundle = bundles.get(String(item.key));
    return !bundle || !reached(bundle);
  });
}

// ---- The bell --------------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "1 PM" / "1:30 PM" parts of an HH:MM time, or null.
function clockParts(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour12: hour % 12 || 12, minute, meridiem: hour >= 12 ? 'PM' : 'AM' };
}
const clockText = (p, withMeridiem) => `${p.hour12}${p.minute ? `:${String(p.minute).padStart(2, '0')}` : ''}${withMeridiem ? ` ${p.meridiem}` : ''}`;

// "1-2 PM", "11 AM-1 PM", "1 PM" (no end), or ''.
function timeRangeWords(start, end) {
  const from = clockParts(start);
  if (!from) return '';
  const to = clockParts(end);
  if (!to) return clockText(from, true);
  return from.meridiem === to.meridiem
    ? `${clockText(from, false)}-${clockText(to, true)}`
    : `${clockText(from, true)}-${clockText(to, true)}`;
}

// "Mon Nov 3, 1-2 PM": the day the visitor picked, as a person says it. '' when the date is unusable.
function slotWords(slot) {
  if (!slot) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(slot.date || '');
  if (!m) return '';
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  if (Number.isNaN(day.getTime())) return '';
  const when = `${WEEKDAYS[day.getUTCDay()]} ${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`;
  const range = timeRangeWords(slot.start, slot.end);
  return range ? `${when}, ${range}` : when;
}

// What happened, as the bell's one sentence.
function whyWords(item, who) {
  const service = item.service || '';
  if (item.source === SOURCE_ESTIMATE_CARD) {
    return `${who} opened the card step on ${service ? `a ${service}` : 'an'} estimate and did not finish`;
  }
  const picked = slotWords(item.slot);
  const forService = service ? ` for ${service}` : '';
  return picked ? `${who} picked ${picked}${forService} and did not finish` : `${who} started booking${forService} and did not finish`;
}

// The headline half: "Call <name>: booking not finished", the name cut to fit.
function actionWords(name) {
  if (!name) return 'Call a visitor: booking not finished';
  return require('./admin-alert-names').fitAction('Customers', name, [
    (who) => `Call ${who}: booking not finished`,
    (who) => `Call ${who}`,
  ]);
}

// Where a person opens it: the customer page, else the estimate, else a new text to the visitor's phone.
function linkFor(item) {
  if (item.customerId) return `/admin/customers?customerId=${encodeURIComponent(item.customerId)}`;
  if (item.estimateId) return `/admin/estimates?estimateId=${encodeURIComponent(item.estimateId)}`;
  return `/admin/communications?phone=${encodeURIComponent(item.phone)}&action=sms#tab=sms`;
}

// The alert's words for a name. A name that breaks the alert rules (a typed full stop before a capital, a
// code-shaped word) falls back to the first word, then to no name: the bell is raised either way.
function composeWords(item) {
  const { breaksAlertRules, cutAtWord } = require('./admin-alert-compose');
  const { tidyName } = require('./admin-alert-names');
  const full = tidyName(item.name);
  const attempts = [full, full.split(' ')[0], ''];
  for (const name of attempts) {
    const why = cutAtWord(whyWords(item, name || 'A visitor'), MAX_WHY_CHARS);
    const action = actionWords(name);
    if (!breaksAlertRules(why) && !breaksAlertRules(action)) return { action, why, name };
  }
  return { action: 'Call a visitor: booking not finished', why: 'A visitor started booking and did not finish', name: '' };
}

function bellMetadata(item) {
  return {
    ...(item.customerId ? { customerId: item.customerId } : {}),
    ...(item.source === SOURCE_BOOKING_PAGE ? { bookingIntentId: item.sourceId } : { checkoutEstimateId: item.sourceId }),
    ...(item.source === SOURCE_BOOKING_PAGE && item.estimateId ? { pricingEstimateId: item.estimateId } : {}),
    source: item.source,
    service: item.service || null,
    slotDate: item.slot?.date || null,
    slotStart: item.slot?.start || null,
    slotEnd: item.slot?.end || null,
    dropOffAt: item.dropOffAt.toISOString(),
    // A visitor with no customer on file: the Portal tab and the contact check read these.
    ...(item.customerId ? {} : { contactName: item.name || null, contactPhone: item.phone || null }),
  };
}

// What the bell is about: the customer, else the estimate, else the intent as a lead.
function subjectFor(item) {
  if (item.customerId) return { type: 'customer', id: item.customerId };
  return item.source === SOURCE_ESTIMATE_CARD ? { type: 'estimate', id: item.sourceId } : { type: 'lead', id: item.sourceId };
}

// Raise the one bell. Returns { id, isNew } or null when nothing was written. The default dedupe finds a row
// with this key, open or done, so a drop-off never rings twice.
async function raiseBell(item) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const { action, why } = composeWords(item);
  const result = await raiseAdminAlert('alert', {
    area: 'Customers',
    action,
    why,
    severity: 'needs-you',
    link: linkFor(item),
    subject: subjectFor(item),
    doneWhen: 'customer_answered',
    who: 'person',
  }, {
    bell: true,
    dedupeKey: item.key,
    metadata: bellMetadata(item),
  });
  if (!result?.id || result.suppressed) return null;
  return { id: result.id, isNew: result.deduped === false, why, action };
}

// Phone push for an app ask (portal-ask-push.js) is added by another change; this module rings the bell alone.

async function raiseAll(items) {
  let raised = 0;
  for (const item of items) {
    try {
      const done = await raiseBell(item);
      if (done?.isNew) raised += 1;
    } catch (err) {
      logger.warn(`[portal-unfinished-bookings] bell for ${item.source} ${item.sourceId} not raised: ${safeError(err)}`);
    }
  }
  return raised;
}

// Every page of one source, up to MAX_PAGES: each page's unanswered drop-offs ring before the next page is read.
// A witness read that fails is no verdict: it throws, nothing more rings this run, and the next sweep reads again.
async function sweepSource(source, now, conn, pageSize) {
  let cursor = null;
  let found = 0;
  let raised = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { items, next } = await findDropOffPage(source, now, { conn, cursor, pageSize });
    found += items.length;
    if (items.length) raised += await raiseAll(await withoutPersonContact(items, conn));
    if (!next) return { found, raised };
    cursor = next;
  }
  logger.warn(`[portal-unfinished-bookings] ${source.name}: stopped after ${MAX_PAGES} pages; the next sweep reads the rest`);
  return { found, raised };
}

async function runPortalUnfinishedBookings({ now = new Date(), conn = db, pageSize = PAGE_SIZE } = {}) {
  if (!require('../config/feature-gates').portalBookingItemsLive?.()) return { skipped: true, reason: 'gate_off' };
  let found = 0;
  let raised = 0;
  try {
    for (const source of SOURCES) {
      const result = await sweepSource(source, now, conn, pageSize);
      found += result.found;
      raised += result.raised;
    }
  } catch (err) {
    logger.warn(`[portal-unfinished-bookings] stopped, nothing more raised this run: ${safeError(err)}`);
  }
  if (raised) logger.info(`[portal-unfinished-bookings] raised ${raised} bell(s) for bookings not finished`);
  return { skipped: false, found, raised };
}

module.exports = {
  WINDOW_DAYS,
  QUIET_MINUTES,
  KEY_PREFIX,
  BOOKING_KEY_PREFIX,
  CHECKOUT_KEY_PREFIX,
  SOURCE_BOOKING_PAGE,
  SOURCE_ESTIMATE_CARD,
  SOURCES,
  findDropOffPage,
  withoutPersonContact,
  slotWords,
  composeWords,
  runPortalUnfinishedBookings,
};
