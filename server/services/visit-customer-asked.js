/**
 * "Customer asked" facts for the technician's Visit Brief (owner 2026-11-26: the tech should have context for a
 * request, or messages from the portal or app, like re-service notes or reminder notes from the customer).
 *
 * Read-only, no AI, no gate of its own. Four sources, each read by an existing path:
 *   reservice_reason / reservice_words  gatherReserviceAsks (GATE_RESERVICE_ASKS), the same scrubbed, capped list the
 *                                       technician close-out sheet reads. Call quotes and office-only messages never
 *                                       show (owner ruling D1 A 2026-11-04: no call words on a technician screen).
 *   booking_note                        the note a customer typed when self-booking, from the visit's notes line.
 *   portal_request                      the customer's open portal requests: the service and their own words, never
 *                                       a price or a pricing snapshot.
 *
 * Words from the re-service gather keep its customer-words scrub ('reservice' lane). A booking note and a portal
 * request are shown as typed: a technician needs the access details and the "call before you come" lines the scrub
 * would drop, and un-scrubbing would need new code.
 *
 * Every source fails on its own: a failed read logs its error code (never the customer's text) and yields nothing.
 */

const logger = require('./logger');

const MAX_ITEMS = 8;
const MAX_TEXT_CHARS = 280;
const PORTAL_ROW_LIMIT = 5;
// The portal form's categories that name a service or a visit; billing, cancellation, pause and moving requests are
// the office's.
const PORTAL_CATEGORIES = ['pest_issue', 'lawn_concern', 'add_service', 'schedule_change', 'upgrade', 'other'];
// The promotion card writes this server line as the description; it is not the customer's words.
const PROMOTION_DESCRIPTION_RE = /^Customer expressed interest via promotion card/;
const ASK_SOURCE = { request_form: 'picker', text: 'text', call: 'call', office: 'office' };

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
async function reserviceItems(svc, dbh) {
  if (!require('../config/feature-gates').reserviceAsksLive()) return [];
  const gathered = await require('./reservice-asks').gatherReserviceAsks(svc.id, { knex: dbh });
  if (!gathered?.ok) return [];
  const bookingId = `booking:${svc.id}`;
  return gathered.items
    // A call's quotes are never shown; the booking item may come from a call and is then the visit's own paraphrase.
    .filter((item) => item.text && !item.officeOnly && (item.source !== 'call' || item.id === bookingId))
    .map((item) => {
      const reason = item.id === bookingId;
      const source = reason || item.source === 'text' ? ASK_SOURCE[item.source] : undefined;
      return entry(reason ? 'reservice_reason' : 'reservice_words', item.at, item.text, {
        ...(item.pests?.length ? { pests: item.pests } : {}),
        ...(source ? { source } : {}),
      });
    });
}

function bookingNoteItems(svc) {
  const text = require('./reservice-asks').selfBookedNoteText(svc.notes);
  return text ? [entry('booking_note', svc.created_at, text)] : [];
}

// Open requests the customer made in the portal or the app. A portal form row is their own subject and note; a card
// or chat row (CTA sources) carries a server-written description, so only its subject (the service) shows.
async function portalItems(svc, dbh) {
  const { CTA_REQUEST_SOURCES } = require('./cta-service-request');
  const { OPEN_REQUEST_TERMINAL_STATUSES } = require('./estimate-add-service-request');
  const rows = await dbh('service_requests')
    .where({ customer_id: svc.customer_id })
    .whereIn('category', PORTAL_CATEGORIES)
    .where(function openRows() {
      this.whereNull('status').orWhereNotIn('status', OPEN_REQUEST_TERMINAL_STATUSES);
    })
    .where(function portalSources() {
      this.whereNull('source').orWhereIn('source', CTA_REQUEST_SOURCES);
    })
    .orderBy('created_at', 'desc')
    .limit(PORTAL_ROW_LIMIT)
    .select('subject', 'description', 'source', 'created_at');
  return (rows || []).map((row) => {
    const note = row.source || PROMOTION_DESCRIPTION_RE.test(row.description || '') ? '' : compact(row.description);
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
    safely('booking note', async () => bookingNoteItems(svc)),
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

module.exports = { customerAskedFacts, MAX_ITEMS, MAX_TEXT_CHARS };
