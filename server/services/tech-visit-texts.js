/**
 * Technician Visit Brief: the customer's texts of the last 7 days (GATE_TECH_VISIT_TEXTS).
 *
 * Read-only. One customer, one window (ET midnight 7 days before the visit date, up to now), sms_log only: no call_log,
 * no transcript, no model call. Every row is sorted into one of three bins by textVerdict():
 *   show    a plain customer reply, or an office text of a visit-related type with no money word in it;
 *   hidden  money or unknown: counted, the body never leaves this module;
 *   skip    noise the technician does not need (reminders, tapbacks, opt-in words, failed sends): not counted.
 * A card number, a labeled card / bank detail or a link hides the whole text. An outbound type that is in neither list is hidden, so a type added later stays out until someone lists it here.
 */
const { addETDays, etDateString, parseETDateTime } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { scrubPansDetailed } = require('../utils/pan-scrub');
const { isSmsReaction } = require('./sms-intent');
const { excludeRecruitingSmsLog } = require('../utils/recruiting-thread-scope');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');

const WINDOW_DAYS = 7;
const MAX_TEXTS = 40;
const PAGE_SIZE = 200;
const MAX_PAGES = 5;
// Only these image types are ever signed: a PDF or any other document is never linked.
const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif']);

const SHOW_INBOUND_TYPES = new Set(['inbound', 'domain_lead', 'van_lead', 'reschedule_reply']);
// 'manual' is also what marketing, retention and follow-up sends are stored as: it shows only when a staff member wrote it
// (sms_log.admin_user_id set), so an automated send of that type stays hidden.
const SHOW_OUTBOUND_TYPES = new Set([
  'manual', 'ai_approved', 'ai_revised', 'ai_autosent', 'ai_assistant_reply', 'auto_reply', 'customer_reply',
  'appointment_rescheduled', 'appointment_cancelled', 'reschedule_reply', 'reschedule_series_confirmation',
  'rain_out_moved_v2', 'rain_out_moved_v3', 'rain_out_moved_day_v1', 'rain_out_moved_custom_v1', 'rain_out_customer_pick_v1',
  'prep_info', 'prep_guide', 'lawn_watering_instruction',
]);
// Not money, and not worth a technician's attention: dropped without a count.
const QUIET_TYPES = new Set([
  'sms_reaction', 'opt_in', 'opt_out', 'help_request', 'recipient_optin_request',
  'appointment_reminder', 'appointment_reminder_72h', 'reminder', 'reminder_24h', 'reminder_72h',
  'confirmation', 'appointment_confirmation', 'tech_en_route', 'review_request', 'review', 'review_followup',
]);
// An outbound text in one of these states never reached the customer (or has not yet).
const UNSENT_STATUSES = new Set(['failed', 'undelivered', 'blocked', 'held', 'scheduled', 'pending', 'pending_review', 'sending', 'cancelled', 'canceled']);

// bill, invoice, charge, card, payment, pay, paid, refund, price, cost, balance, owe, a dollar amount; plus the plain
// forms of the same words a customer types (autopay, receipt, deposit, cash, venmo, zelle, fee).
const MONEY_WORDS = /\b(bills?|billed|billing|invoices?|invoiced|charges?|charged|charging|cards?|payments?|pay|pays|paying|paid|payable|refunds?|refunded|prices?|priced|pricing|costs?|balance|balances|owe|owes|owed|owing|autopay|receipts?|deposits?|cash|venmo|zelle|fees?)\b/i;
const DOLLAR_AMOUNT = /\$\s?\d|\b\d[\d,]*(\.\d{1,2})?\s*(dollars?|bucks)\b/i;

// Card or bank details a customer may text: a labeled CVV / security code / expiry, a routing or account number.
const CREDENTIAL_WORDS = /\b(?:cvv2?|cvc2?|cid|security code|card code|expir(?:y|es|ation|ing)|exp\.? date|routing)\b|\b(?:account|acct|acc|bank|checking|savings)\b[^\n]{0,24}?\d(?:[\s.-]?\d){5,}|\b(?:account|acct)\.?\s*(?:number|no\.?|#)|\b\d{8,17}\b/i;
// A link: a customer-action link (reschedule, pay, estimate, portal) works without a login, and a technician must never
// read one that belongs to another visit of the customer. Any text carrying a URL, a www. address or a short link is held back.
const LINK = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|us|app|link|ly|me|info|biz)\b/i;

function hasMoneyWords(body) {
  const text = String(body || '');
  return MONEY_WORDS.test(text) || DOLLAR_AMOUNT.test(text);
}

// A card number (the repo's PAN detector, spoken and spaced forms included) or a labeled card / bank detail.
function hasLink(body) {
  return LINK.test(String(body || ''));
}

