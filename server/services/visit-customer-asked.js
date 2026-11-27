/**
 * "Customer asked" facts for the technician's Visit Brief (owner 2026-11-26: the tech should have context for a
 * request, or messages from the portal or app, like re-service notes or reminder notes from the customer).
 *
 * Read-only, no AI, no gate of its own. Four sources, each read by an existing path:
 *   reservice_reason / reservice_words  gatherReserviceAsks (GATE_RESERVICE_ASKS) with skipCalls, as the technician
 *                                       route calls it: the same scrubbed, capped list the close-out sheet reads. No
 *                                       call-derived words and no office-only message ever show (owner ruling D1 A
 *                                       2026-11-04).
 *   booking_note                        the note a customer typed when self-booking: the original booking's
 *                                       customer_notes, else the visit's notes line.
 *   portal_message                      what the customer typed on the portal Messages screen in the 7 days before the
 *                                       visit: their own messages only, never an office or AI reply, never one with a
 *                                       money word, a link or a run of 3+ digits.
 *   portal_request                      the customer's open portal requests for THIS property (or this appointment,
 *                                       for a reschedule request): the service and their own words, never a price,
 *                                       a pricing snapshot or an office-written description.
 *
 * Words from the re-service gather keep its customer-words scrub ('reservice' lane). A booking note and a portal
 * request are shown as typed: a technician needs the access details and the "call before you come" lines the scrub
 * would drop, and un-scrubbing would need new code.
 *
 * Every source fails on its own: a failed read logs its error code (never the customer's text) and yields nothing.
 */

const logger = require('./logger');
const { parseETDateTime, etCalendarDayOf, addETDays, etDateString, validCalendarDate } = require('../utils/datetime-et');

const MAX_ITEMS = 8;
const MAX_TEXT_CHARS = 280;
// Rows shown, and rows read: a row whose stored address is another home's is dropped after the read.
const PORTAL_ROW_LIMIT = 5;
const PORTAL_READ_LIMIT = 40;
// The portal form's categories that name a service or a visit; billing, cancellation, pause and moving requests are
// the office's.
const PORTAL_CATEGORIES = ['pest_issue', 'lawn_concern', 'add_service', 'schedule_change', 'upgrade', 'other'];
const ASK_SOURCE = { request_form: 'picker', text: 'text', office: 'office' };
const RESCHEDULE_SOURCE = 'customer_portal_reschedule';
// A null-source row is the customer's portal form only when it says so: the writer mark routes/requests.js stamps, or
// the property or photo-id stamp only that form writes. Other null-source rows (the cancel flow's re-service request,
// office follow-ups) hold case ids and office instructions in the description, so they never show. The mark tells the
// typed form ('portal_form': the customer's own words) from the pricing flows ('portal_flow': a generated description
// that holds prices); a row with only the stamp is an older row of either kind.
const PORTAL_FORM_SQL = "(metadata->>'writer' IN ('portal_form', 'portal_flow') OR metadata->>'propertyId' IS NOT NULL OR metadata->'photoIdSource' IS NOT NULL)";
// The reschedule route (routes/schedule.js) writes the description as "Appointment <id>: <type> on <date>", then the
// preferred date and "Customer notes: <text>" lines; each later update appends a "Customer updated <ET date>:" block.
const RESCHEDULE_UPDATE_SPLIT_RE = /\n(?=Customer updated \d{4}-\d{2}-\d{2}:)/;
const RESCHEDULE_UPDATE_DATE_RE = /^Customer updated (\d{4}-\d{2}-\d{2}):/;
const RESCHEDULE_NOTE_RE = /Customer notes: ([\s\S]*)$/;

// No prices on a technician screen (owner rule). An amount is a money sign, a dollar word, or a price-shaped number
// (a comma thousand like 1,200, or two decimals like 49.95). The word screen adds what a message or an older
// description must also pass: price, cost, charge, refund, invoice, quote and the like.
const MONEY_AMOUNT_RE = /[$€£]|\b(?:usd|dollars?|bucks?)\b|\b\d{1,3}(?:,\d{3})+\b|\b\d+\.\d{2}\b/i;
const MONEY_WORD_RE = /\b(?:price|prices|pricing|priced|cost|costs|costing|charge|charged|charges|refund\w*|invoice\w*|bill|billed|billing|pay|paid|payment\w*|fees?|quote\w*|estimate\w*|discount\w*|total|balance|deposit|owe|owed|credit|card)\b/i;
const moneyFree = (text) => !MONEY_AMOUNT_RE.test(text);
const moneyWordFree = (text) => moneyFree(text) && !MONEY_WORD_RE.test(text);

