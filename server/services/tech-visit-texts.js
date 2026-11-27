/**
 * Technician Visit Brief: the customer's texts of the last 7 days (GATE_TECH_VISIT_TEXTS).
 *
 * Read-only. One customer, one window (ET midnight 7 days before the visit date, up to now), sms_log only: no call_log,
 * no transcript, no model call. Every row is sorted into one of three bins by textVerdict():
 *   show    a plain customer reply, or an office text of a visit-related type with no money word in it;
 *   hidden  money or unknown: counted, the body never leaves this module;
 *   skip    noise the technician does not need (reminders, tapbacks, opt-in words, failed sends): not counted.
 * An outbound type that is in neither list is hidden, so a type added later stays out until someone lists it here.
 */
const { addETDays, etDateString, parseETDateTime } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');

const WINDOW_DAYS = 7;
const MAX_TEXTS = 40;
const FETCH_LIMIT = 200;

const SHOW_INBOUND_TYPES = new Set(['inbound', 'domain_lead', 'van_lead']);
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

function hasMoneyWords(body) {
  const text = String(body || '');
  return MONEY_WORDS.test(text) || DOLLAR_AMOUNT.test(text);
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

// 'show' | 'hidden' | 'skip' for one sms_log row ({ direction, message_type, status, message_body, metadata }).
function textVerdict(row) {
  const type = row.message_type || '';
  const inbound = row.direction === 'inbound';
  if (QUIET_TYPES.has(type)) return 'skip';
  if (!inbound && UNSENT_STATUSES.has(row.status)) return 'skip';
  if (!(inbound ? SHOW_INBOUND_TYPES : SHOW_OUTBOUND_TYPES).has(type)) return 'hidden';
  if (hasMoneyWords(row.message_body)) return 'hidden';
  if (!String(row.message_body || '').trim() && !(inbound && mediaOf(row).length)) return 'skip';
  return 'show';
}

// ET midnight, 7 ET calendar days before the visit's scheduled date. Never a fixed UTC offset.
function windowStart(scheduledDate) {
  const day = dateOnlyString(scheduledDate);
  if (!day) return null;
  const noon = parseETDateTime(`${day}T12:00`);
  return parseETDateTime(`${etDateString(addETDays(noon, -WINDOW_DAYS))}T00:00`);
}

// The photos the customer sent, as short-lived signed links. Only a stored object (S3 key) is ever linked: a provider
// URL is never returned, and a photo that cannot be signed is left out.
async function signedPhotos(row, sign) {
  if (row.direction !== 'inbound') return [];
  const media = mediaOf(row).filter((item) => item && item.key);
  if (!media.length) return [];
  const signed = await sign(media);
  return signed
    .filter((item) => item.url && item.url !== item.providerUrl)
    .map((item) => ({ url: item.url, contentType: item.contentType || null }));
}

async function visitTexts(db, svc, { now = new Date(), sign = null } = {}) {
  const start = windowStart(svc.scheduled_date);
  if (!svc.customer_id || !start) return { texts: [], hidden: 0 };
  const signer = sign || ((media) => require('./sms-media').signMediaForClient(media));
  const rows = await db('sms_log')
    .where({ customer_id: svc.customer_id })
    .where('created_at', '>=', start)
    .where('created_at', '<=', now)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(FETCH_LIMIT)
    .select('id', 'direction', 'message_body', 'message_type', 'status', 'metadata', 'created_at');
  let hidden = 0;
  const shown = [];
  for (const row of rows) {
    const verdict = textVerdict(row);
    if (verdict === 'hidden') hidden += 1;
    else if (verdict === 'show' && shown.length < MAX_TEXTS) shown.push(row);
  }
  const texts = await Promise.all(shown.reverse().map(async (row) => ({
    id: row.id,
    direction: row.direction,
    at: row.created_at,
    body: row.message_body || '',
    photos: await signedPhotos(row, signer),
  })));
  return { texts, hidden };
}

module.exports = { textVerdict, hasMoneyWords, windowStart, visitTexts, WINDOW_DAYS, MAX_TEXTS };