function hasCardCredentials(body) {
  const text = String(body || '');
  return CREDENTIAL_WORDS.test(text) || scrubPansDetailed(text).count > 0;
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

function mediaOf(row) {
  const media = parseMetadata(row.metadata).media;
  return Array.isArray(media) ? media : [];
}

const isImageType = (type) => IMAGE_TYPES.has(String(type || '').split(';')[0].trim().toLowerCase());

// The customer's stored image attachments: a stored object with an allow-listed image type.
function photosOf(row) {
  if (row.direction !== 'inbound') return [];
  return mediaOf(row).filter((item) => item && item.key && isImageType(item.contentType));
}

// 'show' | 'hidden' | 'skip' for one sms_log row ({ direction, message_type, status, message_body, metadata }).
function textVerdict(row) {
  const type = row.message_type || '';
  const inbound = row.direction === 'inbound';
  if (QUIET_TYPES.has(type) || (inbound && isSmsReaction(row.message_body))) return 'skip';
  if (!inbound && UNSENT_STATUSES.has(row.status)) return 'skip';
  if (!(inbound ? SHOW_INBOUND_TYPES : SHOW_OUTBOUND_TYPES).has(type)) return 'hidden';
  if (hasMoneyWords(row.message_body) || hasCardCredentials(row.message_body) || hasLink(row.message_body)) return 'hidden';
  if (type === 'manual' && !inbound && !row.admin_user_id) return 'hidden';
  // A text with no words (a photo alone) is never shown: a photo of a card or a check has no caption to screen.
  if (!String(row.message_body || '').trim()) return 'skip';
  return 'show';
}

// ET midnight, 7 ET calendar days before the visit's scheduled date. Never a fixed UTC offset.
function windowStart(scheduledDate) {
  const day = dateOnlyString(scheduledDate);
  if (!day) return null;
  const noon = parseETDateTime(`${day}T12:00`);
  return parseETDateTime(`${etDateString(addETDays(noon, -WINDOW_DAYS))}T00:00`);
}

// The photos the customer sent (GATE_TECH_VISIT_TEXT_PHOTOS), as short-lived signed links. Only a stored object (S3 key) is
// ever linked: a provider URL is never returned, and a photo that cannot be signed is left out.
async function signedPhotos(row, sign) {
  const media = photosOf(row);
  if (!media.length) return [];
  // Stored objects only: any url / providerUrl on the item is dropped first, so a failed signature can never fall back to one.
  const signed = await sign(media.map(({ url, providerUrl, ...stored }) => stored));
  return signed
    .filter((item) => item.url)
    .map((item) => ({ url: item.url, contentType: item.contentType || null }));
}

// A scheduled send is two rows: the queue parent (promoted to 'sent' when the text leaves) and the provider row that names
// it in metadata.scheduled_sms_log_id (as customer-activity-timeline.js). Keep the provider row, drop the parent.
function withoutQueueParents(rows) {
  const parents = new Set(rows.map((row) => parseMetadata(row.metadata).scheduled_sms_log_id).filter(Boolean).map(String));
  return rows.filter((row) => !parents.has(String(row.id)));
}

// Statuses an outbound text may carry once it left (customer-activity-timeline.js OUTBOUND_LEFT).
const OUTBOUND_LEFT = ['', 'sent', 'queued', 'accepted', 'delivered', 'read', 'failed', 'undelivered'];

// One customer's sms_log rows in the window, the way every sms_log reader builds them: no recruiting threads, no unresolved
// send reservations, and a scheduled send's queue parent left out when its provider row is there.
function visibleWindowQuery(db, customerId, start, now) {
  const query = db('sms_log as sl')
    .where('sl.customer_id', customerId)
    .where('sl.created_at', '>=', start)
    .where('sl.created_at', '<=', now)
    .whereNotExists(function providerTwin() {
      this.select(1).from('sms_log as twin')
        .where('twin.direction', 'outbound')
        .whereRaw('twin.customer_id = sl.customer_id')
        .whereRaw('twin.id <> sl.id')
        .whereRaw("twin.metadata->>'scheduled_sms_log_id' = sl.id::text")
        .whereRaw(`LOWER(COALESCE(twin.status, '')) IN (${OUTBOUND_LEFT.map(() => '?').join(', ')})`, OUTBOUND_LEFT)
        .modify((q) => excludeUnresolvedSendReservations(q, 'twin'));
    });
  return excludeUnresolvedSendReservations(excludeRecruitingSmsLog(query, 'sl.message_type'), 'sl');
}

// The window's rows, newest first, read in pages (at most MAX_PAGES x PAGE_SIZE) so a run of reminders newer than a
// customer's instruction cannot push it out of view. Classification happens after, over every row read.
async function windowRows(db, customerId, start, now) {
  const rows = [];
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await visibleWindowQuery(db, customerId, start, now)
      .orderBy('sl.created_at', 'desc')
      .orderBy('sl.id', 'desc')
      .limit(PAGE_SIZE)
      .offset(page * PAGE_SIZE)
      .select('sl.id', 'sl.direction', 'sl.message_body', 'sl.message_type', 'sl.status', 'sl.admin_user_id', 'sl.metadata', 'sl.created_at');
    for (const row of batch) if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
    if (batch.length < PAGE_SIZE) break;
  }
  return withoutQueueParents(rows);
}

async function visitTexts(db, svc, { now = new Date(), sign = null, withPhotos = false } = {}) {
  const start = windowStart(svc.scheduled_date);
  if (!svc.customer_id || !start) return { texts: [], hidden: 0 };
  const signer = sign || ((media) => require('./sms-media').signMediaForClient(media));
  const rows = await windowRows(db, svc.customer_id, start, now);
  let hidden = 0;
  const shown = [];
  for (const row of rows) {
    const verdict = textVerdict(row);
    if (verdict === 'hidden') hidden += 1;
    else if (verdict === 'show') shown.push(row);
  }
  const texts = await Promise.all(shown.slice(0, MAX_TEXTS).reverse().map(async (row) => ({
    id: row.id,
    direction: row.direction,
    at: row.created_at,
    body: row.message_body || '',
    photos: withPhotos ? await signedPhotos(row, signer) : [],
    photoCount: photosOf(row).length,
  })));
  return { texts, hidden };
}

module.exports = { textVerdict, hasMoneyWords, hasCardCredentials, hasLink, windowStart, visitTexts, WINDOW_DAYS, MAX_TEXTS, MAX_PAGES, PAGE_SIZE };