const newestFirst = (a, b) => Date.parse(b.at) - Date.parse(a.at);
const compact = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

function clip(text, max = MAX_TEXT_CHARS) {
  const words = compact(text);
  return words.length <= max ? words : `${words.slice(0, max - 1).replace(/[\s.,;:!?-]+$/, '')}…`;
}

const iso = (value) => {
  const d = new Date(value);
  return value == null || Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// Every item of every kind passes the money-amount screen: an item with a price in its words is dropped.
function entry(kind, at, text, extra = {}) {
  const when = iso(at);
  const words = clip(text);
  return when && words && moneyFree(words) ? { kind, at: when, text: words, ...extra } : null;
}

async function safely(name, read) {
  try {
    return await read();
  } catch (err) {
    logger.warn(`[visit-customer-asked] ${name} unreadable: ${err?.code || err?.name || 'Error'}`);
    return [];
  }
}

// The customer's words behind a re-service. The booking item is the reason; every other kept item is a later message.
// skipCalls is the technician route's own rule: no call-derived item is returned, the booking paraphrase of a call
// included.
async function reserviceItems(svc, dbh) {
  if (!require('../config/feature-gates').reserviceAsksLive()) return [];
  const gathered = await require('./reservice-asks').gatherReserviceAsks(svc.id, { knex: dbh, skipCalls: true });
  if (!gathered?.ok) return [];
  const bookingId = `booking:${svc.id}`;
  return gathered.items
    .filter((item) => item.text && !item.officeOnly)
    .map((item) => {
      const reason = item.id === bookingId;
      const source = reason || item.source === 'text' ? ASK_SOURCE[item.source] : undefined;
      return entry(reason ? 'reservice_reason' : 'reservice_words', item.at, item.text, {
        ...(item.pests?.length ? { pests: item.pests } : {}),
        ...(source ? { source } : {}),
        // A text or email names no property: on an account that may have several, it may be about another home. The
        // technician route keeps such items with the flag; so does this list, and the screen says so.
        ...(item.accountWide ? { accountWide: true } : {}),
      });
    });
}

// The booking row, when it is the public booking form's. Two writers make self_booked_appointments rows: the public
// form (routes/booking.js) always stamps `source` ('direct', a fleet site, 'reservice_link'), and the AI assistant's
// book_appointment (availability.confirmBooking) writes none. Only the form's row holds words the customer typed.
async function typedBookingRow(svc, dbh) {
  const row = await dbh('self_booked_appointments').where({ id: svc.self_booking_id }).first('customer_notes', 'source');
  return row && row.source ? row : null;
}

// Only on the visit the customer booked (linked to a public self-booking whose row proves the form wrote it): the
// recurring seeder copies the parent's notes onto every follow-up it seeds, and the AI assistant's booking notes are
// not the customer's typing. An unreadable row proves nothing, so nothing shows.
async function bookingNoteItems(svc, dbh) {
  if (!svc.self_booking_id) return [];
  const row = await typedBookingRow(svc, dbh);
  if (!row) return [];
  const text = require('./reservice-asks').selfBookedNoteText(svc.notes, row.customer_notes);
  return text ? [entry('booking_note', svc.created_at, text)] : [];
}

// Does this account provably have ONE premises? The re-service asks' own fail-closed proof; a failed read is "no".
async function singlePremises(svc, dbh) {
  try {
    return await require('./reservice-property-scope').accountProvesSinglePremises(dbh, svc.customer_id);
  } catch (err) {
    logger.warn(`[visit-customer-asked] premises proof unavailable: ${err?.code || err?.name || 'Error'}`);
    return false;
  }
}

// The customer_properties ids this visit's premises are, or null when the account has one premises (no filter). The
// repo's visit-property-scope resolver reads the visit's own stamp, then its property_id, then its source estimate;
// a visit with none of the three is an unstamped visit and belongs to the primary property (the visit rule of
// account-properties.js). A stamp or link that cannot be resolved matches nothing: the request is withheld.
async function visitPropertyIds(svc, dbh, scope) {
  try {
    const { sameResolvedProperty } = require('./service-report/visit-property-scope');
    const linkage = require('./estimate-property-linkage');
    const props = await dbh('customer_properties')
      .where({ customer_id: svc.customer_id, active: true })
      .select('id', 'is_primary', 'address_line1', 'address_line2', 'city', 'zip');
    if (!scope.hasEvidence) return (props || []).filter((p) => p.is_primary === true).map((p) => String(p.id));
    if (!scope.key) return [];
    return (props || []).filter((p) => {
      const key = linkage.normalizedStampedStreet(p.address_line1, p.address_line2, p.city, p.zip);
      return key && sameResolvedProperty(scope.key, key);
    }).map((p) => String(p.id));
  } catch (err) {
    logger.warn(`[visit-customer-asked] visit premises unreadable: ${err?.code || err?.name || 'Error'}`);
    return [];
  }
}

// The visit's premises key (stamp, property_id, source estimate). An unreadable resolve is "stamp present, not
// resolved": it matches nothing.
async function visitScope(svc, dbh) {
  try {
    return await require('./service-report/visit-property-scope').resolveVisitPropertyScope(svc, dbh);
  } catch (err) {
    logger.warn(`[visit-customer-asked] visit scope unreadable: ${err?.code || err?.name || 'Error'}`);
    return { key: null, hasEvidence: true };
  }
}

function metaOf(row) {
  let meta = row.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = null; }
  }
  return meta && typeof meta === 'object' ? meta : null;
}

