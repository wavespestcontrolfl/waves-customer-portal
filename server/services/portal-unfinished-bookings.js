/**
 * Unfinished bookings reach a person (GATE_PORTAL_BOOKING_ITEMS, owner 2026-11-02, unworked-leads audit).
 *
 * A customer opened the card step of an estimate our office sent (an estimate_checkout_events row, kind
 * recurring_card or card_hold) and left without accepting. Nothing followed and nobody was told. This raises ONE
 * admin bell per such estimate, so a person calls. It is an admin row, never a service request: a request is shown
 * to the customer in the app and a status change sends them a notice.
 *
 * Scope (owner 2026-11-02, "A"): only an estimate our office sent: made by staff (its maker is on the row) or
 * drafted by the call and text estimator, so its link went only to the contact we chose or to the number that
 * called or texted us (99 of 105 card-step drop-offs, Jun-Nov 2026). Booking-page starts and website estimates are
 * left out: anyone can type any phone number there and nothing verifies it, so they keep today's automatic
 * recovery text and email until the booking page can check phone numbers.
 *
 * - Drop-off time: the newest checkout event's updated_at of the estimate. It counts after QUIET_MINUTES with no
 *   new touch, and only if it is not older than WINDOW_DAYS, so turning the gate on cannot burst old rows.
 * - Skipped: an estimate accepted, declined or archived; a customer with a live visit booked (any way) after the
 *   drop-off; a drop-off a PERSON already followed up (the shared witnesses in admin-alert-contact-witnesses.js:
 *   a person's text, a call a person placed or answered, a person's Gmail send, after the drop-off); an estimate
 *   that already has a bell with its key, open or done.
 * - Customer-less: an estimate with no customer_id (the staff estimator can keep only customer_name and
 *   customer_phone) still gets a bell. The contact check then matches by its PHONE; the "booked a visit" skip
 *   needs a customer id, so only the estimate's own end closes it then.
 * - One bell per key: dedupeKey `portal-unfinished-checkout:<estimate id>`, notifyAdmin's default dedupe (finds a
 *   done row too). The query also leaves out a key whose row exists, so a bell a person marked done never rings
 *   again.
 * - The bell is closed by admin-alert-relevance.js (class portal_unfinished_booking) and listed on the
 *   Communications Portal tab by portal-inbox.js.
 * - A new bell also pages the admin phones once (GATE_PORTAL_ASK_PUSH, portal-ask-push.js), like the app's other asks.
 * - Sends nothing to a customer: no text, email, call or app notice. Admin bell rows and admin phone pages only.
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
// many contacted ones still ring. At most MAX_PAGES pages per run; a run that stops there says so, and the next
// sweep starts again from the newest.
const PAGE_SIZE = 200;
const MAX_PAGES = 10;
// An estimate our office sent: made by staff (its maker is on the row), or drafted by the call and text estimator
// (estimate-learning.js AI_DRAFT_SOURCES), never a website or self-served source. Not source 'manual': it is the
// column's default, so a path that sets no source would pass as the office's.
const OFFICE_ESTIMATE_SQL = "(e.created_by_technician_id IS NOT NULL OR e.source IN ('estimator_engine', 'ai_agent'))";
const KEY_PREFIX = 'portal-unfinished-';
const CHECKOUT_KEY_PREFIX = 'portal-unfinished-checkout:';
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

// Card-step drop-offs: one row per estimate (its newest event), an estimate our office sent and still open.
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
    .whereRaw(OFFICE_ESTIMATE_SQL)
    .whereRaw(`NOT ${KEY_TAKEN_SQL(CHECKOUT_KEY_PREFIX, 'e.id')}`);
  return afterCursor(visitBookedAfter(query, 'e.customer_id', 'ce.last_at'), 'ce.last_at', 'e.id', cursor)
    .orderBy([{ column: 'ce.last_at', order: 'desc' }, { column: 'e.id', order: 'desc' }])
    .limit(pageSize)
    .select('e.id', 'e.customer_id', 'e.customer_name', 'e.customer_phone', 'e.estimate_data', 'e.service_interest',
      'ce.last_at as drop_off_at', conn.raw('ce.last_at::text AS cursor_at'));
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');

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
    estimateId: String(row.id),
  };
}

// One page of drop-offs that could ring now, before the person-contact check, and the cursor of the next page
// (null when this was the last one).
async function findDropOffPage(now, { conn = db, cursor = null, pageSize = PAGE_SIZE } = {}) {
  const rows = await estimateCardQuery(conn, now, { cursor, pageSize });
  const items = rows.map(estimateItem).filter((item) => !Number.isNaN(item.dropOffAt.getTime()));
  const last = rows[rows.length - 1];
  return { items, next: rows.length < pageSize || !last ? null : { at: last.cursor_at, id: String(last.id) } };
}

// A person reached the customer after the drop-off: the witnesses' text, call back, answered call or Gmail send.
const reached = (bundle) => [bundle.textAt, bundle.backAt, bundle.inAt, bundle.replyAt]
  .some((at) => at && new Date(at).getTime() > bundle.anchor.getTime());

// The drop-offs no person has followed up. A customer-less drop-off is matched by its phone. A witness read that
// fails is no verdict and throws: nothing rings this run. A drop-off the witnesses cannot identify (no customer
// id and no usable phone) has no bundle and stays: only the estimate's own end can close it.
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

// What happened, as the bell's one sentence.
function whyWords(item, who) {
  return `${who} opened the card step on ${item.service ? `a ${item.service}` : 'an'} estimate and did not finish`;
}

// The headline half: "Call <name>: booking not finished", the name cut to fit.
function actionWords(name) {
  if (!name) return 'Call a visitor: booking not finished';
  return require('./admin-alert-names').fitAction('Customers', name, [
    (who) => `Call ${who}: booking not finished`,
    (who) => `Call ${who}`,
  ]);
}

// Where a person opens it: the customer page, else the estimate.
function linkFor(item) {
  if (item.customerId) return `/admin/customers?customerId=${encodeURIComponent(item.customerId)}`;
  return `/admin/estimates?estimateId=${encodeURIComponent(item.estimateId)}`;
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
  return { action: 'Call a visitor: booking not finished', why: 'A visitor opened the card step on an estimate and did not finish', name: '' };
}

function bellMetadata(item) {
  return {
    ...(item.customerId ? { customerId: item.customerId } : {}),
    checkoutEstimateId: item.sourceId,
    source: item.source,
    service: item.service || null,
    dropOffAt: item.dropOffAt.toISOString(),
    // An estimate with no customer on file: the Portal tab and the contact check read these.
    ...(item.customerId ? {} : { contactName: item.name || null, contactPhone: item.phone || null }),
  };
}

// What the bell is about: the customer, else the estimate.
function subjectFor(item) {
  return item.customerId ? { type: 'customer', id: item.customerId } : { type: 'estimate', id: item.sourceId };
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

// GATE_PORTAL_ASK_PUSH: a new bell also pages the admin phones, once (a dedupe never pages). This waits for the
// name read only; the page goes out from portal-ask-push.js's queue, never awaited, so it cannot hold the sweep.
// First name and last initial, no phone: a push shows on a lock screen. Never throws.
async function pushNewBell(item) {
  try {
    if (!require('../config/feature-gates').portalAskPushLive?.()) return;
    const { pushPortalAsk, customerShortName, shortName } = require('./portal-ask-push');
    const [first, ...rest] = require('./admin-alert-names').tidyName(item.name).split(' ');
    const name = item.customerId ? await customerShortName(item.customerId) : shortName(first, rest.pop());
    void pushPortalAsk({
      itemKey: item.key,
      title: 'Booking not finished',
      body: whyWords(item, name),
      link: linkFor(item),
      customerId: item.customerId,
    });
  } catch (err) {
    logger.warn(`[portal-unfinished-bookings] push for estimate ${item.sourceId} failed: ${safeError(err)}`);
  }
}

async function raiseAll(items) {
  let raised = 0;
  for (const item of items) {
    try {
      const done = await raiseBell(item);
      if (done?.isNew) {
        raised += 1;
        await pushNewBell(item);
      }
    } catch (err) {
      logger.warn(`[portal-unfinished-bookings] bell for estimate ${item.sourceId} not raised: ${safeError(err)}`);
    }
  }
  return raised;
}

// Every page, up to MAX_PAGES: each page's unanswered drop-offs ring before the next page is read. A witness read
// that fails is no verdict: it throws, nothing more rings this run, and the next sweep reads again.
async function runPortalUnfinishedBookings({ now = new Date(), conn = db, pageSize = PAGE_SIZE } = {}) {
  if (!require('../config/feature-gates').portalBookingItemsLive?.()) return { skipped: true, reason: 'gate_off' };
  let found = 0;
  let raised = 0;
  try {
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { items, next } = await findDropOffPage(now, { conn, cursor, pageSize });
      found += items.length;
      if (items.length) raised += await raiseAll(await withoutPersonContact(items, conn));
      if (!next) break;
      if (page === MAX_PAGES - 1) logger.warn(`[portal-unfinished-bookings] stopped after ${MAX_PAGES} pages; the next sweep reads the rest`);
      cursor = next;
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
  CHECKOUT_KEY_PREFIX,
  SOURCE_ESTIMATE_CARD,
  findDropOffPage,
  withoutPersonContact,
  composeWords,
  runPortalUnfinishedBookings,
};
