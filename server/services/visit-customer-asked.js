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
// (a comma thousand like 1,200, or two decimals like 49.95), or a whole number paired with a billing unit or a pricing
// word ("149/month", "quoted 149", "for 149"); room numbers and counts ("room 149", "3 dogs") stay. The word screen adds what a message or an older
// description must also pass.
const BILLING_UNITS = 'month|mo|year|yr|visit|application|treatment|service|quarter|week|time|spray|trip|stop';
const PRICING_WORDS = 'quoted?|priced?|prices?|cost|costs|costing|charged?|charges|fees?|rates?|paid|pay|owe|owed|deposit|balance|quote|estimate|dollars?|bucks?';
const MONEY_AMOUNT_RES = [
  /[$€£]|\b(?:usd|dollars?|bucks?)\b|\b\d{1,3}(?:,\d{3})+\b|\b\d+\.\d{2}\b/i,
  // A whole-number amount with a billing unit: "149/month", "149 per application", "149 a visit".
  new RegExp(`\\b\\d+\\s*(?:/|per\\b|a\\b|an\\b|each\\b|every\\b)\\s*(?:${BILLING_UNITS})s?\\b`, 'i'),
  // A whole-number amount beside a pricing word, either order: "quoted 149", "149 total price", "for 149".
  new RegExp(`\\b(?:${PRICING_WORDS})\\b[^.\\n\\d]{0,20}\\b\\d{2,}\\b|\\b\\d{2,}\\b[^.\\n\\d]{0,12}\\b(?:${PRICING_WORDS})\\b|\\bfor\\s+\\d{3,}\\b`, 'i'),
];
const moneyFree = (text) => !MONEY_AMOUNT_RES.some((re) => re.test(text));

// A query builder never runs with a missing customer: knex turns { customer_id: null } into IS NULL.
function requireCustomer(svc) {
  if (!svc?.customer_id) throw new Error('customer_id required');
}

// Return reason, booking note and reschedule note are about this appointment; the rest is the customer's, account-wide.
const belongsToAppointment = (item) => item.kind === 'reservice_reason' || item.kind === 'booking_note' || item.appointment === true;

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

// The one body screen for every free-text item of every kind: the screen the texts to a technician use
// (tech-visit-texts.js screenBodyForTechnician: money words, card / bank / credential / sign-in / secret cues, a run of 3+
// digits with times and dates exempt, a link on any host, payment-scoped text, the customer's stored access codes), plus this
// module's own price-shape screen (a whole-number amount beside a billing unit). Loaded on first use.
function screenOk(text, codes) {
  return moneyFree(text) && require('./tech-visit-texts').screenBodyForTechnician(text, { codes }) === 'ok';
}

// An office-only message (damage we caused, money, a complaint, a missed visit) is the office's: nothing of it shows.
const officeOnly = (text) => Boolean(require('./reservice-office-only').officeOnlyReason(text));

// Run on the FULL text, before the 280-character cut (a price or a link past the cut must not slip through because the cut
// hid it): an item that fails is dropped.
function entry(kind, at, text, extra = {}, codes = null) {
  const when = iso(at);
  const full = compact(text);
  return when && full && screenOk(full, codes) ? { kind, at: when, text: clip(full), ...extra } : null;
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
async function reserviceItems(svc, dbh, codes) {
  if (!require('../config/feature-gates').reserviceAsksLive()) return [];
  // holdText: the body screen runs on each message's ORIGINAL text, before the gather scrubs and caps it.
  const gathered = await require('./reservice-asks').gatherReserviceAsks(svc.id, { knex: dbh, skipCalls: true, holdText: (text) => !screenOk(compact(text), codes) });
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
      }, codes);
    });
}

// The booking row, when it is the public booking form's. Two writers make self_booked_appointments rows: the public
// form (routes/booking.js) always stamps `source` ('direct', a fleet site, 'reservice_link'), and the AI assistant's
// book_appointment (availability.confirmBooking) writes none. Only the form's row holds words the customer typed.
async function typedBookingRow(svc, dbh) {
  // The row must be this visit's own customer's: a mismatched id (a merge, a bad link) yields no note.
  const row = await dbh('self_booked_appointments').where({ id: svc.self_booking_id, customer_id: svc.customer_id }).first('customer_notes', 'source');
  return row && row.source ? row : null;
}

// Only on the visit the customer booked (linked to a public self-booking whose row proves the form wrote it): the
// recurring seeder copies the parent's notes onto every follow-up it seeds, and the AI assistant's booking notes are
// not the customer's typing. An unreadable row proves nothing, so nothing shows.
async function bookingNoteItems(svc, dbh, codes) {
  if (!svc.self_booking_id) return [];
  const row = await typedBookingRow(svc, dbh);
  if (!row) return [];
  const text = require('./reservice-asks').selfBookedNoteText(svc.notes, row.customer_notes);
  return text && !officeOnly(text) ? [entry('booking_note', svc.created_at, text, {}, codes)] : [];
}