// The address the portal form stored on a request (metadata.property.address, one line), or null.
const storedAddress = (row) => metaOf(row)?.property?.address || null;

// An unstamped visit is on the primary property: its premises key is the customer's CURRENT primary property address
// (the customer row's own address when no property row exists). Nothing resolvable is "stamp present, not resolved":
// it matches nothing.
async function primaryScope(svc, dbh) {
  try {
    const linkage = require('./estimate-property-linkage');
    const columns = ['address_line1', 'address_line2', 'city', 'zip'];
    const property = await dbh('customer_properties').where({ customer_id: svc.customer_id, is_primary: true, active: true }).first(...columns);
    const source = property || await dbh('customers').where({ id: svc.customer_id }).first(...columns);
    const key = source ? linkage.normalizedStampedStreet(source.address_line1, source.address_line2, source.city, source.zip) : null;
    return { hasEvidence: true, key: key && !linkage.scopeKeyLacksLocality(key) ? key : null };
  } catch (err) {
    logger.warn(`[visit-customer-asked] primary address unreadable: ${err?.code || err?.name || 'Error'}`);
    return { hasEvidence: true, key: null };
  }
}

// The stored address against the visit's premises: it is what the customer saw, so it is checked on every path,
// single premises and an unstamped primary visit included (`scope` is then the primary address). A request with no
// stored address keeps the property-id rule alone.
function storedAddressMatches(row, scope) {
  const address = storedAddress(row);
  if (!address) return true;
  if (!scope.key) return false;
  const { sameResolvedProperty } = require('./service-report/visit-property-scope');
  const key = require('./estimate-property-linkage').normalizedEstimateStreet(address);
  return !!key && sameResolvedProperty(scope.key, key);
}

// A portal request belongs to this visit's property when it was filed for it. A request that names no property shows
// only when the account provably has one premises (propertyIds null). Otherwise it is withheld.
function propertyFilter(query, propertyIds) {
  if (propertyIds === null) return query;
  if (!propertyIds.length) return query.whereRaw('false');
  return query.whereRaw(`metadata->>'propertyId' IN (${propertyIds.map(() => '?').join(', ')})`, propertyIds);
}

const appointmentHeader = (svc) => `Appointment ${svc.id}: `;

