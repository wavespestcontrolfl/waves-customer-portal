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
const { parseETDateTime } = require('../utils/datetime-et');

const MAX_ITEMS = 8;
const MAX_TEXT_CHARS = 280;
const PORTAL_ROW_LIMIT = 5;
// The portal form's categories that name a service or a visit; billing, cancellation, pause and moving requests are
// the office's.
const PORTAL_CATEGORIES = ['pest_issue', 'lawn_concern', 'add_service', 'schedule_change', 'upgrade', 'other'];
const ASK_SOURCE = { request_form: 'picker', text: 'text', office: 'office' };
const RESCHEDULE_SOURCE = 'customer_portal_reschedule';
// A null-source row is the customer's own portal form only when it says so: the form's writer mark, or the property
// or photo-id stamp only that form writes. Other null-source rows (the cancel flow's re-service request, office
// follow-ups) hold case ids and office instructions in the description, so they never show.
const PORTAL_FORM_SQL = "(metadata->>'writer' = 'portal_form' OR metadata->>'propertyId' IS NOT NULL OR metadata->'photoIdSource' IS NOT NULL)";
// The reschedule route (routes/schedule.js) writes the description as "Appointment <id>: <type> on <date>", then the
// preferred date and "Customer notes: <text>" lines; each later update appends a "Customer updated <ET date>:" block.
const RESCHEDULE_UPDATE_SPLIT_RE = /\n(?=Customer updated \d{4}-\d{2}-\d{2}:)/;
const RESCHEDULE_UPDATE_DATE_RE = /^Customer updated (\d{4}-\d{2}-\d{2}):/;
const RESCHEDULE_NOTE_RE = /Customer notes: ([\s\S]*)$/;

const compact = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

function clip(text, max = MAX_TEXT_CHARS) {
  const words = compact(text);
  return words.length <= max ? words : `${words.slice(0, max - 1).replace(/[\s.,;:!?-]+$/, '')}…`;
}

const iso = (value) => {
  const d = new Date(value);
  return value == null || Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function entry(kind, at, text, extra = {}) {
  const when = iso(at);
  const words = clip(text);
  return when && words ? { kind, at: when, text: words, ...extra } : null;
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

// The original booking's own words, when the visit came from a self-booking and its row is readable.
async function typedBookingNote(svc, dbh) {
  if (!svc.self_booking_id) return null;
  const row = await dbh('self_booked_appointments').where({ id: svc.self_booking_id }).first('customer_notes');
  return row?.customer_notes || null;
}

async function bookingNoteItems(svc, dbh) {
  const typed = await typedBookingNote(svc, dbh).catch((err) => {
    logger.warn(`[visit-customer-asked] booking row unreadable: ${err?.code || err?.name || 'Error'}`);
    return null;
  });
  const text = require('./reservice-asks').selfBookedNoteText(svc.notes, typed);
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
async function visitPropertyIds(svc, dbh) {
  try {
    const { resolveVisitPropertyScope, sameResolvedProperty } = require('./service-report/visit-property-scope');
    const linkage = require('./estimate-property-linkage');
    const props = await dbh('customer_properties')
      .where({ customer_id: svc.customer_id, active: true })
      .select('id', 'is_primary', 'address_line1', 'address_line2', 'city', 'zip');
    const scope = await resolveVisitPropertyScope(svc, dbh);
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
    // Newest by last change: a revised reschedule note appends to an old row and bumps updated_at.
    .orderByRaw('GREATEST(created_at, COALESCE(updated_at, created_at)) DESC')
    .limit(PORTAL_ROW_LIMIT)
    .select('subject', 'description', 'source', 'created_at');
}

// The customer's own note from a reschedule request, dated by the update that supplied it: the newest block with a
// "Customer notes:" line. The first block is the request itself (the row's date); a later one carries its ET date.
// Nothing else of the row is read.
function rescheduleNote(description, createdAt) {
  const blocks = String(description || '').split(RESCHEDULE_UPDATE_SPLIT_RE);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const note = compact(RESCHEDULE_NOTE_RE.exec(blocks[i])?.[1]);
    if (!note) continue;
    const day = i === 0 ? null : RESCHEDULE_UPDATE_DATE_RE.exec(blocks[i])?.[1];
    return { note, at: day ? parseETDateTime(`${day}T12:00`) : createdAt };
  }
  return null;
}

// Open requests the customer made in the portal or the app. A portal form row is their own subject and note; a card
// or chat row (CTA sources) carries a server-written description, so only its subject (the service) shows; a
// reschedule request for this appointment shows only the note the customer typed, dated by the update that supplied it.
async function portalItems(svc, dbh) {
  const single = await singlePremises(svc, dbh);
  const rows = await portalRowsQuery(dbh, svc, single ? null : await visitPropertyIds(svc, dbh));
  return (rows || []).map((row) => {
    if (row.source === RESCHEDULE_SOURCE) {
      const revised = rescheduleNote(row.description, row.created_at);
      // `appointment` marks a note that belongs to this one appointment, so a grouped stop keeps it with its service.
      return revised ? entry('portal_request', revised.at, revised.note, { source: 'portal', appointment: true }) : null;
    }
    const note = row.source ? '' : compact(row.description);
    const subject = compact(row.subject);
    return entry('portal_request', row.created_at, note ? `${subject}: ${note}` : subject, { source: 'portal' });
  });
}

/**
 * @param {object} svc the visit's scheduled_services row
 * @returns {Promise<{ items: object[] } | null>} Newest first, one entry per wording, at most 8; null when nothing.
 */
async function customerAskedFacts(svc, dbh) {
  const lists = await Promise.all([
    safely('re-service asks', () => reserviceItems(svc, dbh)),
    safely('booking note', () => bookingNoteItems(svc, dbh)),
    safely('portal requests', () => portalItems(svc, dbh)),
  ]);
  const seen = new Set();
  const items = lists.flat().filter(Boolean).filter((item) => {
    const key = item.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return items.length ? { items: items.slice(0, MAX_ITEMS) } : null;
}

module.exports = { customerAskedFacts, MAX_ITEMS, MAX_TEXT_CHARS, _test: { portalRowsQuery, rescheduleNote, visitPropertyIds } };