// Does this account provably have ONE premises? The re-service asks' own fail-closed proof; a failed read is "no".
async function singlePremises(svc, dbh) {
  if (!svc?.customer_id) return false;
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
  if (!svc?.customer_id) return [];
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
  if (!svc?.customer_id) return { hasEvidence: true, key: null };
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
  requireCustomer(svc);
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
      });
    })
    // Newest by creation, never by last change: an office edit bumps updated_at and must not displace a newer ask.
    .orderBy('created_at', 'desc')
    .limit(PORTAL_READ_LIMIT)
    .select('subject', 'description', 'source', 'created_at', 'metadata');
}

// This appointment's own reschedule requests, in a query of their own (anchored header match), so the portal read's
// depth never decides whether one shows. They name no property: the appointment is the scope.
function rescheduleRowsQuery(dbh, svc) {
  requireCustomer(svc);
  const { OPEN_REQUEST_TERMINAL_STATUSES } = require('./estimate-add-service-request');
  return dbh('service_requests')
    .where({ customer_id: svc.customer_id, category: 'schedule_change', source: RESCHEDULE_SOURCE })
    .where(function openRows() {
      this.whereNull('status').orWhereNotIn('status', OPEN_REQUEST_TERMINAL_STATUSES);
    })
    .whereRaw('left(COALESCE(description, \'\'), ?) = ?', [appointmentHeader(svc).length, appointmentHeader(svc)])
    .orderBy('created_at', 'desc')
    .limit(PORTAL_ROW_LIMIT)
    .select('subject', 'description', 'source', 'created_at', 'metadata');
}

// The customer's own note from a reschedule request, dated by the update that supplied it: the newest block with a
// "Customer notes:" line. The first block is the request itself (the row's date). A later block carries an ET date
// the customer's own text could also spell: it counts only as a real calendar day from the request's day to today
// (ET). Its time is noon Eastern, never later than now and never earlier than the request (the one timestamp used to
// rank and to show); any other date falls back to the row's date.
function rescheduleNote(description, createdAt, now = new Date()) {
  const blocks = String(description || '').split(RESCHEDULE_UPDATE_SPLIT_RE);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const note = compact(RESCHEDULE_NOTE_RE.exec(blocks[i])?.[1]);
    if (!note) continue;
    const day = i === 0 ? null : validCalendarDate(RESCHEDULE_UPDATE_DATE_RE.exec(blocks[i])?.[1]);
    const inRange = day && day >= etCalendarDayOf(createdAt) && day <= etDateString(now);
    const stamped = inRange ? new Date(Math.max(new Date(createdAt), Math.min(parseETDateTime(`${day}T12:00`), now))) : null;
    return { note, at: stamped || createdAt };
  }
  return null;
}

// The words of a portal request row. A row whose subject is an independently generated service label shows that label when it
// passes every screen: a card or chat row, and a pricing flow ('portal_flow', whose generated description holds prices, never shown). A typed
// portal form row (and an older row with only the stamp) derives its subject FROM the description: its first 80 characters,
// which can carry what the description's screen held, so a held description shows nothing at all. A description that starts
// with its subject is shown alone.
function requestRowText(row, codes = null) {
  const subject = compact(row.subject);
  const passes = (text) => screenOk(text, codes) && !officeOnly(text);
  // A label the client or the server wrote (a card or chat row, or a row naming itself a pricing flow) is trusted for nothing:
  // its subject shows only if it passes every screen.
  if (row.source || metaOf(row)?.writer === 'portal_flow') return passes(subject) ? subject : '';
  const description = compact(row.description);
  // The complete outgoing request text, subject and description together, passes every screen or nothing shows.
  if (!description || !passes(compact(`${subject} ${description}`))) return '';
  return description.toLowerCase().startsWith(subject.toLowerCase()) ? description : `${subject}: ${description}`;
}