// The query is built before the row limit applies: the property, writer and appointment filters all run in SQL.
function portalRowsQuery(dbh, svc, propertyIds) {
  const { CTA_REQUEST_SOURCES } = require('./cta-service-request');
  const { OPEN_REQUEST_TERMINAL_STATUSES } = require('./estimate-add-service-request');
  return dbh('service_requests')
    .where({ customer_id: svc.customer_id })
    .where(function openRows() {
      this.whereNull('status').orWhereNotIn('status', OPEN_REQUEST_TERMINAL_STATUSES);
    })
    .where(function ownRows() {
      this.where(function propertyRows() {
        this.whereIn('category', PORTAL_CATEGORIES)
          .where(function writtenByCustomerSurface() {
            this.whereIn('source', CTA_REQUEST_SOURCES)
              .orWhere(function portalForm() { this.whereNull('source').whereRaw(PORTAL_FORM_SQL); });
          });
        propertyFilter(this, propertyIds);
      }).orWhere(function thisAppointment() {
        this.where({ category: 'schedule_change', source: RESCHEDULE_SOURCE })
          .whereRaw('left(COALESCE(description, \'\'), ?) = ?', [appointmentHeader(svc).length, appointmentHeader(svc)]);
      });
    })
    // Newest by creation, never by last change: an office edit bumps updated_at and must not displace a newer ask.
    // A revised reschedule note is dated in JS (rescheduleNote), after a read deep enough to cover it.
    .orderBy('created_at', 'desc')
    .limit(PORTAL_READ_LIMIT)
    .select('subject', 'description', 'source', 'created_at', 'metadata');
}

// The customer's own note from a reschedule request, dated by the update that supplied it: the newest block with a
// "Customer notes:" line. The first block is the request itself (the row's date). A later block carries an ET date
// the customer's own text could also spell: it counts only as a real calendar date between the request and now, at
// noon Eastern (the one timestamp used to rank and to show); anything else falls back to the row's date.
function rescheduleNote(description, createdAt, now = new Date()) {
  const blocks = String(description || '').split(RESCHEDULE_UPDATE_SPLIT_RE);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const note = compact(RESCHEDULE_NOTE_RE.exec(blocks[i])?.[1]);
    if (!note) continue;
    const day = i === 0 ? null : validCalendarDate(RESCHEDULE_UPDATE_DATE_RE.exec(blocks[i])?.[1]);
    const stamped = day ? parseETDateTime(`${day}T12:00`) : null;
    const usable = stamped && stamped >= new Date(createdAt) && stamped <= now;
    return { note, at: usable ? stamped : createdAt };
  }
  return null;
}

// The words of a portal request row. A card or chat row carries a server-written description: its subject (the
// service) only. A typed portal form row shows the customer's description, once it passes the money-amount screen;
// the pricing flows ('portal_flow', and any older row with only the stamp) post a GENERATED description that holds
// prices: the first shows its subject only, the second its description only if it passes the whole money screen. The
// typed form's subject is the description's first 80 characters, so a description that starts with its subject is
// shown alone.
function requestRowText(row) {
  const subject = compact(row.subject);
  if (row.source) return subject;
  const description = compact(row.description);
  const writer = metaOf(row)?.writer;
  const shown = writer === 'portal_form' ? moneyFree(description) : writer !== 'portal_flow' && moneyWordFree(description);
  if (!description || !shown) return subject;
  return description.toLowerCase().startsWith(subject.toLowerCase()) ? description : `${subject}: ${description}`;
}

// Open requests the customer made in the portal or the app. A reschedule request for this appointment shows only the
// note the customer typed, dated by the update that supplied it.
async function portalItems(svc, dbh, singleSoon) {
  const single = await singleSoon;
  const scope = await visitScope(svc, dbh);
  const rows = await portalRowsQuery(dbh, svc, single ? null : await visitPropertyIds(svc, dbh, scope));
  // An unstamped visit resolves its premises only when a row has an address to check against.
  const checkScope = scope.hasEvidence || !(rows || []).some(storedAddress) ? scope : await primaryScope(svc, dbh);
  // Entries first, empties dropped (a preferred-date-only reschedule), THEN the limit.
  return (rows || [])
    .filter((row) => storedAddressMatches(row, checkScope))
    .map((row) => {
      if (row.source === RESCHEDULE_SOURCE) {
        const revised = rescheduleNote(row.description, row.created_at);
        // `appointment` marks a note that belongs to this one appointment, so a grouped stop keeps it with its service.
        return revised ? entry('portal_request', revised.at, revised.note, { source: 'portal', appointment: true }) : null;
      }
      return entry('portal_request', row.created_at, requestRowText(row), { source: 'portal' });
    })
    .filter(Boolean)
    .sort(newestFirst)
    .slice(0, PORTAL_ROW_LIMIT);
}