// Open requests the customer made in the portal or the app. A reschedule request for this appointment shows only the
// note the customer typed, dated by the update that supplied it.
async function portalItems(svc, dbh, singleSoon, codes) {
  const single = await singleSoon;
  const scope = await visitScope(svc, dbh);
  const [portalRows, rescheduleRows] = await Promise.all([
    portalRowsQuery(dbh, svc, single ? null : await visitPropertyIds(svc, dbh, scope)),
    rescheduleRowsQuery(dbh, svc),
  ]);
  const rows = [...(portalRows || []), ...(rescheduleRows || [])];
  // An unstamped visit resolves its premises only when a row has an address to check against.
  const checkScope = scope.hasEvidence || !(rows || []).some(storedAddress) ? scope : await primaryScope(svc, dbh);
  // Entries first, empties dropped (a preferred-date-only reschedule), THEN the limit.
  return (rows || [])
    .filter((row) => storedAddressMatches(row, checkScope))
    .map((row) => {
      if (row.source === RESCHEDULE_SOURCE) {
        const revised = rescheduleNote(row.description, row.created_at);
        // `appointment` marks a note that belongs to this one appointment, so a grouped stop keeps it with its service.
        return revised && !officeOnly(revised.note) ? entry('portal_request', revised.at, revised.note, { source: 'portal', appointment: true }, codes) : null;
      }
      return entry('portal_request', row.created_at, requestRowText(row, codes), { source: 'portal' }, codes);
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

function messageWindow(svc, now = new Date()) {
  const day = etCalendarDayOf(svc.scheduled_date) || etDateString(now);
  const noon = parseETDateTime(`${day}T12:00`);
  const since = parseETDateTime(`${etDateString(addETDays(noon, -PORTAL_MESSAGE_WINDOW_DAYS))}T00:00`);
  const dayEnd = parseETDateTime(`${etDateString(addETDays(noon, 1))}T00:00`);
  return { since, until: dayEnd < now ? dayEnd : now };
}

// A message with no letters after normalization (digits, spaces, punctuation: "48", "1", "4 5 1 1") is never shown, whatever came
// before it or wherever the read ends: it can be the tail of a code or a card number whose first part is held or unread.
const hasLetters = (text) => /\p{L}/u.test(String(text).normalize('NFKC'));
const safeMessage = (text, codes = null) => hasLetters(text) && screenOk(text, codes) && !officeOnly(text);

async function portalMessageItems(svc, dbh, singleSoon, codes) {
  if (!svc?.customer_id) return [];
  if (!require('../config/feature-gates').portalMessagesLive()) return [];
  const { since, until } = messageWindow(svc);
  const rows = await dbh('messages as m')
    .join('conversations as c', 'c.id', 'm.conversation_id')
    .where({ 'c.customer_id': svc.customer_id, 'c.channel': 'portal', 'm.channel': 'portal', 'm.direction': 'inbound', 'm.author_type': 'customer', 'm.message_type': 'portal_message' })
    .where('m.created_at', '>=', since)
    .where('m.created_at', '<=', until)
    .orderBy('m.created_at', 'desc')
    .limit(PORTAL_READ_LIMIT)
    .select('m.id', 'm.body', 'm.created_at');
  const accountWide = !(await singleSoon);
  // The texts feature's own sequence step, over the whole window in time order, BEFORE any filter or the display cap: a card
  // number sent a few digits at a time, and a 1-2 digit reply right after a held message ("my verification code is" ... "48").
  const sequenceHeld = require('./tech-visit-texts').sequenceHeldIds(
    (rows || []).map((row) => ({ id: row.id, direction: 'inbound', message_body: row.body, created_at: row.created_at })),
  );
  return (rows || [])
    .filter((row) => !sequenceHeld.has(row.id))
    .filter((row) => compact(row.body) && safeMessage(compact(row.body), codes))
    .slice(0, PORTAL_ROW_LIMIT)
    .map((row) => entry('portal_message', row.created_at, row.body, { source: 'portal', ...(accountWide ? { accountWide: true } : {}) }, codes));
}

// The stored access codes (null = none stored, false = unreadable). One read for the whole call.
async function safeCodes(svc, dbh) {
  try {
    return await require('./tech-visit-texts').readStoredCodes(dbh, svc.customer_id);
  } catch (err) {
    logger.warn(`[visit-customer-asked] stored codes unreadable: ${err?.code || err?.name || 'Error'}`);
    return false;
  }
}

/**
 * @param {object} svc the visit's scheduled_services row
 * @returns {Promise<{ items: object[] } | null>} Newest first, one entry per wording, at most 8; null when nothing.
 */
async function customerAskedFacts(svc, dbh) {
  // A hold or any visit with no customer reads nothing: no query may run on a missing customer id.
  if (!svc?.customer_id) return null;
  // The customer's stored access codes, read once for every screen below (the texts feature's own reader: every property's
  // codes and every filed code). A failed read returns no free-text item at all.
  const codes = await safeCodes(svc, dbh);
  if (codes === false) return null;
  // The premises proof is read once for both portal sources; it never rejects (a failed read is "not single").
  const single = singlePremises(svc, dbh);
  const lists = await Promise.all([
    safely('re-service asks', () => reserviceItems(svc, dbh, codes)),
    safely('booking note', () => bookingNoteItems(svc, dbh, codes)),
    safely('portal requests', () => portalItems(svc, dbh, single, codes)),
    safely('portal messages', () => portalMessageItems(svc, dbh, single, codes)),
  ]);
  // One copy per wording within a scope, the newest kept. An item about this appointment (the return reason, the booking
  // note, a reschedule note) is a different thing from the same words said account-wide, so each scope dedupes alone.
  // The return reason is never dropped: it goes first, so a booking or reschedule note with the same words is the copy that
  // yields.
  const seen = new Set();
  const flat = lists.flat().filter(Boolean).sort(newestFirst);
  const ordered = [...flat.filter((item) => item.kind === 'reservice_reason'), ...flat.filter((item) => item.kind !== 'reservice_reason')];
  const items = ordered.filter((item) => {
    const words = item.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const key = `${belongsToAppointment(item) ? 'appointment' : 'account'}|${words}`;
    if (!words || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const picked = pickItems(items);
  return picked.length ? { items: picked } : null;
}

module.exports = { customerAskedFacts, MAX_ITEMS, MAX_TEXT_CHARS, _test: { rescheduleRowsQuery, moneyFree, requestRowText, portalMessageItems, safeMessage, messageWindow, portalRowsQuery, rescheduleNote, visitPropertyIds, storedAddressMatches, pickItems } };