// At most MAX_ITEMS: the return reason (why the visit exists) always has its slot, the newest others fill the rest,
// then everything is ordered newest first for display.
function pickItems(items) {
  const reason = items.filter((item) => item.kind === 'reservice_reason').sort(newestFirst)[0];
  const others = items.filter((item) => item !== reason).sort(newestFirst);
  return [...(reason ? [reason] : []), ...others.slice(0, MAX_ITEMS - (reason ? 1 : 0))].sort(newestFirst);
}

// The customer's own words on the portal Messages screen (channel 'portal', inbound, authored by the customer): the
// 7 ET days up to the visit's day, never past now. An office or AI reply, an internal note and the SMS channel are
// never read. A message about money, a link or a number run is left out, as is an office-only message (a refund, a
// complaint). The portal names no home: on an account that may have several, it may be about another one.
const PORTAL_MESSAGE_WINDOW_DAYS = 7;
const LINK_RE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|co|io|app|link|us|info|biz|me)\b/i;
const NUMBER_RUN_RE = /\d{3,}/;

function messageWindow(svc, now = new Date()) {
  const day = etCalendarDayOf(svc.scheduled_date) || etDateString(now);
  const noon = parseETDateTime(`${day}T12:00`);
  const since = parseETDateTime(`${etDateString(addETDays(noon, -PORTAL_MESSAGE_WINDOW_DAYS))}T00:00`);
  const dayEnd = parseETDateTime(`${etDateString(addETDays(noon, 1))}T00:00`);
  return { since, until: dayEnd < now ? dayEnd : now };
}

const safeMessage = (text) => moneyWordFree(text) && !LINK_RE.test(text) && !NUMBER_RUN_RE.test(text)
  && !require('./reservice-office-only').officeOnlyReason(text);

async function portalMessageItems(svc, dbh, singleSoon) {
  if (!require('../config/feature-gates').portalMessagesLive()) return [];
  const { since, until } = messageWindow(svc);
  const rows = await dbh('messages as m')
    .join('conversations as c', 'c.id', 'm.conversation_id')
    .where({ 'c.customer_id': svc.customer_id, 'c.channel': 'portal', 'm.channel': 'portal', 'm.direction': 'inbound', 'm.author_type': 'customer', 'm.message_type': 'portal_message' })
    .where('m.created_at', '>=', since)
    .where('m.created_at', '<=', until)
    .orderBy('m.created_at', 'desc')
    .limit(PORTAL_READ_LIMIT)
    .select('m.body', 'm.created_at');
  const accountWide = !(await singleSoon);
  return (rows || [])
    .filter((row) => compact(row.body) && safeMessage(compact(row.body)))
    .slice(0, PORTAL_ROW_LIMIT)
    .map((row) => entry('portal_message', row.created_at, row.body, { source: 'portal', ...(accountWide ? { accountWide: true } : {}) }));
}

/**
 * @param {object} svc the visit's scheduled_services row
 * @returns {Promise<{ items: object[] } | null>} Newest first, one entry per wording, at most 8; null when nothing.
 */
async function customerAskedFacts(svc, dbh) {
  // The premises proof is read once for both portal sources; it never rejects (a failed read is "not single").
  const single = singlePremises(svc, dbh);
  const lists = await Promise.all([
    safely('re-service asks', () => reserviceItems(svc, dbh)),
    safely('booking note', () => bookingNoteItems(svc, dbh)),
    safely('portal requests', () => portalItems(svc, dbh, single)),
    safely('portal messages', () => portalMessageItems(svc, dbh, single)),
  ]);
  const seen = new Set();
  const items = lists.flat().filter(Boolean).filter((item) => {
    const key = item.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const picked = pickItems(items);
  return picked.length ? { items: picked } : null;
}

module.exports = { customerAskedFacts, MAX_ITEMS, MAX_TEXT_CHARS, _test: { requestRowText, portalMessageItems, safeMessage, messageWindow, portalRowsQuery, rescheduleNote, visitPropertyIds, storedAddressMatches, pickItems } };
